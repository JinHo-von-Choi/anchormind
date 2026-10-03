/**
 * RankFusion - 검색 계층 결과의 순위 융합
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * FragmentSearch가 계층(L1, L2, 그래프, L3, 시간, 어휘)마다 얻은 후보를 하나의 순서로 합치는
 * 순수 함수를 둔다.
 */

import { byDescendingScore } from "./DeterministicRanking.js";

/**
 * 범용 Reciprocal Rank Fusion (RRF) 병합
 *
 * 스케일이 다른 다계층 검색 결과를 순위 기반으로 공정하게 병합한다.
 * 레이어 수에 무관하게 동작하므로 temporal, morpheme 등
 * 신규 레이어 추가 시 파라미터 변경 없이 확장 가능하다.
 *
 * @param {Array<{name: string, results: Array, weightFactor: number, unranked?: boolean}>} layers
 *   - results가 문자열 배열이면 ID 전용 레이어(L1)로 간주하여 {id} 형태로 정규화
 *   - results가 객체 배열이면 각 객체의 id 필드를 사용
 * @param {number} k - RRF 상수 (기본 60, 상위 랭크 과도한 부스트 방지)
 * @returns {Object[]} RRF 스코어 기준 내림차순 정렬된 파편 배열 (_rrfScore 포함)
 */
export function mergeRRF(layers, k = 60) {
  const scoreMap = new Map();

  for (const { results, weightFactor = 1.0, unranked = false } of layers) {
    for (let rank = 0; rank < results.length; rank++) {
      const item  = results[rank];
      const isId  = typeof item === "string";
      const id    = isId ? item : item.id;
      /** Redis Set처럼 자체 rank가 없는 레이어는 모든 후보에 같은 기여를 준다. */
      const score = weightFactor / (k + (unranked ? 1 : rank + 1));

      if (scoreMap.has(id)) {
        const existing = scoreMap.get(id);
        existing._rrfScore += score;
        /** ID-only 엔트리(L1 유래)는 완전 파편 객체가 도착하면 승격시킨다.
         *  승격하지 않으면 content 부재로 최종 필터에서 정당한 hit가 탈락한다. */
        if (!isId && existing.content === undefined && item.content !== undefined) {
          scoreMap.set(id, { ...item, _rrfScore: existing._rrfScore });
        }
      } else {
        scoreMap.set(id, isId ? { id, _rrfScore: score } : { ...item, _rrfScore: score });
      }
    }
  }

  return [...scoreMap.values()].sort(byDescendingScore(f => f._rrfScore));
}

/**
 * L2의 실제 검색 결과는 앞에 유지하고, Redis hydration 후보는 하나의 결정적 tail로
 * 합친다. DB fallback과 warm cache가 같은 ID 순서를 만들도록 hydration 출처는 랭킹
 * 신호로 사용하지 않는다.
 */
export function mergeHydratedCandidates(l2Results, cached) {
  const primary = [];
  const hydrated = [];
  const seen = new Set();

  for (const fragment of l2Results) {
    if (seen.has(fragment.id)) continue;
    seen.add(fragment.id);
    (fragment._l1Hydrated === true ? hydrated : primary).push(fragment);
  }
  for (const fragment of cached) {
    if (seen.has(fragment.id)) continue;
    seen.add(fragment.id);
    hydrated.push({ ...fragment, _l1Hydrated: true });
  }

  hydrated.sort(byDescendingScore(f => f.importance ?? 0));
  return [...primary, ...hydrated];
}
