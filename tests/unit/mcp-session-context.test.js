/**
 * MCP 핸들러 세션 값 주입과 토큰 키 도출 단위 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-09-30
 *
 * DB, Redis, 세션 저장소에 닿지 않는 순수 함수 두 개의 분기를 단언한다.
 *
 *  A. injectSessionContext
 *     - method가 tools/call이 아니면 메시지를 그대로 돌려준다
 *     - arguments가 없으면 빈 객체를 만든 뒤 주입한다
 *     - 클라이언트가 보낸 _mode는 버리고 서버 값으로 다시 넣는다
 *  B. deriveTokenKey
 *     - master는 "master:hash", 키 소유자는 "keyId:hash" 형식이다
 *     - 같은 토큰이라도 keyId가 다르면 토큰 키가 다르다
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { injectSessionContext, deriveTokenKey } from "../../lib/handlers/mcp-handler.js";

describe("injectSessionContext 세션 값 주입", () => {

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
        arguments: { query: "test", _mode: "forged-mode" }
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
// B. deriveTokenKey
// ---------------------------------------------------------------------------

describe("deriveTokenKey 토큰 키 도출", () => {

  it("keyId가 null(master)이면 'master:hash' 형식이다", () => {
    const req = { headers: { authorization: "Bearer master-token-xyz" } };
    const key = deriveTokenKey(req, {}, { keyId: null, isMaster: true });

    assert.ok(key,                    "null이면 안 된다");
    assert.ok(key.startsWith("master:"), `'master:' prefix 기대: ${key}`);
    assert.strictEqual(key.split(":").length, 2, "ns:hash 형식");
    assert.strictEqual(key.split(":")[1].length, 16, "hash는 16자");
  });

  it("memento-access-key 헤더 + keyId=null → 'master:hash'", () => {
    const req = { headers: { "memento-access-key": "ak-test-123" } };
    const key = deriveTokenKey(req, {}, { keyId: null, isMaster: true });

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
