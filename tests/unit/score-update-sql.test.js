/**
 * 점수 갱신 SQL 구조 검사
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * utility_score는 real 컬럼이므로 변경 판정도 real로 맞춰야 저장값이 같은 행을
 * 다시 쓰지 않는다. 하한에 있는 importance는 하향 대상에서 뺀다.
 */
import { describe, it, mock } from "node:test";
import assert                  from "node:assert/strict";

process.env.MEMENTO_SCORE_UPDATE_BATCH = "0";

const calls = [];
mock.module("../../lib/tools/db.js", {
  namedExports: {
    getPrimaryPool       : () => ({ query: async (sql) => { calls.push(sql); return { rows: [] }; } }),
    /** 대상 조건이 잠금 문장에 있는 갱신은 두 문장을 이어 붙여 기록한다. */
    queryWithAgentVector : async (_agent, sql, _params, opts) => {
      calls.push(opts?.lock ? `${sql}\n${opts.lock.sql}` : sql);
      return { rows: [], rowCount: 0 };
    },
    withTransaction      : async () => { throw new Error("unused"); }
  }
});

const { MemoryConsolidator } = await import("../../lib/memory/consolidate/MemoryConsolidator.js");

describe("utility_score 갱신 조건", () => {
  it("변경 판정을 real 형으로 한다", async () => {
    calls.length = 0;
    await MemoryConsolidator.prototype._updateUtilityScores.call({});
    const sql = calls.find(s => /SET utility_score/.test(s));
    assert.ok(sql, "utility 갱신 문장이 실행되어야 한다");
    assert.match(sql, /IS DISTINCT FROM\s*\(([\s\S]*)\)::real/);
  });
});

describe("calibrate stale 하향 조건", () => {
  it("하한 0.05인 행을 제외한다", async () => {
    mock.module("../../lib/redis.js", {
      namedExports: { redisClient: { status: "ready" }, pushToQueue: async () => {} }
    });
    mock.module("../../lib/memory/processors/SessionActivityTracker.js", {
      namedExports: { SessionActivityTracker: { getActivity: async () => null } }
    });
    const { ConsolidatorGC } = await import("../../lib/memory/consolidate/ConsolidatorGC.js");
    calls.length = 0;
    await new ConsolidatorGC().calibrateByFeedback();
    const sql = calls.find(s => /importance \* 0\.5/.test(s));
    assert.ok(sql, "stale 하향 문장이 실행되어야 한다");
    assert.match(sql, /importance <> 0\.05::real/);
  });
});
