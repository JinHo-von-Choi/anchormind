/**
 * SearchEventRecorder - 검색 이벤트 영속화
 *
 * 작성자: 최진호
 * 작성일: 2026-03-25
 *
 * 검색 경로(L1/L2/L3/RRF) 파싱, 쿼리 타입 분류, 필터 키 추출,
 * agent_memory.search_events 테이블 INSERT를 담당한다.
 * recordSearchEvent는 fire-and-forget — 실패해도 호출자에게 예외를 전파하지 않는다.
 */

import { getPrimaryPool } from "../../tools/db.js";
import { logWarn }        from "../../logger.js";

/**
 * 검색 쿼리 객체를 분석하여 쿼리 타입을 반환한다.
 *
 * 분류 기준:
 *  - text 전용  → "text"
 *  - keywords 전용 → "keywords"
 *  - topic 전용(keywords 없음) → "topic"
 *  - 복수 필드  → "mixed"
 *  - 모든 필드 없음 → "keywords" (폴백)
 *
 * @param {{ text?: string, keywords?: string[], topic?: string }} query
 * @returns {"text"|"keywords"|"topic"|"mixed"}
 */
export function classifyQueryType(query) {
  if (!query || typeof query !== "object") return "keywords";

  const hasText     = query.text     !== undefined && query.text     !== null && query.text !== "";
  const hasKeywords = query.keywords !== undefined && query.keywords !== null &&
                      (Array.isArray(query.keywords) ? query.keywords.length > 0 : true);
  const hasTopic    = query.topic    !== undefined && query.topic    !== null && query.topic !== "";

  const count = (hasText ? 1 : 0) + (hasKeywords ? 1 : 0) + (hasTopic ? 1 : 0);

  if (count === 0) return "keywords";
  if (count > 1)  return "mixed";

  if (hasText)     return "text";
  if (hasKeywords) return "keywords";
  return "topic";
}

/**
 * 쿼리 객체에서 활성화된 필터 키 목록을 반환한다.
 *
 * 검사 대상 필드: topic, type, isAnchor, includeSuperseded, minImportance
 *  - isAnchor 존재 시 "is_anchor" 문자열로 출력
 *  - query.keyId가 존재하고 null이 아니면 "key_id" 추가
 *
 * @param {Object} query
 * @returns {string[]}
 */
export function extractFilterKeys(query) {
  if (!query || typeof query !== "object") return [];

  const keys = [];

  if (query.topic             !== undefined && query.topic             !== null) keys.push("topic");
  if (query.type              !== undefined && query.type              !== null) keys.push("type");
  if (query.isAnchor          !== undefined && query.isAnchor          !== null) keys.push("is_anchor");
  if (query.includeSuperseded !== undefined && query.includeSuperseded !== null) keys.push("includeSuperseded");
  if (query.minImportance     !== undefined && query.minImportance     !== null) keys.push("minImportance");
  if (query.keyId             !== undefined && query.keyId             !== null) keys.push("key_id");

  return keys;
}

/**
 * 검색 결과와 메타데이터로부터 DB INSERT용 이벤트 객체를 생성한다.
 *
 * searchPath 파싱 규칙:
 *  - "L1:N"  패턴에서 l1_count 추출
 *  - "L2:N"  패턴에서 l2_count 추출
 *  - "L3:N"  패턴에서 l3_count 추출
 *  - "RRF" 포함 여부로 used_rrf 결정
 *
 * @param {Object}  query                   - 원본 검색 쿼리 객체
 * @param {Array}   result                  - 검색 결과 배열
 * @param {Object}  meta                    - 메타데이터
 * @param {string}  [meta.searchPath]       - 검색 경로 문자열 (예: "L1:5 → L2:10 → RRF")
 * @param {string}  [meta.sessionId]        - 세션 ID
 * @param {number}  [meta.keyId]            - API 키 ID
 * @param {number}  [meta.latencyMs]        - 전체 검색 지연(ms)
 * @param {boolean} [meta.l1IsFallback]     - L1이 폴백으로 사용됐는지 여부
 * @param {number}  [meta.l1LatencyMs]      - L1 레이어 소요시간(ms)
 * @param {number}  [meta.l2LatencyMs]      - L2 레이어 소요시간(ms)
 * @param {number}  [meta.l3LatencyMs]      - L3 레이어 소요시간(ms)
 * @param {boolean} [meta.graphUsed]        - L2.5 Graph 사용 여부
 * @returns {Object}  agent_memory.search_events INSERT용 객체
 */
export function buildSearchEvent(query, result, meta = {}) {
  const searchPath  = meta.searchPath || "";
  const resultArray = Array.isArray(result) ? result : [];

  const l1Match = searchPath.match(/L1:(\d+)/);
  const l2Match = searchPath.match(/L2:(\d+)/);
  const l3Match = searchPath.match(/L3:(\d+)/);

  const l1Count  = l1Match ? parseInt(l1Match[1], 10) : 0;
  const l2Count  = l2Match ? parseInt(l2Match[1], 10) : 0;
  const l3Count  = l3Match ? parseInt(l3Match[1], 10) : 0;
  const usedRrf  = searchPath.includes("RRF");

  return {
    session_id    : meta.sessionId    ?? null,
    key_id        : meta.keyId        ?? null,
    search_path   : searchPath,
    l1_count      : l1Count,
    l2_count      : l2Count,
    l3_count      : l3Count,
    result_count  : resultArray.length,
    l1_is_fallback: meta.l1IsFallback ?? false,
    used_rrf      : usedRrf,
    latency_ms    : meta.latencyMs    ?? null,
    query_type    : classifyQueryType(query),
    filter_keys   : extractFilterKeys(query),
    l1_latency_ms : meta.l1LatencyMs  ?? null,
    l2_latency_ms : meta.l2LatencyMs  ?? null,
    l3_latency_ms : meta.l3LatencyMs  ?? null,
    graph_used    : meta.graphUsed    ?? false
  };
}

/**
 * 검색 이벤트를 agent_memory.search_events 테이블에 INSERT한다.
 *
 * fire-and-forget 설계: 실패해도 logWarn만 남기고 null을 반환한다.
 * 호출자의 검색 응답 경로에 예외를 전파하지 않는다.
 *
 * @param {Object} event - buildSearchEvent()가 반환한 이벤트 객체
 * @returns {Promise<number|null>} 삽입된 row의 id, 실패 시 null
 */
export async function recordSearchEvent(event) {
  const sql = `
    INSERT INTO agent_memory.search_events
      (session_id, key_id, search_path, l1_count, l2_count, l3_count,
       result_count, l1_is_fallback, used_rrf, latency_ms, query_type, filter_keys,
       l1_latency_ms, l2_latency_ms, l3_latency_ms, graph_used)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
    RETURNING id
  `;

  const params = [
    event.session_id,
    event.key_id,
    event.search_path,
    event.l1_count,
    event.l2_count,
    event.l3_count,
    event.result_count,
    event.l1_is_fallback,
    event.used_rrf,
    event.latency_ms,
    event.query_type,
    event.filter_keys,
    event.l1_latency_ms  ?? null,
    event.l2_latency_ms  ?? null,
    event.l3_latency_ms  ?? null,
    event.graph_used     ?? false
  ];

  try {
    const pool = getPrimaryPool();
    const res  = await pool.query(sql, params);
    return res.rows[0]?.id ?? null;
  } catch (err) {
    logWarn("SearchEventRecorder: INSERT 실패", { error: err.message });
    return null;
  }
}
