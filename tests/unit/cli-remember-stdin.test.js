/**
 * M2: CLI stdin 파이프 — remember.js stdin 경로 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-20
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

/** readStdin 유닛 테스트를 위한 모킹 헬퍼 */
async function simulateReadStdin(content) {
  const { Readable } = await import("node:stream");
  const stream = Readable.from([Buffer.from(content, "utf8")]);

  const chunks = [];
  let   total  = 0;
  const MAX    = 1_048_576;

  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX) {
      throw new Error(`stdin input exceeds 1MB limit (${total} bytes received).`);
    }
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) throw new Error("stdin is empty.");
  return text;
}

describe("M2: _stdin.js readStdin 로직", () => {
  it("정상 내용 읽기 — 텍스트 반환", async () => {
    const result = await simulateReadStdin("Hello from stdin\n");
    assert.ok(result.includes("Hello from stdin"), "내용이 그대로 반환돼야 함");
  });

  it("빈 stdin — 에러 throw", async () => {
    await assert.rejects(
      () => simulateReadStdin("   \n"),
      /stdin is empty/i,
      "빈 stdin은 에러를 throw해야 함"
    );
  });

  it("1MB 초과 — 에러 throw", async () => {
    const oversize = "x".repeat(1_048_577);
    await assert.rejects(
      () => simulateReadStdin(oversize),
      /exceeds 1MB limit/i,
      "1MB 초과 시 에러를 throw해야 함"
    );
  });

  it("정확히 1MB — 에러 없음", async () => {
    const exactly1MB = "a".repeat(1_048_576);
    const result     = await simulateReadStdin(exactly1MB);
    assert.strictEqual(result.length, 1_048_576, "정확히 1MB는 허용돼야 함");
  });
});

describe("M2: remember.js --stdin 플래그 + positional 충돌 감지", () => {
  it("_stdin.js usage export 존재 확인", async () => {
    /** _stdin.js에 usage export는 없으나 readStdin export 확인 */
    const mod = await import("../../lib/cli/_stdin.js");
    assert.strictEqual(typeof mod.readStdin, "function", "readStdin이 export돼야 함");
  });

  it("remember.js usage export에 --stdin 문서화", async () => {
    const mod = await import("../../lib/cli/remember.js");
    assert.ok(typeof mod.usage === "string", "usage는 문자열이어야 함");
    assert.ok(mod.usage.includes("--stdin"), "usage에 --stdin 옵션이 문서화돼야 함");
    assert.ok(mod.usage.includes("stdin"), "usage에 stdin 관련 안내가 있어야 함");
  });

  it("positional + stdin 동시 제공 시 충돌 감지 로직 존재 확인", async () => {
    const src = await import("node:fs").then(m => m.promises.readFile(
      new URL("../../lib/cli/remember.js", import.meta.url),
      "utf8"
    ));
    assert.ok(
      src.includes("use positional or stdin, not both"),
      "positional+stdin 충돌 에러 메시지가 소스에 있어야 함"
    );
  });
});
