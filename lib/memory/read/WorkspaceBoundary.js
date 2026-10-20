/**
 * 다른 작업 공간에서 확인된 사실 표시
 *
 * 작성자: 최진호
 * 작성일: 2026-10-20
 *
 * 작업 공간의 사실(fact)은 그 작업 공간에서 확인한 값이라, 다른 작업 공간에 옮기면 가설이다. 일반 조회는
 * 현재 작업 공간과 전역 파편만 돌려주므로 이런 경우가 생기지 않고, master의 allWorkspaces 조회에서만
 * 다른 작업 공간의 fact가 섞인다. 그때 적용 대상 작업 공간(요청의 workspace, 없으면 키 기본값)과 다른
 * 작업 공간의 fact에 다시 확인하라는 표시를 단다. 절차, 결정 같은 다른 유형과 전역 fact는 표시하지 않는다.
 * 시간이 지나 낡았다는 stale 표시와는 별개다. DB를 읽지 않는 순수 함수다.
 */

/**
 * @param {{type?: string, workspace?: string|null}} fragment
 * @param {{allWorkspaces?: boolean, workspace?: string|null, _defaultWorkspace?: string|null}} params 조회 인자
 * @returns {string|null} 표시 문구. 표시하지 않으면 null
 */
export function workspaceBoundaryWarning(fragment, params = {}) {
  if (params.allWorkspaces !== true) return null;
  const target = params.workspace ?? params._defaultWorkspace ?? null;
  if (target === null || fragment?.type !== "fact") return null;
  const origin = fragment.workspace ?? null;
  if (origin === null || origin === target) return null;
  return `[WORKSPACE_SCOPE] 이 fact는 workspace '${origin}'에서 확인된 값입니다. '${target}'에 적용하기 전에 다시 확인하세요.`;
}
