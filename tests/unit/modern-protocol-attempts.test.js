/**
 * 세션 없는 현대식 프로토콜 요청 지표 시험.
 * 판정 함수는 순수 함수로, 지표 증가와 응답 형태는 실제 handleMcpPost를 로컬 HTTP 서버에
 * 물려 확인한다. 세션 없는 비initialize 요청은 400과 -32000으로 끝나 클라이언트가
 * initialize로 돌아가는 경로에 남는다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */
import { describe, it, before, after } from "node:test";
import assert                          from "node:assert/strict";
import http                            from "node:http";

process.env.DOTENV_CONFIG_PATH      ??= ".env.test";
process.env.MEMENTO_METRICS_DEFAULT ??= "off";
process.env.REDIS_ENABLED           ??= "false";
process.env.CACHE_ENABLED           ??= "false";

const { handleMcpPost, classifyModernProtocolAttempt } = await import("../../lib/handlers/mcp-handler.js");
const metrics                                          = await import("../../lib/metrics.js");
const { SUPPORTED_PROTOCOL_VERSIONS }                  = await import("../../lib/protocol-versions.js");

const META_KEY       = "io.modelcontextprotocol/protocolVersion";
const MODERN_VERSION = "2026-07-28";
const METRIC_NAME    = "memento_modern_protocol_attempts_total";

/** 라벨 값별 카운터 값 */
async function attempts(signal) {
  const snap = await metrics.modernProtocolAttemptsTotal.get();
  return snap.values.filter(v => v.labels.signal === signal).reduce((sum, v) => sum + v.value, 0);
}

/** 모든 라벨의 카운터 합 */
async function totalAttempts() {
  const snap = await metrics.modernProtocolAttemptsTotal.get();
  return snap.values.reduce((sum, v) => sum + v.value, 0);
}

function modernBody(method) {
  return { jsonrpc: "2.0", id: 1, method, params: { _meta: { [META_KEY]: MODERN_VERSION, "io.modelcontextprotocol/clientCapabilities": {} } } };
}

describe("classifyModernProtocolAttempt", () => {
  it("지원 목록 밖 버전 헤더와 _meta 버전이 함께 오면 header_and_meta", () => {
    assert.equal(classifyModernProtocolAttempt(MODERN_VERSION, modernBody("tools/list")), "header_and_meta");
  });

  it("지원 목록 밖 버전 헤더만 오면 header", () => {
    assert.equal(classifyModernProtocolAttempt(MODERN_VERSION, { jsonrpc: "2.0", id: 1, method: "tools/list" }), "header");
  });

  it("지원 목록 안 헤더와 _meta 버전이면 meta", () => {
    assert.equal(classifyModernProtocolAttempt("2025-11-25", modernBody("tools/list")), "meta");
  });

  it("헤더 없이 _meta 버전만 있으면 meta", () => {
    assert.equal(classifyModernProtocolAttempt(undefined, modernBody("server/discover")), "meta");
  });

  it("지원 목록 안 헤더나 헤더 없음만으로는 세지 않는다", () => {
    for (const v of SUPPORTED_PROTOCOL_VERSIONS) {
      assert.equal(classifyModernProtocolAttempt(v, { jsonrpc: "2.0", id: 1, method: "tools/list" }), null);
    }
    assert.equal(classifyModernProtocolAttempt(undefined, { jsonrpc: "2.0", id: 1, method: "tools/list" }), null);
    assert.equal(classifyModernProtocolAttempt("", { jsonrpc: "2.0", id: 1, method: "tools/list" }), null);
  });

  it("initialize 요청은 헤더와 _meta가 있어도 세지 않는다", () => {
    assert.equal(classifyModernProtocolAttempt(MODERN_VERSION, modernBody("initialize")), null);
  });

  it("배열 본문은 원소 중 하나의 _meta 버전으로 판정한다", () => {
    const batch = [{ jsonrpc: "2.0", id: 1, method: "tools/list" }, modernBody("tools/call")];
    assert.equal(classifyModernProtocolAttempt(undefined, batch), "meta");
    assert.equal(classifyModernProtocolAttempt(undefined, [{ jsonrpc: "2.0", id: 1, method: "tools/list" }]), null);
  });

  it("params나 _meta가 객체가 아니어도 예외 없이 판정한다", () => {
    assert.equal(classifyModernProtocolAttempt(undefined, { method: "tools/list", params: null }), null);
    assert.equal(classifyModernProtocolAttempt(undefined, { method: "tools/list", params: { _meta: "x" } }), null);
    assert.equal(classifyModernProtocolAttempt(undefined, null), null);
  });
});

describe("memento_modern_protocol_attempts_total 등록", () => {
  it("레지스트리에 signal 라벨 하나를 가진 카운터로 등록된다", async () => {
    const metric = metrics.register.getSingleMetric(METRIC_NAME);
    assert.ok(metric, "미등록");
    const json = await metric.get();
    assert.equal(json.type, "counter");
    assert.deepEqual(metric.labelNames, ["signal"]);
  });

  it("기록 함수는 정해진 세 값만 라벨로 쓰고 그 밖의 값은 unknown으로 닫는다", async () => {
    for (const s of ["header", "meta", "header_and_meta"]) {
      const before = await attempts(s);
      metrics.recordModernProtocolAttempt(s);
      assert.equal(await attempts(s), before + 1);
    }
    const before = await attempts("unknown");
    metrics.recordModernProtocolAttempt("2026-07-28");
    assert.equal(await attempts("unknown"), before + 1);
    assert.equal(await attempts("2026-07-28"), 0);
  });
});

describe("세션 없는 요청의 응답과 지표", () => {
  let server;
  let base;

  before(async () => {
    server = http.createServer((req, res) => handleMcpPost(req, res, process.hrtime.bigint(), { allow: () => true }));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => new Promise((resolve) => server.close(resolve)));

  async function post(headers, body) {
    const res = await fetch(`${base}/mcp`, {
      method : "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body   : JSON.stringify(body)
    });
    return { status: res.status, body: await res.json(), sessionId: res.headers.get("mcp-session-id") };
  }

  it("현대식 요청은 400과 -32000을 받고 header_and_meta로 한 번 센다", async () => {
    const before = await attempts("header_and_meta");
    const res    = await post({ "mcp-protocol-version": MODERN_VERSION, "mcp-method": "tools/list" }, modernBody("tools/list"));
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, -32000);
    assert.match(res.body.error.message, /^Session required/);
    assert.equal(res.sessionId, null);
    assert.equal(await attempts("header_and_meta"), before + 1);
  });

  it("server/discover도 같은 400과 -32000을 받는다", async () => {
    const before = await totalAttempts();
    const res    = await post({ "mcp-protocol-version": MODERN_VERSION, "mcp-method": "server/discover" }, modernBody("server/discover"));
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, -32000);
    assert.equal(res.body.result, undefined);
    assert.equal(await totalAttempts(), before + 1);
  });

  it("레거시 버전 헤더의 세션 없는 요청은 같은 400을 받되 세지 않는다", async () => {
    const before = await totalAttempts();
    const res    = await post({ "mcp-protocol-version": "2025-06-18" }, { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, -32000);
    assert.equal(await totalAttempts(), before);
  });

  it("세션 없는 initialize는 현대식 헤더가 있어도 세지 않는다", async () => {
    const before = await totalAttempts();
    await post({ "mcp-protocol-version": MODERN_VERSION }, modernBody("initialize"));
    assert.equal(await totalAttempts(), before);
  });
});
