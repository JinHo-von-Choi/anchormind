/**
 * Admin 파편 상세/본문 검색/Export 안전장치 API 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-07-14
 *
 * GET /memory/fragments/:id, /memory/fragments?q=, /export 필수 필터를
 * 실제 핸들러(handleMemory/handleExport)에 대해 검증한다. DB는 mock.
 */

import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

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
  namedExports: {
    getPrimaryPool: () => mockPool
  }
});

const { handleMemory } = await import("../../lib/admin/admin-memory.js");
const { handleExport } = await import("../../lib/admin/admin-export.js");

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

beforeEach(() => {
  queryCalls   = [];
  queryResults = [];
});

/* ── GET /memory/fragments — 목록 필드/검색 ── */
describe("GET /memory/fragments 목록", () => {
  it("SELECT가 content alias·keywords·access_count를 포함한다", async () => {
    queryResults = [{ rows: [{ total: 0 }] }, { rows: [] }];
    const res = fakeRes();
    const handled = await handleMemory(
      { method: "GET" }, res, makeUrl(`${ADMIN_BASE}/memory/fragments`)
    );
    assert.equal(handled, true);
    const itemsSql = queryCalls.map(c => c.sql).find(s => s.includes("LEFT(content"));
    assert.ok(itemsSql, "목록 쿼리가 실행되어야 한다");
    assert.match(itemsSql, /LEFT\(content, 200\) AS content/);
    assert.match(itemsSql, /keywords/);
    assert.match(itemsSql, /access_count/);
  });

  it("q 파라미터가 content ILIKE 조건으로 바인딩된다 (LIKE 이스케이프 포함)", async () => {
    queryResults = [{ rows: [{ total: 0 }] }, { rows: [] }];
    const res = fakeRes();
    await handleMemory(
      { method: "GET" }, res, makeUrl(`${ADMIN_BASE}/memory/fragments?q=50%25_off`)
    );
    const call = queryCalls.find(c => c.sql.includes("content ILIKE"));
    assert.ok(call, "content ILIKE 조건이 있어야 한다");
    assert.ok(
      call.params.some(p => p === "%50\\%\\_off%"),
      `이스케이프된 패턴이 바인딩되어야 한다: ${JSON.stringify(call.params)}`
    );
  });
});

/* ── GET /memory/fragments/:id — 상세 ── */
describe("GET /memory/fragments/:id 상세", () => {
  const row = {
    id: "frag-1", content: "full content", type: "fact", topic: "t",
    keywords: ["k"], importance: 0.7, agent_id: "default", key_id: "key-1",
    case_id: null, assertion_status: "observed", resolution_status: null,
    is_anchor: false, created_at: "2026-07-14", verified_at: null,
    valid_to: null, access_count: 3
  };

  it("존재하는 id는 fragment + links를 반환한다", async () => {
    queryResults = [
      { rows: [row] },
      { rows: [{ relation_type: "resolved_by", direction: "out", id: "frag-2", type: "procedure", topic: "t", preview: "fix" }] }
    ];
    const res = fakeRes();
    const handled = await handleMemory(
      { method: "GET" }, res, makeUrl(`${ADMIN_BASE}/memory/fragments/frag-1`)
    );
    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.fragment.id, "frag-1");
    assert.equal(body.fragment.content, "full content");
    assert.equal(body.links.length, 1);
    assert.equal(body.links[0].relation_type, "resolved_by");
  });

  it("존재하지 않는 id는 404", async () => {
    queryResults = [{ rows: [] }];
    const res = fakeRes();
    await handleMemory(
      { method: "GET" }, res, makeUrl(`${ADMIN_BASE}/memory/fragments/none`)
    );
    assert.equal(res.statusCode, 404);
  });

  it("group_id 스코프에 멤버 키가 없으면 404", async () => {
    queryResults = [{ rows: [] }];
    const res = fakeRes();
    await handleMemory(
      { method: "GET" }, res, makeUrl(`${ADMIN_BASE}/memory/fragments/frag-1?group_id=g1`)
    );
    assert.equal(res.statusCode, 404);
    /** 스코프 판정 이후 파편 조회 쿼리가 실행되지 않아야 한다 */
    assert.equal(queryCalls.length, 1);
  });

  it("group_id 스코프 밖 파편은 404 (key_id ANY 조건)", async () => {
    queryResults = [
      { rows: [{ key_id: "key-other" }] },
      { rows: [] }
    ];
    const res = fakeRes();
    await handleMemory(
      { method: "GET" }, res, makeUrl(`${ADMIN_BASE}/memory/fragments/frag-1?group_id=g1`)
    );
    assert.equal(res.statusCode, 404);
    const fragCall = queryCalls[1];
    assert.match(fragCall.sql, /key_id = ANY/);
  });
});

/* ── GET /export — 필수 필터 ── */
describe("GET /export 안전장치", () => {
  it("key_id·group_id·confirm 전부 없으면 400", async () => {
    const res = fakeRes();
    const handled = await handleExport(
      { method: "GET" }, res, makeUrl(`${ADMIN_BASE}/export`)
    );
    assert.equal(handled, true);
    assert.equal(res.statusCode, 400);
    assert.equal(queryCalls.length, 0);
  });

  it("confirm=full이면 전체 반출 허용", async () => {
    queryResults = [{ rows: [{ id: "f1", content: "c" }] }];
    const res = fakeRes();
    await handleExport(
      { method: "GET" }, res, makeUrl(`${ADMIN_BASE}/export?confirm=full`)
    );
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.includes('"id":"f1"'));
  });

  it("key_id + topic은 topic ILIKE로 바인딩된다", async () => {
    queryResults = [{ rows: [] }];
    const res = fakeRes();
    await handleExport(
      { method: "GET" }, res, makeUrl(`${ADMIN_BASE}/export?key_id=key-1&topic=mem&type=fact`)
    );
    assert.equal(res.statusCode, 200);
    const call = queryCalls[0];
    assert.match(call.sql, /topic ILIKE/);
    assert.match(call.sql, /type = /);
    assert.deepEqual(call.params, ["key-1", "%mem%", "fact"]);
  });

  it("group_id 멤버가 없으면 빈 스트림으로 종료한다", async () => {
    queryResults = [{ rows: [] }];
    const res = fakeRes();
    await handleExport(
      { method: "GET" }, res, makeUrl(`${ADMIN_BASE}/export?group_id=g1`)
    );
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, "");
  });
});
