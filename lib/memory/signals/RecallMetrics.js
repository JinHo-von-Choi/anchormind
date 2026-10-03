/**
 * RecallMetrics - 검색 평가 지표 순수 함수
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 질의 하나의 결과(반환 순서와 파편별 토큰 수)와 정답(관련도 등급)에서 순위, 역순위,
 * 적중 여부, 토큰 가중 nDCG를 구하고, 질의 행 묶음을 R@1/5/10, MRR, nDCG로 집계한다.
 * 순위 기반 집계와 백분위수는 RecallBenchmark가 내보내는 함수(RecallRankStats)를 그대로 쓴다.
 * 입출력과 시간에 의존하지 않으므로 같은 입력은 항상 같은 출력을 낸다.
 */

import { computeRecallAt, computeMRR, percentile } from "./RecallRankStats.js";

/** nDCG 위치 할인의 토큰 단위. 항목마다 이 크기이면 통상의 nDCG와 같아진다. */
export const NDCG_UNIT_TOKENS = 100;

/** 지표 입력 형식 위반. */
export class MetricInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "MetricInputError";
  }
}

/**
 * 반환 목록에서 정답이 처음 나오는 순위(1부터)를 구한다.
 *
 * @param {string[]}    returnedIds 반환 순서
 * @param {Set<string>} relevantIds
 * @returns {number|null} 없으면 null
 */
export function firstRelevantRank(returnedIds, relevantIds) {
  const idx = returnedIds.findIndex(id => relevantIds.has(id));
  return idx >= 0 ? idx + 1 : null;
}

/**
 * 오답 후보가 첫 정답보다 앞서는지 판정한다. 오답 후보가 없으면 null이다.
 * 정답이 반환되지 않았는데 오답 후보가 반환되었으면 true다.
 *
 * @param {string[]}    returnedIds
 * @param {Set<string>} relevantIds
 * @param {Set<string>} distractorIds
 * @returns {boolean|null}
 */
export function distractorAboveRelevant(returnedIds, relevantIds, distractorIds) {
  if (distractorIds.size === 0) return null;
  const firstDistractor = returnedIds.findIndex(id => distractorIds.has(id));
  if (firstDistractor < 0) return false;
  const firstRelevant = returnedIds.findIndex(id => relevantIds.has(id));
  return firstRelevant < 0 || firstDistractor < firstRelevant;
}

const gainOf = (grade) => 2 ** grade - 1;

/**
 * 토큰 위치로 할인한 DCG를 구한다. 항목의 위치는 앞선 항목이 쓴 토큰 수로 정하고,
 * 할인은 1 / log2(2 + 앞선 토큰 / 단위)이다. 예산을 넘는 항목은 지급되지 않는다.
 *
 * @param {Array<{gain: number, tokens: number}>} items 전달 순서
 * @param {number} budget
 * @param {number} unit
 * @param {"stop"|"skip"} overflow stop은 처음 넘는 항목에서 끝내고, skip은 그 항목만 건너뛴다
 * @returns {number}
 */
function discountedGain(items, budget, unit, overflow) {
  let consumed = 0;
  let total    = 0;
  for (const item of items) {
    if (consumed + item.tokens > budget) {
      if (overflow === "stop") break;
      continue;
    }
    total    += item.gain / Math.log2(2 + consumed / unit);
    consumed += item.tokens;
  }
  return total;
}

/**
 * 정답 항목의 형식을 확인한다.
 *
 * @param {Map<string, {grade: number, tokens: number}>} relevant
 */
function assertRelevantInput(relevant) {
  for (const [id, info] of relevant) {
    if (!Number.isInteger(info.grade) || info.grade < 1) throw new MetricInputError(`정답 ${id}의 grade가 1 이상의 정수가 아니다`);
    if (!Number.isFinite(info.tokens) || info.tokens < 1) throw new MetricInputError(`정답 ${id}의 tokens가 1 이상의 수가 아니다`);
  }
}

/**
 * 예산 내 토큰 가중 nDCG. 이득은 2^등급 - 1이다. 이상적 순서는 이득 내림차순, 같으면
 * 토큰이 작은 순서로 예산에 채운 탐욕 순서이며, 이 순서가 최적이 아닌 드문 경우를 위해
 * 결과를 1로 제한한다. 예산 안에 들어가는 정답이 없으면 정의되지 않아 null이다.
 *
 * @param {Object}   input
 * @param {Array<{id: string, tokens: number}>} input.returned 반환 순서
 * @param {Map<string, {grade: number, tokens: number}>} input.relevant
 * @param {number}   input.budgetTokens
 * @param {number}   [input.unitTokens]
 * @returns {number|null}
 */
export function tokenWeightedNdcg({ returned, relevant, budgetTokens, unitTokens = NDCG_UNIT_TOKENS }) {
  if (!Number.isFinite(budgetTokens) || budgetTokens < 1) throw new MetricInputError("budgetTokens는 1 이상이어야 한다");
  if (!Number.isFinite(unitTokens)   || unitTokens < 1)   throw new MetricInputError("unitTokens는 1 이상이어야 한다");
  assertRelevantInput(relevant);

  const seen    = new Set();
  const actual  = [];
  for (const item of returned) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const info = relevant.get(item.id);
    actual.push({ gain: info ? gainOf(info.grade) : 0, tokens: Number.isFinite(item.tokens) && item.tokens >= 1 ? item.tokens : unitTokens });
  }

  const ideal = [...relevant.entries()]
    .map(([id, info]) => ({ id, gain: gainOf(info.grade), tokens: info.tokens }))
    .sort((a, b) => b.gain - a.gain || a.tokens - b.tokens || (a.id < b.id ? -1 : 1));

  const idcg = discountedGain(ideal, budgetTokens, unitTokens, "skip");
  if (idcg === 0) return null;
  return Math.min(1, discountedGain(actual, budgetTokens, unitTokens, "stop") / idcg);
}

/**
 * 질의 하나의 결과를 지표 행으로 만든다. 행의 값은 부트스트랩 비교의 입력이다.
 *
 * @param {Object}   input
 * @param {Object}   input.entry     평가 항목(id, subset, tags, domain, relevant, distractors)
 * @param {Array<{id: string, tokens: number}>} input.returned
 * @param {Map<string, {grade: number, tokens: number}>} input.relevant 대상 DB에서 확인된 정답
 * @param {number}   input.budgetTokens
 * @param {number}   [input.unitTokens]
 * @returns {Object}
 */
export function scoreQuery({ entry, returned, relevant, budgetTokens, unitTokens }) {
  const returnedIds = returned.map(r => r.id);
  const rank        = firstRelevantRank(returnedIds, new Set(relevant.keys()));

  return {
    id             : entry.id,
    subset         : entry.subset,
    tags           : [...(entry.tags ?? [])],
    domain         : entry.domain ?? null,
    rank,
    rr             : rank ? 1 / rank : 0,
    hit_at_1       : rank !== null && rank <= 1 ? 1 : 0,
    hit_at_5       : rank !== null && rank <= 5 ? 1 : 0,
    hit_at_10      : rank !== null && rank <= 10 ? 1 : 0,
    ndcg           : tokenWeightedNdcg({ returned, relevant, budgetTokens, unitTokens }),
    distractor_above: distractorAboveRelevant(returnedIds, new Set(relevant.keys()), new Set(entry.distractors ?? [])),
    returned       : returned.length
  };
}

const mean = (values) => (values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length);

/**
 * 지표 행 묶음을 집계한다.
 *
 * @param {Object[]} rows scoreQuery 결과
 * @returns {Object}
 */
export function aggregateRows(rows) {
  const ranks = rows.map(r => r.rank);
  const ndcg  = rows.map(r => r.ndcg).filter(v => typeof v === "number");
  const dist  = rows.map(r => r.distractor_above).filter(v => typeof v === "boolean");

  return {
    cases                 : rows.length,
    recall_at_1           : computeRecallAt(ranks, 1),
    recall_at_5           : computeRecallAt(ranks, 5),
    recall_at_10          : computeRecallAt(ranks, 10),
    mrr                   : computeMRR(ranks),
    ndcg_at_budget        : mean(ndcg),
    ndcg_cases            : ndcg.length,
    misses                : ranks.filter(r => r === null).length,
    distractor_above_rate : dist.length === 0 ? null : dist.filter(Boolean).length / dist.length,
    distractor_cases      : dist.length
  };
}

/**
 * 행을 키로 나누어 집계한다. 키 함수가 여러 키를 돌려주면 그 모두에 행이 속한다.
 *
 * @param {Object[]} rows
 * @param {(row: Object) => string[]} keysOf
 * @returns {Object} 키 이름순으로 정렬된 집계
 */
export function aggregateBy(rows, keysOf) {
  const groups = new Map();
  for (const row of rows) {
    for (const key of keysOf(row)) {
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
  }
  return Object.fromEntries([...groups.keys()].sort().map(key => [key, aggregateRows(groups.get(key))]));
}

/**
 * 질의 행에서 보고용 지표 전체를 만든다. 보조 부분집합(합성)은 전체 집계에서 빼고
 * 부분집합별 표에서만 따로 보인다.
 *
 * @param {Object[]} rows
 * @param {string[]} auxiliarySubsets
 * @returns {{overall: Object, by_subset: Object, by_tag: Object, by_domain: Object}}
 */
export function summarizeRows(rows, auxiliarySubsets = ["synthetic"]) {
  const primary = rows.filter(r => !auxiliarySubsets.includes(r.subset));
  return {
    overall  : aggregateRows(primary),
    by_subset: aggregateBy(rows, r => [r.subset]),
    by_tag   : aggregateBy(primary, r => r.tags),
    by_domain: aggregateBy(primary.filter(r => r.domain), r => [r.domain])
  };
}

/**
 * 지연 요약. 백분위수는 nearest-rank 방식이다.
 *
 * @param {number[]} values 밀리초
 * @returns {{n: number, p50: number|null, p95: number|null, max: number|null}}
 */
export function latencySummary(values) {
  const finite = values.filter(Number.isFinite);
  return {
    n  : finite.length,
    p50: percentile(finite, 50),
    p95: percentile(finite, 95),
    max: finite.length > 0 ? Math.max(...finite) : null
  };
}
