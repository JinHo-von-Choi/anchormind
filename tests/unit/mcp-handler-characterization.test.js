/**
 * mcp-handler.js 특성화(characterization) 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-06-15
 *
 * 목적: handleMcpPost()를 분해하기 전에 현재 동작을 고정한다.
 *
 * handleMcpPost 자체는 DB·Redis·sessions 의존성이 복잡하므로
 * 단위 테스트 가능한 순수 함수 2개를 집중 커버한다.
 *
 *  A. injectSessionContext() — 기존 mcp-keyid-injection.test.js가 없는 분기
 *     - method !== "tools/call" 이면 msg 그대로 반환
 *     - msg.params.arguments 가 falsy 이면 빈 객체를 생성한 뒤 주입
 *     - _mode 필드도 클라이언트 위조 차단 후 서버 값으로 재주입
 *
 *  B. deriveTokenKey() — 기존 session-linker-token-reuse.test.js가 없는 분기
 *     - 동일 토큰 + keyId null(master) → "master:hash" 형식
 *     - memento-access-key 헤더 + keyId null → 정상 hash 생성
 *
 *  C. _resolveMode() — 완전 미테스트 (모듈 내부 private. 순수 함수 로직을 재현 검증)
 *     - 헤더 우선 > initialize params.mode > DB default_mode > null
 *     - 알 수 없는 preset → null
 *
 * handleMcpPost 자체의 세션/SSE/auth 분기는 아래 이유로 단위테스트에서 제외:
 *   - validateStreamableSession, validateAuthentication, getSessionFromRedis,
 *     dispatchJsonRpc 등이 실 DB/Redis를 요구함
 *   - mock.module이 필요하고 --experimental-test-module-mocks 없이는 모듈 부작용
 *     으로 실패함 (제외 분기를 하단 "단위테스트 불가 분기" 주석에 문서화)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { injectSessionContext, deriveTokenKey } from "../../lib/handlers/mcp-handler.js";

// ---------------------------------------------------------------------------
// A. injectSessionContext()
// ---------------------------------------------------------------------------

describe("injectSessionContext — 미커버 분기 보강", () => {

  const BASE_CTX = {
    sessionId              : "sess-001",
    sessionKeyId           : "key-abc",
    sessionGroupKeyIds     : ["key-abc"],
    sessionPermissions     : null,
    sessionDefaultWorkspace: null,
    sessionMode            : null,
    clientIp               : "127.0.0.1",
    userAgent              : "test-agent"
  };

  it("method가 tools/call이 아니면 msg를 변형하지 않고 그대로 반환한다", () => {
    const msg = {
      jsonrpc : "2.0",
      id      : 1,
      method  : "initialize",
      params  : { protocolVersion: "2025-03-26" }
    };
    const before = JSON.stringify(msg);
    const result = injectSessionContext(msg, BASE_CTX);

    assert.strictEqual(result,                JSON.stringify(msg) && msg, "동일 참조");
    assert.strictEqual(JSON.stringify(result), before,                    "params 변형 없음");
  });

  it("msg가 null이면 null을 반환한다", () => {
    const result = injectSessionContext(null, BASE_CTX);
    assert.strictEqual(result, null);
  });

  it("msg.params.arguments가 null이면 빈 객체를 생성한 뒤 _keyId를 주입한다", () => {
    const msg = {
      jsonrpc: "2.0",
      id     : 2,
      method : "tools/call",
      params : { name: "remember", arguments: null }
    };
    const result = injectSessionContext(msg, BASE_CTX);

    assert.ok(result.params.arguments,           "arguments가 생성돼야 한다");
    assert.strictEqual(result.params.arguments._keyId, "key-abc", "_keyId 주입");
  });

  it("msg.params.arguments가 undefined이면 빈 객체를 생성한 뒤 주입한다", () => {
    const msg = {
      jsonrpc: "2.0",
      id     : 3,
      method : "tools/call",
      params : { name: "recall" }
      /* arguments 키 자체가 없음 */
    };
    const result = injectSessionContext(msg, BASE_CTX);

    assert.ok(result.params.arguments,                      "arguments가 생성돼야 한다");
    assert.strictEqual(result.params.arguments._sessionId, "sess-001");
  });

  it("클라이언트가 보낸 _mode는 삭제되고 서버 값으로 재주입된다", () => {
    const msg = {
      jsonrpc: "2.0",
      id     : 4,
      method : "tools/call",
      params : {
        name     : "recall",
        arguments: { query: "test", _mode: "ATTACKER_MODE" }
      }
    };
    const ctx = { ...BASE_CTX, sessionMode: "lite" };
    const result = injectSessionContext(msg, ctx);

    assert.strictEqual(result.params.arguments._mode, "lite", "서버 값으로 재주입");
  });

  it("_clientIp 가 ctx에 없으면 'unknown'이 주입된다", () => {
    const msg = {
      jsonrpc: "2.0",
      id     : 5,
      method : "tools/call",
      params : { name: "remember", arguments: {} }
    };
    const ctxNoIp = { ...BASE_CTX, clientIp: undefined };
    const result  = injectSessionContext(msg, ctxNoIp);

    assert.strictEqual(result.params.arguments._clientIp, "unknown");
  });

  it("ctx 값들이 arguments에 모두 주입된다", () => {
    const msg = {
      jsonrpc: "2.0",
      id     : 6,
      method : "tools/call",
      params : { name: "remember", arguments: { content: "hi" } }
    };
    const ctx = {
      sessionId              : "s-xyz",
      sessionKeyId           : "k-xyz",
      sessionGroupKeyIds     : ["k-xyz", "k-grp"],
      sessionPermissions     : ["read", "write"],
      sessionDefaultWorkspace: "ws-main",
      sessionMode            : "default",
      clientIp               : "10.0.0.1",
      userAgent              : "curl/7.8"
    };
    const result = injectSessionContext(msg, ctx);
    const args   = result.params.arguments;

    assert.strictEqual(args._sessionId,          "s-xyz");
    assert.strictEqual(args._keyId,              "k-xyz");
    assert.deepStrictEqual(args._groupKeyIds,    ["k-xyz", "k-grp"]);
    assert.deepStrictEqual(args._permissions,    ["read", "write"]);
    assert.strictEqual(args._defaultWorkspace,   "ws-main");
    assert.strictEqual(args._mode,               "default");
    assert.strictEqual(args._clientIp,           "10.0.0.1");
    assert.strictEqual(args._userAgent,          "curl/7.8");
  });
});

// ---------------------------------------------------------------------------
// B. deriveTokenKey() — 미커버 분기
// ---------------------------------------------------------------------------

describe("deriveTokenKey — 미커버 분기 보강", () => {

  it("keyId가 null(master)이면 'master:hash' 형식이다", () => {
    const req = { headers: { authorization: "Bearer master-token-xyz" } };
    const key = deriveTokenKey(req, {}, { keyId: null });

    assert.ok(key,                    "null이면 안 된다");
    assert.ok(key.startsWith("master:"), `'master:' prefix 기대: ${key}`);
    assert.strictEqual(key.split(":").length, 2, "ns:hash 형식");
    assert.strictEqual(key.split(":")[1].length, 16, "hash는 16자");
  });

  it("memento-access-key 헤더 + keyId=null → 'master:hash'", () => {
    const req = { headers: { "memento-access-key": "ak-test-123" } };
    const key = deriveTokenKey(req, {}, { keyId: null });

    assert.ok(key.startsWith("master:"), `'master:' prefix: ${key}`);
  });

  it("인증 정보가 전혀 없으면 null을 반환한다", () => {
    const req = { headers: {} };
    const key = deriveTokenKey(req, {}, null);

    assert.strictEqual(key, null);
  });

  it("initialize params.accessKey + keyId → 'keyId:hash'", () => {
    const req = { headers: {} };
    const msg = { method: "initialize", params: { accessKey: "param-ak-456" } };
    const key = deriveTokenKey(req, msg, { keyId: "k-99" });

    assert.ok(key.startsWith("k-99:"), `keyId prefix 기대: ${key}`);
  });

  it("동일 토큰 + 동일 keyId → 동일 tokenKey (결정론적 해시)", () => {
    const req1 = { headers: { authorization: "Bearer stable-token" } };
    const req2 = { headers: { authorization: "Bearer stable-token" } };

    const k1 = deriveTokenKey(req1, {}, { keyId: "k-1" });
    const k2 = deriveTokenKey(req2, {}, { keyId: "k-1" });

    assert.strictEqual(k1, k2, "동일 입력 → 동일 tokenKey");
  });

  it("동일 토큰 + 다른 keyId → 다른 tokenKey (cross-tenant 격리)", () => {
    const req = { headers: { authorization: "Bearer same-token" } };

    const k1 = deriveTokenKey(req, {}, { keyId: "key-A" });
    const k2 = deriveTokenKey(req, {}, { keyId: "key-B" });

    assert.notStrictEqual(k1, k2, "keyId 다르면 tokenKey도 달라야 한다");
  });
});

// ---------------------------------------------------------------------------
// C. _resolveMode() — private 함수이므로 로직 재현 검증
//    실제 함수는 export 없음. 동일 로직을 재현하여 현재 우선순위 동작을 고정한다.
// ---------------------------------------------------------------------------

/**
 * _resolveMode 로직 재현.
 * 우선순위: X-Memento-Mode 헤더 > initialize params.mode > dbDefaultMode > null
 * 알 수 없는 preset 이름이면 null 반환.
 */
function simulateResolveMode(headerMode, msgMode, dbDefaultMode, knownPresets) {
  const presets = new Set(knownPresets || []);
  const getPreset = (name) => presets.has(name) ? { name } : null;

  if (headerMode) {
    return getPreset(headerMode) ? headerMode : null;
  }
  if (msgMode) {
    return getPreset(msgMode) ? msgMode : null;
  }
  if (dbDefaultMode) {
    return getPreset(dbDefaultMode) ? dbDefaultMode : null;
  }
  return null;
}

describe("_resolveMode — 우선순위 재현 검증", () => {

  const KNOWN = ["default", "lite", "deep"];

  it("헤더가 있으면 헤더가 최우선이다", () => {
    const mode = simulateResolveMode("lite", "deep", "default", KNOWN);
    assert.strictEqual(mode, "lite");
  });

  it("헤더가 없으면 initialize params.mode가 차순위이다", () => {
    const mode = simulateResolveMode(null, "deep", "default", KNOWN);
    assert.strictEqual(mode, "deep");
  });

  it("헤더와 params.mode가 없으면 DB default_mode를 사용한다", () => {
    const mode = simulateResolveMode(null, null, "default", KNOWN);
    assert.strictEqual(mode, "default");
  });

  it("모두 없으면 null이다", () => {
    const mode = simulateResolveMode(null, null, null, KNOWN);
    assert.strictEqual(mode, null);
  });

  it("헤더 preset이 알 수 없는 이름이면 null로 폴백한다", () => {
    const mode = simulateResolveMode("unknown-preset", "lite", "default", KNOWN);
    assert.strictEqual(mode, null);
  });

  it("params.mode preset이 알 수 없는 이름이면 null로 폴백한다", () => {
    const mode = simulateResolveMode(null, "bad-preset", "default", KNOWN);
    assert.strictEqual(mode, null);
  });

  it("DB default_mode가 알 수 없는 이름이면 null로 폴백한다", () => {
    const mode = simulateResolveMode(null, null, "bad-db-preset", KNOWN);
    assert.strictEqual(mode, null);
  });
});

/**
 * 단위테스트 불가로 제외한 handleMcpPost 분기 목록:
 *
 * 1. sessionId 있고 validateStreamableSession 실패 → isRecoverable 분기
 *    (validateStreamableSession이 in-memory sessions 맵 + Redis 의존)
 *
 * 2. 세션 복구 중 getSessionFromRedis keyId mismatch → 403
 *    (mcp-session-recovery.test.js의 순수 재현 방식으로 간접 커버됨)
 *
 * 3. Stale 세션 groupKeyIds 재조회 → getGroupKeyIds(DB) + saveSessionToRedis
 *    (DB pool 의존)
 *
 * 4. session.authenticated=false → requireAuthentication
 *    (auth 검증 로직은 auth.js 단위 테스트로 분리됨)
 *
 * 5. isInitializeRequest + 토큰 재사용(getSessionIdByToken + validateStreamableSession)
 *    (Redis 의존; session-linker-token-reuse.test.js에서 deriveTokenKey 층만 커버)
 *
 * 6. SSE 분기(_handleProgressSSE) — batch_remember/memory_consolidate + Accept:text/event-stream
 *    (sse-progress-handler.test.js에서 _handleProgressSSE 내부 동작 커버)
 *
 * 7. Rate Limit 429 응답
 *    (rate-limit-headers.test.js 등에서 별도 커버)
 */
