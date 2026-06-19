/**
 * RBAC - 도구별 권한 매핑 및 검증
 *
 * 작성자: 최진호
 * 작성일: 2026-03-27
 */

export const TOOL_PERMISSIONS = {
  remember:              "write",
  batch_remember:        "write",
  batch_status:          "read",
  recall:                "read",
  forget:                "write",
  link:                  "write",
  amend:                 "write",
  reflect:               "write",
  context:               "read",
  tool_feedback:         "write",
  memory_stats:          "read",
  memory_consolidate:    "admin",
  graph_explore:         "read",
  fragment_history:      "read",
  reconstruct_history:   "read",
  search_traces:         "read",
  get_skill_guide:       "read",
  check_update:          "admin",
  apply_update:          "admin",
  /**
   * session_rotate는 인증된 모든 사용자가 자기 세션을 회전할 수 있어야 한다.
   * 자원 소유권은 도구 핸들러가 sessionId 매칭으로 별도 검증한다.
   */
  session_rotate:        "read",
};

/**
 * 권한 검증
 * @param {string[]|null} permissions - null이면 master key (전체 허용)
 * @param {string} toolName
 * @returns {{ allowed: boolean, required?: string, reason?: string }}
 */
export function checkPermission(permissions, toolName) {
  const required = TOOL_PERMISSIONS[toolName];
  /**
   * default-deny. TOOL_PERMISSIONS에 등재되지 않은 도구는 마스터 키(permissions=null)
   * 포함 어떤 권한 셋으로도 허용되지 않는다. 새 도구 추가 시 반드시 TOOL_PERMISSIONS를
   * 갱신해야 한다.
   */
  if (!required) return { allowed: false, reason: "unknown_tool" };
  if (!permissions) return { allowed: true };
  if (permissions.includes(required)) return { allowed: true };
  if (permissions.includes("admin")) return { allowed: true };
  return { allowed: false, required };
}
