/**
 * 관리 판정(능력 기반)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 결정 표
 *   1. 주체 해석: 마스터 키는 owner, 관리자 세션은 역할 바인딩의 합집합, API 키는 service 프리셋 안에서
 *      permissions 변환(read는 mem.read, write는 mem.write와 mem.delete.soft, anchor는 mem.anchor)이 준 능력.
 *   2. 능력 집합 = 바인딩 프리셋 능력의 합집합에서 명시 거부(deny)를 뺀 것. 거부가 앞선다.
 *   3. 범위 = 그 능력을 주는 바인딩의 셀 목록. 셀은 (workspace, 키 목록)이고 null은 제한 없음이다.
 *      전역 바인딩은 전체, 그룹 바인딩은 그 그룹 멤버 키(binding.key_ids)로 제한한 셀이다. workspace 이름은 키마다
 *      따로 쓰는 이름이라 그룹 없이 workspace만 가진 바인딩(migration-074 이전 형식)은 능력을 주지 않는다.
 *      교집합 키 allowed_workspaces(API 키 주체, NULL은 제한 없음)
 *      교집합 범위 행(행이 하나라도 있으면 행에 없는 (능력, workspace) 조합은 거부, 행이 없으면 제한 없음).
 *   4. 허용 = 능력 포함 그리고 대상이 범위 안. 대상 workspace가 없으면 전역 대상이며 범위가 전체일 때만 허용한다.
 *      기억 조회 라우트(범위 종류 workspace)는 workspace 제한이 없는 셀(그룹 전체)이 있으면 전역 대상도 그 셀로
 *      허용한다. 그룹 라우트(범위 종류 group)는 대상 그룹에 묶인 바인딩이 있거나 범위가 전체일 때 허용한다.
 * 허용 판정의 방식(mode)은 대상을 덮는 바인딩(대상 workspace의 바인딩 또는 전역 바인딩, 전역 대상이면 전역
 * 바인딩만)에서 가장 넓은 것을 고른다. 질의 범위(scope)는 그 방식을 준 바인딩에 전역 바인딩이 있고 범위가
 * 전체일 때만 전체이고, 그 밖에는 대상 workspace 하나다. 관리 SQL은 scope로 거른다(adminScopeOf).
 * 거부는 어느 단계에서 멈췄는지(deniedAt)와 사유 코드를 남긴다. 판정 결과는 GET /me/explain의 응답이다.
 *
 * 집행은 관리 API 요청마다 authorizeAdminRoute가 라우트 표(admin-route-table.js)의 능력과 범위 종류로 한다.
 * 허용된 요청에는 주체와 판정을 묶어 두고, 처리기는 adminScopeOf(req)로 판정 범위를 받아 ScopeFilter에 넘긴다.
 */

import {
  ROLE_PRESETS, CAP_MODE_ORDER, CAP_AUTHENTICATED, CAP_PUBLIC, UNLISTED_ROUTE_CAP, isCapability, capabilitiesFromPermissions
} from "./capabilities.js";
import { findAdminRoute }          from "./admin-route-table.js";
import { applyResponseRedaction } from "./admin-redact.js";

/** 주체 종류 */
export const PRINCIPAL_KINDS = Object.freeze(["master", "admin_session", "api_key"]);

const ALL_RANGE = Object.freeze({ all: true });

/**
 * 마스터 키(또는 마스터 키 로그인 세션) 주체. owner를 전역으로 바인딩한다.
 *
 * @returns {object}
 */
export function masterPrincipal() {
  return { kind: "master", id: "master", bindings: [{ role: "owner", workspace: null }], deny: [] };
}

/**
 * API 키 주체. service 프리셋을 전역으로 바인딩하고 permissions와 allowed_workspaces를 함께 둔다.
 *
 * @param {{ keyId: string, permissions: string[]|null, allowedWorkspaces: string[]|null }} key
 * @returns {object}
 */
export function apiKeyPrincipal({ keyId, permissions, allowedWorkspaces }) {
  return {
    kind         : "api_key",
    id           : keyId,
    bindings     : [{ role: "service", workspace: null }],
    deny         : [],
    permissions  : Array.isArray(permissions) ? [...permissions] : [],
    keyWorkspaces: Array.isArray(allowedWorkspaces) ? [...allowedWorkspaces] : null
  };
}

/**
 * @param {unknown} principal
 * @returns {boolean}
 */
function isValidPrincipal(principal) {
  return Boolean(principal)
    && PRINCIPAL_KINDS.includes(principal.kind)
    && typeof principal.id === "string" && principal.id !== ""
    && Array.isArray(principal.bindings);
}

/**
 * 역할 이름의 프리셋. 모르는 이름은 null이다.
 *
 * @param {unknown} role
 * @returns {Record<string, string>|null}
 */
function presetOf(role) {
  return typeof role === "string" && Object.hasOwn(ROLE_PRESETS, role) ? ROLE_PRESETS[role] : null;
}

/**
 * 능력을 주는 바인딩 목록. API 키 주체는 permissions 변환이 준 능력만 남긴다.
 *
 * @param {object} principal
 * @param {string} cap
 * @returns {Array<{ role: string, workspace: string|null, mode: string }>}
 */
function grantsFor(principal, cap) {
  const legacy = principal.kind === "api_key" ? capabilitiesFromPermissions(principal.permissions) : null;
  if (legacy && !legacy.has(cap)) return [];
  const grants = [];
  for (const binding of principal.bindings) {
    const preset = presetOf(binding?.role);
    if (!preset || !Object.hasOwn(preset, cap)) continue;
    const workspace = typeof binding.workspace === "string" ? binding.workspace : null;
    const groupId   = typeof binding.group_id === "string" ? binding.group_id : null;
    /** 그룹 없는 workspace 바인딩은 같은 이름을 쓰는 모든 키를 열므로 능력을 주지 않는다 */
    if (workspace !== null && groupId === null) continue;
    const keyIds = groupId === null ? null
      : (Array.isArray(binding.key_ids) ? binding.key_ids.filter((id) => typeof id === "string") : []);
    grants.push({ role: binding.role, workspace, groupId, keyIds, mode: preset[cap] });
  }
  return grants;
}

/**
 * 범위의 셀 목록. 예전 형식(workspaces)은 키 제한 없는 셀로 읽는다.
 *
 * @param {{ all: boolean, cells?: object[], workspaces?: string[] }} range
 * @returns {Array<{ workspace: string|null, keyIds: string[]|null }>}
 */
export function rangeCells(range) {
  if (!range || range.all) return [{ workspace: null, keyIds: null }];
  if (Array.isArray(range.cells)) return range.cells;
  return Array.isArray(range.workspaces) ? range.workspaces.map((workspace) => ({ workspace, keyIds: null })) : [];
}

/**
 * 범위와 workspace 허용 목록의 교집합. list가 배열이 아니면 제한 없음이다.
 *
 * @param {{ all: boolean, cells?: object[] }} range
 * @param {string[]|null} list
 * @returns {{ all: boolean, cells?: object[] }}
 */
function intersectRange(range, list) {
  if (!Array.isArray(list)) return range;
  const allowed = [...new Set(list.filter((ws) => typeof ws === "string"))];
  const cells   = rangeCells(range).flatMap((cell) => (cell.workspace === null
    ? allowed.map((workspace) => ({ workspace, keyIds: cell.keyIds }))
    : (allowed.includes(cell.workspace) ? [cell] : [])));
  return { all: false, cells };
}

/**
 * 결정 표 3단계의 범위(셀 목록).
 *
 * @param {object} principal
 * @param {string} cap
 * @param {Array<{ workspace: string|null, groupId: string|null, keyIds: string[]|null }>} grants
 * @returns {{ all: boolean, cells?: Array<{ workspace: string|null, keyIds: string[]|null }> }}
 */
function rangeFor(principal, cap, grants) {
  let range = grants.some((g) => g.workspace === null && g.groupId === null)
    ? ALL_RANGE
    : { all: false, cells: grants.map((g) => ({ workspace: g.workspace, keyIds: g.keyIds })) };
  if (principal.kind === "api_key") range = intersectRange(range, principal.keyWorkspaces);
  const rows = Array.isArray(principal.scopeRows) ? principal.scopeRows : [];
  if (rows.length > 0) range = intersectRange(range, rows.filter((r) => r?.cap === cap).map((r) => r.workspace));
  return range.all ? { all: true } : range;
}

/**
 * 바인딩들이 주는 방식 중 가장 넓은 것.
 *
 * @param {Array<{ mode: string }>} grants
 * @returns {string}
 */
function widestMode(grants) {
  return grants.map((g) => g.mode).sort((a, b) => CAP_MODE_ORDER.indexOf(a) - CAP_MODE_ORDER.indexOf(b))[0];
}

/**
 * 판정 근거에 싣는 주체 요약. permissions, 키 범위 같은 정책 값은 단계 항목에만 싣는다.
 *
 * @param {object} principal
 * @returns {{ kind: string, id: string, roles: string[] }}
 */
function principalSummary(principal) {
  return {
    kind : principal.kind,
    id   : principal.id,
    roles: [...new Set(principal.bindings.map((b) => b?.role).filter((r) => typeof r === "string"))]
  };
}

/**
 * 판정 결과 값을 만든다.
 */
function result({ allowed, cap, workspace, principal, steps, deniedAt = null, reason = null, mode = null, range = null, scope = null }) {
  return {
    allowed,
    cap      : typeof cap === "string" ? cap : null,
    workspace: workspace ?? null,
    principal,
    mode,
    redact   : allowed && mode === "M",
    range,
    scope,
    deniedAt,
    reason,
    steps
  };
}

/**
 * 대상 workspace가 범위 안인지 본다. 대상이 없으면 범위가 전체여야 한다. keyScoped(기억 조회 라우트)이면
 * workspace 제한이 없는 셀(그룹 전체)로도 전역 대상을 허용한다.
 *
 * @param {{ all: boolean, cells?: object[] }} range
 * @param {string|null} workspace
 * @param {boolean} keyScoped
 * @returns {{ ok: boolean, reason: string|null }}
 */
function targetCheck(range, workspace, keyScoped) {
  if (range.all) return { ok: true, reason: null };
  const cells = rangeCells(range);
  if (workspace === null) {
    return keyScoped && cells.some((c) => c.workspace === null)
      ? { ok: true, reason: null }
      : { ok: false, reason: "global_target_requires_unrestricted_range" };
  }
  return cells.some((c) => c.workspace === null || c.workspace === workspace)
    ? { ok: true, reason: null }
    : { ok: false, reason: "workspace_out_of_range" };
}

/**
 * 두 키 목록이 같은 제한인지 본다(null은 제한 없음).
 *
 * @param {string[]|null} a
 * @param {string[]|null} b
 * @returns {boolean}
 */
function sameKeys(a, b) {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/**
 * 허용 판정의 방식과 질의 범위. 대상을 덮는 바인딩에서 가장 넓은 방식을 고르고, 질의 범위는 그 방식을 준
 * 바인딩의 범위로 좁힌다. 좁히지 않으면 그룹에 묶인 넓은 방식(가림 없음)이 전역의 좁은 방식(가림)이 덮던 다른 키
 * 파편까지 가림 없이 보여 준다. 방식을 준 바인딩에 전역 바인딩이 있고 범위가 전체면 질의 범위도 전체다.
 *
 * @param {Array<{ workspace: string|null, groupId: string|null, keyIds: string[]|null, mode: string }>} grants
 * @param {{ all: boolean, cells?: object[] }} range
 * @param {string|null} target
 * @returns {{ mode: string, scope: { all: boolean, cells?: object[] } }}
 */
function modeAndScope(grants, range, target) {
  const covering   = grants.filter((g) => g.workspace === null || (target !== null && g.workspace === target));
  const mode       = widestMode(covering);
  const modeGrants = covering.filter((g) => g.mode === mode);
  if (range.all && modeGrants.some((g) => g.workspace === null && g.groupId === null)) return { mode, scope: { all: true } };
  const source = range.all
    ? modeGrants.map((g) => ({ workspace: g.workspace, keyIds: g.keyIds }))
    : rangeCells(range).filter((c) => modeGrants.some((g) => sameKeys(g.keyIds, c.keyIds)));
  const cells = source
    .filter((c) => c.workspace === null || c.workspace === target)
    .map((c) => ({ workspace: target, keyIds: c.keyIds }));
  return { mode, scope: { all: false, cells } };
}

/**
 * 그룹 라우트 판정. 범위가 전체이거나 대상 그룹에 묶인 바인딩이 있으면 허용한다. 대상이 "*"(그룹 목록)이면 그룹
 * 바인딩이 하나라도 있으면 허용하고, 질의 범위에 그 그룹 id 목록을 싣는다.
 *
 * @param {Array<{ groupId: string|null, keyIds: string[]|null, mode: string }>} grants
 * @param {{ all: boolean }} range
 * @param {string} group
 * @returns {{ ok: boolean, mode?: string, scope?: object }}
 */
function groupCheck(grants, range, group) {
  if (range.all) return { ok: true, mode: widestMode(grants), scope: { all: true } };
  const matching = grants.filter((g) => g.groupId !== null && (group === "*" || g.groupId === group));
  if (matching.length === 0) return { ok: false };
  return {
    ok   : true,
    mode : widestMode(matching),
    scope: {
      all   : false,
      groups: [...new Set(matching.map((g) => g.groupId))],
      cells : matching.map((g) => ({ workspace: g.workspace, keyIds: g.keyIds }))
    }
  };
}

/**
 * 결정 표에 따라 주체가 능력을 대상 workspace에 쓸 수 있는지 판정한다. 순수 함수다.
 *
 * @param {object|null} principal
 * @param {string} cap
 * @param {{ workspace?: string|null, group?: string|null, keyScoped?: boolean }} [target]
 *        group은 그룹 라우트의 대상 그룹 id("*"는 그룹 목록), keyScoped는 기억 조회 라우트 여부
 * @returns {object} 판정 결과(allowed, mode, redact, range, scope, deniedAt, reason, steps, principal)
 */
export function decide(principal, cap, { workspace = null, group = null, keyScoped = false } = {}) {
  const target = typeof workspace === "string" && workspace !== "" ? workspace : null;
  const base   = { cap, workspace: target };
  if (!isValidPrincipal(principal)) {
    return result({ ...base, allowed: false, principal: null, deniedAt: "principal", reason: "invalid_principal",
      steps: [{ step: "principal", ok: false }] });
  }
  const summary = principalSummary(principal);
  const steps   = [{ step: "principal", ok: true, kind: summary.kind, roles: summary.roles }];
  const out     = { ...base, principal: summary, steps };

  if (cap === CAP_AUTHENTICATED) return result({ ...out, allowed: true });
  if (!isCapability(cap)) {
    steps.push({ step: "capability", ok: false, reason: "unknown_capability" });
    return result({ ...out, allowed: false, deniedAt: "capability", reason: "unknown_capability" });
  }

  const grants = grantsFor(principal, cap);
  const via    = [...new Set(grants.map((g) => g.role))];
  steps.push(principal.kind === "api_key"
    ? { step: "capability", ok: grants.length > 0, via, permissions: [...principal.permissions] }
    : { step: "capability", ok: grants.length > 0, via });
  if (grants.length === 0) return result({ ...out, allowed: false, deniedAt: "capability", reason: "not_granted" });

  const denied = Array.isArray(principal.deny) && principal.deny.includes(cap);
  steps.push({ step: "deny", ok: !denied });
  if (denied) return result({ ...out, allowed: false, deniedAt: "deny", reason: "explicitly_denied" });

  const range = rangeFor(principal, cap, grants);
  if (typeof group === "string" && group !== "") {
    const verdict = groupCheck(grants, range, group);
    steps.push({ step: "group", ok: verdict.ok, range, target: group, ...(verdict.ok ? {} : { reason: "group_out_of_range" }) });
    if (!verdict.ok) return result({ ...out, allowed: false, deniedAt: "group", reason: "group_out_of_range", mode: widestMode(grants), range });
    return result({ ...out, allowed: true, mode: verdict.mode, range, scope: verdict.scope });
  }
  const check = targetCheck(range, target, keyScoped);
  steps.push({ step: "workspace", ok: check.ok, range, target, ...(check.reason ? { reason: check.reason } : {}) });
  if (!check.ok) return result({ ...out, allowed: false, deniedAt: "workspace", reason: check.reason, mode: widestMode(grants), range });

  const { mode, scope } = modeAndScope(grants, range, target);
  return result({ ...out, allowed: true, mode, range, scope });
}

/** 요청별 주체와 판정 */
const contexts = new WeakMap();

/**
 * 허용된 요청의 질의 범위(판정의 scope). 판정을 거치지 않은 요청은 null이다(ScopeFilter에서 빈 결과).
 *
 * @param {object} req
 * @returns {{ all: boolean, cells?: Array<{ workspace: string|null, keyIds: string[]|null }>, groups?: string[] }|null}
 */
export function adminScopeOf(req) {
  return contexts.get(req)?.decision?.scope ?? null;
}

/**
 * 처리기가 관리 모듈 밖의 기억 읽기, 쓰기 경로(MemoryManager, 검색 집계, 내보내기, 가져오기, 세션 반영)를 부르기 전에
 * 질의 범위가 전체인지 확인한다. 전체가 아니거나 판정을 거치지 않은 요청이면 403을 쓰고 false다.
 *
 * @param {object} req
 * @param {import("node:http").ServerResponse} res
 * @returns {boolean}
 */
export function requireFullScope(req, res) {
  if (adminScopeOf(req)?.all === true) return true;
  res.statusCode = 403;
  res.end(JSON.stringify({ error: "Forbidden", reason: "full_scope_required" }));
  return false;
}

/**
 * 허용된 요청의 주체. 판정을 거치지 않은 요청은 null이다.
 *
 * @param {object} req
 * @returns {object|null}
 */
export function adminPrincipalOf(req) {
  return contexts.get(req)?.principal ?? null;
}

/**
 * 주체가 능력을 대상 workspace에 쓸 수 있는지 판정한다. 허용이면 주체와 판정을 요청에 묶고 판정을 돌려준다.
 * 거부면 403과 능력, 거부 단계, 사유를 쓰고 null을 돌려준다.
 *
 * @param {object} req
 * @param {import("node:http").ServerResponse} res
 * @param {{ principal: object, cap: string, workspace?: string|null, group?: string|null, keyScoped?: boolean }} args
 * @returns {object|null}
 */
export function requireCapability(req, res, { principal, cap, workspace = null, group = null, keyScoped = false }) {
  const decision = decide(principal, cap, { workspace, group, keyScoped });
  if (decision.allowed) {
    contexts.set(req, { principal, decision });
    return decision;
  }
  res.statusCode = 403;
  res.end(JSON.stringify({ error: "Forbidden", cap: decision.cap, deniedAt: decision.deniedAt, reason: decision.reason }));
  return null;
}

/**
 * 라우트 표 항목의 요구 능력. 표에 없는 경로는 owner 전용 능력을, 로그인 표지는 인증 표지를 요구한다.
 * API 키 주체는 자기 정보 라우트(인증 표지)만 부른다. 관리 질의는 키 범위를 걸지 않으므로 키 주체에게
 * 기억 능력 라우트를 열지 않는다.
 *
 * @param {object|null} entry
 * @param {object} principal
 * @returns {string}
 */
function routeCapability(entry, principal) {
  if (!entry) return UNLISTED_ROUTE_CAP;
  const cap = entry.cap === CAP_PUBLIC ? CAP_AUTHENTICATED : entry.cap;
  return principal?.kind === "api_key" && cap !== CAP_AUTHENTICATED ? UNLISTED_ROUTE_CAP : cap;
}

/**
 * 관리 API 요청 하나를 라우트 표로 판정한다. 허용이면 마스킹 판정의 응답 가림을 걸고 true를 돌려준다.
 *
 * @param {object} req
 * @param {import("node:http").ServerResponse} res
 * @param {{ principal: object, method: string, subPath: string, searchParams: URLSearchParams }} args
 * @returns {boolean}
 */
export function authorizeAdminRoute(req, res, { principal, method, subPath, searchParams }) {
  const found     = findAdminRoute(method, subPath);
  const entry     = found?.entry ?? null;
  const workspace = entry?.scope === "workspace" ? searchParams.get("workspace") : null;
  const group     = entry?.scope === "group" ? (found.params[0] ?? "*") : null;
  const decision  = requireCapability(req, res, {
    principal, cap: routeCapability(entry, principal), workspace, group, keyScoped: entry?.scope === "workspace"
  });
  if (!decision) return false;
  applyResponseRedaction(res, decision);
  return true;
}
