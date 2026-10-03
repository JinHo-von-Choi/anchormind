/**
 * PairedBootstrap - 짝지은 부트스트랩 신뢰구간
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 같은 질의에 대한 두 실행(기준과 후보)의 질의별 점수 차이를 복원 추출해 평균 차이의
 * 백분위 구간을 구한다. 난수는 시드를 받는 생성기를 쓰므로 같은 입력과 시드는 같은
 * 결과를 낸다. 구간 비교만 하며 통과 기준값은 두지 않는다.
 */

export const DEFAULT_ITERATIONS = 2000;
export const DEFAULT_SEED       = 20261003;
export const DEFAULT_CONFIDENCE = 0.95;

/** 부트스트랩 입력 오류. */
export class BootstrapInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "BootstrapInputError";
  }
}

/**
 * 32비트 시드 난수 생성기(mulberry32). 0 이상 1 미만의 수를 돌려준다.
 *
 * @param {number} seed
 * @returns {() => number}
 */
export function createRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 입력을 검사한다.
 *
 * @param {number[]} baseline
 * @param {number[]} candidate
 * @param {{iterations: number, confidence: number}} opts
 */
function assertInput(baseline, candidate, { iterations, confidence }) {
  if (!Array.isArray(baseline) || !Array.isArray(candidate)) throw new BootstrapInputError("점수는 배열이어야 한다");
  if (baseline.length !== candidate.length) throw new BootstrapInputError(`길이가 다르다: ${baseline.length} 대 ${candidate.length}`);
  if (![...baseline, ...candidate].every(Number.isFinite)) throw new BootstrapInputError("점수에 유한하지 않은 값이 있다");
  if (!Number.isInteger(iterations) || iterations < 1)      throw new BootstrapInputError("iterations는 1 이상의 정수여야 한다");
  if (!(confidence > 0 && confidence < 1))                  throw new BootstrapInputError("confidence는 0과 1 사이여야 한다");
}

/**
 * 짝지은 부트스트랩. 차이는 후보 - 기준이다.
 *
 * @param {number[]} baseline 질의별 기준 점수
 * @param {number[]} candidate 같은 질의 순서의 후보 점수
 * @param {{iterations?: number, seed?: number, confidence?: number}} [opts]
 * @returns {{n: number, mean_diff: number|null, ci_low: number|null, ci_high: number|null,
 *            confidence: number, iterations: number, seed: number}}
 */
export function pairedBootstrap(baseline, candidate, opts = {}) {
  const iterations = opts.iterations ?? DEFAULT_ITERATIONS;
  const seed       = opts.seed       ?? DEFAULT_SEED;
  const confidence = opts.confidence ?? DEFAULT_CONFIDENCE;
  assertInput(baseline, candidate, { iterations, confidence });

  const n    = baseline.length;
  const base = { n, confidence, iterations, seed };
  if (n === 0) return { ...base, mean_diff: null, ci_low: null, ci_high: null };

  const diffs = baseline.map((b, i) => candidate[i] - b);
  const rng   = createRng(seed);
  const means = new Float64Array(iterations);
  for (let it = 0; it < iterations; it++) {
    let sum = 0;
    for (let k = 0; k < n; k++) sum += diffs[Math.floor(rng() * n)];
    means[it] = sum / n;
  }
  means.sort();

  const tail = (1 - confidence) / 2;
  const lo   = Math.min(iterations - 1, Math.floor(iterations * tail));
  const hi   = Math.max(0, Math.ceil(iterations * (1 - tail)) - 1);

  return { ...base, mean_diff: diffs.reduce((a, b) => a + b, 0) / n, ci_low: means[lo], ci_high: means[hi] };
}

/** 비교 지표와 행의 필드. nDCG는 양쪽 모두 값이 있는 질의만 쓴다. recall_at_k는 적중률이다. */
const METRIC_FIELDS = Object.freeze({
  recall_at_1 : "hit_at_1",
  recall_at_5 : "hit_at_5",
  recall_at_10: "hit_at_10",
  mrr         : "rr",
  recall_fraction_at_1 : "recall_fraction_at_1",
  recall_fraction_at_5 : "recall_fraction_at_5",
  recall_fraction_at_10: "recall_fraction_at_10",
  ndcg_at_budget          : "ndcg",
  ndcg_uncapped_at_budget : "ndcg_uncapped"
});

export const DEFAULT_MIN_N = 10;

export const COMPARE_METRICS = Object.freeze(Object.keys(METRIC_FIELDS));

/**
 * 행이 속한 비교 묶음 이름들.
 *
 * @param {Object} row
 * @param {string[]} auxiliarySubsets 전체 묶음에서 빼는 부분집합
 * @returns {string[]}
 */
function groupsOf(row, auxiliarySubsets) {
  const groups = [`subset:${row.subset}`];
  if (auxiliarySubsets.includes(row.subset)) return groups;
  groups.push("overall", ...row.tags.map(t => `tag:${t}`));
  if (row.domain) groups.push(`domain:${row.domain}`);
  return groups;
}

/**
 * 두 실행의 질의 행을 id로 짝지어 묶음과 지표마다 부트스트랩 구간을 구한다.
 * 한쪽에만 있는 질의는 제외하고 그 수를 unpaired로 알린다. 짝지은 질의 수가 minN(기본 10)
 * 미만인 묶음은 insufficient_n을 true로 하고 excludes_zero를 판단하지 않는다(false).
 *
 * @param {Object[]} baselineRows
 * @param {Object[]} candidateRows
 * @param {{iterations?: number, seed?: number, confidence?: number, auxiliarySubsets?: string[], minN?: number}} [opts]
 * @returns {{unpaired: {baseline: number, candidate: number}, comparisons: Object[]}}
 */
export function compareRuns(baselineRows, candidateRows, opts = {}) {
  const auxiliary  = opts.auxiliarySubsets ?? ["synthetic"];
  const minN       = opts.minN ?? DEFAULT_MIN_N;
  const candidates = new Map(candidateRows.map(r => [r.id, r]));
  const pairs      = baselineRows.filter(r => candidates.has(r.id)).map(r => [r, candidates.get(r.id)]);

  const byGroup = new Map();
  for (const [a, b] of pairs) {
    for (const group of groupsOf(a, auxiliary)) {
      if (!byGroup.has(group)) byGroup.set(group, []);
      byGroup.get(group).push([a, b]);
    }
  }

  const comparisons = [];
  for (const group of [...byGroup.keys()].sort()) {
    for (const metric of COMPARE_METRICS) {
      const field  = METRIC_FIELDS[metric];
      const usable = byGroup.get(group).filter(([a, b]) => typeof a[field] === "number" && typeof b[field] === "number");
      const result = pairedBootstrap(usable.map(([a]) => a[field]), usable.map(([, b]) => b[field]), opts);
      const insufficient = result.n < minN;
      comparisons.push({
        group,
        metric,
        ...result,
        min_n        : minN,
        insufficient_n: insufficient,
        excludes_zero: !insufficient && result.ci_low !== null && (result.ci_low > 0 || result.ci_high < 0)
      });
    }
  }

  return {
    unpaired: { baseline: baselineRows.length - pairs.length, candidate: candidateRows.length - pairs.length },
    comparisons
  };
}
