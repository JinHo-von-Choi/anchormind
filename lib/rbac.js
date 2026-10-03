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
 * 키 권한 목록에 두는 출처 신뢰 표지. 이 표지가 있는 키는 클라이언트가 주장한 출처의 신뢰 등급을
 * 높음(3)까지 쓸 수 있고, 없는 키는 보통(2)이 상한이다. 도구 허가에는 쓰지 않는다.
 */
export const TRUSTED_ORIGIN_PERMISSION = "trusted_origin";

/**
 * 키가 출처 신뢰 표지를 가졌는지 본다. 마스터 키는 항상 가진 것으로 본다.
 *
 * @param {string[]|null} permissions
 * @param {boolean} [isMaster]
 * @returns {boolean}
 */
export function trustedOriginGranted(permissions, isMaster = false) {
  if (isMaster === true) return true;
  return Array.isArray(permissions) && permissions.includes(TRUSTED_ORIGIN_PERMISSION);
}

/**
 * 권한 검증
 * @param {string[]|null} permissions - null이면 master key (전체 허용)
 * @param {string} toolName
 * @returns {{ allowed: boolean, required?: string, reason?: string }}
 */
export function checkPermission(permissions, toolName, isMaster = false) {
  const required = TOOL_PERMISSIONS[toolName];
  /**
   * default-deny. TOOL_PERMISSIONS에 등재되지 않은 도구는 마스터 키(permissions=null)
   * 포함 어떤 권한 셋으로도 허용되지 않는다. 새 도구 추가 시 반드시 TOOL_PERMISSIONS를
   * 갱신해야 한다.
   */
  if (!required) return { allowed: false, reason: "unknown_tool" };
  if (isMaster === true) return { allowed: true };
  if (!Array.isArray(permissions)) return { allowed: false, required, reason: "invalid_permissions" };
  if (permissions.includes(required)) return { allowed: true };
  if (permissions.includes("admin")) return { allowed: true };
  return { allowed: false, required };
}

/** 앵커 지정 권한 이름. write와 별개로 부여한다. */
export const ANCHOR_PERMISSION = "anchor";

/**
 * 키 권한 목록이 앵커 지정을 허용하는지 본다. admin 권한은 앵커 권한을 포함한다.
 * master 판정은 호출자가 먼저 한다.
 *
 * @param {string[]|null|undefined} permissions
 * @returns {boolean}
 */
export function hasAnchorPermission(permissions) {
  if (!Array.isArray(permissions)) return false;
  return permissions.includes(ANCHOR_PERMISSION) || permissions.includes("admin");
}
