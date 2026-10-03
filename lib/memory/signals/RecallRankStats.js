/**
 * RecallRankStats - 순위 기반 검색 지표의 순수 함수
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 입출력과 설정에 의존하지 않는다. 측정 스크립트가 연결 설정을 읽기 전에 불러올 수 있도록
 * RecallBenchmark와 분리해 둔다. RecallBenchmark는 같은 이름으로 다시 내보낸다.
 */

/**
 * 순위 배열에서 Recall@k를 계산한다.
 * 순위는 1부터 시작하며 미검출은 null이다.
 *
 * @param {Array<number|null>} ranks
 * @param {number}             k
 * @returns {number|null} 0~1, 표본이 없으면 null
 */
export function computeRecallAt(ranks, k) {
  if (!Array.isArray(ranks) || ranks.length === 0) return null;
  const hit = ranks.filter(r => typeof r === "number" && r >= 1 && r <= k).length;
  return hit / ranks.length;
}

/**
 * Mean Reciprocal Rank. 미검출 항목은 기여도 0으로 분모에는 포함한다.
 *
 * @param {Array<number|null>} ranks
 * @returns {number|null}
 */
export function computeMRR(ranks) {
  if (!Array.isArray(ranks) || ranks.length === 0) return null;
  const sum = ranks.reduce((acc, r) => acc + (typeof r === "number" && r >= 1 ? 1 / r : 0), 0);
  return sum / ranks.length;
}

/**
 * 백분위수. 선형 보간 없이 nearest-rank 방식을 쓴다.
 *
 * @param {number[]} values
 * @param {number}   p       0~100
 * @returns {number|null}
 */
export function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx    = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
}
