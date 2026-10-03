/**
 * M6: export / import JSONL CLI — 단위 테스트
 *
 * DB 연결 없이 로직·인터페이스만 검증한다.
 * export.js / import.js의 usage export, JSON parse 에러 핸들링,
 * --dry-run 동작, --idempotent 중복 처리를 테스트한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-04-20
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs     from "node:fs";
import path   from "node:path";
import os     from "node:os";

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


/** ---- 헬퍼: importRows를 대역 의존성으로 실행 ---- */
async function runLines(lines, { dryRun = false, idempotent = false, writer = null } = {}) {
  const { importRows }                  = await import("../../lib/cli/import.js");
  const { importProfile, IMPORT_DEFAULTS } = await import("../../lib/memory/write/FragmentImporter.js");
  const { WriteGate }                   = await import("../../lib/memory/write/WriteGate.js");
  const statements = [];
  const client     = { query: async (sql) => { statements.push(String(sql).split(/\s/)[0]); return { rows: [] }; }, release() {} };
  const report = await importRows(lines, {
    profile        : importProfile(IMPORT_DEFAULTS.cli, { owner: true }),
    entry          : "cli_import",
    gate           : new WriteGate(),
    writer         : writer ?? { insertDetailed: async (f) => ({ id: f.id, created: true }) },
    linkStore      : { restoreLink: async () => ({ created: true }) },
    pool           : { connect: async () => client },
    withTransaction: async (_pool, fn) => fn(client),
    idempotent,
    dryRun,
    log            : () => {}
  });
  return { report, statements };
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

  it("형식 버전 1 열 목록이 문서화된 17개 열이다", async () => {
    const { V1_FRAGMENT_COLUMNS } = await import("../../lib/memory/transfer/exportFormat.js");
    const requiredFields = [
      "id", "content", "topic", "type", "keywords", "importance",
      "source", "agent_id", "created_at", "is_anchor",
      "case_id", "idempotency_key",
      "goal", "outcome", "phase", "resolution_status", "assertion_status",
    ];
    assert.deepEqual([...V1_FRAGMENT_COLUMNS], requiredFields);
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

  it("JSON으로 해석할 수 없는 줄은 invalid_json으로 거부하고 다음 줄을 처리한다", async () => {
    const { report } = await runLines([
      "{not json",
      JSON.stringify({ id: "ok-1", content: "Redis on 6380 for cache", topic: "infra" })
    ]);
    const summary = report.toJSON();
    assert.deepEqual(summary.rejected_by_reason, { invalid_json: 1 });
    assert.equal(summary.imported, 1);
  });

  it("--dry-run은 같은 경로로 처리하고 트랜잭션을 되돌린다", async () => {
    const { report, statements } = await runLines(
      [JSON.stringify({ id: "ok-1", content: "Redis on 6380 for cache", topic: "infra" })],
      { dryRun: true }
    );
    assert.equal(report.toJSON().imported, 1);
    assert.equal(statements[0], "BEGIN");
    assert.equal(statements.at(-1), "ROLLBACK");
    assert.ok(!statements.includes("COMMIT"));
  });

  it("--idempotent 플래그: 같은 id로 거부된 행은 duplicates, 플래그가 없으면 id_conflict로 거부한다", async () => {
    const conflict = Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
    const lines    = [JSON.stringify({ id: "test-1", content: "Redis on 6380 for cache", topic: "infra" })];
    const writer   = { insertDetailed: async () => { throw conflict; }, findKeyOfId: async () => ({ key_id: null }) };

    const skipped = (await runLines(lines, { idempotent: true, writer })).report.toJSON();
    assert.deepEqual([skipped.imported, skipped.duplicates, skipped.rejected], [0, 1, 0]);

    const failed = (await runLines(lines, { idempotent: false, writer })).report.toJSON();
    assert.deepEqual([failed.imported, failed.duplicates, failed.rejected], [0, 0, 1]);
    assert.deepEqual(failed.rejected_by_reason, { id_conflict: 1 });
  });

  it("되살리기 가져오기는 감사 로그에 요약 한 줄을 남긴다", async () => {
    const { auditRestoreImport } = await import("../../lib/cli/import.js");
    const calls = [];
    await auditRestoreImport(
      { imported: 4, duplicates: 1, rejected: 0, errors: 0, transformed: 2 },
      { keyId: null, dryRun: false, outcome: "failed", audit: async (operation, fields) => { calls.push({ operation, fields }); } }
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].operation, "cli import restore");
    assert.match(calls[0].fields.details, /restore=trusted outcome=failed .*key=master imported=4 duplicates=1 rejected=0 errors=0 transformed=2/);
    assert.equal(calls[0].fields.success, false);
  });

  it("되살리기 실행이 오류로 멈춰도 그때까지의 집계를 failed로 감사에 남긴다", async () => {
    const { runAudited }   = await import("../../lib/cli/import.js");
    const { ImportReport } = await import("../../lib/memory/transfer/ImportReport.js");
    const calls  = [];
    const report = new ImportReport({ restore: true });
    report.imported("fragments");
    report.imported("fragments");
    const audit  = async (operation, fields) => { calls.push({ operation, fields }); };

    await assert.rejects(runAudited(report, { keyId: "k", dryRun: false, restore: true, audit }, async () => { throw new Error("boom"); }), /boom/);
    assert.equal(calls.length, 1);
    assert.match(calls[0].fields.details, /outcome=failed .*key=k imported=2/);

    calls.length = 0;
    await runAudited(report, { keyId: null, dryRun: false, restore: true, audit }, async () => {});
    assert.match(calls[0].fields.details, /outcome=completed/);

    calls.length = 0;
    await runAudited(report, { keyId: null, dryRun: false, restore: false, audit }, async () => {});
    assert.equal(calls.length, 0);
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
      new URL("../../bin/memento.js", import.meta.url).pathname,
      "utf8"
    );
    assert.ok(src.includes("export:"), "COMMANDS에 export가 등록돼야 함");
    assert.ok(src.includes("import:"), "COMMANDS에 import가 등록돼야 함");
    assert.ok(src.includes("lib/cli/export.js"), "export.js 경로가 포함돼야 함");
    assert.ok(src.includes("lib/cli/import.js"), "import.js 경로가 포함돼야 함");
  });

  it("export/import가 LOCAL_ONLY_COMMANDS에 포함됨", async () => {
    const src = fs.readFileSync(
      new URL("../../bin/memento.js", import.meta.url).pathname,
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
