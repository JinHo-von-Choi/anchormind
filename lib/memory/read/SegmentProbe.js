/**
 * SegmentProbe - L3 시맨틱 검색에 붙는 구간(세그먼트) 벡터 프로브
 *
 * 작성자: 최진호
 * 작성일: 2026-10-09
 *
 * 본 검색(searchBySemantic)과 병렬로 구간 표를 검색하고, 결과를 본문 후보에 합친다. 검색이 꺼져 있거나 실패하거나
 * 시간 예산을 넘기면 빈 결과로 본 검색만 쓴다.
 */

import { MEMORY_CONFIG }     from "../../../config/memory.js";
import { layerScope }        from "./SearchLayerScope.js";
import { logWarn }           from "../../logger.js";
import { segmentVersion }    from "../embedding/segmenter.js";
import { mergeSegmentHits }  from "./SegmentMerge.js";

/**
 * 구간 프로브를 시작한다. 결과를 기다리는 호출자가 본 검색과 함께 Promise.all로 기다린다.
 * 본 검색(searchBySemantic)과 같은 필터를 query에서 만들어 건다.
 *
 * @param {Object}   store    searchBySegments를 가진 FragmentStore
 * @param {number[]} vec      질의 벡터(L3가 이미 만든 것)
 * @param {Object}   query    검색 질의(includeSuperseded, affect, type, topic, scope 필드)
 * @param {{agentId: string, keyId: any, timeRange: any, minSimilarity: number}} ctx
 * @returns {Promise<Object[]>}
 */
export function startSegmentProbe(store, vec, query, { agentId, keyId, timeRange, minSimilarity }) {
  const cfg = MEMORY_CONFIG.segmentEmbedding || {};
  if (cfg.searchEnabled !== true) return Promise.resolve([]);
  return Promise.race([
    store.searchBySegments(vec, {
      agentId, keyId, timeRange, minSimilarity,
      includeSuperseded: query.includeSuperseded || false,
      ...layerScope(query),
      affect    : query.affect ?? null,
      type      : query.type ?? null,
      topic     : query.topic ?? null,
      limit     : cfg.searchLimit ?? 30,
      rowLimit  : cfg.rowLimit ?? 120,
      segVersion: segmentVersion(cfg)
    }),
    new Promise(resolve => setTimeout(() => resolve([]), cfg.searchTimeoutMs ?? 1500).unref?.())
  ]).catch(err => {
    logWarn(`[FragmentSearch] L3 segment probe failed: ${err.message}`);
    return [];
  });
}

/**
 * 구간 히트를 본문 후보에 합친다. results 배열을 제자리에서 바꾸고 같은 배열을 돌려준다(히트가 없으면 그대로).
 *
 * @param {Object[]} results
 * @param {Object[]} segmentResults
 * @param {number}   limit
 * @returns {Object[]}
 */
export function applySegmentHits(results, segmentResults, limit) {
  if (!segmentResults || segmentResults.length === 0) return results;
  const cfg    = MEMORY_CONFIG.segmentEmbedding || {};
  const merged = mergeSegmentHits(results, segmentResults, {
    limit     : limit ?? 10,
    adoptLimit: cfg.adoptLimit ?? 10,
    decay     : cfg.similarityDecay ?? 0.95
  });
  results.splice(0, results.length, ...merged);
  return results;
}
