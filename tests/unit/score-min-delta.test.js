/**
 * 재기록 최소 변화량 설정 단위 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */
import { describe, it, afterEach } from "node:test";
import assert                       from "node:assert/strict";
import { changedRowsSpec, minDeltaFromEnv } from "../../lib/memory/consolidate/idOrderedUpdate.js";

afterEach(() => {
  delete process.env.MEMENTO_DECAY_MIN_DELTA;
  delete process.env.MEMENTO_UTILITY_MIN_DELTA;
});

describe("minDeltaFromEnv", () => {
  it("미설정, 0, 음수, 숫자가 아닌 값은 0이다", () => {
    assert.equal(minDeltaFromEnv("MEMENTO_DECAY_MIN_DELTA"), 0);
    for (const v of ["0", "-0.1", "abc", ""]) {
      process.env.MEMENTO_DECAY_MIN_DELTA = v;
      assert.equal(minDeltaFromEnv("MEMENTO_DECAY_MIN_DELTA"), 0, v);
    }
  });

  it("양수는 그대로, 1을 넘으면 1이다", () => {
    process.env.MEMENTO_DECAY_MIN_DELTA = "0.01";
    assert.equal(minDeltaFromEnv("MEMENTO_DECAY_MIN_DELTA"), 0.01);
    process.env.MEMENTO_DECAY_MIN_DELTA = "5";
    assert.equal(minDeltaFromEnv("MEMENTO_DECAY_MIN_DELTA"), 1);
  });
});

describe("changedRowsSpec", () => {
  const spec = { stored: "utility_score", computed: "EXPR", minDeltaEnv: "MEMENTO_UTILITY_MIN_DELTA" };

  it("미설정이면 real 비교 조건이고 매개변수가 없다", () => {
    assert.deepEqual(changedRowsSpec(spec), {
      where : "utility_score IS DISTINCT FROM (EXPR)::real",
      params: []
    });
  });

  it("설정되면 NULL 또는 차이 초과 조건이고 최소 변화량이 $4다", () => {
    process.env.MEMENTO_UTILITY_MIN_DELTA = "0.01";
    assert.deepEqual(changedRowsSpec(spec), {
      where : "utility_score IS NULL OR ABS(utility_score - (EXPR)) > $4",
      params: [0.01]
    });
  });
});
