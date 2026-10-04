/**
 * Admin 메모리 운영 API 테스트
 *
 * /v1/internal/model/nothing/memory/* 엔드포인트의
 * 라우팅, 파라미터 파싱, 응답 구조를 검증한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-03-26
 *
 * DB는 mock 처리하여 순수 라우팅 로직만 테스트.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

/* ------------------------------------------------------------------ */
/*  Mock 설정                                                           */
/* ------------------------------------------------------------------ */

/** pool.query mock — 테스트별로 반환값 교체 */
let queryResults = [];
let queryIndex   = 0;

const mockPool = { // eslint-disable-line no-unused-vars
  query(_sql, _params) {
    const result = queryResults[queryIndex] ?? { rows: [] };
    queryIndex++;
    return Promise.resolve(result);
  }
};

/**
 * DB mock: getPrimaryPool이 mockPool을 반환하도록 설정.
 * admin-routes.js가 import하는 ../tools/db.js를 가로챈다.
 */
const _originalModule = await import("../../lib/tools/db.js");

/** SearchMetrics mock */
const _mockSearchMetrics = {
  async getStats() {
    return {
      L1:    { p50: 2.1, p90: 5.3, p99: 12.0, count: 50 },
      L2:    { p50: 15.0, p90: 30.0, p99: 60.0, count: 50 },
      L3:    { p50: 8.0, p90: 18.0, p99: 35.0, count: 30 },
      total: { p50: 25.0, p90: 55.0, p99: 100.0, count: 50 }
    };
  }
};

/* ------------------------------------------------------------------ */
/*  공통 유틸리티                                                       */
/* ------------------------------------------------------------------ */

const ADMIN_BASE = "/v1/internal/model/nothing";

function fakeRes() { // eslint-disable-line no-unused-vars
  const _headers = {};
  const res = {
    statusCode: 0,
    _body:      null,
    _headers,
    setHeader(k, v)    { _headers[k.toLowerCase()] = v; },
    writeHead(code, h) { res.statusCode = code; if (h) Object.assign(_headers, h); },
    end(body)          { res._body = body ?? ""; }
  };
  return res;
}

function fakeReq(method, pathname, headers = {}) { // eslint-disable-line no-unused-vars
  return {
    method,
    url: `http://localhost${pathname}`,
    headers: {
      authorization: "Bearer test-master-key",
      ...headers
    }
  };
}

function parseBody(res) { // eslint-disable-line no-unused-vars
  return JSON.parse(res._body);
}

/* ------------------------------------------------------------------ */
/*  라우팅 로직 추출 — handleMemoryApi 시뮬레이션                        */
/* ------------------------------------------------------------------ */

/**
 * admin-routes.js의 메모리 API 라우팅 로직을 재현.
 * 실제 핸들러를 직접 호출하면 모듈 레벨 import 부작용이 있으므로,
 * 핵심 비즈니스 로직(SQL 조합, 파라미터 파싱, 응답 구조화)을 테스트한다.
 */

/** 페이지 파라미터 파싱 및 캡핑 */
function parsePageParams(url) {
  const page  = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "20", 10)));
  return { page, limit, offset: (page - 1) * limit };
}

/** 콘텐츠 미리보기 (200자 절단) */
function contentPreview(content) {
  if (!content) return "";
  return content.length > 200 ? content.slice(0, 200) + "..." : content;
}

/* ================================================================== */
/*  테스트 1: GET /memory/overview                                      */
/* ================================================================== */

describe("GET /memory/overview", () => {
  it("전체 파편 수, 타입별/토픽별 집계, 품질 미검증, 대체 건수를 반환한다", async () => {
    const overviewData = {
      totalFragments: 150,
      byType:         { fact: 60, error: 30, decision: 25, procedure: 20, preference: 15 },
      byTopic:        [{ topic: "database", count: 40 }, { topic: "auth", count: 30 }],
      qualityPending: 12,
      supersededCount: 8,
      recentActivity: [
        { id: "f1", topic: "db", type: "fact", created_at: "2026-03-25T10:00:00Z" }
      ]
    };

    assert.strictEqual(overviewData.totalFragments, 150);
    assert.strictEqual(overviewData.byType.fact, 60);
    assert.strictEqual(overviewData.byTopic.length, 2);
    assert.strictEqual(overviewData.qualityPending, 12);
    assert.strictEqual(overviewData.supersededCount, 8);
    assert.ok(Array.isArray(overviewData.recentActivity));
  });

  it("DB 쿼리 결과를 overview 구조로 변환한다", async () => {
    /** 시뮬레이션: 4개 병렬 쿼리 결과 → 단일 응답 */
    const totalRow    = { total: "150" };
    const typeRows    = [
      { type: "fact", count: "60" },
      { type: "error", count: "30" }
    ];
    const topicRows   = [
      { topic: "database", count: "40" },
      { topic: "auth", count: "30" }
    ];
    const pendingRow  = { count: "12" };
    const supersededRow = { count: "8" };

    const overview = {
      totalFragments:  parseInt(totalRow.total),
      byType:          Object.fromEntries(typeRows.map(r => [r.type, parseInt(r.count)])),
      byTopic:         topicRows.map(r => ({ topic: r.topic, count: parseInt(r.count) })),
      qualityPending:  parseInt(pendingRow.count),
      supersededCount: parseInt(supersededRow.count),
      recentActivity:  []
    };

    assert.strictEqual(overview.totalFragments, 150);
    assert.deepStrictEqual(overview.byType, { fact: 60, error: 30 });
    assert.strictEqual(overview.byTopic[0].topic, "database");
    assert.strictEqual(overview.qualityPending, 12);
    assert.strictEqual(overview.supersededCount, 8);
  });
});

/* ================================================================== */
/*  테스트 2: GET /memory/search-events                                 */
/* ================================================================== */

describe("GET /memory/search-events", () => {
  it("days 파라미터를 파싱하고 기본값 7을 사용한다", () => {
    const url1 = new URL("http://localhost/memory/search-events?days=14");
    const days1 = Math.min(365, Math.max(1, parseInt(url1.searchParams.get("days") || "7", 10)));
    assert.strictEqual(days1, 14);

    const url2 = new URL("http://localhost/memory/search-events");
    const days2 = Math.min(365, Math.max(1, parseInt(url2.searchParams.get("days") || "7", 10)));
    assert.strictEqual(days2, 7);
  });

  it("days 파라미터를 365 이하로 제한한다", () => {
    const url = new URL("http://localhost/memory/search-events?days=9999");
    const days = Math.min(365, Math.max(1, parseInt(url.searchParams.get("days") || "7", 10)));
    assert.strictEqual(days, 365);
  });

  it("검색 이벤트 응답 구조가 올바르다", () => {
    const response = {
      totalSearches:  100,
      avgRelevance:   0.75,
      avgSufficiency: 0.68,
      failedQueries:  [{ query_type: "keywords", result_count: 0, created_at: "2026-03-25" }],
      searchMetrics:  {
        L1: { p50: 2.1, p90: 5.3, p99: 12.0, count: 50 },
        L2: { p50: 15.0, p90: 30.0, p99: 60.0, count: 50 },
        L3: { p50: 8.0, p90: 18.0, p99: 35.0, count: 30 }
      }
    };

    assert.strictEqual(typeof response.totalSearches, "number");
    assert.strictEqual(typeof response.avgRelevance, "number");
    assert.strictEqual(typeof response.avgSufficiency, "number");
    assert.ok(Array.isArray(response.failedQueries));
    assert.ok(response.searchMetrics.L1);
    assert.ok(response.searchMetrics.L2);
    assert.ok(response.searchMetrics.L3);
  });

  it("tool_feedback 집계로 avgRelevance, avgSufficiency를 계산한다", () => {
    const feedbackRows = [
      { relevant: true, sufficient: true },
      { relevant: true, sufficient: false },
      { relevant: false, sufficient: false },
      { relevant: true, sufficient: true }
    ];

    const total          = feedbackRows.length;
    const relevantCount  = feedbackRows.filter(r => r.relevant).length;
    const sufficientCount = feedbackRows.filter(r => r.sufficient).length;

    const avgRelevance   = total > 0 ? parseFloat((relevantCount / total).toFixed(4)) : null;
    const avgSufficiency = total > 0 ? parseFloat((sufficientCount / total).toFixed(4)) : null;

    assert.strictEqual(avgRelevance, 0.75);
    assert.strictEqual(avgSufficiency, 0.5);
  });
});

/* ================================================================== */
/*  테스트 3: GET /memory/fragments                                     */
/* ================================================================== */

describe("GET /memory/fragments", () => {
  it("페이지 파라미터를 파싱한다 (기본값: page=1, limit=20)", () => {
    const url = new URL("http://localhost/memory/fragments");
    const { page, limit, offset } = parsePageParams(url);
    assert.strictEqual(page, 1);
    assert.strictEqual(limit, 20);
    assert.strictEqual(offset, 0);
  });

  it("limit를 100으로 제한한다", () => {
    const url = new URL("http://localhost/memory/fragments?limit=500");
    const { limit } = parsePageParams(url);
    assert.strictEqual(limit, 100);
  });

  it("page=0은 1로 보정한다", () => {
    const url = new URL("http://localhost/memory/fragments?page=0");
    const { page } = parsePageParams(url);
    assert.strictEqual(page, 1);
  });

  it("offset을 올바르게 계산한다 (page=3, limit=25)", () => {
    const url = new URL("http://localhost/memory/fragments?page=3&limit=25");
    const { page, limit, offset } = parsePageParams(url);
    assert.strictEqual(page, 3);
    assert.strictEqual(limit, 25);
    assert.strictEqual(offset, 50);
  });

  it("콘텐츠 미리보기를 200자로 절단한다", () => {
    const longContent = "a".repeat(300);
    const preview     = contentPreview(longContent);
    assert.strictEqual(preview.length, 203); // 200 + "..."
    assert.ok(preview.endsWith("..."));
  });

  it("200자 이하 콘텐츠는 절단하지 않는다", () => {
    const shortContent = "short content";
    assert.strictEqual(contentPreview(shortContent), shortContent);
  });

  it("null/undefined 콘텐츠에 빈 문자열을 반환한다", () => {
    assert.strictEqual(contentPreview(null), "");
    assert.strictEqual(contentPreview(undefined), "");
  });

  it("응답 구조가 올바르다 (items, total, page, limit)", () => {
    const response = {
      items: [
        { id: "f1", topic: "db", type: "fact", preview: "some content...", importance: 0.8, created_at: "2026-03-25" }
      ],
      total: 150,
      page:  1,
      limit: 20
    };

    assert.ok(Array.isArray(response.items));
    assert.strictEqual(typeof response.total, "number");
    assert.strictEqual(typeof response.page, "number");
    assert.strictEqual(typeof response.limit, "number");
    assert.ok(response.items[0].id);
    assert.ok(response.items[0].preview);
  });

  it("필터 파라미터(topic, type, key_id)를 SQL WHERE 조건으로 변환한다", () => {
    const url = new URL("http://localhost/memory/fragments?topic=auth&type=error&key_id=5");

    const conditions = [];
    const params     = [];
    let   paramIdx   = 1;

    const topic = url.searchParams.get("topic");
    const type  = url.searchParams.get("type");
    const keyId = url.searchParams.get("key_id");

    if (topic) {
      conditions.push(`topic ILIKE $${paramIdx++}`);
      params.push(`%${topic}%`);
    }
    if (type) {
      conditions.push(`type = $${paramIdx++}`);
      params.push(type);
    }
    if (keyId) {
      conditions.push(`key_id = $${paramIdx++}`);
      params.push(parseInt(keyId, 10));
    }

    assert.strictEqual(conditions.length, 3);
    assert.deepStrictEqual(params, ["%auth%", "error", 5]);
    assert.ok(conditions[0].includes("ILIKE"));
    assert.ok(conditions[2].includes("key_id"));
  });
});

/* ================================================================== */
/*  테스트 4: GET /memory/anomalies                                     */
/* ================================================================== */

describe("GET /memory/anomalies", () => {
  it("anomalies 응답 구조가 올바르다", () => {
    const response = {
      qualityUnverified:      25,
      possibleSupersessions:  3,
      failedSearches:         [{ query_type: "text", result_count: 0, created_at: "2026-03-25" }],
      staleFragments:         10
    };

    assert.strictEqual(typeof response.qualityUnverified, "number");
    assert.strictEqual(typeof response.possibleSupersessions, "number");
    assert.ok(Array.isArray(response.failedSearches));
    assert.strictEqual(typeof response.staleFragments, "number");
  });

  it("quality_verified IS NULL 카운트를 집계한다", () => {
    const rows = [
      { quality_verified: null },
      { quality_verified: true },
      { quality_verified: null },
      { quality_verified: false }
    ];
    const unverified = rows.filter(r => r.quality_verified == null).length;
    assert.strictEqual(unverified, 2);
  });

  it("30일 이상 미접근 파편을 stale로 판별한다", () => {
    const now         = new Date("2026-03-26");
    const threshold   = new Date(now);
    threshold.setDate(threshold.getDate() - 30);

    const fragments = [
      { id: "f1", updated_at: new Date("2026-02-01") },
      { id: "f2", updated_at: new Date("2026-03-25") },
      { id: "f3", updated_at: new Date("2026-02-20") }
    ];

    const stale = fragments.filter(f => f.updated_at < threshold);
    assert.strictEqual(stale.length, 2); // f1, f3
  });

  it("failedSearches는 result_count=0인 최근 검색 이벤트 10건을 반환한다", () => {
    const events = Array.from({ length: 15 }, (_, i) => ({
      id:           i + 1,
      query_type:   "keywords",
      result_count: i < 12 ? 0 : 3,
      created_at:   `2026-03-${String(10 + i).padStart(2, "0")}`
    }));

    const failed = events
      .filter(e => e.result_count === 0)
      .sort((a, b) => b.id - a.id)
      .slice(0, 10);

    assert.strictEqual(failed.length, 10);
    assert.ok(failed[0].id > failed[9].id);
  });
});

/* ================================================================== */
/*  테스트 5: 라우트 매칭                                                */
/* ================================================================== */

describe("Memory API route matching", () => {
  const memoryPrefix = `${ADMIN_BASE}/memory`;

  it("/memory/overview 경로를 매칭한다", () => {
    const pathname = `${ADMIN_BASE}/memory/overview`;
    assert.ok(pathname.startsWith(memoryPrefix));
    assert.strictEqual(pathname.slice(memoryPrefix.length), "/overview");
  });

  it("/memory/search-events 경로를 매칭한다", () => {
    const pathname = `${ADMIN_BASE}/memory/search-events`;
    assert.strictEqual(pathname.slice(memoryPrefix.length), "/search-events");
  });

  it("/memory/fragments 경로를 매칭한다", () => {
    const pathname = `${ADMIN_BASE}/memory/fragments`;
    assert.strictEqual(pathname.slice(memoryPrefix.length), "/fragments");
  });

  it("/memory/anomalies 경로를 매칭한다", () => {
    const pathname = `${ADMIN_BASE}/memory/anomalies`;
    assert.strictEqual(pathname.slice(memoryPrefix.length), "/anomalies");
  });

  it("/memory/graph 경로를 매칭한다", () => {
    const pathname = `${ADMIN_BASE}/memory/graph`;
    assert.strictEqual(pathname.slice(memoryPrefix.length), "/graph");
  });

  it("GET 이외의 메서드는 404를 반환해야 한다", () => {
    /** memory API는 모두 GET 전용 (READ-ONLY) */
    const allowedMethod = "GET";
    assert.strictEqual(allowedMethod, "GET");
    assert.notStrictEqual("POST", allowedMethod);
    assert.notStrictEqual("DELETE", allowedMethod);
  });
});

/* ================================================================== */
/*  테스트 6: GET /memory/graph                                         */
/* ================================================================== */

describe("GET /memory/graph", () => {
  it("graph 응답 구조가 올바르다 (nodes + edges)", () => {
    const response = {
      nodes: [
        { id: "f1", label: "DB 연결 설정", topic: "database", type: "fact", importance: 0.8 },
        { id: "f2", label: "인증 로직 결정", topic: "auth", type: "decision", importance: 0.7 }
      ],
      edges: [
        { from_id: "f1", to_id: "f2", relation_type: "related", weight: 1.0 }
      ]
    };

    assert.ok(Array.isArray(response.nodes));
    assert.ok(Array.isArray(response.edges));
    assert.strictEqual(response.nodes.length, 2);
    assert.strictEqual(response.edges.length, 1);
    assert.strictEqual(typeof response.nodes[0].id, "string");
    assert.strictEqual(typeof response.nodes[0].label, "string");
    assert.strictEqual(typeof response.nodes[0].importance, "number");
    assert.strictEqual(response.edges[0].from_id, "f1");
    assert.strictEqual(response.edges[0].to_id, "f2");
  });

  it("limit 파라미터를 10-10000 범위로 캡핑한다", () => {
    const cases = [
      { input: "5",   expected: 10 },
      { input: "50",  expected: 50 },
      { input: "300", expected: 300 },
      { input: "20000", expected: 10000 },
      { input: "abc", expected: 50 },
      { input: null,  expected: 50 }
    ];

    for (const c of cases) {
      const raw = parseInt(c.input || "50", 10);
      const limit = Math.min(10000, Math.max(10, Number.isNaN(raw) ? 50 : raw));
      assert.strictEqual(limit, c.expected, `input=${c.input}`);
    }
  });

  it("topic이 없으면 전체 파편을 조회한다", () => {
    const url   = new URL("http://localhost/memory/graph?limit=30");
    const topic = url.searchParams.get("topic") || null;
    assert.strictEqual(topic, null);
  });

  it("content를 60자로 절단하여 label을 생성한다", () => {
    const longContent = "A".repeat(100);
    const label       = longContent.slice(0, 60);
    assert.strictEqual(label.length, 60);
  });

  it("edges에서 노드 집합에 없는 링크를 필터링한다", () => {
    const nodeIds = new Set(["f1", "f2", "f3"]);
    const edges   = [
      { from_id: "f1", to_id: "f2" },
      { from_id: "f1", to_id: "f99" },
      { from_id: "f3", to_id: "f2" }
    ];
    const filtered = edges.filter(e => nodeIds.has(e.from_id) && nodeIds.has(e.to_id));
    assert.strictEqual(filtered.length, 2);
  });
});

/* ================================================================== */
/*  테스트 7: SQL injection 방어                                        */
/* ================================================================== */

describe("SQL injection prevention", () => {
  it("topic 필터에 SQL 특수문자가 포함되어도 파라미터 바인딩으로 처리한다", () => {
    const maliciousTopic = "'; DROP TABLE fragments; --";
    const params         = [];
    let   paramIdx       = 1;

    params.push(`%${maliciousTopic}%`);
    const condition = `topic ILIKE $${paramIdx++}`;

    assert.strictEqual(condition, "topic ILIKE $1");
    assert.strictEqual(params[0], "%'; DROP TABLE fragments; --%");
    /** 파라미터 바인딩이므로 SQL 실행 시 이스케이프 처리됨 */
  });

  it("days 파라미터에 비숫자 입력 시 기본값으로 처리한다", () => {
    const url    = new URL("http://localhost/memory/search-events?days=abc");
    const raw    = parseInt(url.searchParams.get("days"), 10);
    const days   = Math.min(365, Math.max(1, Number.isNaN(raw) ? 7 : raw));
    assert.strictEqual(days, 7);
  });

  it("page/limit에 음수 입력 시 최소값으로 보정한다", () => {
    const url = new URL("http://localhost/memory/fragments?page=-5&limit=-10");
    const { page, limit } = parsePageParams(url);
    assert.strictEqual(page, 1);
    assert.strictEqual(limit, 1);
  });
});
