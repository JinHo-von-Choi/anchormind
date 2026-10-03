/**
 * context 도구 응답 조립
 *
 * 작성자: 최진호
 * 작성일: 2026-10-04
 *
 * ContextBuilder 결과의 내부 필드(_memento_hint, _searchEventId, _suggestion, _anchorSelection,
 * _coreSelection)를 응답의 `_meta` 블록으로 옮긴다. 나머지 필드는 그대로 싣는다. coreSelection은
 * 결과에 있을 때만(MEMENTO_PROVENANCE=on) 싣는다.
 */

import { serverTimeMeta } from "./serverTime.js";

/**
 * @param {object} result - ContextBuilder.build 결과
 * @returns {object} 성공 응답
 */
export function contextResponse(result) {
  const {
    _memento_hint,
    _searchEventId,
    _suggestion,
    _anchorSelection,
    _coreSelection,
    ...restResult
  } = result;
  return {
    success: true,
    ...restResult,
    _meta: {
      searchEventId  : _searchEventId ?? null,
      hints          : _memento_hint ? [_memento_hint] : [],
      suggestion     : _suggestion ?? undefined,
      anchorSelection: _anchorSelection,
      ...(_coreSelection ? { coreSelection: _coreSelection } : {}),
      serverTime     : serverTimeMeta()
    }
  };
}
