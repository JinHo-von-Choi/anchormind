/**
 * master 전용 mode preset 요청 판정 시험(실제 handleMcpPost, 키 조회는 대역)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * master가 아닌 세션이 master 전용 preset(audit)을 X-Memento-Mode 헤더, initialize params.mode, 키
 * default_mode로 요청하면 MEMENTO_WORKSPACE_READ_AUTHZ=enforce에서 세션을 만들지 않고 403과 -32001로
 * 거부한다. warn은 would_deny를 세고 세션을 만든다(preset 무시 유지). off는 판정하지 않는다. master 키와
 * 일반 preset은 모든 방식에서 그대로다. 같은 판정이 세션 자동 복구 경로에도 적용된다.
 */
import { describe, it, before, after, beforeEach, mock } from "node:test";
import assert                                            from "node:assert/strict";
import http                                              from "node:http";

process.env.DOTENV_CONFIG_PATH      ??= ".env.test";
process.env.MEMENTO_METRICS_DEFAULT ??= "off";
process.env.REDIS_ENABLED           ??= "false";
process.env.CACHE_ENABLED           ??= "false";

let keyDefaultMode = null;

const realKeys = await import("../../lib/admin/ApiKeyStore.js");
mock.module("../../lib/admin/ApiKeyStore.js", {
  namedExports: {
    ...realKeys,
    incrementUsage      : async () => {},
    validateApiKeyFromDB: async () => ({
      valid: true, keyId: "key-preset", groupKeyIds: ["key-preset"], permissions: ["read", "write"],
      defaultWorkspace: null, defaultMode: keyDefaultMode
    })
  }
});

const { handleMcpPost }           = await import("../../lib/handlers/mcp-handler.js");
const { workspaceReadAuthzTotal } = await import("../../lib/memory/read/read-authz-metrics.js");

const allowAll = { allow: () => true };
let server;
let base;

before(async () => {
  server = http.createServer((req, res) => handleMcpPost(req, res, process.hrtime.bigint(), allowAll));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

beforeEach(() => { keyDefaultMode = null; });

const initBody = (params = {}) => ({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params : { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" }, ...params }
});

function post(token, body, extraHeaders = {}) {
  return fetch(`${base}/mcp`, {
    method : "POST",
    headers: { "content-type": "application/json", "authorization": `Bearer ${token}`, ...extraHeaders },
    body   : JSON.stringify(body)
  });
}

async function presetCount(outcome) {
  const { values } = await workspaceReadAuthzTotal.get();
  const hit = values.find(v => v.labels.surface === "mode_preset" && v.labels.outcome === outcome);
  return hit ? hit.value : 0;
}

async function expectRejected(res) {
  assert.equal(res.status, 403);
  assert.equal(res.headers.get("mcp-session-id"), null);
  const body = await res.json();
  assert.equal(body.error.code, -32001);
  assert.match(body.error.message, /'audit' requires master authentication/);
  assert.equal(body.result, undefined);
}

describe("enforce", () => {
  before(() => { process.env.MEMENTO_WORKSPACE_READ_AUTHZ = "enforce"; });

  it("헤더로 요청한 master 전용 preset을 거부한다", async () => {
    const before = await presetCount("denied");
    await expectRejected(await post("mmcp_preset_key", initBody(), { "x-memento-mode": "audit" }));
    assert.equal(await presetCount("denied"), before + 1);
  });

  it("initialize params.mode로 요청한 master 전용 preset을 거부한다", async () => {
    await expectRejected(await post("mmcp_preset_key", initBody({ mode: "audit" })));
  });

  it("키 default_mode의 master 전용 preset을 거부한다", async () => {
    keyDefaultMode = "audit";
    await expectRejected(await post("mmcp_preset_key", initBody()));
  });

  it("세션 자동 복구에서도 거부한다", async () => {
    const res = await post("mmcp_preset_key", { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      { "mcp-session-id": "00000000-0000-4000-8000-0000000000c1", "mcp-protocol-version": "2025-06-18", "x-memento-mode": "audit" });
    await expectRejected(res);
  });

  it("일반 preset과 master 키는 그대로 세션을 연다", async () => {
    const plain = await post("mmcp_preset_key", initBody(), { "x-memento-mode": "recall-only" });
    assert.equal(plain.status, 200);
    assert.ok(plain.headers.get("mcp-session-id"));
    const master = await post(process.env.MEMENTO_ACCESS_KEY, initBody(), { "x-memento-mode": "audit" });
    assert.equal(master.status, 200);
  });
});

describe("warn", () => {
  before(() => { process.env.MEMENTO_WORKSPACE_READ_AUTHZ = "warn"; });

  it("would_deny를 세고 세션을 연다", async () => {
    const before = await presetCount("would_deny");
    const res = await post("mmcp_preset_key", initBody(), { "x-memento-mode": "audit" });
    assert.equal(res.status, 200);
    assert.ok(res.headers.get("mcp-session-id"));
    assert.equal(await presetCount("would_deny"), before + 1);
  });
});

describe("off", () => {
  before(() => { process.env.MEMENTO_WORKSPACE_READ_AUTHZ = "off"; });
  after(() => { delete process.env.MEMENTO_WORKSPACE_READ_AUTHZ; });

  it("판정하지 않고 세션을 연다", async () => {
    const before = (await presetCount("would_deny")) + (await presetCount("denied"));
    const res = await post("mmcp_preset_key", initBody(), { "x-memento-mode": "audit" });
    assert.equal(res.status, 200);
    assert.equal((await presetCount("would_deny")) + (await presetCount("denied")), before);
  });
});
