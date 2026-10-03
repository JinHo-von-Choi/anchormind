/**
 * 읽기 경로 workspace 허가 판정
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * API 키의 allowed_workspaces로 읽기 요청의 대상과 파편 하나의 workspace를 판정하는 순수 함수와
 * 판정 오류 형식을 둔다. 입출력과 환경 판독은 WorkspaceReadAuthz.js가 맡는다.
 *
 * 규칙
 *   - master 주체는 제한이 없다.
 *   - allowed_workspaces가 NULL인 키는 제한이 없다.
 *   - 범위가 있는 키는 범위 안 workspace와 전역(workspace NULL) 파편만 읽는다. 빈 범위는 전역만 읽는다.
 *   - 범위가 있는 키에게 전체 workspace 대상(allWorkspaces, 저장소 전체 집계)은 범위 밖이다.
 *   - 범위 조회에 실패했거나 범위 형식이 틀리면 판정할 수 없으므로 범위 밖으로 다룬다.
 */

/** 거부 사유. 지표 라벨의 닫힌 집합이기도 하다. */
export const WORKSPACE_READ_REASONS = Object.freeze([
  "explicit_out_of_range",
  "default_out_of_range",
  "all_workspaces",
  "lookup_failed"
]);

/**
 * workspace 허가를 거치는 읽기 도구와 대상 종류.
 *   request        요청의 effective workspace(명시 인자 > 키 기본값 > 전역)
 *   all_workspaces 저장소 전체 집계를 돌려주는 도구
 * 읽기 권한 도구 가운데 이 표에 없는 도구는 WORKSPACE_READ_EXEMPT에 근거와 함께 올라 있다.
 */
export const WORKSPACE_READ_TOOLS = Object.freeze({
  recall             : "request",
  context            : "request",
  graph_explore      : "request",
  fragment_history   : "request",
  reconstruct_history: "request",
  search_traces      : "request",
  memory_stats       : "all_workspaces"
});

/** 파편 내용이나 workspace별 자료를 돌려주지 않는 읽기 권한 도구와 그 근거 */
export const WORKSPACE_READ_EXEMPT = Object.freeze({
  batch_status   : "작업 id의 진행 상태만 돌려준다",
  get_skill_guide: "고정 안내 문서를 돌려준다",
  session_rotate : "호출자 자신의 세션을 회전한다"
});

/** resources/read 판정 표면 이름 */
export const RESOURCE_READ_SURFACE = "resources/read";

/** master 전용 preset 판정 표면 이름과 사유 */
export const MODE_PRESET_SURFACE = "mode_preset";
export const MODE_PRESET_REASON  = "preset_requires_master";

const DENY_MESSAGES = Object.freeze({
  explicit_out_of_range: "Permission denied: the requested workspace is outside the key's allowed_workspaces",
  default_out_of_range : "Permission denied: the key's default workspace is outside the key's allowed_workspaces",
  all_workspaces       : "Permission denied: a key with allowed_workspaces cannot read across all workspaces",
  lookup_failed        : "Permission denied: the key's allowed_workspaces could not be determined"
});

/**
 * 범위가 있는 키의 읽기 요청이 범위 밖일 때의 오류. 응답에는 자료를 싣지 않는다.
 */
export class WorkspaceReadDeniedError extends Error {
  /**
   * @param {string} surface 판정 표면(도구 이름 또는 resources/read)
   * @param {string} reason  WORKSPACE_READ_REASONS 가운데 하나
   */
  constructor(surface, reason) {
    super(DENY_MESSAGES[reason] ?? DENY_MESSAGES.lookup_failed);
    this.name    = "WorkspaceReadDeniedError";
    this.code    = -32001;
    this.surface = surface;
    this.reason  = reason;
  }
}

/**
 * master가 아닌 세션이 master 전용 preset을 요청했을 때의 오류.
 */
export class ModePresetRejectedError extends Error {
  /**
   * @param {string} preset 등록된 preset 이름
   * @param {"header"|"initialize_params"|"key_default"} source 요청 출처
   */
  constructor(preset, source) {
    super(`Permission denied: mode preset '${preset}' requires master authentication`);
    this.name   = "ModePresetRejectedError";
    this.code   = -32001;
    this.preset = preset;
    this.source = source;
  }
}

/**
 * 파편 하나의 workspace를 허가 범위로 판정한다.
 *
 * @param {string[]|null|undefined} range     허가 범위. null이면 제한 없음
 * @param {string|null|undefined}   workspace 파편의 workspace. null이면 전역 파편
 * @returns {boolean}
 */
export function isWorkspaceReadable(range, workspace) {
  if (range == null)     return true;
  if (workspace == null) return true;
  return range.includes(workspace);
}

/**
 * 읽기 요청 하나를 판정한다.
 *
 * @param {{
 *   isMaster?: boolean,
 *   allowedWorkspaces?: string[]|null,
 *   lookupFailed?: boolean,
 *   target: { workspace: string|null, allWorkspaces: boolean, source: "explicit"|"key_default"|"none" }
 * }} input
 * @returns {{ allowed: boolean, reason: string }}
 */
export function decideWorkspaceRead({ isMaster = false, allowedWorkspaces = null, lookupFailed = false, target }) {
  if (isMaster === true)                   return { allowed: true,  reason: "master" };
  if (lookupFailed === true)               return { allowed: false, reason: "lookup_failed" };
  if (allowedWorkspaces === null)          return { allowed: true,  reason: "unrestricted" };
  if (!Array.isArray(allowedWorkspaces))   return { allowed: false, reason: "lookup_failed" };
  if (target.allWorkspaces === true)       return { allowed: false, reason: "all_workspaces" };
  if (isWorkspaceReadable(allowedWorkspaces, target.workspace)) {
    return { allowed: true, reason: target.workspace == null ? "global" : "in_range" };
  }
  return {
    allowed: false,
    reason : target.source === "key_default" ? "default_out_of_range" : "explicit_out_of_range"
  };
}
