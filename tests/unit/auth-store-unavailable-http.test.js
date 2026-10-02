/**
 * 인증 저장소 조회 실패 시 MCP 응답 상태 시험 (MEMENTO_AUTH_STORE_UNAVAILABLE_STATUS=503)
 * 실제 handleMcpPost를 호출하고 ApiKeyStore의 원시 키 조회만 대체한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */
import { describe, it, before, after, mock } from "node:test";
import assert                                from "node:assert/strict";
import http                                  from "node:http";

process.env.DOTENV_CONFIG_PATH                    ??= ".env.test";
process.env.MEMENTO_METRICS_DEFAULT               ??= "off";
process.env.REDIS_ENABLED                         ??= "false";
process.env.CACHE_ENABLED                         ??= "false";
process.env.MEMENTO_AUTH_STORE_UNAVAILABLE_STATUS = "503";

let storeDown = true;

const realKeys = await import("../../lib/admin/ApiKeyStore.js");
mock.module("../../lib/admin/ApiKeyStore.js", {
  namedExports: {
    ...realKeys,
    validateApiKeyFromDB: async () => {
      if (storeDown) { const e = new Error("connect ECONNREFUSED"); e.code = "ECONNREFUSED"; throw e; }
      return { valid: false };
    }
  }
});

const { handleMcpPost } = await import("../../lib/handlers/mcp-handler.js");

const allowAll = { allow: () => true };
let server;
let base;

before(async () => {
  server = http.createServer((req, res) => handleMcpPost(req, res, process.hrtime.bigint(), allowAll));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

const INIT_BODY = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } };

function post(token, body, extraHeaders = {}) {
  return fetch(`${base}/mcp`, {
    method : "POST",
    headers: { "content-type": "application/json", "authorization": `Bearer ${token}`, ...extraHeaders },
    body   : JSON.stringify(body)
  });
}

describe("저장소 조회 실패 응답 상태 (503 설정)", () => {
  it("initialize는 503과 Retry-After를 받는다", async () => {
    const res = await post("mmcp_raw_key_value", INIT_BODY);
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("retry-after"), "10");
    assert.equal(res.headers.get("www-authenticate"), null);
  });

  it("마스터 키 initialize는 저장소와 무관하게 200이다", async () => {
    const res = await post(process.env.MEMENTO_ACCESS_KEY, INIT_BODY);
    assert.equal(res.status, 200);
  });

  it("조회는 성공했지만 없는 키는 401과 WWW-Authenticate를 받는다", async () => {
    storeDown = false;
    try {
      const res = await post("mmcp_unknown_key", INIT_BODY);
      assert.equal(res.status, 401);
      assert.match(res.headers.get("www-authenticate") ?? "", /^Bearer resource_metadata=/);
      assert.equal(res.headers.get("retry-after"), null);
    } finally {
      storeDown = true;
    }
  });

  it("없는 세션의 자동 복구는 조회 실패면 503이다", async () => {
    const res = await post("mmcp_raw_key_value", { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      { "mcp-session-id": "00000000-0000-4000-8000-0000000000aa", "mcp-protocol-version": "2025-06-18" });
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("retry-after"), "10");
  });

  it("없는 세션의 자동 복구는 없는 키면 404다", async () => {
    storeDown = false;
    try {
      const res = await post("mmcp_unknown_key", { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
        { "mcp-session-id": "00000000-0000-4000-8000-0000000000ab", "mcp-protocol-version": "2025-06-18" });
      assert.equal(res.status, 404);
    } finally {
      storeDown = true;
    }
  });
});
