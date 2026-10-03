/**
 * 감사 기록의 행위자 표기와 관리 인증 실패 처리 시험.
 * 실제 logAudit, handleToolsCall, handleAdminApi를 호출하고 MemoryManager, ApiKeyStore, 감사 이벤트 기록기
 * (audit-outbox.recordAudit)만 대체한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */
import { describe, it, before, after, beforeEach, mock } from "node:test";
import assert                                            from "node:assert/strict";
import http                                              from "node:http";
import fs                                                from "node:fs";
import os                                                from "node:os";
import path                                              from "node:path";

const LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "memento-audit-"));
process.env.LOG_DIR                   = LOG_DIR;
process.env.DOTENV_CONFIG_PATH      ??= ".env.test";
process.env.MEMENTO_METRICS_DEFAULT ??= "off";
process.env.REDIS_ENABLED           ??= "false";
process.env.CACHE_ENABLED           ??= "false";

const KEY_ID = "7a1e0000-0000-4000-8000-000000000001";
const SID    = "e9509944-0482-4e7e-9a69-78cfb07b2f5a";

/** 감사 이벤트 기록기가 받은 이벤트 */
const auditEvents = [];
mock.module("../../lib/logging/audit-outbox.js", {
  exports: { recordAudit: async (event) => { auditEvents.push(event); return null; }, enqueueAudit: async () => null }
});

const realManager = await import("../../lib/memory/MemoryManager.js");
mock.module("../../lib/memory/MemoryManager.js", {
  namedExports: { ...realManager, MemoryManager: { getInstance: () => ({ forget: async () => ({ deleted: 0 }) }) } }
});
const realKeys = await import("../../lib/admin/ApiKeyStore.js");
mock.module("../../lib/admin/ApiKeyStore.js", {
  namedExports: { ...realKeys, updateApiKeyStatus: async (id, status) => ({ id, name: "k", status }) }
});

const { handleToolsCall }              = await import("../../lib/jsonrpc.js");
const { handleAdminApi }               = await import("../../lib/admin/admin-routes.js");
const { ADMIN_BASE }                   = await import("../../lib/admin/admin-auth.js");
const { _resetAdminAuthGuardForTest }  = await import("../../lib/admin/admin-login-guard.js");
const { ACCESS_KEY }                   = await import("../../lib/config.js");

let server;
let base;

before(async () => {
  server = http.createServer((req, res) => handleAdminApi(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}${ADMIN_BASE}`;
});

after(async () => {
  delete process.env.MEMENTO_ADMIN_AUTH_BACKOFF;
  /** 마지막 요청이 남긴 비동기 기록이 끝난 뒤 디렉터리를 지운다 */
  await new Promise((r) => setTimeout(r, 100));
  fs.rmSync(LOG_DIR, { recursive: true, force: true });
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  delete process.env.MEMENTO_ADMIN_AUTH_BACKOFF;
  _resetAdminAuthGuardForTest();
  auditEvents.length = 0;
  for (const f of fs.readdirSync(LOG_DIR)) fs.rmSync(path.join(LOG_DIR, f));
});

function auditLines() {
  return fs.readdirSync(LOG_DIR)
    .filter((f) => f.startsWith("audit-"))
    .flatMap((f) => fs.readFileSync(path.join(LOG_DIR, f), "utf8").split("\n").filter(Boolean));
}

/** finish 이벤트 뒤 비동기 기록이 끝나기를 기다린다 */
async function settle(needle = "") {
  for (let i = 0; i < 50 && !auditLines().some((l) => l.includes(needle)); i++) await new Promise((r) => setTimeout(r, 10));
}

function loginForm(key) {
  return fetch(`${base}/auth`, {
    method  : "POST",
    headers : { "content-type": "application/x-www-form-urlencoded" },
    body    : new URLSearchParams({ key }),
    redirect: "manual"
  });
}

describe("도구 감사 기록의 행위자", () => {
  it("키, 세션 앞 8자, 클라이언트 주소를 남기고 세션 ID 전체는 남기지 않는다", async () => {
    await handleToolsCall({ name: "forget", arguments: { id: "frag-0000000000000000" } }, {
      authenticated: true, isMaster: false, keyId: KEY_ID, groupKeyIds: [KEY_ID], permissions: ["read", "write"],
      defaultWorkspace: null, mode: null, sessionId: SID, clientIp: "203.0.113.7"
    });
    const line = auditLines().find((l) => l.includes("| forget |"));
    assert.ok(line, "forget 감사 줄이 있어야 한다");
    assert.match(line, new RegExp(`key=${KEY_ID}; sid=e9509944; ip=203\\.0\\.113\\.7`));
    assert.doesNotMatch(line, new RegExp(SID));
  });

  it("클라이언트가 보낸 _auditActor는 서버 값으로 덮인다", async () => {
    await handleToolsCall({ name: "forget", arguments: { id: "frag-0000000000000000", _auditActor: { keyId: "forged" } } }, {
      authenticated: true, isMaster: true, keyId: null, groupKeyIds: null, permissions: null,
      defaultWorkspace: null, mode: null, sessionId: null, clientIp: "198.51.100.1"
    });
    const line = auditLines().find((l) => l.includes("| forget |"));
    assert.match(line, /key=master; ip=198\.51\.100\.1/);
    assert.doesNotMatch(line, /forged/);
  });
});

describe("관리 감사와 인증 실패", () => {
  it("관리 로그인 실패를 감사 기록에 남긴다(시도한 값은 남기지 않는다)", async () => {
    const res = await loginForm("wrong-key-value");
    assert.equal(res.status, 302);
    await settle();
    const line = auditLines().find((l) => l.includes("| admin_auth |"));
    assert.match(line, /\| FAIL \| channel=form; key=unknown; ip=/);
    assert.doesNotMatch(line, /wrong-key-value/);
  });

  it("관리 키 상태 변경을 행위자와 함께 남긴다", async () => {
    const res = await fetch(`${base}/keys/${KEY_ID}`, {
      method : "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${ACCESS_KEY}` },
      body   : JSON.stringify({ status: "inactive" })
    });
    assert.equal(res.status, 200);
    await settle();
    const line = auditLines().find((l) => l.includes("admin PUT /keys/7a1e0000 "));
    assert.match(line, /\| OK \| status=200; key=master; sid=bearer; ip=/);
    assert.doesNotMatch(line, new RegExp(KEY_ID));
    assert.doesNotMatch(line, new RegExp(ACCESS_KEY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("읽기 전용 요청은 감사 기록을 만들지 않는다", async () => {
    const res = await fetch(`${base}/keys`, { headers: { authorization: `Bearer ${ACCESS_KEY}` } }).catch(() => null);
    assert.ok(res);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(auditLines().filter((l) => l.includes("admin GET")).length, 0);
  });

  it("MEMENTO_ADMIN_AUTH_BACKOFF=on이면 연속 실패 뒤 올바른 키도 지연 시간 동안 429를 받는다", async () => {
    process.env.MEMENTO_ADMIN_AUTH_BACKOFF = "on";
    for (let i = 0; i < 6; i++) await loginForm(`wrong-${i}`);
    const blocked = await loginForm(ACCESS_KEY);
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get("retry-after")) >= 1);
  });

  it("MEMENTO_ADMIN_AUTH_BACKOFF=on이면 Bearer 경로도 지연 시간 동안 올바른 키를 거절한다", async () => {
    process.env.MEMENTO_ADMIN_AUTH_BACKOFF = "on";
    for (let i = 0; i < 6; i++) {
      await fetch(`${base}/keys`, { headers: { authorization: `Bearer wrong-${i}` } });
    }
    const blocked = await fetch(`${base}/keys`, { headers: { authorization: `Bearer ${ACCESS_KEY}` } });
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get("retry-after")) >= 1);
  });

  it("Bearer 로그인 성공을 감사 기록에 남긴다", async () => {
    const res = await fetch(`${base}/auth`, { method: "POST", headers: { authorization: `Bearer ${ACCESS_KEY}` } });
    assert.equal(res.status, 200);
    await settle("| OK | channel=bearer");
    const line = auditLines().find((l) => l.includes("| admin_auth |") && l.includes("| OK |"));
    assert.match(line, /\| OK \| channel=bearer; key=master; ip=/);
  });

  it("기본(off)은 연속 실패 뒤에도 올바른 키로 로그인한다", async () => {
    for (let i = 0; i < 6; i++) await loginForm(`wrong-${i}`);
    const ok = await loginForm(ACCESS_KEY);
    assert.equal(ok.status, 302);
    assert.equal(ok.headers.get("location"), ADMIN_BASE);
  });
});

describe("관리 감사 기록의 경로 표기", () => {
  const FULL_SID = "e9509944-0482-4e7e-9a69-78cfb07b2f5a";

  it("경로의 세션 ID 전체는 앞 8자로 줄여 남긴다", async () => {
    await fetch(`${base}/sessions/${FULL_SID}`, { method: "DELETE", headers: { authorization: `Bearer ${ACCESS_KEY}` } });
    await settle("admin DELETE /sessions/");
    const line = auditLines().find((l) => l.includes("admin DELETE /sessions/"));
    assert.ok(line);
    assert.match(line, /admin DELETE \/sessions\/e9509944 \|/);
    assert.doesNotMatch(line, new RegExp(FULL_SID));
  });

  it("경로의 구분자 문자는 일곱 열 형식을 깨지 않는다", async () => {
    await new Promise((resolve, reject) => {
      const req = http.request(`${base}/x|y;z`, { method: "DELETE", headers: { authorization: `Bearer ${ACCESS_KEY}` } },
        (res) => { res.resume(); res.on("end", resolve); });
      req.on("error", reject);
      req.end();
    });
    await settle("admin DELETE /x");
    const line = auditLines().find((l) => l.includes("admin DELETE /x"));
    assert.ok(line);
    assert.equal(line.split(" | ").length, 7);
    assert.equal(line.split("|").length, 7);
  });
});

describe("관리 감사 이벤트", () => {
  /** finish 이벤트 뒤 감사 이벤트가 기록되기를 기다린다 */
  async function eventFor(action) {
    for (let i = 0; i < 50 && !auditEvents.some((e) => e.action === action); i++) await new Promise((r) => setTimeout(r, 10));
    return auditEvents.find((e) => e.action === action);
  }

  it("관리 로그인 실패는 시도한 값 없이 admin.auth denied로 남는다", async () => {
    await loginForm("wrong-key-value");
    const event = await eventFor("admin.auth");
    assert.equal(event.outcome, "denied");
    assert.equal(event.actor.keyId, "unknown");
    assert.doesNotMatch(JSON.stringify(event), /wrong-key-value/);
  });

  it("키 상태 변경은 선언된 행위, 대상 키, 이후 상태, 마스터 행위자로 남는다", async () => {
    const res = await fetch(`${base}/keys/${KEY_ID}`, {
      method : "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${ACCESS_KEY}` },
      body   : JSON.stringify({ status: "inactive" })
    });
    assert.equal(res.status, 200);
    const event = await eventFor("admin.key.status_update");
    assert.equal(event.outcome, "success");
    assert.deepEqual(event.target, { type: "api_key", id: KEY_ID });
    assert.deepEqual(event.detail.after, { status: "inactive" });
    assert.equal(event.detail.status, 200);
    assert.equal(event.actor.keyId, "master");
    assert.doesNotMatch(JSON.stringify(event), new RegExp(ACCESS_KEY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("세션 종료의 대상은 세션 id 앞 8자다", async () => {
    await fetch(`${base}/sessions/${SID}`, { method: "DELETE", headers: { authorization: `Bearer ${ACCESS_KEY}` } });
    const event = await eventFor("admin.session.close");
    assert.deepEqual(event.target, { type: "session", id: SID.slice(0, 8) });
    assert.doesNotMatch(JSON.stringify(event), new RegExp(SID));
  });

  it("읽기 전용 요청은 감사 이벤트를 만들지 않는다", async () => {
    await fetch(`${base}/keys`, { headers: { authorization: `Bearer ${ACCESS_KEY}` } });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(auditEvents.filter((e) => e.action.startsWith("admin.") && e.action !== "admin.auth").length, 0);
  });

  it("도구 forget은 서버가 확인한 행위자로 memory.forget을 남긴다", async () => {
    await handleToolsCall({ name: "forget", arguments: { id: "frag-0000000000000000" } }, {
      authenticated: true, isMaster: false, keyId: KEY_ID, groupKeyIds: [KEY_ID], permissions: ["read", "write"],
      defaultWorkspace: null, mode: null, sessionId: SID, clientIp: "203.0.113.7"
    });
    const event = await eventFor("memory.forget");
    assert.equal(event.actor.keyId, KEY_ID);
    assert.deepEqual(event.target, { type: "fragment", id: "frag-0000000000000000" });
  });
});

