/**
 * /health/live, /health/ready 처리기 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */
import { describe, it, before, after } from "node:test";
import assert                          from "node:assert/strict";
import http                            from "node:http";

const { handleLive, handleReady, probeWithDeadline } = await import("../../lib/handlers/health-handler.js");

let probe = async () => {};
let server;
let baseUrl;

before(async () => {
  server = http.createServer(async (req, res) => {
    const start = process.hrtime.bigint();
    if (req.url === "/health/live")  return handleLive(req, res, start);
    if (req.url === "/health/ready") return handleReady(req, res, start, { probe, timeoutMs: 100 });
    res.statusCode = 404;
    res.end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

describe("probeWithDeadline", () => {
  it("성공, 실패, 시간 초과를 구분한다", async () => {
    assert.equal((await probeWithDeadline(async () => {}, 50)).reason, "ok");
    const failed = await probeWithDeadline(async () => { const e = new Error("x"); e.code = "ECONNREFUSED"; throw e; }, 50);
    assert.deepEqual([failed.reason, failed.code], ["error", "ECONNREFUSED"]);
    const slow = await probeWithDeadline(() => new Promise(r => setTimeout(r, 500)), 50);
    assert.equal(slow.reason, "timeout");
    assert.ok(slow.latencyMs < 400, `latency ${slow.latencyMs}`);
  });
});

describe("GET /health/live", () => {
  it("DB 상태와 무관하게 200이다", async () => {
    probe = async () => { throw new Error("db down"); };
    const res = await fetch(`${baseUrl}/health/live`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, "alive");
  });
});

describe("GET /health/ready", () => {
  it("DB가 응답하면 200이다", async () => {
    probe = async () => {};
    const res = await fetch(`${baseUrl}/health/ready`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "ready" });
  });

  it("DB 오류면 503 db_error다", async () => {
    probe = async () => { throw new Error("db down"); };
    const res = await fetch(`${baseUrl}/health/ready`);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { status: "not_ready", reason: "db_error" });
  });

  it("DB가 상한 안에 답하지 않으면 상한 근처에서 503 db_timeout이다", async () => {
    probe = () => new Promise(r => setTimeout(r, 600));
    const t0  = Date.now();
    const res = await fetch(`${baseUrl}/health/ready`);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { status: "not_ready", reason: "db_timeout" });
    assert.ok(Date.now() - t0 < 500, `elapsed ${Date.now() - t0}`);
  });
});
