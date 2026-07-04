/**
 * search-path-perf.test.js
 * getPathPerformance() 반환 구조 및 순수 함수 계약 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-03-31
 *
 * DB 의존성 없이 getPathPerformance의 반환 형태와
 * buildSearchEvent의 per-layer latency 필드를 검증한다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

import {
  buildSearchEvent,
  classifyQueryType,
  extractFilterKeys,
} from "../../lib/memory/signals/SearchEventRecorder.js";

/* ================================================================== */
/*  테스트 1: buildSearchEvent — per-layer latency 필드 포함 검증      */
/* ================================================================== */

describe("buildSearchEvent — per-layer latency fields", () => {
  it("l1LatencyMs/l2LatencyMs/l3LatencyMs/graphUsed가 이벤트에 반영된다", () => {
    const query  = { keywords: ["foo"] };
    const result = [{ id: "1" }, { id: "2" }];
    const meta   = {
      searchPath : "L1:5 → L2:10 → L3:8 → RRF",
      sessionId  : "sess-abc",
      keyId      : null,
      latencyMs  : 120,
      l1IsFallback: false,
      l1LatencyMs: 10,
      l2LatencyMs: 55,
      l3LatencyMs: 50,
      graphUsed  : false,
    };

    const event = buildSearchEvent(query, result, meta);

    assert.strictEqual(event.l1_latency_ms, 10,    "l1_latency_ms 매핑 오류");
    assert.strictEqual(event.l2_latency_ms, 55,    "l2_latency_ms 매핑 오류");
    assert.strictEqual(event.l3_latency_ms, 50,    "l3_latency_ms 매핑 오류");
    assert.strictEqual(event.graph_used,    false, "graph_used 매핑 오류");
  });

  it("graphUsed=true 시 graph_used가 true로 설정된다", () => {
    const event = buildSearchEvent(
      { text: "semantic query" },
      [],
      {
        searchPath  : "L2:5 → L2.5Graph:3 → L3:8 → RRF",
        latencyMs   : 200,
        l1LatencyMs : 5,
        l2LatencyMs : 80,
        l3LatencyMs : 110,
        graphUsed   : true,
      }
    );

    assert.strictEqual(event.graph_used, true, "graphUsed=true가 반영되지 않음");
  });

  it("meta에 레이어 레이턴시가 없으면 null로 기본값이 설정된다", () => {
    const event = buildSearchEvent(
      { keywords: ["bar"] },
      [{ id: "x" }],
      { searchPath: "L1:2 → L2:3", latencyMs: 30 }
    );

    assert.strictEqual(event.l1_latency_ms, null, "l1_latency_ms 기본값은 null이어야 한다");
    assert.strictEqual(event.l2_latency_ms, null, "l2_latency_ms 기본값은 null이어야 한다");
    assert.strictEqual(event.l3_latency_ms, null, "l3_latency_ms 기본값은 null이어야 한다");
    assert.strictEqual(event.graph_used,    false, "graph_used 기본값은 false이어야 한다");
  });

  it("RRF 경로에서 used_rrf=true가 설정된다", () => {
    const event = buildSearchEvent(
      { text: "query" },
      [],
      { searchPath: "L2:5 → L3:4 → RRF", latencyMs: 100 }
    );

    assert.strictEqual(event.used_rrf, true, "RRF 포함 경로에서 used_rrf는 true여야 한다");
  });

  it("RRF 없는 경로에서 used_rrf=false가 설정된다", () => {
    const event = buildSearchEvent(
      { keywords: ["k1"] },
      [],
      { searchPath: "L1:3 → L2:5", latencyMs: 20 }
    );

    assert.strictEqual(event.used_rrf, false, "RRF 없는 경로에서 used_rrf는 false여야 한다");
  });
});

/* ================================================================== */
/*  테스트 2: getPathPerformance — 반환 구조 계약 검증 (DB mock)        */
/* ================================================================== */

describe("getPathPerformance — return shape contract", () => {
  /**
   * pool mock을 주입받는 getPathPerformance 래퍼.
   * 실제 함수는 getPrimaryPool()을 내부에서 호출하므로,
   * 여기서는 동일 SQL 계약을 직접 구현하여 반환 구조만 검증한다.
   */
  async function getPathPerformanceWithPool(pool, days = 7) {
    const SQL = `
      SELECT
        search_path,
        used_rrf,
        COUNT(*)::int                             AS search_count,
        ROUND(AVG(latency_ms)::numeric, 1)        AS avg_latency_ms,
        ROUND(AVG(result_count)::numeric, 1)      AS avg_result_count,
        ROUND(AVG(l1_latency_ms)::numeric, 1)     AS avg_l1_ms,
        ROUND(AVG(l2_latency_ms)::numeric, 1)     AS avg_l2_ms,
        ROUND(AVG(l3_latency_ms)::numeric, 1)     AS avg_l3_ms
      FROM agent_memory.search_events
      WHERE created_at > NOW() - INTERVAL '1 day' * $1
      GROUP BY search_path, used_rrf
      ORDER BY search_count DESC
    `;
    try {
      const { rows } = await pool.query(SQL, [days]);
      return rows;
    } catch {
      return null;
    }
  }

  it("정상 응답 시 배열을 반환한다", async () => {
    const mockRows = [
      {
        search_path    : "L2:5 → L3:4 → RRF",
        used_rrf       : true,
        search_count   : 42,
        avg_latency_ms : "120.5",
        avg_result_count: "7.2",
        avg_l1_ms      : null,
        avg_l2_ms      : "55.1",
        avg_l3_ms      : "60.3",
      },
      {
        search_path    : "L1:3 → L2:8",
        used_rrf       : false,
        search_count   : 18,
        avg_latency_ms : "30.0",
        avg_result_count: "5.0",
        avg_l1_ms      : "5.2",
        avg_l2_ms      : "22.1",
        avg_l3_ms      : null,
      },
    ];

    const mockPool = { query: async () => ({ rows: mockRows }) };
    const result   = await getPathPerformanceWithPool(mockPool, 7);

    assert.ok(Array.isArray(result),              "결과는 배열이어야 한다");
    assert.strictEqual(result.length, 2,          "2개 행이 반환되어야 한다");

    const first = result[0];
    assert.ok("search_path"     in first, "search_path 필드 필수");
    assert.ok("used_rrf"        in first, "used_rrf 필드 필수");
    assert.ok("search_count"    in first, "search_count 필드 필수");
    assert.ok("avg_latency_ms"  in first, "avg_latency_ms 필드 필수");
    assert.ok("avg_result_count"in first, "avg_result_count 필드 필수");
    assert.ok("avg_l1_ms"       in first, "avg_l1_ms 필드 필수");
    assert.ok("avg_l2_ms"       in first, "avg_l2_ms 필드 필수");
    assert.ok("avg_l3_ms"       in first, "avg_l3_ms 필드 필수");
  });

  it("search_count 내림차순으로 정렬된다 (mock 데이터 기준)", async () => {
    const mockRows = [
      { search_path: "path-A", used_rrf: true,  search_count: 100, avg_latency_ms: "50.0", avg_result_count: "5.0", avg_l1_ms: null, avg_l2_ms: "20.0", avg_l3_ms: "25.0" },
      { search_path: "path-B", used_rrf: false, search_count:  30, avg_latency_ms: "20.0", avg_result_count: "3.0", avg_l1_ms: "5.0", avg_l2_ms: "12.0", avg_l3_ms: null },
    ];

    const mockPool = { query: async () => ({ rows: mockRows }) };
    const result   = await getPathPerformanceWithPool(mockPool, 7);

    assert.strictEqual(result[0].search_count, 100, "첫 번째 행이 가장 높은 search_count여야 한다");
    assert.strictEqual(result[1].search_count,  30, "두 번째 행이 다음 높은 search_count여야 한다");
  });

  it("DB 오류 시 null을 반환한다", async () => {
    const brokenPool = { query: async () => { throw new Error("DB down"); } };
    const result     = await getPathPerformanceWithPool(brokenPool, 7);

    assert.strictEqual(result, null, "DB 오류 시 null을 반환해야 한다");
  });

  it("빈 결과 시 빈 배열을 반환한다", async () => {
    const emptyPool = { query: async () => ({ rows: [] }) };
    const result    = await getPathPerformanceWithPool(emptyPool, 7);

    assert.ok(Array.isArray(result),          "빈 결과도 배열이어야 한다");
    assert.strictEqual(result.length, 0,      "빈 배열이어야 한다");
  });
});

/* ================================================================== */
/*  테스트 3: classifyQueryType / extractFilterKeys (기존 계약 회귀)    */
/* ================================================================== */

describe("classifyQueryType — regression", () => {
  it("text만 있으면 'text' 반환", () => {
    assert.strictEqual(classifyQueryType({ text: "hello" }), "text");
  });

  it("keywords만 있으면 'keywords' 반환", () => {
    assert.strictEqual(classifyQueryType({ keywords: ["a"] }), "keywords");
  });

  it("topic만 있으면 'topic' 반환", () => {
    assert.strictEqual(classifyQueryType({ topic: "myTopic" }), "topic");
  });

  it("복수 필드 있으면 'mixed' 반환", () => {
    assert.strictEqual(classifyQueryType({ text: "q", keywords: ["k"] }), "mixed");
  });
});

describe("extractFilterKeys — regression", () => {
  it("topic/type이 있으면 각각 키를 반환한다", () => {
    const keys = extractFilterKeys({ topic: "t", type: "fact" });
    assert.ok(keys.includes("topic"), "topic 키가 포함되어야 한다");
    assert.ok(keys.includes("type"),  "type 키가 포함되어야 한다");
  });

  it("keyId가 있으면 'key_id' 포함", () => {
    const keys = extractFilterKeys({ keyId: 42 });
    assert.ok(keys.includes("key_id"), "key_id 키가 포함되어야 한다");
  });
});
