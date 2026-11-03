/**
 * 키 상태로 세션 identity 갱신
 *
 * 작성자: 최진호
 * 작성일: 2026-11-04
 *
 * MCP 세션(streamable, legacy SSE)과 훅 인증 캐시가 키 상태 재확인(key-state-cache.js) 결과로 권한, 기본 workspace,
 * 그룹 접근을 바꿀 때 같은 규칙을 쓰게 한다. 입출력이 없는 순수 함수다.
 */

import { legacyGroupGrants } from "../memory/groupGrants.js";

/**
 * 세션이나 캐시한 인증 결과에 덮어쓸 현재 identity. 키 상태에 있는 값만 싣는다. 그룹 접근을 읽지 못했으면
 * (재확인 꺼짐, 조회 실패) 세션의 그룹 목록을 그대로 두고 쓰기 권한은 legacyGroupGrants로 정한다.
 *
 * 공유 workspace 제한(groupShareScopes)도 키 상태에서 받고, 읽지 못했으면 세션에 저장된 값을 쓴다.
 *
 * @param {object|null} keyState getCachedKeyState 결과
 * @param {{ keyId: string|null, groupKeyIds: string[]|null, groupShareScopes?: object|null }} stored 세션에 저장된 값
 * @returns {{ permissions?: string[], groupKeyIds?: string[], defaultWorkspace?: string|null, groupGrants: object,
 *             groupShareScopes: object }}
 */
export function identityFromKeyState(keyState, stored) {
  const fresh = {};
  if (Array.isArray(keyState?.permissions)) fresh.permissions = keyState.permissions;
  if (keyState && Object.hasOwn(keyState, "defaultWorkspace")) fresh.defaultWorkspace = keyState.defaultWorkspace;
  if (Array.isArray(keyState?.groupKeyIds)) {
    fresh.groupKeyIds      = keyState.groupKeyIds;
    fresh.groupGrants      = keyState.groupGrants;
    fresh.groupShareScopes = keyState.groupShareScopes ?? {};
  } else {
    fresh.groupGrants      = legacyGroupGrants(stored.keyId, stored.groupKeyIds);
    fresh.groupShareScopes = stored.groupShareScopes ?? {};
  }
  return fresh;
}
