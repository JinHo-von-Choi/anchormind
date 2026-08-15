/**
 * MemoryConsolidator.getStats — workspaces 필드 통합 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-08-15
 *
 * getPrimaryPool()을 순서 보장 mock으로 대체해 getStats()가 발행하는
 * 4개 쿼리(기존 집계 + workspace 분포 + 키 기입률 + 세션 분포)의 결과를
 * workspaces 필드로 올바르게 조립하는지 검증한다.
 * 실제 DB 연결 없이 순수 로직만 검증하기 위해 lib/tools/db.js를 모킹한다.
 */

import { describe, it, before } from "node:test";
import assert                    from "node:assert/strict";
import { mock }                  from "node:test";

const queryResponses = [];
let   queryCallLog    = [];

mock.module("../../lib/tools/db.js", {
  exports: {
    getPrimaryPool: () => ({
      query: async (sql) => {
        queryCallLog.push(sql);
        return queryResponses.shift() ?? { rows: [] };
      }
    }),
    getBatchPool        : () => null,
    shutdownPool        : async () => undefined,
    getPoolStats        : () => ({}),
    queryWithAgentVector: async () => ({ rows: [], rowCount: 0 }),
    withTransaction     : async (pool, fn) => fn(pool)
  }
});

mock.module("../../lib/redis.js", {
  exports: {
    pushToQueue : async () => undefined,
    redisClient : null
  }
});

mock.module("../../lib/logger.js", {
  exports: {
    logInfo : () => {},
    logWarn : () => {},
    logError: () => {},
    logDebug: () => {}
  }
});

describe("MemoryConsolidator.getStats — workspaces 필드", () => {
  let MemoryConsolidator;

  before(async () => {
    const mod           = await import("../../lib/memory/consolidate/MemoryConsolidator.js");
    MemoryConsolidator  = mod.MemoryConsolidator;
  });

  it("4개 쿼리 결과를 workspaces.{distribution,key_fill_rate,session_fragment_distribution}로 조립한다", async () => {
    queryCallLog = [];
    queryResponses.length = 0;
    queryResponses.push(
      { rows: [{
        total: "4", permanent: "0", hot: "4", warm: "0", cold: "0", embedded: "4",
        avg_importance: "0.5", topic_count: "1", error_count: "0", preference_count: "0",
        decision_count: "0", procedure_count: "0", fact_count: "4", relation_count: "0",
        total_accesses: "0", avg_utility: "0", total_tokens: "0"
      }] },
      { rows: [{ workspace: "memento", cnt: "3" }, { workspace: null, cnt: "1" }] },
      { rows: [{ key_id: "key-1", key_name: "claude-code", total: "4", with_workspace: "3" }] },
      { rows: [{ session_id: "s1", cnt: "2" }, { session_id: "s2", cnt: "4" }] }
    );

    const consolidator = new MemoryConsolidator();
    const stats         = await consolidator.getStats();

    assert.strictEqual(queryCallLog.length, 4, "getStats는 정확히 4개의 쿼리를 실행해야 한다");
    assert.strictEqual(stats.workspaces.distribution.null_count, 1);
    assert.strictEqual(stats.workspaces.distribution.top[0].workspace, "memento");
    assert.strictEqual(stats.workspaces.distribution.top[0].count, 3);
    assert.strictEqual(stats.workspaces.key_fill_rate[0].fill_rate, 0.75);
    assert.strictEqual(stats.workspaces.session_fragment_distribution.max, 4);
    assert.strictEqual(stats.workspaces.session_fragment_distribution.sample_sessions, 2);
  });

  it("workspace/session 그룹 쿼리가 비어 있으면 빈 구조를 반환한다", async () => {
    queryCallLog = [];
    queryResponses.length = 0;
    queryResponses.push(
      { rows: [{
        total: "0", permanent: "0", hot: "0", warm: "0", cold: "0", embedded: "0",
        avg_importance: "0", topic_count: "0", error_count: "0", preference_count: "0",
        decision_count: "0", procedure_count: "0", fact_count: "0", relation_count: "0",
        total_accesses: "0", avg_utility: "0", total_tokens: "0"
      }] },
      { rows: [] },
      { rows: [] },
      { rows: [] }
    );

    const consolidator = new MemoryConsolidator();
    const stats         = await consolidator.getStats();

    assert.deepStrictEqual(stats.workspaces.distribution, { top: [], null_count: 0, distinct_count: 0 });
    assert.deepStrictEqual(stats.workspaces.key_fill_rate, []);
    assert.strictEqual(stats.workspaces.session_fragment_distribution.sample_sessions, 0);
    assert.strictEqual(stats.workspaces.session_fragment_distribution.p50, null);
  });

});
