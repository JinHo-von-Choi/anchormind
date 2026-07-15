/**
 * Admin key-scoped REST API 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-07-15
 *
 * 신설 엔드포인트 검증 (DB·MemoryManager는 mock):
 *   GET  /keys/:id/stats
 *   GET  /memory/fragments (확장 필터·detail)
 *   GET  /memory/fragments/:id (key_ids 스코프)
 *   PATCH/DELETE/POST /memory/fragments[/:id]
 *   GET  /memory/fragments/:id/history
 *   POST /search
 *   GET  /search-events
 *   GET  /export?key_ids
 *   PUT  /keys/:id/fragment-limit (limit_below_usage 불변조건)
 */

import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";

/* ── DB mock ── */
let queryCalls   = [];
let queryResults = [];

const mockPool = {
  query(sql, params) {
    queryCalls.push({ sql, params });
    const result = queryResults[queryCalls.length - 1] ?? { rows: [] };
    return Promise.resolve(result);
  }
};

mock.module("../../lib/tools/db.js", {
  namedExports: { getPrimaryPool: () => mockPool }
});

/* ── MemoryManager mock ── */
let mgrCalls = [];
const mgrStub = {
  remember:        (p) => { mgrCalls.push(["remember", p]);        return Promise.resolve({ success: true, id: "new-frag" }); },
  amend:           (p) => { mgrCalls.push(["amend", p]);           return Promise.resolve({ updated: true, fragment: { id: p.id } }); },
  forget:          (p) => { mgrCalls.push(["forget", p]);          return Promise.resolve(p.dryRun ? { dryRun: true, simulated: { would_delete: true } } : { deleted: 1, protected: 0 }); },
  recall:          (p) => { mgrCalls.push(["recall", p]);          return Promise.resolve({ fragments: [{ id: "f1" }], searchPath: ["L1:1"], count: 1, totalCount: 1 }); },
  fragmentHistory: (p) => { mgrCalls.push(["fragmentHistory", p]); return Promise.resolve({ current: { id: p.id }, versions: [] }); }
};

mock.module("../../lib/memory/MemoryManager.js", {
  namedExports: { MemoryManager: { getInstance: () => mgrStub } }
});

/* ApiKeyStore·admin-keys의 getFragmentCount/updateFragmentLimit는 실제 구현을 쓰되
 * getPrimaryPool(mock) 경유로 DB 응답을 queryResults로 주입한다. */

const { handleMemory, handleSearch, handleSearchEvents } = await import("../../lib/admin/admin-memory.js");
const { handleExport } = await import("../../lib/admin/admin-export.js");
const { handleKeys }   = await import("../../lib/admin/admin-keys.js");

const ADMIN_BASE = "/v1/internal/model/nothing";

function fakeRes() {
  const headers = {};
  const chunks  = [];
  return {
    statusCode: 0,
    headers,
    chunks,
    setHeader(k, v) { headers[k.toLowerCase()] = v; },
    write(c)        { chunks.push(c); },
    end(body)       { if (body) chunks.push(body); this._done = true; },
    get body()      { return chunks.join(""); }
  };
}

function makeUrl(pathAndQuery) {
  return new URL(`http://localhost${pathAndQuery}`);
}

/** req with JSON body for POST/PATCH — readJsonBody는 data/end 이벤트로 읽는다 */
function jsonReq(method, body) {
  const payload = JSON.stringify(body);
  const req     = Readable.from([Buffer.from(payload)]);
  req.method    = method;
  req.headers   = { "content-type": "application/json" };
  return req;
}

beforeEach(() => {
  queryCalls   = [];
  queryResults = [];
  mgrCalls     = [];
});

/* ── GET /keys/:id/stats ── */
describe("GET /keys/:id/stats", () => {
  it("단일 집계 SQL로 통계 객체를 반환한다", async () => {
    queryResults = [{ rows: [{
      total: 10, type_fact: 4, type_decision: 1, type_error: 2, type_preference: 0,
      type_procedure: 1, type_relation: 0, type_episode: 2,
      ttl_short: 1, ttl_hot: 0, ttl_warm: 7, ttl_cold: 2, ttl_permanent: 0,
      anchors: 3, expiring_soon: 1, growth_7d: 2, growth_28d: 5, stale_30d: 4
    }] }];
    const res = fakeRes();
    const handled = await handleKeys({ method: "GET" }, res, makeUrl(`${ADMIN_BASE}/keys/key-1/stats`));
    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.total, 10);
    assert.equal(body.byType.fact, 4);
    assert.equal(body.byTtlTier.warm, 7);
    assert.equal(body.anchors, 3);
    assert.equal(body.expiringSoon, 1);
    assert.equal(body.growth7d, 2);
    assert.equal(body.staleRatio30d, 0.4);
    /** 단일 쿼리만 실행 */
    assert.equal(queryCalls.length, 1);
    assert.match(queryCalls[0].sql, /FILTER \(WHERE valid_to IS NULL\)/);
  });
});

/* ── GET /memory/fragments 확장 필터 ── */
describe("GET /memory/fragments 확장", () => {
  it("assertion_status·ttl_tier·is_anchor·min_access_count 필터가 바인딩된다", async () => {
    queryResults = [{ rows: [{ total: 0 }] }, { rows: [] }];
    const res = fakeRes();
    await handleMemory({ method: "GET" }, res, makeUrl(
      `${ADMIN_BASE}/memory/fragments?assertion_status=verified&ttl_tier=warm&is_anchor=true&min_access_count=5`
    ));
    const itemsCall = queryCalls.find(c => c.sql.includes("LEFT(content"));
    assert.match(itemsCall.sql, /assertion_status = /);
    assert.match(itemsCall.sql, /ttl_tier = /);
    assert.match(itemsCall.sql, /is_anchor = /);
    assert.match(itemsCall.sql, /access_count >= /);
    assert.ok(itemsCall.params.includes("verified"));
    assert.ok(itemsCall.params.includes("warm"));
    assert.ok(itemsCall.params.includes(true));
    assert.ok(itemsCall.params.includes(5));
  });

  it("key_ids는 key_id = ANY로 바인딩된다", async () => {
    queryResults = [{ rows: [{ total: 0 }] }, { rows: [] }];
    const res = fakeRes();
    await handleMemory({ method: "GET" }, res, makeUrl(
      `${ADMIN_BASE}/memory/fragments?key_ids=a,b,c`
    ));
    const itemsCall = queryCalls.find(c => c.sql.includes("LEFT(content"));
    assert.match(itemsCall.sql, /key_id = ANY/);
    assert.ok(itemsCall.params.some(p => Array.isArray(p) && p.length === 3));
  });

  it("detail=true면 확장 컬럼을 SELECT에 포함한다", async () => {
    queryResults = [{ rows: [{ total: 0 }] }, { rows: [] }];
    const res = fakeRes();
    await handleMemory({ method: "GET" }, res, makeUrl(`${ADMIN_BASE}/memory/fragments?detail=true`));
    const itemsCall = queryCalls.find(c => c.sql.includes("LEFT(content"));
    assert.match(itemsCall.sql, /assertion_status/);
    assert.match(itemsCall.sql, /workspace/);
  });
});

/* ── GET /memory/fragments/:id key_ids 스코프 ── */
describe("GET /memory/fragments/:id key_ids 스코프", () => {
  it("key_ids가 오면 keyScopeClause 조건이 붙는다", async () => {
    queryResults = [{ rows: [{ id: "frag-1", key_id: "a" }] }, { rows: [] }];
    const res = fakeRes();
    await handleMemory({ method: "GET" }, res, makeUrl(`${ADMIN_BASE}/memory/fragments/frag-1?key_ids=a,b`));
    assert.equal(res.statusCode, 200);
    const fragCall = queryCalls[0];
    assert.match(fragCall.sql, /IS NOT DISTINCT FROM|= ANY/);
    assert.match(fragCall.sql, /affect, workspace/);
  });

  it("스코프 밖이면 404", async () => {
    queryResults = [{ rows: [] }];
    const res = fakeRes();
    await handleMemory({ method: "GET" }, res, makeUrl(`${ADMIN_BASE}/memory/fragments/frag-1?key_ids=z`));
    assert.equal(res.statusCode, 404);
  });
});

/* ── POST /memory/fragments (create) ── */
describe("POST /memory/fragments", () => {
  it("remember 처리기를 key_id 스코프로 호출하고 201", async () => {
    const res = fakeRes();
    await handleMemory(
      jsonReq("POST", { key_id: "key-9", content: "c", topic: "t", type: "fact" }),
      res, makeUrl(`${ADMIN_BASE}/memory/fragments`)
    );
    assert.equal(res.statusCode, 201);
    const [name, params] = mgrCalls[0];
    assert.equal(name, "remember");
    assert.equal(params._keyId, "key-9");
    assert.equal(params.content, "c");
  });

  it("필수 필드 누락 시 400", async () => {
    const res = fakeRes();
    await handleMemory(
      jsonReq("POST", { key_id: "key-9", content: "c" }),
      res, makeUrl(`${ADMIN_BASE}/memory/fragments`)
    );
    assert.equal(res.statusCode, 400);
    assert.equal(mgrCalls.length, 0);
  });
});

/* ── PATCH /memory/fragments/:id ── */
describe("PATCH /memory/fragments/:id", () => {
  it("amend를 필드 매핑·스코프와 함께 호출한다", async () => {
    const res = fakeRes();
    await handleMemory(
      jsonReq("PATCH", { content: "x", is_anchor: true, assertion_status: "verified" }),
      res, makeUrl(`${ADMIN_BASE}/memory/fragments/frag-1?key_ids=a,b`)
    );
    assert.equal(res.statusCode, 200);
    const [name, params] = mgrCalls[0];
    assert.equal(name, "amend");
    assert.equal(params.id, "frag-1");
    assert.equal(params.isAnchor, true);
    assert.equal(params.assertionStatus, "verified");
    assert.deepEqual(params._groupKeyIds, ["a", "b"]);
  });
});

/* ── DELETE /memory/fragments/:id ── */
describe("DELETE /memory/fragments/:id", () => {
  it("dryRun=true면 forget을 dryRun으로 호출한다", async () => {
    const res = fakeRes();
    await handleMemory(
      { method: "DELETE" }, res, makeUrl(`${ADMIN_BASE}/memory/fragments/frag-1?dryRun=true`)
    );
    assert.equal(res.statusCode, 200);
    const [name, params] = mgrCalls[0];
    assert.equal(name, "forget");
    assert.equal(params.dryRun, true);
    assert.equal(params.id, "frag-1");
  });
});

/* ── GET /memory/fragments/:id/history ── */
describe("GET /memory/fragments/:id/history", () => {
  it("fragmentHistory를 호출하고 결과를 반환한다", async () => {
    const res = fakeRes();
    const handled = await handleMemory(
      { method: "GET" }, res, makeUrl(`${ADMIN_BASE}/memory/fragments/frag-1/history`)
    );
    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(mgrCalls[0][0], "fragmentHistory");
    assert.equal(mgrCalls[0][1].id, "frag-1");
  });
});

/* ── POST /search ── */
describe("POST /search", () => {
  it("recall을 key_ids 스코프로 호출하고 fragments·searchPath 반환", async () => {
    const res = fakeRes();
    const handled = await handleSearch(
      jsonReq("POST", { key_ids: ["a", "b"], keywords: ["x"], pageSize: 5 }),
      res, makeUrl(`${ADMIN_BASE}/search`)
    );
    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.fragments.length, 1);
    assert.deepEqual(body.searchPath, ["L1:1"]);
    const [name, params] = mgrCalls[0];
    assert.equal(name, "recall");
    assert.equal(params._keyId, "a");
    assert.deepEqual(params._groupKeyIds, ["a", "b"]);
  });

  it("경로·메서드 불일치면 false 반환", async () => {
    const res = fakeRes();
    const handled = await handleSearch({ method: "GET" }, res, makeUrl(`${ADMIN_BASE}/search`));
    assert.equal(handled, false);
  });
});

/* ── GET /search-events ── */
describe("GET /search-events", () => {
  it("30일 기본 요약(총수·평균·zero-hit)을 반환한다", async () => {
    queryResults = [{ rows: [{ total_searches: 100, avg_result_count: "3.50", zero_hit_count: 20 }] }];
    const res = fakeRes();
    const handled = await handleSearchEvents({ method: "GET" }, res, makeUrl(`${ADMIN_BASE}/search-events`));
    assert.equal(handled, true);
    const body = JSON.parse(res.body);
    assert.equal(body.windowDays, 30);
    assert.equal(body.totalSearches, 100);
    assert.equal(body.avgResultCount, 3.5);
    assert.equal(body.zeroHitRate, 0.2);
  });

  it("key_ids 제공 시 귀속 불가 안내(keyScopeNote)를 포함한다", async () => {
    queryResults = [{ rows: [{ total_searches: 0, avg_result_count: "0", zero_hit_count: 0 }] }];
    const res = fakeRes();
    await handleSearchEvents({ method: "GET" }, res, makeUrl(`${ADMIN_BASE}/search-events?key_ids=a`));
    const body = JSON.parse(res.body);
    assert.ok(body.keyScopeNote);
  });
});

/* ── GET /export?key_ids ── */
describe("GET /export key_ids", () => {
  it("key_ids는 key_id = ANY + valid_to IS NULL로 반출한다", async () => {
    queryResults = [{ rows: [{ id: "f1", content: "c" }] }];
    const res = fakeRes();
    await handleExport({ method: "GET" }, res, makeUrl(`${ADMIN_BASE}/export?key_ids=a,b`));
    assert.equal(res.statusCode, 200);
    const call = queryCalls[0];
    assert.match(call.sql, /key_id = ANY/);
    assert.match(call.sql, /valid_to IS NULL/);
    assert.ok(call.params.some(p => Array.isArray(p) && p.length === 2));
  });
});

/* ── PUT /keys/:id/fragment-limit 불변조건 ── */
describe("PUT /keys/:id/fragment-limit 불변조건", () => {
  it("새 상한이 실사용보다 작으면 400 limit_below_usage", async () => {
    /** getFragmentCount → 50, 이후 updateFragmentLimit는 호출되지 않아야 함 */
    queryResults = [{ rows: [{ count: 50 }] }];
    const res = fakeRes();
    await handleKeys(
      jsonReq("PUT", { fragment_limit: 10 }),
      res, makeUrl(`${ADMIN_BASE}/keys/key-1/fragment-limit`)
    );
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.equal(body.error, "limit_below_usage");
    assert.equal(body.used, 50);
    /** 사용량 조회 1건만 실행, UPDATE 미실행 */
    assert.equal(queryCalls.length, 1);
  });

  it("상한이 실사용 이상이면 갱신 진행", async () => {
    queryResults = [{ rows: [{ count: 5 }] }, { rowCount: 1, rows: [] }];
    const res = fakeRes();
    await handleKeys(
      jsonReq("PUT", { fragment_limit: 100 }),
      res, makeUrl(`${ADMIN_BASE}/keys/key-1/fragment-limit`)
    );
    assert.equal(res.statusCode, 200);
    /** 사용량 조회 + UPDATE 2건 */
    assert.equal(queryCalls.length, 2);
    assert.match(queryCalls[1].sql, /UPDATE agent_memory.api_keys SET fragment_limit/);
  });

  it("null(무제한)은 사용량 검사 없이 통과", async () => {
    queryResults = [{ rowCount: 1, rows: [] }];
    const res = fakeRes();
    await handleKeys(
      jsonReq("PUT", { fragment_limit: null }),
      res, makeUrl(`${ADMIN_BASE}/keys/key-1/fragment-limit`)
    );
    assert.equal(res.statusCode, 200);
    /** 사용량 조회 없이 UPDATE 1건만 */
    assert.equal(queryCalls.length, 1);
    assert.match(queryCalls[0].sql, /UPDATE agent_memory.api_keys SET fragment_limit/);
  });
});
