/**
 * RankSimilarity - 유사도 없이 들어온 후보의 순위용 코사인
 *
 * 작성자: 최진호
 * 작성일: 2026-11-02
 *
 * 키워드(L2), 그래프 이웃, 연결 파편은 similarity 없이 후보가 된다. 순위 점수는 similarity가 없으면 0으로 보므로,
 * semanticWeight를 키운 모델(semanticSearch.modelCalibration의 ranking)에서는 이 후보들이 약한 의미 후보에도 밀린다.
 * 그래서 이미 범위 필터를 통과한 후보에 질의 벡터와의 실제 코사인을 _rankSimilarity로 붙여 같은 기준으로 순위를 매긴다.
 *
 * _rankSimilarity는 순위 점수(_computeRankScore, computeRecallScore)만 읽고 응답에서 지운다. similarity 값과
 * threshold 필터, MMR, 중복 판정은 그대로다. 질의 벡터는 같은 요청의 L3 검색이 만든 것(sq._rankVec)을 쓰고, 없으면
 * 임베딩 캐시에 있을 때만 쓴다. 그래서 임베딩 호출을 늘리지 않는다. 둘 다 없거나 조회가 실패하면 붙이지 않는다.
 */

import { MEMORY_CONFIG }                              from "../../../config/memory.js";
import { prepareTextForEmbedding, vectorToSql, EMBEDDING_ENABLED } from "../../tools/embedding.js";
import { queryWithAgentVector }                       from "../../tools/db.js";
import { logWarn }                                    from "../../logger.js";
import { SCHEMA }                                     from "../schema.js";
import { keyScopeClause }                             from "../keyScope.js";
import { expandAssistantQuery }                       from "./assistant-query.js";
import { semanticThresholds }                         from "./SemanticThresholds.js";

/**
 * keywords-only 질의의 L3 보조 검색 입력. 소문자·중복 제거·정렬로 결정적이라 임베딩 캐시 키가 된다.
 *
 * @param {string[]} keywords
 * @returns {string}
 */
export function keywordSynthText(keywords) {
  return [...new Set(keywords.map(k => String(k).toLowerCase().trim()))].sort().join(" ");
}

/**
 * L3 검색이 임베딩한 것과 같은 문자열. 임베딩이 꺼졌거나 L3가 돌지 않는 질의는 null이다.
 *
 * @param {{text?: string, keywords?: string[]}} sq
 * @returns {string|null}
 */
export function rankingQueryText(sq) {
  if (!EMBEDDING_ENABLED) return null;
  let raw = null;
  if (sq.text) raw = sq.text;
  else if ((MEMORY_CONFIG.semanticSearch?.keywordFallback ?? true) && Array.isArray(sq.keywords) && sq.keywords.length > 0) {
    raw = keywordSynthText(sq.keywords);
  }
  return raw ? prepareTextForEmbedding(expandAssistantQuery(raw).text, 500) : null;
}

/**
 * 후보 id의 질의 벡터 코사인. 임베딩이 없는 파편은 결과에 없다.
 *
 * @param {number[]} vec
 * @param {string[]} ids
 * @param {{keyId?: any, agentId?: string}} sq
 * @returns {Promise<Map<string, number>>}
 */
export async function loadRankSimilarities(vec, ids, sq) {
  const params    = [vectorToSql(vec), ids];
  const groupIds  = Array.isArray(sq.keyId) ? sq.keyId : [];
  const keyClause = keyScopeClause(params, "key_id", { keyId: Array.isArray(sq.keyId) ? sq.keyId[0] ?? null : sq.keyId ?? null, groupKeyIds: groupIds });
  const result    = await queryWithAgentVector(sq.agentId || "default",
    `SELECT id, 1 - (embedding <=> $1::vector) AS similarity
       FROM ${SCHEMA}.fragments
      WHERE id = ANY($2) AND embedding IS NOT NULL${keyClause}`,
    params
  );
  return new Map(result.rows.map(row => [row.id, Number(row.similarity)]));
}

/**
 * 순위 가중치를 덮어쓰는 모델이면 similarity가 없는 후보에 _rankSimilarity를 붙인다(변경). 실패해도 던지지 않는다.
 *
 * @param {{get: (text: string) => Promise<number[]|null>}} embeddingCache
 * @param {Object}   sq
 * @param {Object[]} fragments
 * @param {Function} [load] 테스트 대체용 조회 함수
 */
export async function attachRankSimilarity(embeddingCache, sq, fragments, load = loadRankSimilarities) {
  const text = semanticThresholds().modelRanking ? rankingQueryText(sq) : null;
  const ids  = text ? [...new Set(fragments.filter(f => f?.similarity == null && typeof f.id === "string").map(f => f.id))] : [];
  if (ids.length === 0) return;
  try {
    const vec = sq._rankVec?.value ?? await embeddingCache.get(text);
    if (!vec) return;
    const sims = await load(vec, ids, sq);
    for (const f of fragments) {
      if (f?.similarity == null && sims.has(f.id)) f._rankSimilarity = sims.get(f.id);
    }
  } catch (err) {
    logWarn(`[RankSimilarity] 순위용 유사도 조회 실패, 유사도 없이 정렬한다: ${err.message}`);
  }
}
