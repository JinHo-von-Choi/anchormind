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
 * MCP 전송 계층이 주입한 master 여부로 전체 workspace 조회 권한을 검증한다.
 * `_isMaster`는 클라이언트 입력을 제거한 뒤 서버가 다시 주입한다.
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
  if (allWorkspaces) return params.length + 1;

  if (workspace === null) {
    conditions.push(`${column} IS NULL`);
    return params.length + 1;
  }

  params.push(workspace);
  conditions.push(`(${column} = $${params.length} OR ${column} IS NULL)`);
  return params.length + 1;
}
