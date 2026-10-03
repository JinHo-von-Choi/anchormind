/**
 * 짝지은 부트스트랩 순수 함수 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */

import { test, describe } from "node:test";
import assert             from "node:assert/strict";

import {
  createRng, pairedBootstrap, compareRuns, BootstrapInputError, COMPARE_METRICS
} from "../../lib/memory/signals/PairedBootstrap.js";

describe("createRng", () => {
  test("같은 시드는 같은 수열, 다른 시드는 다른 수열", () => {
    const a = createRng(7), b = createRng(7), c = createRng(8);
    const seqA = Array.from({ length: 5 }, a), seqB = Array.from({ length: 5 }, b), seqC = Array.from({ length: 5 }, c);
    assert.deepEqual(seqA, seqB);
    assert.notDeepEqual(seqA, seqC);
  });

  test("값은 0 이상 1 미만이다", () => {
    const rng = createRng(1);
    for (let i = 0; i < 1000; i++) {
      const v = rng();
      assert.ok(v >= 0 && v < 1);
    }
  });
});

describe("pairedBootstrap", () => {
  const baseline  = [0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 1, 0];
  const candidate = [1, 0, 1, 1, 1, 0, 1, 1, 0, 1, 1, 0];

  test("같은 입력과 시드는 같은 결과를 낸다", () => {
    assert.deepEqual(pairedBootstrap(baseline, candidate, { seed: 42 }), pairedBootstrap(baseline, candidate, { seed: 42 }));
  });

  test("시드가 다르면 구간 끝이 달라질 수 있고 평균 차이는 같다", () => {
    const x = [0.1, 0.4, 0.35, 0.8, 0.15, 0.5, 0.65, 0.2, 0.9, 0.05];
    const y = [0.3, 0.38, 0.9, 0.85, 0.1, 0.77, 0.6, 0.45, 0.95, 0.4];
    const a = pairedBootstrap(x, y, { seed: 1, iterations: 500 });
    const b = pairedBootstrap(x, y, { seed: 2, iterations: 500 });
    assert.equal(a.mean_diff, b.mean_diff);
    assert.ok(a.ci_low !== b.ci_low || a.ci_high !== b.ci_high);
  });

  test("평균 차이는 후보 - 기준이다", () => {
    const r = pairedBootstrap([0, 0, 0, 0], [1, 1, 0, 0], { seed: 1 });
    assert.equal(r.mean_diff, 0.5);
  });

  test("구간은 평균 차이를 감싸고 순서가 맞다", () => {
    const r = pairedBootstrap(baseline, candidate, { seed: 3 });
    assert.ok(r.ci_low <= r.mean_diff && r.mean_diff <= r.ci_high);
    assert.ok(r.ci_low > 0, "후보가 일관되게 앞선 입력에서 하한이 0을 넘어야 한다");
  });

  test("차이가 모두 같으면 구간이 한 점이다", () => {
    const r = pairedBootstrap([0, 0, 0], [1, 1, 1], { seed: 5 });
    assert.equal(r.ci_low, 1);
    assert.equal(r.ci_high, 1);
    const same = pairedBootstrap([2, 3], [2, 3], { seed: 5 });
    assert.deepEqual([same.mean_diff, same.ci_low, same.ci_high], [0, 0, 0]);
  });

  test("차이의 부호가 섞이면 구간이 0을 포함한다", () => {
    const r = pairedBootstrap([1, 0, 1, 0, 1, 0, 1, 0], [0, 1, 0, 1, 0, 1, 0, 1], { seed: 9 });
    assert.ok(r.ci_low < 0 && r.ci_high > 0);
  });

  test("기준과 후보를 바꾸면 구간 부호가 뒤집힌다", () => {
    const fwd = pairedBootstrap(baseline, candidate, { seed: 11 });
    const rev = pairedBootstrap(candidate, baseline, { seed: 11 });
    assert.equal(rev.mean_diff, -fwd.mean_diff);
    assert.ok(rev.ci_high < 0);
  });

  test("신뢰수준이 높을수록 구간이 넓다", () => {
    const narrow = pairedBootstrap(baseline, candidate, { seed: 4, confidence: 0.5 });
    const wide   = pairedBootstrap(baseline, candidate, { seed: 4, confidence: 0.99 });
    assert.ok(wide.ci_high - wide.ci_low >= narrow.ci_high - narrow.ci_low);
  });

  test("입력을 변형하지 않는다", () => {
    const a = [1, 2, 3], b = [2, 3, 4];
    pairedBootstrap(a, b, { seed: 1, iterations: 50 });
    assert.deepEqual(a, [1, 2, 3]);
    assert.deepEqual(b, [2, 3, 4]);
  });

  test("빈 입력은 null 구간", () => {
    const r = pairedBootstrap([], [], { seed: 1 });
    assert.deepEqual([r.n, r.mean_diff, r.ci_low, r.ci_high], [0, null, null, null]);
  });

  test("입력 오류는 BootstrapInputError", () => {
    assert.throws(() => pairedBootstrap([1], [1, 2]), BootstrapInputError);
    assert.throws(() => pairedBootstrap([Number.NaN], [1]), BootstrapInputError);
    assert.throws(() => pairedBootstrap([1], [1], { iterations: 0 }), BootstrapInputError);
    assert.throws(() => pairedBootstrap([1], [1], { confidence: 1 }), BootstrapInputError);
    assert.throws(() => pairedBootstrap("a", [1]), BootstrapInputError);
  });
});

describe("compareRuns", () => {
  const row = (id, subset, tags, over = {}) => ({ id, subset, tags, domain: null, hit_at_1: 0, hit_at_5: 0, hit_at_10: 0, rr: 0, ndcg: 0, ...over });
  const base = [row("1", "human_ko", ["spacing"]), row("2", "human_ko", []), row("3", "identifier", ["en_identifier"]), row("4", "synthetic", [])];
  const cand = [row("1", "human_ko", ["spacing"], { hit_at_5: 1, rr: 0.5 }), row("2", "human_ko", []), row("3", "identifier", ["en_identifier"], { hit_at_5: 1, rr: 1 }), row("4", "synthetic", [], { hit_at_5: 1 }), row("9", "human_ko", [])];

  test("id로 짝짓고 한쪽에만 있는 질의 수를 알린다", () => {
    const result = compareRuns(base, cand, { seed: 1, iterations: 100 });
    assert.deepEqual(result.unpaired, { baseline: 0, candidate: 1 });
  });

  test("전체, 부분집합, 태그 묶음마다 모든 지표의 구간을 낸다", () => {
    const { comparisons } = compareRuns(base, cand, { seed: 1, iterations: 100 });
    const groups = new Set(comparisons.map(c => c.group));
    assert.ok(["overall", "subset:human_ko", "subset:identifier", "subset:synthetic", "tag:spacing", "tag:en_identifier"].every(g => groups.has(g)));
    for (const group of groups) {
      assert.deepEqual(comparisons.filter(c => c.group === group).map(c => c.metric), COMPARE_METRICS);
    }
  });

  test("합성 질의는 전체 묶음에 들어가지 않는다", () => {
    const overall = compareRuns(base, cand, { seed: 1, iterations: 100 }).comparisons.find(c => c.group === "overall" && c.metric === "recall_at_5");
    assert.equal(overall.n, 3);
  });

  test("평균 차이는 후보 - 기준이고 0을 제외하는 구간은 표시된다", () => {
    const { comparisons } = compareRuns(base, cand, { seed: 1, iterations: 200 });
    const id = comparisons.find(c => c.group === "subset:identifier" && c.metric === "recall_at_5");
    assert.equal(id.mean_diff, 1);
    assert.equal(id.excludes_zero, true);
  });

  test("ndcg가 한쪽이라도 null인 질의는 그 지표에서 뺀다", () => {
    const a = [row("1", "human_ko", [], { ndcg: null }), row("2", "human_ko", [], { ndcg: 0.5 })];
    const b = [row("1", "human_ko", [], { ndcg: 1 }), row("2", "human_ko", [], { ndcg: 1 })];
    const ndcg = compareRuns(a, b, { seed: 1, iterations: 50 }).comparisons.find(c => c.group === "overall" && c.metric === "ndcg_at_budget");
    assert.equal(ndcg.n, 1);
  });

  test("같은 입력과 시드는 같은 결과를 낸다", () => {
    assert.deepEqual(compareRuns(base, cand, { seed: 3, iterations: 100 }), compareRuns(base, cand, { seed: 3, iterations: 100 }));
  });
});
