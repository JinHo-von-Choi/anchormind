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
  const mergeEvidence = mergeRankEvidence;

  for (const { name, results, weightFactor = 1.0, unranked = false } of layers) {
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
          const promoted = { ...item, _rrfScore: existing._rrfScore, _rankEvidence: existing._rankEvidence };
          mergeEvidence(promoted, item, name);
          scoreMap.set(id, promoted);
        } else if (!isId) {
          mergeEvidence(existing, item, name);
        }
      } else {
        const entry = isId ? { id, _rrfScore: score } : { ...item, _rrfScore: score };
        mergeEvidence(entry, isId ? null : item, name);
        scoreMap.set(id, entry);
      }
    }
  }

  return [...scoreMap.values()].sort(byDescendingScore(f => f._rrfScore));
}

/**
 * RRF를 거치지 않는 경로(text 없는 검색)의 후보에 출처 계층을 단다. 이미 증거가 있으면 채널만 더한다.
 *
 * @param {Object[]} rows
 * @param {string}   channel - l1, l2, lexical, l3, graph, temporal
 * @returns {Object[]} 같은 배열
 */
export function tagChannel(rows, channel) {
  for (const row of rows) mergeRankEvidence(row, null, channel);
  return rows;
}

/**
 * 후보의 출처 계층 목록. 증거가 없으면 null이다.
 *
 * @param {Object} fragment
 * @returns {string[]|null}
 */
export function rankChannels(fragment) {
  const channels = fragment?._rankEvidence?.channels;
  return Array.isArray(channels) ? channels : null;
}

/**
 * 후보 id별 출처 계층. 증거가 없는 후보는 넣지 않는다.
 *
 * @param {Object[]} rows
 * @returns {Map<string, string[]>}
 */
export function rankChannelsById(rows) {
  return new Map(rows.map(f => [f.id, rankChannels(f)]).filter(([, channels]) => channels));
}

/** 중복 후보의 정규 필드는 유지하고 채널별 순위 증거만 순서 독립적으로 합친다. */
function mergeRankEvidence(target, source, channel) {
  const channels = new Set(target._rankEvidence?.channels ?? []);
  if (channel) channels.add(channel);
  target._rankEvidence = { channels: [...channels].sort() };
  if (!source) return;

  for (const field of ["similarity", "_lexicalScore", "rerankerScore"]) {
    const incoming = Number(source[field]);
    if (!Number.isFinite(incoming)) continue;
    const current = Number(target[field]);
    if (!Number.isFinite(current) || incoming > current) target[field] = incoming;
  }
  if (source._kwExact === true) target._kwExact = true;
  if (source._kwSupplement === true) target._kwSupplement = true;
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

/**
 * 재정렬 점수가 하한보다 낮은 후보를 뺀다. 하한이 0이면 그대로 둔다. 뺀 수를 searchPath에 남긴다.
 *
 * @param {object[]} reranked
 * @param {number} minScore
 * @param {string[]} searchPath - in-place 수정
 * @returns {object[]}
 */
export function filterByRerankerScore(reranked, minScore, searchPath = []) {
  if (!(minScore > 0)) return reranked;
  const kept = reranked.filter(f => !(f.rerankerScore < minScore));
  if (kept.length < reranked.length) searchPath.push(`RerankFilter:${reranked.length - kept.length}`);
  return kept;
}

/**
 * 여러 결과 목록의 상위를 번갈아 골라 중복 없는 id를 limit개까지 모은다(그래프 이웃 시드).
 *
 * @param {Array<Array<{id: string}>>} lists
 * @param {number} limit
 * @returns {string[]}
 */
export function interleaveSeedIds(lists, limit) {
  const ids = new Set();
  const longest = Math.max(0, ...lists.map(l => l?.length ?? 0));
  for (let i = 0; i < longest && ids.size < limit; i++) {
    for (const list of lists) {
      const id = list?.[i]?.id;
      if (id && ids.size < limit) ids.add(id);
    }
  }
  return [...ids];
}
