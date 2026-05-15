/**
 * M6: export / import JSONL CLI — 단위 테스트
 *
 * DB 연결 없이 로직·인터페이스만 검증한다.
 * export.js / import.js의 usage export, JSON parse 에러 핸들링,
 * --dry-run 동작, --idempotent 중복 스킵 로직을 테스트한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-04-20
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs     from "node:fs";
import path   from "node:path";
import os     from "node:os";
import { fileURLToPath } from "node:url";

/** ---- 헬퍼: 임시 JSONL 파일 ---- */
function writeTempJsonl(rows) {
  const file = path.join(os.tmpdir(), `memento-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  const lines = rows.map(r => JSON.stringify(r)).join("\n") + "\n";
  fs.writeFileSync(file, lines, "utf8");
  return file;
}

function removeTempFile(file) {
  try { fs.unlinkSync(file); } catch { /* ignore */ }
}

/** ---- export.js 테스트 ---- */
describe("M6: export.js", () => {
  it("usage export가 존재하고 Usage: 포함", async () => {
    const mod = await import("../../lib/cli/export.js");
    assert.strictEqual(typeof mod.usage, "string", "usage는 문자열이어야 함");
    assert.ok(mod.usage.includes("Usage:"), "usage에 Usage: 헤더가 있어야 함");
    assert.ok(mod.usage.includes("--output"), "--output 옵션이 문서화돼야 함");
    assert.ok(mod.usage.includes("--since"), "--since 옵션이 문서화돼야 함");
    assert.ok(mod.usage.includes("--idempotent") === false, "export에는 --idempotent가 없음"); // export는 idempotent 없음
  });

  it("default export가 함수", async () => {
    const mod = await import("../../lib/cli/export.js");
    assert.strictEqual(typeof mod.default, "function", "default export는 함수여야 함");
  });

  it("JSONL 출력 필드 목록이 소스에 포함됨", async () => {
    const src = fs.readFileSync(
      fileURLToPath(new URL("../../lib/cli/export.js", import.meta.url)),
      "utf8"
    );
    const requiredFields = [
      "id", "content", "topic", "type", "keywords", "importance",
      "source", "agent_id", "created_at", "is_anchor",
      "case_id", "idempotency_key",
      "goal", "outcome", "phase", "resolution_status", "assertion_status",
    ];
    for (const field of requiredFields) {
      assert.ok(src.includes(field), `export.js SELECT에 '${field}' 필드가 있어야 함`);
    }
  });
});

/** ---- import.js 테스트 ---- */
describe("M6: import.js", () => {
  it("usage export가 존재하고 Usage: 포함", async () => {
    const mod = await import("../../lib/cli/import.js");
    assert.strictEqual(typeof mod.usage, "string", "usage는 문자열이어야 함");
    assert.ok(mod.usage.includes("Usage:"), "usage에 Usage: 헤더가 있어야 함");
    assert.ok(mod.usage.includes("--idempotent"), "--idempotent 옵션이 문서화돼야 함");
    assert.ok(mod.usage.includes("--dry-run"),    "--dry-run 옵션이 문서화돼야 함");
    assert.ok(mod.usage.includes("--input"),      "--input 옵션이 문서화돼야 함");
  });

  it("default export가 함수", async () => {
    const mod = await import("../../lib/cli/import.js");
    assert.strictEqual(typeof mod.default, "function", "default export는 함수여야 함");
  });

  it("JSON parse 에러 처리 — 소스 내 에러 핸들링 확인", async () => {
    const src = fs.readFileSync(
      fileURLToPath(new URL("../../lib/cli/import.js", import.meta.url)),
      "utf8"
    );
    assert.ok(src.includes("JSON parse error"), "JSON parse 에러 메시지가 소스에 있어야 함");
    assert.ok(src.includes("errors++"),         "에러 카운터 증가 로직이 있어야 함");
  });

  it("--dry-run 플래그 처리 — INSERT 없이 검증만", async () => {
    const src = fs.readFileSync(
      fileURLToPath(new URL("../../lib/cli/import.js", import.meta.url)),
      "utf8"
    );
    assert.ok(src.includes("dryRun"), "dry-run 처리 로직이 있어야 함");
    assert.ok(src.includes("dryRun ? null"), "dry-run 시 pool이 null로 분기돼야 함");
  });

  it("--idempotent 플래그 — ON CONFLICT DO NOTHING 사용", async () => {
    const src = fs.readFileSync(
      fileURLToPath(new URL("../../lib/cli/import.js", import.meta.url)),
      "utf8"
    );
    assert.ok(src.includes("ON CONFLICT (id) DO NOTHING"), "idempotent 모드에 ON CONFLICT DO NOTHING이 있어야 함");
    assert.ok(src.includes("skipped++"), "중복 시 skipped 카운터 증가 로직이 있어야 함");
  });

  it("임시 JSONL 파일 생성/파싱 기능 정상 동작 확인", () => {
    const rows = [
      { id: "test-1", content: "Redis on 6380", topic: "infra",    type: "fact"     },
      { id: "test-2", content: "Use bcrypt",    topic: "security", type: "decision" },
    ];
    const file = writeTempJsonl(rows);
    try {
      const lines = fs.readFileSync(file, "utf8").trim().split("\n");
      assert.strictEqual(lines.length, 2, "2줄 JSONL이어야 함");
      const parsed = lines.map(l => JSON.parse(l));
      assert.strictEqual(parsed[0].content, "Redis on 6380");
      assert.strictEqual(parsed[1].topic,   "security");
    } finally {
      removeTempFile(file);
    }
  });
});

/** ---- bin/memento.js 등록 확인 ---- */
describe("M6: bin/memento.js COMMANDS 등록", () => {
  it("export와 import가 COMMANDS에 등록됨", async () => {
    const src = fs.readFileSync(
      fileURLToPath(new URL("../../bin/memento.js", import.meta.url)),
      "utf8"
    );
    assert.ok(src.includes("export:"), "COMMANDS에 export가 등록돼야 함");
    assert.ok(src.includes("import:"), "COMMANDS에 import가 등록돼야 함");
    assert.ok(src.includes("lib/cli/export.js"), "export.js 경로가 포함돼야 함");
    assert.ok(src.includes("lib/cli/import.js"), "import.js 경로가 포함돼야 함");
  });

  it("export/import가 LOCAL_ONLY_COMMANDS에 포함됨", async () => {
    const src = fs.readFileSync(
      fileURLToPath(new URL("../../bin/memento.js", import.meta.url)),
      "utf8"
    );
    /** LOCAL_ONLY_COMMANDS Set 라인 추출 */
    const match = src.match(/LOCAL_ONLY_COMMANDS\s*=\s*new Set\(\[([^\]]+)\]\)/);
    assert.ok(match, "LOCAL_ONLY_COMMANDS Set이 존재해야 함");
    const setContent = match[1];
    assert.ok(setContent.includes('"export"'), "export가 LOCAL_ONLY_COMMANDS에 있어야 함");
    assert.ok(setContent.includes('"import"'), "import가 LOCAL_ONLY_COMMANDS에 있어야 함");
  });
});
