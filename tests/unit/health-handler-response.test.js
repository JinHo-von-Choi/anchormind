/**
 * /health, /metrics 핸들러 응답 계약 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * DB 풀만 대역으로 바꾸고 실제 핸들러를 호출한다. 비인증 응답의 필드 범위,
 * DB 실패 시 상태 판정, /metrics 인증 요구를 확인한다.
 */

import { describe, it, after, mock } from "node:test";
import assert                        from "node:assert/strict";

/** 설정 모듈이 읽기 전에 시험 전용 마스터 키를 고정한다. */
const TEST_KEY = "health-handler-test-key";
process.env.MEMENTO_ACCESS_KEY = TEST_KEY;

let dbFails = false;

const realDb = await import("../../lib/tools/db.js");
mock.module("../../lib/tools/db.js", {
  exports: {
    ...realDb,
    getPrimaryPool: () => ({
      query: async (sql) => {
        if (dbFails) throw new Error("connect ECONNREFUSED");
        if (/pg_extension/.test(sql)) return { rows: [{ extversion: "0.8.0" }] };
        return { rows: [{ "?column?": 1 }] };
      }
    }),
    getPoolStats: () => ({ total: 1, idle: 1, waiting: 0 })
  }
});

const { handleHealth, handleMetrics, handleReady }   = await import("../../lib/handlers/health-handler.js");
const { ACCESS_KEY }                                 = await import("../../lib/config.js");
const { teardownTestResources, assertCleanShutdown } = await import("../_lifecycle.js");

after(async () => {
  await teardownTestResources();
  await assertCleanShutdown();
});

/** 응답을 기록하는 최소 res 대역 */
function makeRes() {
  return {
    statusCode: 0,
    headers   : {},
    body      : null,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(data)              { this.body = data === undefined ? null : String(data); }
  };
}

function makeReq(authorized) {
  return {
    method : "GET",
    headers: authorized ? { authorization: `Bearer ${ACCESS_KEY}` } : {}
  };
}

describe("handleHealth", () => {
  it("시험용 마스터 키가 설정에 반영돼 있다", () => {
    assert.equal(ACCESS_KEY, TEST_KEY);
  });

  it("비인증 요청에는 status와 timestamp만 돌려준다", async () => {
    dbFails = false;
    const res = makeRes();
    await handleHealth(makeReq(false), res, process.hrtime.bigint());
    assert.equal(res.statusCode, 200);
    assert.deepEqual(Object.keys(JSON.parse(res.body)).sort(), ["status", "timestamp"]);
    assert.equal(JSON.parse(res.body).status, "healthy");
  });

  it("인증 요청에는 services와 workers가 들어간다", async () => {
    dbFails = false;
    const res  = makeRes();
    await handleHealth(makeReq(true), res, process.hrtime.bigint());
    const body = JSON.parse(res.body);
    assert.equal(res.statusCode, 200);
    assert.equal(body.services.database.status, "up");
    assert.deepEqual(body.services.pgvector, { status: "up", version: "0.8.0" });
    assert.equal(body.services.redis.status, "disabled");
    assert.ok("embedding" in body.workers);
  });

  it("DB 질의가 실패하면 unhealthy와 503을 돌려주고 오류 원문을 싣지 않는다", async () => {
    dbFails = true;
    try {
      const res  = makeRes();
      await handleHealth(makeReq(true), res, process.hrtime.bigint());
      const body = JSON.parse(res.body);
      assert.equal(res.statusCode, 503);
      assert.equal(body.status, "unhealthy");
      assert.deepEqual(body.services.database, { status: "down", error: "Connection failed" });
      assert.equal(res.body.includes("ECONNREFUSED"), false);
    } finally {
      dbFails = false;
    }
  });
});

describe("handleReady 기본 확인", () => {
  it("주 풀 질의가 성공하면 200 ready를 돌려준다", async () => {
    dbFails = false;
    const res = makeRes();
    await handleReady(makeReq(false), res, process.hrtime.bigint());
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { status: "ready" });
  });

  it("주 풀 질의가 실패하면 503 db_error를 돌려주고 오류 원문을 싣지 않는다", async () => {
    dbFails = true;
    try {
      const res = makeRes();
      await handleReady(makeReq(false), res, process.hrtime.bigint());
      assert.equal(res.statusCode, 503);
      assert.deepEqual(JSON.parse(res.body), { status: "not_ready", reason: "db_error" });
      assert.equal(res.body.includes("ECONNREFUSED"), false);
    } finally {
      dbFails = false;
    }
  });
});

describe("handleMetrics", () => {
  it("마스터 키 없이 요청하면 401을 돌려준다", async () => {
    const res = makeRes();
    await handleMetrics(makeReq(false), res, process.hrtime.bigint());
    assert.equal(res.statusCode, 401);
    assert.deepEqual(JSON.parse(res.body), { error: "Unauthorized" });
  });

  it("마스터 키로 요청하면 Prometheus 본문을 돌려준다", async () => {
    const res = makeRes();
    await handleMetrics(makeReq(true), res, process.hrtime.bigint());
    assert.equal(res.statusCode, 200);
    assert.match(res.headers["content-type"], /text\/plain/);
  });
});
