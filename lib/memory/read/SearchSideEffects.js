/**
 * SearchSideEffects — 검색 파이프라인 직후의 부작용을 단일 모듈로 격리한다.
 *
 * 책임:
 *  1. recordSearchEvent — 검색 이벤트 영속화. 동기 await으로 searchEventId를 반환하여
 *     호출자가 응답에 `_searchEventId`를 부착할 수 있게 한다(tool_feedback FK 계약).
 *  2. SearchParamAdaptor.recordOutcome — adaptor 학습 신호. fire-and-forget.
 *
 * FragmentSearch는 검색 파이프라인 결과 생성에만 집중하고, 본 모듈을 호출하여
 * 부작용 단계를 명시적으로 분리한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-05-13
 */

import { buildSearchEvent, recordSearchEvent, classifyQueryType } from "../signals/SearchEventRecorder.js";
import { getSearchParamAdaptor }                                  from "../signals/SearchParamAdaptor.js";

/**
 * 검색 결과 확정 직후의 부작용을 처리하고 searchEventId를 반환한다.
 *
 * @param {Object} query           - 원본 검색 쿼리
 * @param {Object} sq              - 정규화된 쿼리(keyId 등 포함)
 * @param {Array}  cleanResult     - 검색 결과 fragment 배열(필드 pick 이전)
 * @param {Object} ctx
 * @param {string[]}    ctx.searchPath
 * @param {string|null} ctx.sessionId
 * @param {number}      ctx.latencyMs
 * @param {boolean}     ctx.l1IsFallback
 * @param {Object}      ctx.layerLatency
 * @param {number}      ctx.rawResultCount
 * @returns {Promise<string|null>} searchEventId (실패 시 null)
 */
export async function commitSearchSideEffects(query, sq, cleanResult, ctx) {
  const keyIdForEvent = (Array.isArray(sq.keyId) ? sq.keyId[0] : sq.keyId) ?? null;

  const searchEvent = buildSearchEvent(
    query,
    cleanResult,
    {
      searchPath  : ctx.searchPath.join(" → "),
      sessionId   : ctx.sessionId,
      keyId       : keyIdForEvent,
      latencyMs   : ctx.latencyMs,
      l1IsFallback: ctx.l1IsFallback,
      l1LatencyMs : ctx.layerLatency.l1Ms  ?? null,
      l2LatencyMs : ctx.layerLatency.l2Ms  ?? null,
      l3LatencyMs : ctx.layerLatency.l3Ms  ?? null,
      graphUsed   : ctx.layerLatency.graphUsed ?? false
    }
  );
  const searchEventId = await recordSearchEvent(searchEvent).catch(() => null);

  /** SearchParamAdaptor: 결과 건수 기록 (fire-and-forget).
   *  Phase 5 CBR filter가 적용되어도 pre-filter count를 전달하여 학습 신호를 보호한다. */
  getSearchParamAdaptor()
    .recordOutcome(
      keyIdForEvent,
      classifyQueryType(query),
      new Date().getHours(),
      ctx.rawResultCount
    )
    .catch(() => {});

  return searchEventId;
}
