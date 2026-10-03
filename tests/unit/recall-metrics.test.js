/**
 * 검색 평가 지표 순수 함수 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 작은 손계산 입력에서 정의대로 값이 나오는지와 성질(통상 nDCG와의 일치, 상한, 순서 무관)을
 * 확인한다. 질의 결과 전체를 고정 문자열과 대조하지 않는다.
 */

import { test, describe } from "node:test";
import assert             from "node:assert/strict";

import {
  firstRelevantRank, distractorAboveRelevant, tokenWeightedNdcg, scoreQuery,
  aggregateRows, aggregateBy, summarizeRows, latencySummary, MetricInputError, NDCG_UNIT_TOKENS
} from "../../lib/memory/signals/RecallMetrics.js";

const rel = (pairs) => new Map(pairs.map(([id, grade, tokens]) => [id, { grade, tokens }]));
const ret = (pairs) => pairs.map(([id, tokens]) => ({ id, tokens }));
const near = (actual, expected, eps = 1e-9) => assert.ok(Math.abs(actual - expected) < eps, `${actual} != ${expected}`);

describe("firstRelevantRank", () => {
  test("처음 나오는 정답의 순위를 1부터 센다", () => {
    assert.equal(firstRelevantRank(["a", "b", "c"], new Set(["c", "b"])), 2);
    assert.equal(firstRelevantRank(["a"], new Set(["z"])), null);
    assert.equal(firstRelevantRank([], new Set(["z"])), null);
  });
});

describe("distractorAboveRelevant", () => {
  const relevant = new Set(["r"]);
  test("오답 후보가 없으면 null", () => {
    assert.equal(distractorAboveRelevant(["r"], relevant, new Set()), null);
  });
  test("오답 후보가 반환되지 않았으면 false", () => {
    assert.equal(distractorAboveRelevant(["r", "x"], relevant, new Set(["d"])), false);
  });
  test("오답 후보가 첫 정답보다 앞서면 true, 뒤면 false", () => {
    assert.equal(distractorAboveRelevant(["d", "r"], relevant, new Set(["d"])), true);
    assert.equal(distractorAboveRelevant(["r", "d"], relevant, new Set(["d"])), false);
  });
  test("정답 없이 오답 후보만 반환되면 true", () => {
    assert.equal(distractorAboveRelevant(["d"], relevant, new Set(["d"])), true);
  });
});

describe("tokenWeightedNdcg", () => {
  test("항목마다 단위 토큰이면 통상의 nDCG와 같다", () => {
    const relevant = rel([["a", 3, 100], ["b", 1, 100]]);
    const returned = ret([["x", 100], ["b", 100], ["a", 100]]);
    const dcg      = 1 / Math.log2(3) + 7 / Math.log2(4);
    const idcg     = 7 / Math.log2(2) + 1 / Math.log2(3);
    near(tokenWeightedNdcg({ returned, relevant, budgetTokens: 4000 }), dcg / idcg);
  });

  test("이상적 순서로 반환하면 1이다", () => {
    const relevant = rel([["a", 3, 80], ["b", 2, 50]]);
    near(tokenWeightedNdcg({ returned: ret([["a", 80], ["b", 50]]), relevant, budgetTokens: 4000 }), 1);
  });

  test("정답이 없으면 0이다", () => {
    const relevant = rel([["a", 3, 80]]);
    assert.equal(tokenWeightedNdcg({ returned: ret([["x", 80]]), relevant, budgetTokens: 4000 }), 0);
  });

  test("앞선 항목이 토큰을 많이 쓸수록 뒤 정답의 가치가 낮아진다", () => {
    const relevant = rel([["a", 3, 100]]);
    const cheap    = tokenWeightedNdcg({ returned: ret([["x", 10], ["a", 100]]), relevant, budgetTokens: 4000 });
    const costly   = tokenWeightedNdcg({ returned: ret([["x", 1500], ["a", 100]]), relevant, budgetTokens: 4000 });
    assert.ok(cheap > costly);
  });

  test("예산을 넘는 항목부터는 지급되지 않는다", () => {
    const relevant = rel([["a", 3, 100]]);
    const inside   = tokenWeightedNdcg({ returned: ret([["a", 100]]), relevant, budgetTokens: 100 });
    const outside  = tokenWeightedNdcg({ returned: ret([["x", 60], ["a", 100]]), relevant, budgetTokens: 100 });
    near(inside, 1);
    assert.equal(outside, 0);
  });

  test("예산 안에 들어가는 정답이 없으면 정의되지 않아 null이다", () => {
    assert.equal(tokenWeightedNdcg({ returned: ret([["a", 500]]), relevant: rel([["a", 3, 500]]), budgetTokens: 100 }), null);
  });

  test("값은 1을 넘지 않는다", () => {
    const relevant = rel([["h", 3, 900], ["l", 1, 10]]);
    const value    = tokenWeightedNdcg({ returned: ret([["l", 10], ["h", 900]]), relevant, budgetTokens: 2000 });
    assert.equal(value, 1);
  });

  test("같은 파편이 반복되어도 한 번만 센다", () => {
    const relevant = rel([["a", 3, 100], ["b", 3, 100]]);
    const once     = tokenWeightedNdcg({ returned: ret([["a", 100], ["b", 100]]), relevant, budgetTokens: 4000 });
    const repeated = tokenWeightedNdcg({ returned: ret([["a", 100], ["a", 100], ["b", 100]]), relevant, budgetTokens: 4000 });
    assert.equal(once, repeated);
  });

  test("입력 형식 위반은 MetricInputError", () => {
    assert.throws(() => tokenWeightedNdcg({ returned: [], relevant: rel([["a", 0, 10]]), budgetTokens: 10 }), MetricInputError);
    assert.throws(() => tokenWeightedNdcg({ returned: [], relevant: rel([["a", 1, 0]]), budgetTokens: 10 }), MetricInputError);
    assert.throws(() => tokenWeightedNdcg({ returned: [], relevant: rel([]), budgetTokens: 0 }), MetricInputError);
  });

  test("기본 단위는 100토큰이다", () => {
    assert.equal(NDCG_UNIT_TOKENS, 100);
  });
});

describe("scoreQuery", () => {
  const entry    = { id: "q1", subset: "human_ko", tags: ["particle"], domain: "ops", distractors: ["d"] };
  const relevant = rel([["a", 3, 100]]);

  test("순위, 역순위, 적중 여부를 만든다", () => {
    const row = scoreQuery({ entry, returned: ret([["x", 50], ["a", 100]]), relevant, budgetTokens: 4000 });
    assert.equal(row.rank, 2);
    assert.equal(row.rr, 0.5);
    assert.deepEqual([row.hit_at_1, row.hit_at_5, row.hit_at_10], [0, 1, 1]);
    assert.equal(row.distractor_above, false);
    assert.equal(row.domain, "ops");
  });

  test("미검출은 순위 null, 역순위 0", () => {
    const row = scoreQuery({ entry, returned: ret([["d", 50]]), relevant, budgetTokens: 4000 });
    assert.equal(row.rank, null);
    assert.equal(row.rr, 0);
    assert.equal(row.distractor_above, true);
  });

  test("같은 입력은 같은 행을 낸다", () => {
    const input = { entry, returned: ret([["x", 50], ["a", 100]]), relevant, budgetTokens: 4000 };
    assert.deepEqual(scoreQuery(input), scoreQuery(input));
  });
});

describe("집계", () => {
  const row = (id, subset, rank, over = {}) => ({
    id, subset, tags: [], domain: null, rank,
    rr: rank ? 1 / rank : 0, hit_at_1: rank === 1 ? 1 : 0, hit_at_5: rank && rank <= 5 ? 1 : 0, hit_at_10: rank && rank <= 10 ? 1 : 0,
    ndcg: rank ? 1 / rank : 0, distractor_above: null, ...over
  });

  test("R@k와 MRR은 RecallBenchmark의 정의를 따른다", () => {
    const agg = aggregateRows([row("1", "human_ko", 1), row("2", "human_ko", 3), row("3", "human_ko", null), row("4", "human_ko", 7)]);
    assert.equal(agg.cases, 4);
    assert.equal(agg.recall_at_1, 0.25);
    assert.equal(agg.recall_at_5, 0.5);
    assert.equal(agg.recall_at_10, 0.75);
    near(agg.mrr, (1 + 1 / 3 + 0 + 1 / 7) / 4);
    assert.equal(agg.misses, 1);
  });

  test("nDCG는 값이 있는 질의만 평균하고 건수를 따로 둔다", () => {
    const agg = aggregateRows([row("1", "human_ko", 1), row("2", "human_ko", 2, { ndcg: null })]);
    assert.equal(agg.ndcg_at_budget, 1);
    assert.equal(agg.ndcg_cases, 1);
  });

  test("오답 후보 비율은 판정이 있는 질의만 센다", () => {
    const agg = aggregateRows([row("1", "hard_negative", 1, { distractor_above: true }), row("2", "hard_negative", 1, { distractor_above: false }), row("3", "hard_negative", 1)]);
    assert.equal(agg.distractor_above_rate, 0.5);
    assert.equal(agg.distractor_cases, 2);
  });

  test("빈 입력의 지표는 null", () => {
    const agg = aggregateRows([]);
    assert.equal(agg.recall_at_5, null);
    assert.equal(agg.mrr, null);
    assert.equal(agg.ndcg_at_budget, null);
  });

  test("aggregateBy는 여러 키에 속한 행을 각각에 넣고 키 순으로 정렬한다", () => {
    const rows   = [row("1", "human_ko", 1, { tags: ["spacing", "particle"] }), row("2", "human_ko", null, { tags: ["particle"] })];
    const groups = aggregateBy(rows, r => r.tags);
    assert.deepEqual(Object.keys(groups), ["particle", "spacing"]);
    assert.equal(groups.particle.cases, 2);
    assert.equal(groups.spacing.cases, 1);
  });

  test("summarizeRows는 합성 질의를 전체와 태그 집계에서 빼고 부분집합 표에만 둔다", () => {
    const rows = [row("1", "human_ko", 1, { tags: ["spacing"] }), row("2", "synthetic", null, { tags: ["spacing"] })];
    const sum  = summarizeRows(rows);
    assert.equal(sum.overall.cases, 1);
    assert.equal(sum.by_subset.synthetic.cases, 1);
    assert.equal(sum.by_tag.spacing.cases, 1);
  });

  test("행 순서가 달라도 집계는 같다", () => {
    const rows = [row("1", "human_ko", 1), row("2", "identifier", 4), row("3", "human_ko", null)];
    assert.deepEqual(summarizeRows(rows), summarizeRows([...rows].reverse()));
  });
});

describe("latencySummary", () => {
  test("nearest-rank 백분위수와 최대를 낸다", () => {
    assert.deepEqual(latencySummary([10, 20, 30, 40]), { n: 4, p50: 20, p95: 40, max: 40 });
  });

  test("유한하지 않은 값은 뺀다", () => {
    assert.equal(latencySummary([5, Number.NaN, Infinity]).n, 1);
  });

  test("빈 입력은 null", () => {
    assert.deepEqual(latencySummary([]), { n: 0, p50: null, p95: null, max: null });
  });
});
