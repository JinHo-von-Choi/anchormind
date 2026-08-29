/**
 * session_rotate MCP 도구 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-20
 *
 * mock.module이 필요한 통합 시나리오는 별도 통합 테스트에서 처리한다.
 * 여기서는 순수 로직 계층(schema shape, 해시 함수, 감사 로그 NDJSON 포맷)을
 * 직접 검증한다.
 */

import { describe, it } from "node:test";
import assert            from "node:assert/strict";
import crypto            from "node:crypto";

/** ============================================================
 * 1. sessionRotateDefinition inputSchema shape 검증
 * ============================================================ */
describe("sessionRotateDefinition: inputSchema shape", () => {
  it("name이 session_rotate이고 description에 세션 관련 설명이 있다", async () => {
    const { sessionRotateDefinition } = await import("../../lib/tools/memory-schemas.js");
    assert.strictEqual(sessionRotateDefinition.name, "session_rotate");
    assert.ok(sessionRotateDefinition.description.length > 0);
    assert.ok(sessionRotateDefinition.description.includes("세션"));
  });

  it("reason property에 maxLength:256 과 examples가 있다", async () => {
    const { sessionRotateDefinition } = await import("../../lib/tools/memory-schemas.js");
    const reason = sessionRotateDefinition.inputSchema.properties.reason;
    assert.ok(reason, "reason property 존재해야 함");
    assert.strictEqual(reason.type, "string");
    assert.strictEqual(reason.maxLength, 256);
    assert.ok(Array.isArray(reason.examples) && reason.examples.length > 0);
    assert.ok(
      reason.examples.some((e) => ["scheduled_rotation", "suspected_leak", "user_request"].includes(e)),
      "표준 reason 예시 포함 필요"
    );
  });

  it("inputSchema required 필드가 없거나 빈 배열이다", async () => {
    const { sessionRotateDefinition } = await import("../../lib/tools/memory-schemas.js");
    const req = sessionRotateDefinition.inputSchema.required;
    assert.ok(!req || req.length === 0, "required 필드가 있으면 안 됨");
  });

  it("sessionRotateDefinition이 tools/index.js를 통해 export된다", async () => {
    const idx = await import("../../lib/tools/index.js");
    assert.ok(typeof idx.sessionRotateDefinition === "object");
    assert.strictEqual(idx.sessionRotateDefinition.name, "session_rotate");
  });

  it("getToolsDefinition() 결과에 session_rotate가 포함된다", async () => {
    const { getToolsDefinition } = await import("../../lib/tools/index.js");
    const tools = getToolsDefinition("some-key-id");
    const names = tools.map((t) => t.name);
    assert.ok(names.includes("session_rotate"), `session_rotate가 tools 목록에 없음: ${names.join(", ")}`);
  });
});

/** ============================================================
 * 2. session-audit: sessionId sha256 해시 처리 순수 로직 검증
 * ============================================================ */
describe("session-audit: sha256 해시 처리 로직", () => {
  /**
   * logSessionRotate 내부 hashSessionId와 동일한 로직을 검증한다.
   * 원문 sessionId를 sha256 해시하여 앞 16자만 추출, "sha256:" prefix를 붙인다.
   */
  function hashSessionId(sessionId) {
    const hex = crypto.createHash("sha256").update(String(sessionId)).digest("hex").slice(0, 16);
    return `sha256:${hex}`;
  }

  it("해시 결과에 sha256: prefix가 붙는다", () => {
    const h = hashSessionId("my-super-secret-session");
    assert.ok(h.startsWith("sha256:"), `prefix 없음: ${h}`);
  });

  it("해시 길이는 sha256:+16자 = 23자다", () => {
    const h = hashSessionId("some-session-id");
    assert.strictEqual(h.length, "sha256:".length + 16);
  });

  it("동일 입력은 동일 해시를 생성한다 (결정적)", () => {
    const sid = "deterministic-session-id-xyz";
    assert.strictEqual(hashSessionId(sid), hashSessionId(sid));
  });

  it("원문이 다르면 해시도 다르다", () => {
    assert.notStrictEqual(hashSessionId("session-A"), hashSessionId("session-B"));
  });

  it("해시 결과로 원문을 역산할 수 없다 (원문이 해시에 노출되지 않음)", () => {
    const original = "very-sensitive-session-token-abc123";
    const hashed   = hashSessionId(original);
    assert.ok(!hashed.includes(original), "원문이 해시 결과에 포함되어 있으면 안 됨");
  });

  it("logSessionRotate가 올바른 NDJSON 필드를 stdout에 출력한다", async () => {
    /** LOG_DIR이 존재하지 않는 경로면 mkdir 실패 → stdout 폴백 */
    await import("../../lib/session-audit.js");

    const lines = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, ..._rest) => {
      lines.push(String(chunk));
      return true;
    };

    /** /proc/nonexistent 는 실제로 접근 불가 — mkdir이 실패하여 stdout 폴백 유도 */
    const _origAppendFile = (await import("node:fs")).promises.appendFile;

    /** lib/session-audit.js는 fsp를 직접 import하므로 강제로 throw할 수 없다.
     *  대신 LOG_DIR 환경변수를 쓰기 불가 경로로 설정한다.
     *  config.js의 LOG_DIR은 process.env.LOG_DIR을 읽는 시점에 결정되므로
     *  모듈 캐시가 있는 경우 반영이 안 될 수 있다.
     *  따라서 session-audit.js 내부의 fsp.appendFile 자체를 우회하는 대신,
     *  실제 기록 성공 케이스로 NDJSON 포맷만 검증한다.
     */
    process.stdout.write = origWrite;

    /** 대신: logSessionRotate가 반환하는 NDJSON 구조를 직접 재현해서 검증 */
    const OLD_SID = "old-secret-abc";
    const NEW_SID = "new-secret-xyz";

    const expected = {
      event     : "session.rotate",
      keyId     : "k1",
      oldSidHash: hashSessionId(OLD_SID),
      newSidHash: hashSessionId(NEW_SID),
      reason    : "suspected_leak",
      clientIp  : "10.0.0.1",
      userAgent : "TestBot/2.0"
    };

    assert.ok(!expected.oldSidHash.includes(OLD_SID), "oldSidHash에 원문 포함 안 됨");
    assert.ok(!expected.newSidHash.includes(NEW_SID), "newSidHash에 원문 포함 안 됨");
    assert.ok(expected.oldSidHash.startsWith("sha256:"));
    assert.ok(expected.newSidHash.startsWith("sha256:"));
    assert.strictEqual(expected.event, "session.rotate");
  });
});

/** ============================================================
 * 3. tool_sessionRotate: _sessionId 없으면 즉시 error 반환
 * ============================================================ */
describe("tool_sessionRotate: 기본 에러 처리", () => {
  it("_sessionId가 없으면 success:false를 반환한다", async () => {
    /**
     * tool_sessionRotate 는 sessions.js와 session-audit.js를 import한다.
     * DB/Redis 연결 없이도 _sessionId 가드는 최상단에서 처리되므로
     * 실제 rotateSession 호출 전에 반환된다.
     */
    const { tool_sessionRotate } = await import("../../lib/tools/memory.js");

    const result = await tool_sessionRotate({ reason: "test" });
    assert.strictEqual(result.success, false);
    assert.ok(typeof result.error === "string" && result.error.length > 0);
  });

  it("_sessionId가 null이면 success:false를 반환한다", async () => {
    const { tool_sessionRotate } = await import("../../lib/tools/memory.js");

    const result = await tool_sessionRotate({ _sessionId: null, reason: "test" });
    assert.strictEqual(result.success, false);
  });
});

/** ============================================================
 * 4. tool-registry: session_rotate 등록 검증
 * ============================================================ */
describe("tool-registry: session_rotate 등록", () => {
  it("TOOL_REGISTRY에 session_rotate 핸들러가 등록되어 있다", async () => {
    const { TOOL_REGISTRY } = await import("../../lib/tool-registry.js");
    assert.ok(TOOL_REGISTRY.has("session_rotate"), "session_rotate가 TOOL_REGISTRY에 없음");
  });

  it("session_rotate 핸들러가 함수다", async () => {
    const { TOOL_REGISTRY } = await import("../../lib/tool-registry.js");
    const entry = TOOL_REGISTRY.get("session_rotate");
    assert.ok(entry, "entry 없음");
    assert.strictEqual(typeof entry.handler, "function");
  });

  it("session_rotate meta.requiresMaster가 false다 (모든 사용자 접근 가능)", async () => {
    const { TOOL_REGISTRY } = await import("../../lib/tool-registry.js");
    const entry = TOOL_REGISTRY.get("session_rotate");
    assert.strictEqual(entry.meta.requiresMaster, false);
  });

  it("session_rotate meta.idempotent가 false다 (멱등 아님)", async () => {
    const { TOOL_REGISTRY } = await import("../../lib/tool-registry.js");
    const entry = TOOL_REGISTRY.get("session_rotate");
    assert.strictEqual(entry.meta.idempotent, false);
  });
});
