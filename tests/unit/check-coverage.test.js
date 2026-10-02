/**
 * 커버리지 하한 점검 함수 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

import { parseLcov, summarize, findDrops, planWrite } from "../../scripts/check-coverage.js";

const LCOV = [
  "TN:", "SF:lib/a.js", "FNF:4", "FNH:2", "BRF:10", "BRH:5", "LF:100", "LH:80", "end_of_record",
  "TN:", "SF:lib/b.js", "FNF:0", "FNH:0", "BRF:0", "BRH:0", "LF:100", "LH:60", "end_of_record",
  "TN:", "SF:tests/x.test.js", "LF:10", "LH:10", "end_of_record", ""
].join("\n");

describe("check-coverage", () => {
  it("파일별 기록을 읽는다", () => {
    const recs = parseLcov(LCOV);
    assert.equal(recs.length, 3);
    assert.deepEqual(recs[0].lines, [80, 100]);
    assert.deepEqual(recs[0].functions, [2, 4]);
  });

  it("포함 조건에 맞는 파일만 합산한다", () => {
    const sum = summarize(parseLcov(LCOV), f => f.startsWith("lib/"));
    assert.deepEqual(sum, { lines: 70, branches: 50, functions: 50, files: 2 });
  });

  it("허용 폭 안의 하락은 통과하고 넘으면 지표 이름을 돌려준다", () => {
    const baseline = { lines: 76.43, branches: 74.68, functions: 63.13, tolerance: 0.5 };
    assert.deepEqual(findDrops({ lines: 76.0, branches: 74.3, functions: 62.7 }, baseline), []);
    const drops = findDrops({ lines: 75.9, branches: 74.68, functions: 63.13 }, baseline);
    assert.equal(drops.length, 1);
    assert.match(drops[0], /^lines: 75\.9% < 75\.93%/);
  });

  it("같은 입력은 항상 같은 합계를 낸다", () => {
    const recs = parseLcov(LCOV);
    assert.deepEqual(summarize(recs), summarize(parseLcov(LCOV)));
  });
});

describe("planWrite", () => {
  const prev = { lines: 76.43, branches: 74.68, functions: 63.13, tolerance: 0.5 };

  it("오른 값은 기록하고 허용 폭을 보존한다", () => {
    const plan = planWrite({ lines: 80, branches: 75, functions: 64, files: 3 }, prev, false);
    assert.deepEqual(plan, {
      ok  : true,
      next: { lines: 80, branches: 75, functions: 64, tolerance: 0.5 },
      lowered: []
    });
  });

  it("기준선보다 낮아지는 값은 허용 옵션 없이는 기록하지 않는다", () => {
    const plan = planWrite({ lines: 76.0, branches: 75, functions: 64, files: 3 }, prev, false);
    assert.equal(plan.ok, false);
    assert.equal(plan.lowered.length, 1);
    assert.match(plan.lowered[0], /^lines: 76% < 76\.43%/);
    assert.equal(planWrite({ lines: 76.0, branches: 75, functions: 64, files: 3 }, prev, true).ok, true);
  });

  it("기준선이 없으면 허용 폭 기본값 0.5로 처음 기록한다", () => {
    const plan = planWrite({ lines: 70, branches: 60, functions: 50, files: 3 }, null, false);
    assert.equal(plan.ok, true);
    assert.equal(plan.next.tolerance, 0.5);
  });
});
