/**
 * 관리 /stats DB 집계 재사용 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-11-04
 */
import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

let failNext = false;
const health = mock.fn(async () => {
  if (failNext) { failNext = false; throw new Error("db down"); }
  return { total: 1, live: 1, verified: 0, embeddingBacklog: 0, qualityPending: 0, stale: 0 };
});
mock.module("../../lib/admin/FragmentHealth.js", { namedExports: { countFragmentHealth: health } });
mock.module("../../lib/memory/signals/SearchEventAnalyzer.js", {
  namedExports: { getSearchObservability: async () => ({}), getPathPerformance: async () => [] }
});

const { loadStatsAggregates, resetStatsAggregates } = await import("../../lib/admin/stats-aggregates.js");
const pool = { query: async (sql) => ({ rows: [/pg_database_size/.test(sql) ? { bytes: "10" } : /SUM\(call_count\)/.test(sql) ? { total: "3", tool_calls: "2" } : { total: "4" }] }) };

beforeEach(() => { resetStatsAggregates(); health.mock.resetCalls(); delete process.env.MEMENTO_ADMIN_STATS_CACHE_MS; });

describe("loadStatsAggregates", () => {
  it("같은 범위는 재사용 시간 안에 한 번만 계산하고 시간이 지나면 다시 계산한다", async () => {
    const a = await loadStatsAggregates(pool, { all: true }, 1_000);
    await loadStatsAggregates(pool, { all: true }, 30_000);
    assert.equal(health.mock.callCount(), 1);
    assert.equal(a.apiCallsToday, 3);
    await loadStatsAggregates(pool, { all: true }, 70_000);
    assert.equal(health.mock.callCount(), 2);
  });

  it("실패한 계산은 남기지 않고, 0이면 재사용하지 않는다", async () => {
    failNext = true;
    await assert.rejects(loadStatsAggregates(pool, { all: true }, 1_000));
    await loadStatsAggregates(pool, { all: true }, 2_000);
    assert.equal(health.mock.callCount(), 2);
    process.env.MEMENTO_ADMIN_STATS_CACHE_MS = "0";
    await loadStatsAggregates(pool, { all: true }, 3_000);
    await loadStatsAggregates(pool, { all: true }, 3_000);
    assert.equal(health.mock.callCount(), 4);
  });
});
