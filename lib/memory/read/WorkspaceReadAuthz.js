/**
 * 읽기 경로 workspace 허가 관문
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * tools/call의 읽기 도구와 resources/read가 처리기에 들어가기 전에 호출하는 단일 관문이다. 요청의
 * effective workspace(명시 인자 > 키 기본값 > 전역, 저장소 전체 집계 도구는 전체 workspace)를 키의
 * allowed_workspaces로 판정한다(workspace-read-policy.js). 방식은 MEMENTO_WORKSPACE_READ_AUTHZ다.
 *   off     판정하지 않는다.
 *   warn    허가 밖 요청을 would_deny 지표와 경고 로그(키 id, 표면, 사유, 대상 workspace)로 남기고 통과시킨다.
 *   enforce 허가 밖 요청을 WorkspaceReadDeniedError(-32001)로 거부한다. 허가된 범위 제한 키의 요청에는
 *           args._workspaceReadRange를 붙여 SearchScope가 파편 단위로 같은 판정을 적용하게 한다.
 *
 * authorizeModePreset은 같은 방식으로 master가 아닌 세션의 master 전용 preset 요청을 판정한다.
 * warn은 기록만 하고 preset을 무시하는 동작을 유지하며, enforce는 ModePresetRejectedError를 돌려준다.
 */

import { getAllowedWorkspaces, WORKSPACE_LOOKUP_FAILED } from "../../admin/ApiKeyStore.js";
import { workspaceReadAuthzMode }                        from "../../config.js";
import { logWarn }                                       from "../../logger.js";
import { getPreset }                                     from "../ModeRegistry.js";
import { workspaceReadTarget }                           from "./WorkspaceScope.js";
import { recordWorkspaceReadAuthz }                      from "./read-authz-metrics.js";
import {
  decideWorkspaceRead,
  WorkspaceReadDeniedError,
  ModePresetRejectedError,
  WORKSPACE_READ_TOOLS,
  RESOURCE_READ_SURFACE,
  MODE_PRESET_SURFACE,
  MODE_PRESET_REASON
} from "./workspace-read-policy.js";

const ALL_WORKSPACES_TARGET = Object.freeze({ workspace: null, allWorkspaces: true, source: "none" });

/**
 * 표면의 대상 종류. 허가 대상이 아니면 null.
 *
 * @param {string} surface
 * @returns {"request"|"all_workspaces"|null}
 */
function targetKindOf(surface) {
  if (surface === RESOURCE_READ_SURFACE) return "request";
  return Object.hasOwn(WORKSPACE_READ_TOOLS, surface) ? WORKSPACE_READ_TOOLS[surface] : null;
}

/**
 * 허가 밖 판정을 지표와 로그로 남기고 방식에 따른 결과를 정한다.
 *
 * @returns {"would_deny"|"denied"}
 */
function noteDenial(mode, surface, reason, detail) {
  const outcome = mode === "enforce" ? "denied" : "would_deny";
  recordWorkspaceReadAuthz(surface, reason, outcome);
  logWarn(`[WorkspaceReadAuthz] ${outcome} surface=${surface} reason=${reason} ${detail}`);
  return outcome;
}

/**
 * 읽기 요청 하나를 판정한다.
 *
 * @param {string} surface 도구 이름 또는 resources/read
 * @param {object} args    서버가 신뢰 문맥(_keyId, _isMaster, _defaultWorkspace)을 주입한 인자
 * @param {{ mode?: () => string, getAllowedWorkspaces?: (keyId: string|null) => Promise<unknown> }} [deps]
 * @returns {Promise<{ allowed: boolean, reason: string }|null>} 판정하지 않았으면 null
 * @throws {WorkspaceReadDeniedError} enforce에서 허가 밖일 때
 */
export async function authorizeWorkspaceRead(surface, args, deps = {}) {
  const kind = targetKindOf(surface);
  if (kind === null) return null;

  const mode = (deps.mode ?? workspaceReadAuthzMode)();
  if (mode === "off") return null;
  if (args._isMaster === true) return { allowed: true, reason: "master" };

  const keyId        = args._keyId ?? null;
  const target       = kind === "all_workspaces" ? ALL_WORKSPACES_TARGET : workspaceReadTarget(args);
  const allowed      = await (deps.getAllowedWorkspaces ?? getAllowedWorkspaces)(keyId);
  const lookupFailed = allowed === WORKSPACE_LOOKUP_FAILED;
  const decision     = decideWorkspaceRead({
    allowedWorkspaces: lookupFailed ? null : allowed,
    lookupFailed,
    target
  });

  if (decision.allowed) {
    if (mode === "enforce" && Array.isArray(allowed)) args._workspaceReadRange = [...allowed];
    return decision;
  }

  const workspaceLabel = target.allWorkspaces ? "*" : (target.workspace ?? "-");
  const outcome        = noteDenial(mode, surface, decision.reason, `key=${keyId} workspace=${workspaceLabel}`);
  if (outcome === "denied") throw new WorkspaceReadDeniedError(surface, decision.reason);
  return decision;
}

/**
 * master 전용 preset 요청을 판정한다.
 *
 * @param {{ preset: string|null, source: string, isMaster: boolean, keyId?: string|null }} input
 * @param {{ mode?: () => string, getPreset?: (name: string) => object|null }} [deps]
 * @returns {{ rejected: boolean, error: ModePresetRejectedError|null }}
 */
export function authorizeModePreset({ preset, source, isMaster, keyId = null }, deps = {}) {
  const pass = { rejected: false, error: null };
  if (!preset || isMaster === true) return pass;

  const mode = (deps.mode ?? workspaceReadAuthzMode)();
  if (mode === "off") return pass;
  if ((deps.getPreset ?? getPreset)(preset)?.requiresMaster !== true) return pass;

  const outcome = noteDenial(mode, MODE_PRESET_SURFACE, MODE_PRESET_REASON, `key=${keyId} preset=${preset} source=${source}`);
  return outcome === "denied"
    ? { rejected: true, error: new ModePresetRejectedError(preset, source) }
    : pass;
}
