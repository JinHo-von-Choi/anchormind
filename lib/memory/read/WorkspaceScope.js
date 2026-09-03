/**
 * recall/context 전 경로가 공유하는 effective-workspace 계약.
 *
 * - 명시 workspace > API key default workspace > 전역(NULL) 순으로 해석한다.
 * - allWorkspaces=true만 workspace 필터를 제거한다.
 */

export const WORKSPACE_SCOPE_FORBIDDEN = "allWorkspaces requires master authentication";

/**
 * @param {object} [params]
 * @returns {{workspace: string|null, allWorkspaces: boolean, mode: "workspace"|"global_only"|"all_workspaces"}}
 */
export function resolveWorkspaceScope(params = {}) {
  /**
   * 권한 판정을 전송 래퍼에만 두면 MemoryManager를 직접 호출하는 CLI나
   * 임베디드 사용자가 allWorkspaces 검사를 우회할 수 있다. 스코프를 실제로
   * 해석하는 계층에서도 같은 검사를 수행해 모든 진입점의 계약을 맞춘다.
   */
  assertAllWorkspacesAuthorized(params);

  const allWorkspaces = params.allWorkspaces === true;
  const workspace = allWorkspaces
    ? null
    : (params.workspace ?? params._defaultWorkspace ?? null);

  return {
    workspace,
    allWorkspaces,
    mode: allWorkspaces
      ? "all_workspaces"
      : (workspace === null ? "global_only" : "workspace")
  };
}

/**
 * effective workspace SQL 조건을 만들고 필요한 값은 params에 바인딩한다.
 * 조건이 필요 없는 allWorkspaces 모드에서는 빈 문자열을 반환한다.
 *
 * @param {any[]} params
 * @param {{workspace?: string|null, allWorkspaces?: boolean}} scope
 * @param {string} [column]
 * @returns {string}
 */
export function workspaceCondition(
  params,
  { workspace = null, allWorkspaces = false } = {},
  column = "workspace"
) {
  if (allWorkspaces) return "";
  if (workspace === null) return `${column} IS NULL`;

  params.push(workspace);
  return `(${column} = $${params.length} OR ${column} IS NULL)`;
}

/**
 * 신뢰된 진입점이 주입한 master 여부로 전체 workspace 조회 권한을 검증한다.
 * MCP에서는 클라이언트의 `_isMaster` 입력을 제거한 뒤 서버가 다시 주입하며,
 * 로컬 CLI와 admin 경로는 자체 master 진입점임을 명시한다.
 *
 * @param {object} [params]
 */
export function assertAllWorkspacesAuthorized(params = {}) {
  if (params.allWorkspaces === true && params._isMaster !== true) {
    const error = new Error(WORKSPACE_SCOPE_FORBIDDEN);
    error.code = "WORKSPACE_SCOPE_FORBIDDEN";
    throw error;
  }
}

/**
 * SQL conditions/params에 effective workspace 조건을 추가한다.
 *
 * @param {string[]} conditions
 * @param {any[]} params
 * @param {{workspace?: string|null, allWorkspaces?: boolean}} scope
 * @param {string} [column]
 * @returns {number} 다음 PostgreSQL parameter index
 */
export function appendWorkspaceCondition(
  conditions,
  params,
  { workspace = null, allWorkspaces = false } = {},
  column = "workspace"
) {
  const condition = workspaceCondition(params, { workspace, allWorkspaces }, column);
  if (condition) conditions.push(condition);
  return params.length + 1;
}
