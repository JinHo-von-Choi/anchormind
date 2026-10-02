/**
 * 재기록 최소 변화량 설정 단위 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */
import { describe, it, mock, beforeEach, afterEach } from "node:test";
import assert                                         from "node:assert/strict";

const warnings = [];
mock.module("../../lib/logger.js", {
  exports: {
    logWarn : (message) => { warnings.push(message); },
    logInfo : () => {},
    logError: () => {},
    logDebug: () => {}
  }
});

const { changedRowsSpec, minDeltaFromEnv } = await import("../../lib/memory/consolidate/idOrderedUpdate.js");
const { scoreMinDeltaEnv }                 = await import("../../lib/config.js");

beforeEach(() => { warnings.length = 0; });
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

  it("값을 바꿀 때만 경고를 한 번 남긴다", () => {
    for (const v of [undefined, "", "0", "0.01", "1"]) {
      if (v === undefined) delete process.env.MEMENTO_DECAY_MIN_DELTA;
      else process.env.MEMENTO_DECAY_MIN_DELTA = v;
      minDeltaFromEnv("MEMENTO_DECAY_MIN_DELTA");
    }
    assert.equal(warnings.length, 0);

    for (const v of ["abc", "-0.1", "5"]) {
      warnings.length = 0;
      process.env.MEMENTO_DECAY_MIN_DELTA = v;
      minDeltaFromEnv("MEMENTO_DECAY_MIN_DELTA");
      assert.equal(warnings.length, 1, v);
      assert.match(warnings[0], /MEMENTO_DECAY_MIN_DELTA/);
    }
  });

  it("지원하지 않는 환경 변수 이름은 거부한다", () => {
    assert.throws(() => scoreMinDeltaEnv("PATH"), RangeError);
    assert.throws(() => minDeltaFromEnv("MEMENTO_SCORE_UPDATE_BATCH"), RangeError);
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

  it("설정되면 NULL 또는 real 기준 차이 초과 조건이고 최소 변화량이 $4다", () => {
    process.env.MEMENTO_UTILITY_MIN_DELTA = "0.01";
    assert.deepEqual(changedRowsSpec(spec), {
      where : "utility_score IS NULL OR ABS(utility_score - (EXPR)::real) > $4::real",
      params: [0.01]
    });
  });

  it("1e-7 미만의 작은 값도 같은 real 비교 형태를 쓴다", () => {
    process.env.MEMENTO_UTILITY_MIN_DELTA = "1e-9";
    const { where, params } = changedRowsSpec(spec);
    assert.deepEqual(params, [1e-9]);
    assert.match(where, /\(EXPR\)::real\) > \$4::real$/);
  });
});
