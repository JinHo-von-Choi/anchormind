/**
 * MCP 세션 ID 수신 경로와 형식 처리 시험.
 * 실제 handleMcpPost, handleMcpGet, handleMcpDelete를 로컬 HTTP 서버에 물려 호출한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */
import { describe, it, before, after, afterEach } from "node:test";
import assert                                     from "node:assert/strict";
import http                                       from "node:http";
import { readFileSync }                           from "node:fs";
import path                                       from "node:path";

process.env.DOTENV_CONFIG_PATH      ??= ".env.test";
process.env.MEMENTO_METRICS_DEFAULT ??= "off";
process.env.REDIS_ENABLED           ??= "false";
process.env.CACHE_ENABLED           ??= "false";

const { handleMcpPost, handleMcpDelete }                     = await import("../../lib/handlers/mcp-handler.js");
const { ACCESS_KEY }                                         = await import("../../lib/config.js");
const { readSessionId, isServerIssuedSessionId }             = await import("../../lib/session-id.js");
const { sessionRef }                                         = await import("../../lib/logging/session-ref.js");
const ROOT                                                   = path.resolve(import.meta.dirname, "../..");

const allowAll = { allow: () => true };
let server;
let base;

before(async () => {
  assert.ok(ACCESS_KEY, ".env.test에 MEMENTO_ACCESS_KEY가 있어야 한다");
  server = http.createServer((req, res) => (req.method === "DELETE"
    ? handleMcpDelete(req, res)
    : handleMcpPost(req, res, process.hrtime.bigint(), allowAll)));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));
afterEach(() => { delete process.env.MEMENTO_SESSION_ID_POLICY; });

const LIST         = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
const JSON_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" };

async function initialize() {
  const res = await fetch(`${base}/mcp`, {
    method : "POST",
    headers: { ...JSON_HEADERS, authorization: `Bearer ${ACCESS_KEY}` },
    body   : JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } })
  });
  assert.equal(res.status, 200);
  return res.headers.get("mcp-session-id");
}

async function post(query, headers) {
  const res = await fetch(`${base}/mcp${query}`, { method: "POST", headers: { ...JSON_HEADERS, ...headers }, body: LIST });
  return res.status;
}

describe("쿼리스트링 세션 ID", () => {
  it("기본(warn)은 쿼리 세션 ID를 받아 처리한다", async () => {
    const sid = await initialize();
    assert.equal(await post(`?sessionId=${sid}`, {}), 200);
  });

  it("enforce는 400으로 거부한다", async () => {
    const sid = await initialize();
    process.env.MEMENTO_SESSION_ID_POLICY = "enforce";
    assert.equal(await post(`?sessionId=${sid}`, {}), 400);
  });

  it("enforce는 mcp-session-id 쿼리 이름도 거부한다", async () => {
    const sid = await initialize();
    process.env.MEMENTO_SESSION_ID_POLICY = "enforce";
    assert.equal(await post(`?mcp-session-id=${sid}`, {}), 400);
  });

  it("enforce에서도 헤더로 보낸 세션 ID는 그대로 쓴다", async () => {
    const sid = await initialize();
    process.env.MEMENTO_SESSION_ID_POLICY = "enforce";
    assert.equal(await post("", { "mcp-session-id": sid }), 200);
  });

  it("enforce에서 헤더와 쿼리가 함께 오면 헤더를 쓰고 거부하지 않는다", async () => {
    const sid = await initialize();
    process.env.MEMENTO_SESSION_ID_POLICY = "enforce";
    assert.equal(await post(`?sessionId=other`, { "mcp-session-id": sid }), 200);
  });

  it("enforce는 DELETE의 쿼리 세션 ID도 거부한다", async () => {
    const sid = await initialize();
    process.env.MEMENTO_SESSION_ID_POLICY = "enforce";
    const res = await fetch(`${base}/mcp?sessionId=${sid}`, { method: "DELETE", headers: { authorization: `Bearer ${ACCESS_KEY}` } });
    assert.equal(res.status, 400);
  });

  it("기본(warn)은 DELETE의 쿼리 세션 ID로 세션을 종료한다", async () => {
    const sid = await initialize();
    const res = await fetch(`${base}/mcp?sessionId=${sid}`, { method: "DELETE", headers: { authorization: `Bearer ${ACCESS_KEY}` } });
    assert.equal(res.status, 200);
  });
});

describe("서버가 발급하지 않은 형식의 세션 ID 복구", () => {
  it("기본(warn)은 인증이 유효하면 같은 ID로 복구한다", async () => {
    assert.equal(await post("", { "mcp-session-id": "chosen-by-client-0001", authorization: `Bearer ${ACCESS_KEY}` }), 200);
  });

  it("enforce는 복구하지 않고 404로 응답한다", async () => {
    process.env.MEMENTO_SESSION_ID_POLICY = "enforce";
    assert.equal(await post("", { "mcp-session-id": "chosen-by-client-0002", authorization: `Bearer ${ACCESS_KEY}` }), 404);
  });

  it("enforce에서도 UUID 형식의 만료 세션은 복구한다", async () => {
    process.env.MEMENTO_SESSION_ID_POLICY = "enforce";
    const stale = "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b";
    assert.equal(await post("", { "mcp-session-id": stale, authorization: `Bearer ${ACCESS_KEY}` }), 200);
  });
});

describe("세션 ID 읽기와 표기", () => {
  it("헤더가 쿼리보다 우선하고 수신 경로를 돌려준다", () => {
    const fromHeader = readSessionId({ headers: { "mcp-session-id": "h" }, url: "/mcp?sessionId=q" });
    const fromQuery  = readSessionId({ headers: {}, url: "/mcp?sessionId=q" });
    const none       = readSessionId({ headers: {}, url: "/mcp" });
    assert.deepEqual(fromHeader, { sessionId: "h", source: "header" });
    assert.deepEqual(fromQuery,  { sessionId: "q", source: "query" });
    assert.deepEqual(none,       { sessionId: null, source: null });
  });

  it("UUID 형식만 서버 발급 형식으로 판정한다", () => {
    assert.equal(isServerIssuedSessionId("3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b"), true);
    assert.equal(isServerIssuedSessionId("chosen-by-client-0001"), false);
    assert.equal(isServerIssuedSessionId(""), false);
  });

  it("표기는 앞 8자만 남긴다", () => {
    assert.equal(sessionRef("3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b"), "3f2a1b4c...");
    assert.equal(sessionRef(null), "none");
  });
});

describe("세션 ID 로그 구조", () => {
  it("로그 호출에 세션 ID 전체를 싣지 않는다", () => {
    const files = ["lib/handlers/mcp-handler.js", "lib/handlers/sse-handler.js", "lib/memory/processors/AutoReflect.js"];
    for (const file of files) {
      const src = readFileSync(path.join(ROOT, file), "utf8");
      assert.doesNotMatch(src, /log(?:Info|Warn|Error|Debug)\([^;]*\$\{(?:sessionId|sid|existingSid)\}/, file);
    }
  });

  it("외부 LLM 프롬프트에 세션 ID 전체를 싣지 않는다", () => {
    const src = readFileSync(path.join(ROOT, "lib/memory/processors/AutoReflect.js"), "utf8");
    assert.doesNotMatch(src, /세션 ID: \$\{sessionId\}/);
  });
});
