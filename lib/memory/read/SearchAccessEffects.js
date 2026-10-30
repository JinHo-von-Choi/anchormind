/**
 * SearchAccessEffects - 검색 결과의 접근 기록과 Hot Cache 저장
 *
 * 작성자: 최진호
 * 작성일: 2026-10-31
 *
 * 검색 이벤트 영속화와 임계값 학습(SearchSideEffects)과 따로 둔다. 주입 조회(sideEffects: "access")는
 * 이 모듈만 쓰고, 내부 조회(sideEffects: "none")는 둘 다 쓰지 않는다.
 */

import { logWarn } from "../../logger.js";

/**
 * 검색 결과의 접근 기록과 Hot Cache 저장을 띄운다(기다리지 않음). 접근 횟수·EMA, 연결 파편 접근 시각,
 * Hot Cache가 대상이다. L1 대체 경로에서 온 결과는 EMA를 올리지 않는다.
 *
 * @param {{store: Object, cache: (rows: Object[], keyId: *) => Promise<void>}} deps
 * @param {Object}   sq          - 정규화된 쿼리(agentId, keyId, workspace, allWorkspaces)
 * @param {Object[]} clean       - 응답에 실을 결과
 * @param {Object[]} cacheable   - 캐시에 넣을 결과(content_hash 포함)
 * @param {boolean}  l1IsFallback
 * @param {"all"|"access"|"none"} [mode] - none이면 아무것도 하지 않는다
 */
export function applyAccessEffects({ store, cache }, sq, clean, cacheable, l1IsFallback, mode = "all") {
  if (clean.length === 0 || mode === "none") return;
  const accessIds = clean.map(f => f.id);
  store.incrementAccess(accessIds, sq.agentId, { noEma: l1IsFallback });
  store.touchLinked(accessIds, sq.agentId, sq.keyId, {
    workspace    : sq.workspace,
    allWorkspaces: sq.allWorkspaces
  }).catch(err => logWarn(`[SearchAccessEffects] touchLinked failed: ${err.message}`));
  cache(cacheable, sq.keyId);
}

/** 검색 부수 효과 범위 */
export const SEARCH_SIDE_EFFECTS = Object.freeze(["all", "access", "none"]);

/**
 * 검색 질의의 부수 효과 범위. 지정하지 않았거나 모르는 값이면 all이다.
 *
 * @param {{sideEffects?: string}} query
 * @returns {"all"|"access"|"none"}
 */
export function searchSideEffects(query) {
  return SEARCH_SIDE_EFFECTS.includes(query?.sideEffects) ? query.sideEffects : "all";
}

/**
 * Hot Cache를 저장할 namespace의 키. 조회는 검색 범위(키 그룹 배열)의 각 namespace를 차례로 보므로, 저장은
 * 파편을 쓴 키의 namespace에 한다. 행에 key_id가 없으면 단일 키 범위일 때만 그 키를 쓰고, 정할 수 없으면
 * 저장하지 않는다(undefined).
 *
 * @param {{key_id?: string|null}} fragment
 * @param {string|string[]|null} keyId - 검색 범위
 * @returns {string|null|undefined}
 */
export function hotCacheOwner(fragment, keyId) {
  if (Object.hasOwn(fragment, "key_id")) return fragment.key_id ?? null;
  if (!Array.isArray(keyId)) return keyId ?? null;
  return keyId.length === 1 ? keyId[0] : undefined;
}
