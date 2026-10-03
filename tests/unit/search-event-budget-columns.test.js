/**
 * search_events 예산 선택 열(마이그레이션 051)이 없는 DB에서의 기록
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */

import { describe, it, beforeEach, mock } from "node:test";
import assert                             from "node:assert/strict";

const queries = [];
let   respond = async () => ({ rows: [{ id: 1 }] });
const warn    = mock.fn();

mock.module("../../lib/tools/db.js", {
  namedExports: {
    getPrimaryPool: () => ({
      query: async (sql, params) => {
        queries.push({ sql, params });
        return respond(sql, params);
      }
    })
  }
});
mock.module("../../lib/logger.js", {
  namedExports: { logWarn: warn, logInfo: mock.fn(), logError: mock.fn(), logDebug: mock.fn() }
});

const {
  recordSearchEvent, buildSearchEvent, budgetColumnState, resetBudgetColumnState, BUDGET_COLUMN_REPROBE_MS
} = await import("../../lib/memory/signals/SearchEventRecorder.js");

const event   = buildSearchEvent({ keywords: ["a"] }, [{ id: "x" }], { searchPath: "L2:1", candidateCount: 7, budgetKept: 3 });
const missing = () => Object.assign(new Error('column "candidate_count" of relation "search_events" does not exist'), { code: "42703" });
const hasBudgetColumns = (sql) => sql.includes("candidate_count") && sql.includes("budget_kept");

beforeEach(() => {
  queries.length = 0;
  warn.mock.resetCalls();
  resetBudgetColumnState();
  respond = async () => ({ rows: [{ id: 1 }] });
});

describe("search_events 예산 선택 열", () => {
  it("열이 있으면 20개 값을 기록하고 present가 된다", async () => {
    const id = await recordSearchEvent(event, 1000);
    assert.equal(id, 1);
    assert.equal(queries.length, 1);
    assert.ok(hasBudgetColumns(queries[0].sql));
    assert.equal(queries[0].params.length, 20);
    assert.deepEqual(queries[0].params.slice(18), [7, 3]);
    assert.equal(budgetColumnState().status, "present");
  });

  it("42703이 한 번 나면 경고 한 번과 함께 18열로 다시 기록해 id를 돌려준다", async () => {
    respond = async (sql) => {
      if (hasBudgetColumns(sql)) throw missing();
      return { rows: [{ id: 2 }] };
    };
    const id = await recordSearchEvent(event, 1000);
    assert.equal(id, 2);
    assert.equal(queries.length, 2);
    assert.ok(!hasBudgetColumns(queries[1].sql));
    assert.equal(queries[1].params.length, 18);
    assert.deepEqual(queries[1].params, queries[0].params.slice(0, 18));
    assert.equal(warn.mock.callCount(), 1);
    assert.deepEqual(budgetColumnState(), { status: "absent", checkedAt: 1000 });
  });

  it("absent 동안은 18열 문장만 쓰고, 확인 간격이 지나면 20열을 다시 시도한다", async () => {
    respond = async (sql) => {
      if (hasBudgetColumns(sql)) throw missing();
      return { rows: [{ id: 3 }] };
    };
    await recordSearchEvent(event, 1000);
    queries.length = 0;

    assert.equal(await recordSearchEvent(event, 1000 + BUDGET_COLUMN_REPROBE_MS - 1), 3);
    assert.equal(queries.length, 1);
    assert.ok(!hasBudgetColumns(queries[0].sql));

    /** 간격이 지난 뒤에도 열이 없으면 다시 absent, 경고는 더 남기지 않는다 */
    queries.length = 0;
    assert.equal(await recordSearchEvent(event, 1000 + BUDGET_COLUMN_REPROBE_MS), 3);
    assert.equal(queries.length, 2);
    assert.equal(warn.mock.callCount(), 1);
    assert.equal(budgetColumnState().checkedAt, 1000 + BUDGET_COLUMN_REPROBE_MS);

    /** 마이그레이션 적용 뒤 확인 간격이 지나면 20열로 돌아온다 */
    respond = async () => ({ rows: [{ id: 4 }] });
    queries.length = 0;
    assert.equal(await recordSearchEvent(event, 1000 + 2 * BUDGET_COLUMN_REPROBE_MS), 4);
    assert.equal(queries.length, 1);
    assert.ok(hasBudgetColumns(queries[0].sql));
    assert.equal(budgetColumnState().status, "present");
  });

  it("다른 오류는 다시 시도하지 않고 null을 돌려준다", async () => {
    respond = async () => { throw Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }); };
    assert.equal(await recordSearchEvent(event, 1000), null);
    assert.equal(queries.length, 1);
    assert.equal(budgetColumnState().status, "unknown");
  });

  it("다른 열의 42703은 예산 선택 열 부재로 보지 않는다", async () => {
    respond = async () => { throw Object.assign(new Error('column "graph_used" does not exist'), { code: "42703" }); };
    assert.equal(await recordSearchEvent(event, 1000), null);
    assert.equal(queries.length, 1);
    assert.equal(budgetColumnState().status, "unknown");
  });
});
