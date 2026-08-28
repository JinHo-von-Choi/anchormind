/**
 * SyntheticQuerySearch - 보조 역질의 벡터 검색
 *
 * 작성자: 최진호
 * 작성일: 2026-08-28
 *
 * fragment_synthetic_query의 보조 벡터로 후보를 찾아 원 파편으로 되돌린다.
 * 본문 임베딩이 놓치는 표기 불일치를 메우는 경로다.
 *
 * 보조 히트의 유사도는 감쇠 계수를 적용해 본문 히트와 구분한다. 감쇠 없이 넘기면
 * _computeRankScore의 semanticWeight 해석이 왜곡되고, 표현만 그럴듯한 역질의가
 * 본문 정확 일치를 밀어낼 수 있다.
 */

import { getPrimaryPool } from "../../tools/db.js";
import { MEMORY_CONFIG }  from "../../../config/memory.js";
import { logWarn }        from "../../logger.js";

const SCHEMA = "agent_memory";

/**
 * 키 격리 목록을 정규화한다. 스칼라와 배열 입력을 모두 받는다.
 *
 * @param {string|string[]|null} keyId
 * @param {string[]|undefined}   groupKeyIds
 * @returns {string[]|null} 마스터 스코프이면 null
 */
export function normalizeKeyList(keyId, groupKeyIds) {
  if (Array.isArray(groupKeyIds) && groupKeyIds.length > 0) return groupKeyIds;
  if (Array.isArray(keyId)) return keyId.length > 0 ? keyId : null;
  return keyId ? [keyId] : null;
}

/**
 * 보조 벡터 검색이 켜져 있는지 판정한다.
 *
 * @returns {boolean}
 */
export function isSyntheticSearchEnabled() {
  return MEMORY_CONFIG.syntheticQuery?.searchEnabled !== false;
}

/**
 * 보조 히트 목록을 파편 단위로 집약한다.
 * 같은 파편의 여러 역질의가 걸리면 가장 높은 감쇠 후 유사도만 남긴다.
 *
 * @param {Array<{fragment_id: string, similarity: number}>} hits
 * @param {number} decay
 * @returns {Map<string, number>} fragment_id -> 감쇠 적용 유사도
 */
export function aggregateHits(hits, decay = 0.85) {
  const best = new Map();
  for (const hit of hits || []) {
    if (!hit?.fragment_id) continue;
    const value = Number(hit.similarity);
    if (!Number.isFinite(value)) continue;
    const decayed = value * decay;
    const prev    = best.get(hit.fragment_id);
    if (prev === undefined || decayed > prev) best.set(hit.fragment_id, decayed);
  }
  return best;
}

/**
 * 이미 본문 경로로 찾은 파편은 보조 결과에서 제외하고, 나머지만 후보로 만든다.
 *
 * @param {Map<string, number>} aggregated
 * @param {Set<string>}         existingIds
 * @param {number}              limit
 * @returns {Array<{id: string, similarity: number}>}
 */
export function selectNewCandidates(aggregated, existingIds, limit) {
  return [...aggregated.entries()]
    .filter(([id]) => !existingIds.has(id))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id, similarity]) => ({ id, similarity }));
}

/**
 * 질의 벡터로 보조 벡터 표를 검색해 원 파편을 돌려준다.
 *
 * @param {number[]} vec
 * @param {Object}   opts
 * @param {string}   opts.agentId
 * @param {string|null}   [opts.keyId]
 * @param {string[]|null} [opts.groupKeyIds]
 * @param {string|null}   [opts.workspace]
 * @param {number}        [opts.minSimilarity]
 * @param {number}        [opts.limit]
 * @param {Set<string>}   [opts.excludeIds]
 * @returns {Promise<Object[]>} fragments 행 (similarity 포함)
 */
export async function searchSyntheticQueries(vec, opts = {}) {
  if (!isSyntheticSearchEnabled()) return [];
  if (!Array.isArray(vec) || vec.length === 0) return [];

  const cfg   = MEMORY_CONFIG.syntheticQuery || {};
  const decay = cfg.similarityDecay ?? 0.85;
  const limit = opts.limit ?? cfg.searchLimit ?? 10;
  const pool  = getPrimaryPool();
  if (!pool) return [];

  const minSimilarity = opts.minSimilarity ?? 0.2;
  const params        = [JSON.stringify(vec), minSimilarity, limit * 3];

  /** 키 격리는 시맨틱 검색 경로(FragmentReader.searchBySemantic)와 같은 표현을 쓴다.
   *  key_id = ANY(배열)은 전역(NULL) 파편도 함께 배제한다. */
  const keyList   = normalizeKeyList(opts.keyId, opts.groupKeyIds);
  let   keyClause = "";
  if (keyList) {
    params.push(keyList);
    keyClause = ` AND q.key_id = ANY($${params.length}::text[])`;
  }

  let hits;
  try {
    const { rows } = await pool.query(
      `SELECT q.fragment_id, 1 - (q.embedding <=> $1::vector) AS similarity
         FROM ${SCHEMA}.fragment_synthetic_query q
         JOIN ${SCHEMA}.fragments f ON f.id = q.fragment_id
        WHERE q.embedding IS NOT NULL
          AND f.valid_to IS NULL
          AND 1 - (q.embedding <=> $1::vector) >= $2${keyClause}
        ORDER BY q.embedding <=> $1::vector
        LIMIT $3`,
      params
    );
    hits = rows;
  } catch (err) {
    logWarn(`[SyntheticQuerySearch] 보조 벡터 검색 실패: ${err.message}`);
    return [];
  }

  const aggregated = aggregateHits(hits, decay);
  const candidates = selectNewCandidates(aggregated, opts.excludeIds ?? new Set(), limit);
  if (candidates.length === 0) return [];

  const simById = new Map(candidates.map(c => [c.id, c.similarity]));
  const idList  = candidates.map(c => c.id);
  const fragParams = [idList];
  let   fragKeyClause = "";
  if (keyList) {
    fragParams.push(keyList);
    fragKeyClause = ` AND f.key_id = ANY($${fragParams.length}::text[])`;
  }

  try {
    const { rows } = await pool.query(
      `SELECT f.*
         FROM ${SCHEMA}.fragments f
        WHERE f.id = ANY($1::text[])
          AND f.valid_to IS NULL${fragKeyClause}`,
      fragParams
    );

    /** ANY(...) 조회는 입력 순서를 보존하지 않는다. 채택 상한이 걸린 호출자가
     *  임의 순서에서 앞 몇 건만 취하면 정작 유사도가 가장 높은 파편이 버려진다. */
    return rows
      .map(row => ({
        ...row,
        similarity      : simById.get(row.id),
        _syntheticMatch : true,
      }))
      .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));
  } catch (err) {
    logWarn(`[SyntheticQuerySearch] 파편 조회 실패: ${err.message}`);
    return [];
  }
}
