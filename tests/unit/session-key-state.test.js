/**
 * 세션 사용 시 API 키 상태 재확인 시험.
 * 실제 handleMcpPost와 관리 키 라우트를 호출하고 ApiKeyStore 저장소 함수만 대체한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */
import { describe, it, before, after, beforeEach, mock } from "node:test";
import assert                                            from "node:assert/strict";
import http                                              from "node:http";

process.env.DOTENV_CONFIG_PATH      ??= ".env.test";
process.env.MEMENTO_METRICS_DEFAULT ??= "off";
process.env.REDIS_ENABLED           ??= "false";
process.env.CACHE_ENABLED           ??= "false";

const KEY_ID     = "7a1e0000-0000-4000-8000-000000000001";
const keyStates  = new Map();
const stateCalls = [];
let   lookupFails = false;

const realKeys = await import("../../lib/admin/ApiKeyStore.js");
mock.module("../../lib/admin/ApiKeyStore.js", {
  namedExports: {
    ...realKeys,
    getKeyAuthState   : async (keyId) => { stateCalls.push(keyId); if (lookupFails) throw new Error("db down"); return keyStates.get(keyId) ?? { exists: false, status: null, permissions: null }; },
    getGroupKeyIds    : async (keyId) => [keyId],
    updateApiKeyStatus: async (id, status) => { keyStates.set(id, { exists: true, status, permissions: ["read"] }); return { id, name: "k", status }; },
    deleteApiKey      : async (id) => { keyStates.delete(id); }
  }
});

const { handleMcpPost }                                = await import("../../lib/handlers/mcp-handler.js");
const { handleKeys }                                   = await import("../../lib/admin/admin-keys.js");
const { createStreamableSession, streamableSessions }  = await import("../../lib/sessions.js");
const { invalidateKeyState }                           = await import("../../lib/admin/key-state-cache.js");
const { ADMIN_BASE }                                   = await import("../../lib/admin/admin-auth.js");

const allowAll = { allow: () => true };
let server;
let base;

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith(ADMIN_BASE)) return handleKeys(req, res, url);
    return handleMcpPost(req, res, process.hrtime.bigint(), allowAll);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

beforeEach(() => {
  delete process.env.MEMENTO_SESSION_KEY_RECHECK_MS;
  invalidateKeyState(KEY_ID);
  stateCalls.length = 0;
  lookupFails       = false;
  keyStates.set(KEY_ID, { exists: true, status: "active", permissions: ["read"] });
});

async function openSession() {
  return createStreamableSession(true, KEY_ID, [KEY_ID], ["read"], null, null, false);
}

async function listTools(sessionId) {
  const res = await fetch(`${base}/mcp`, {
    method : "POST",
    headers: { "content-type": "application/json", "mcp-session-id": sessionId, "mcp-protocol-version": "2025-06-18" },
    body   : JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
  });
  return { status: res.status, body: await res.json() };
}

describe("세션 사용 시 키 상태 재확인", () => {
  it("활성 키의 세션은 그대로 쓴다", async () => {
    const sid = await openSession();
    const r   = await listTools(sid);
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.result.tools));
  });

  it("비활성 키의 세션은 닫고 404로 응답한다", async () => {
    const sid = await openSession();
    keyStates.set(KEY_ID, { exists: true, status: "inactive", permissions: ["read"] });
    const r = await listTools(sid);
    assert.equal(r.status, 404);
    assert.equal(streamableSessions.has(sid), false);
  });

  it("삭제된 키의 세션은 닫고 404로 응답한다", async () => {
    const sid = await openSession();
    keyStates.delete(KEY_ID);
    assert.equal((await listTools(sid)).status, 404);
  });

  it("주기 안의 반복 사용은 키 상태를 한 번만 조회한다", async () => {
    const sid = await openSession();
    await listTools(sid);
    await listTools(sid);
    await listTools(sid);
    assert.equal(stateCalls.length, 1);
  });

  it("MEMENTO_SESSION_KEY_RECHECK_MS=0이면 재확인하지 않는다", async () => {
    process.env.MEMENTO_SESSION_KEY_RECHECK_MS = "0";
    const sid = await openSession();
    keyStates.set(KEY_ID, { exists: true, status: "inactive", permissions: ["read"] });
    assert.equal((await listTools(sid)).status, 200);
    assert.equal(stateCalls.length, 0);
  });
});

describe("권한 반영과 조회 실패", () => {
  it("권한이 바뀐 키는 열린 세션에 현재 권한을 반영한다", async () => {
    const sid = await openSession();
    keyStates.set(KEY_ID, { exists: true, status: "active", permissions: ["read", "write"] });
    assert.equal((await listTools(sid)).status, 200);
    assert.deepEqual(streamableSessions.get(sid).permissions, ["read", "write"]);
  });

  it("키 상태 조회가 실패하면 저장된 identity로 세션을 유지한다", async () => {
    const sid   = await openSession();
    lookupFails = true;
    assert.equal((await listTools(sid)).status, 200);
    assert.equal(streamableSessions.has(sid), true);
    assert.deepEqual(streamableSessions.get(sid).permissions, ["read"]);
  });
});

describe("관리 키 상태 변경", () => {
  it("비활성화하면 그 키의 열린 세션을 즉시 닫는다", async () => {
    const sid = await openSession();
    const res = await fetch(`${base}${ADMIN_BASE}/keys/${KEY_ID}`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "inactive" })
    });
    assert.equal(res.status, 200);
    assert.equal(streamableSessions.has(sid), false);
  });

  it("삭제하면 그 키의 열린 세션을 즉시 닫는다", async () => {
    const sid = await openSession();
    const res = await fetch(`${base}${ADMIN_BASE}/keys/${KEY_ID}`, { method: "DELETE" });
    assert.equal(res.status, 204);
    assert.equal(streamableSessions.has(sid), false);
  });

  it("다른 키의 세션은 닫지 않는다", async () => {
    const other = await createStreamableSession(true, "7a1e0000-0000-4000-8000-000000000002", null, ["read"], null, null, false);
    await fetch(`${base}${ADMIN_BASE}/keys/${KEY_ID}`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "inactive" })
    });
    assert.equal(streamableSessions.has(other), true);
  });
});
