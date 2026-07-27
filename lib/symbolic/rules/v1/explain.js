/**
 * Explain Rules v1 — recall 결과에 대한 reason code 생성
 *
 * 작성자: 최진호
 * 작성일: 2026-04-15
 *
 * 6종 reason code (Phase 2 Explainability):
 * - direct_keyword_match   : L2 형태소/키워드 매치
 * - semantic_similarity    : L3 pgvector 임베딩 유사도
 * - graph_neighbor_1hop    : 그래프 이웃 1-hop
 * - temporal_proximity     : 시간적 근접 (timeRange / ±24h)
 * - case_cohort_member     : 동일 case cohort
 * - recent_activity_ema    : EMA 활성도 상위
 *
 * 각 fragment 당 최대 3개 reason 반환 (UI 출력 가독성).
 */

const MAX_REASONS_PER_FRAGMENT = 3;
const EMA_ACTIVATION_THRESHOLD = 0.5;
const RULE_VERSION             = "v1";

/**
 * searchPath 는 FragmentSearch 가 각 레이어에서 추가하는 태그 배열이다.
 * 본 함수는 tag prefix 로 레이어를 판별한다.
 *
 * @param {string[]} searchPath
 * @param {string} prefix
 * @returns {boolean}
 */
function hasLayerTag(searchPath, prefix) {
  if (!Array.isArray(searchPath)) return false;
  return searchPath.some((p) => typeof p === "string" && p.startsWith(prefix));
}

/**
 * Fragment 단건에 대한 reason code 배열을 생성한다.
 *
 * @param {Object} fragment             - 대상 파편
 * @param {Object} searchContext        - 검색 컨텍스트
 *   @param {string[]} [searchContext.searchPath]   - 레이어 태그 배열
 *   @param {Object}   [searchContext.layerLatency] - 레이어별 ms (사용처 향후 확장)
 *   @param {string}   [searchContext.query]        - 원 쿼리 (reserved)
 *   @param {string}   [searchContext.caseContext]  - 현재 case_id 맥락
 * @returns {Array<{code:string, detail:string, ruleVersion:string}>}
 */
export function buildReasonCodes(fragment, searchContext = {}) {
  const reasons     = [];
  const searchPath  = searchContext.searchPath || [];
  const caseContext = searchContext.caseContext;

  if (hasLayerTag(searchPath, "L2:")) {
    reasons.push({
      code       : "direct_keyword_match",
      detail     : "L2 형태소/키워드 매치",
      ruleVersion: RULE_VERSION
    });
  }

  /** L3 pgvector 또는 HotCache(L1) 는 둘 다 semantic layer 에 속한다 */
  if (hasLayerTag(searchPath, "L3:") || hasLayerTag(searchPath, "HotCache:") ||
      hasLayerTag(searchPath, "L3kw:")) {
    reasons.push({
      code       : "semantic_similarity",
      detail     : "L3 pgvector 임베딩 유사도",
      ruleVersion: RULE_VERSION
    });
  }

  if (hasLayerTag(searchPath, "Graph:")) {
    reasons.push({
      code       : "graph_neighbor_1hop",
      detail     : "그래프 이웃 1-hop",
      ruleVersion: RULE_VERSION
    });
  }

  if (hasLayerTag(searchPath, "Temporal:")) {
    reasons.push({
      code       : "temporal_proximity",
      detail     : "시간적 근접",
      ruleVersion: RULE_VERSION
    });
  }

  if (caseContext && fragment && fragment.case_id === caseContext) {
    reasons.push({
      code       : "case_cohort_member",
      detail     : "동일 case cohort",
      ruleVersion: RULE_VERSION
    });
  }

  const emaActivation = fragment && typeof fragment.ema_activation === "number"
    ? fragment.ema_activation
    : 0;

  if (emaActivation > EMA_ACTIVATION_THRESHOLD) {
    reasons.push({
      code       : "recent_activity_ema",
      detail     : "EMA 활성도 상위",
      ruleVersion: RULE_VERSION
    });
  }

  return reasons.slice(0, MAX_REASONS_PER_FRAGMENT);
}
