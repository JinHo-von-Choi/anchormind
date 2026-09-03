/**
 * _keyId 주입 + 클라이언트 위조 방어 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-10
 *
 * 검증 대상:
 *   - arguments가 null/undefined/{}인 모든 케이스에서 _keyId 서버값으로 채워짐
 *   - 클라이언트가 arguments._keyId를 직접 전송해도 서버 인증값으로 덮어씀
 *   - master 키 호출 시 _keyId === null 보장
 *   - _groupKeyIds/_sessionId/_permissions/_defaultWorkspace 동일하게 위조 차단
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { injectSessionContext } from "../../lib/handlers/mcp-handler.js";

describe("injectSessionContext — _keyId 주입 보장", () => {

  const SESSION_CTX = {
    sessionId:        "sess-abc",
    sessionKeyId:     42,
    sessionGroupKeyIds: [10, 20],
    sessionPermissions: ["read", "write"],
    sessionDefaultWorkspace: "ws-main"
  };

  it("arguments가 null인 경우 새 객체 생성 후 _keyId 주입", () => {
    const msg = { method: "tools/call", params: { name: "remember", arguments: null } };
    const result = injectSessionContext(msg, SESSION_CTX);
    assert.strictEqual(result.params.arguments._keyId, 42);
    assert.strictEqual(result.params.arguments._sessionId, "sess-abc");
  });

  it("arguments가 undefined인 경우 새 객체 생성 후 _keyId 주입", () => {
    const msg = { method: "tools/call", params: { name: "remember", arguments: undefined } };
    const result = injectSessionContext(msg, SESSION_CTX);
    assert.strictEqual(result.params.arguments._keyId, 42);
  });

  it("arguments가 빈 객체인 경우 _keyId 주입", () => {
    const msg = { method: "tools/call", params: { name: "remember", arguments: {} } };
    const result = injectSessionContext(msg, SESSION_CTX);
    assert.strictEqual(result.params.arguments._keyId, 42);
  });

  it("master 키 호출 시 _keyId === null 보장", () => {
    const masterCtx = {
      sessionId:        "sess-master",
      sessionKeyId:     null,
      sessionGroupKeyIds: null,
      sessionPermissions: null,
      sessionDefaultWorkspace: null,
      sessionIsMaster: true
    };
    const msg = { method: "tools/call", params: { name: "recall", arguments: {} } };
    const result = injectSessionContext(msg, masterCtx);
    assert.strictEqual(result.params.arguments._keyId, null);
    assert.strictEqual(result.params.arguments._isMaster, true);
  });

});

describe("injectSessionContext — 클라이언트 위조 차단", () => {

  const SERVER_CTX = {
    sessionId:        "sess-server",
    sessionKeyId:     99,
    sessionGroupKeyIds: [1],
    sessionPermissions: ["read"],
    sessionDefaultWorkspace: "ws-real"
  };

  it("클라이언트가 전송한 _keyId='victim_key' 무시하고 서버 keyId로 덮어씀", () => {
    const msg = {
      method: "tools/call",
      params: {
        name:      "remember",
        arguments: { content: "hello", _keyId: "victim_key" }
      }
    };
    const result = injectSessionContext(msg, SERVER_CTX);
    assert.strictEqual(result.params.arguments._keyId, 99);
    assert.notEqual(result.params.arguments._keyId, "victim_key");
  });

  it("클라이언트가 전송한 _groupKeyIds 무시하고 서버값으로 덮어씀", () => {
    const msg = {
      method: "tools/call",
      params: {
        name:      "remember",
        arguments: { content: "hello", _groupKeyIds: [999, 888] }
      }
    };
    const result = injectSessionContext(msg, SERVER_CTX);
    assert.deepEqual(result.params.arguments._groupKeyIds, [1]);
  });

  it("클라이언트가 전송한 _sessionId 무시하고 서버값으로 덮어씀", () => {
    const msg = {
      method: "tools/call",
      params: {
        name:      "remember",
        arguments: { _sessionId: "attacker-session" }
      }
    };
    const result = injectSessionContext(msg, SERVER_CTX);
    assert.strictEqual(result.params.arguments._sessionId, "sess-server");
  });

  it("클라이언트가 전송한 _permissions 무시하고 서버값으로 덮어씀", () => {
    const msg = {
      method: "tools/call",
      params: {
        name:      "remember",
        arguments: { _permissions: ["admin"] }
      }
    };
    const result = injectSessionContext(msg, SERVER_CTX);
    assert.deepEqual(result.params.arguments._permissions, ["read"]);
  });

  it("클라이언트가 전송한 _defaultWorkspace 무시하고 서버값으로 덮어씀", () => {
    const msg = {
      method: "tools/call",
      params: {
        name:      "remember",
        arguments: { _defaultWorkspace: "malicious-workspace" }
      }
    };
    const result = injectSessionContext(msg, SERVER_CTX);
    assert.strictEqual(result.params.arguments._defaultWorkspace, "ws-real");
  });

  it("클라이언트의 _isMaster 위조를 서버 인증값 false로 덮어쓴다", () => {
    const msg = {
      method: "tools/call",
      params: { name: "recall", arguments: { allWorkspaces: true, _isMaster: true } }
    };
    const result = injectSessionContext(msg, { ...SERVER_CTX, sessionIsMaster: false });
    assert.strictEqual(result.params.arguments._isMaster, false);
  });

  it("기존 사용자 인수(content 등)는 보존됨", () => {
    const msg = {
      method: "tools/call",
      params: {
        name:      "remember",
        arguments: { content: "user data", type: "fact", _keyId: "attacker" }
      }
    };
    const result = injectSessionContext(msg, SERVER_CTX);
    assert.strictEqual(result.params.arguments.content, "user data");
    assert.strictEqual(result.params.arguments.type, "fact");
    assert.strictEqual(result.params.arguments._keyId, 99);
  });

});

describe("injectSessionContext — tools/call 외 메서드는 arguments 건드리지 않음", () => {

  it("tools/list 메서드는 arguments 변경 없음", () => {
    const msg = { method: "tools/list", params: {} };
    const ctx = {
      sessionId:        "sess-x",
      sessionKeyId:     5,
      sessionGroupKeyIds: null,
      sessionPermissions: null,
      sessionDefaultWorkspace: null
    };
    const result = injectSessionContext(msg, ctx);
    assert.ok(!result.params.arguments, "tools/list에는 arguments 주입 없어야 함");
  });

});
