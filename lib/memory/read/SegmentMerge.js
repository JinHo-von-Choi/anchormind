/**
 * SegmentMerge - 구간 벡터 히트를 L3 본문 후보에 합치는 순수 함수
 *
 * 작성자: 최진호
 * 작성일: 2026-10-09
 *
 * 구간 히트는 본문의 실제 일부와의 유사도라서 본문 유사도와 같은 선에서 비교한다(조각별 최대).
 * 다만 짧은 구간 벡터는 긴 본문 벡터보다 코사인이 체계적으로 높게 나오는 경향이 있고, 구간이 많은 긴 조각은
 * 높은 최대값을 얻을 기회가 많다. 그래서 감쇠 계수를 곱하고, 구간이 순위에 영향을 준 조각(상승 + 신규)의 수에
 * 상한을 둔다. 본문 후보는 상한 안에서 밀려나지 않는다.
 */

import { byDescendingScore } from "./DeterministicRanking.js";

/**
 * @param {Object[]} baseResults   본문 경로 L3 결과(유사도 내림차순, similarity 보유)
 * @param {Object[]} segmentHits   구간 경로 결과(조각 행 + similarity = 조각별 최대 구간 유사도, 원본 값)
 * @param {{limit: number, adoptLimit: number, decay: number}} opts
 * @returns {Object[]} 병합 결과(유사도 내림차순, 길이 <= limit)
 */
export function mergeSegmentHits(baseResults, segmentHits, { limit, adoptLimit, decay }) {
  const base = baseResults ?? [];
  if (!Array.isArray(segmentHits) || segmentHits.length === 0) return base;

  const baseById = new Map(base.map(f => [f.id, f]));

  /** 구간이 순위에 영향을 줄 수 있는 후보: 본문 유사도를 넘는 기존 조각 + 본문 경로가 놓친 새 조각 */
  const influenced = [];
  for (const hit of segmentHits) {
    const segSim = Number(hit.similarity) * decay;
    if (!Number.isFinite(segSim)) continue;
    const existing = baseById.get(hit.id);
    if (existing) {
      if (segSim > (existing.similarity ?? 0)) influenced.push({ fragment: existing, similarity: segSim, isNew: false });
    } else {
      influenced.push({ fragment: hit, similarity: segSim, isNew: true });
    }
  }
  influenced.sort(byDescendingScore(c => c.similarity));
  const adopted = influenced.slice(0, Math.max(0, adoptLimit));

  const out = new Map();
  for (const f of base) out.set(f.id, f);
  for (const { fragment, similarity, isNew } of adopted) {
    const original = isNew ? null : (fragment.similarity ?? 0);
    out.set(fragment.id, {
      ...fragment,
      similarity,
      _segmentMatch     : true,
      _segmentSimilarity: similarity,
      _wholeSimilarity  : original
    });
  }

  return [...out.values()]
    .sort(byDescendingScore(f => f.similarity ?? 0))
    .slice(0, limit);
}
