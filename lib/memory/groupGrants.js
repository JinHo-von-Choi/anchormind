/**
 * 키 그룹 멤버 권한
 *
 * 작성자: 최진호
 * 작성일: 2026-11-04
 *
 * 그룹 멤버 행(api_key_group_members.permissions)마다 다섯 권한을 둔다.
 *   read    같은 그룹에서 share를 가진 다른 멤버의 파편을 읽는다
 *   share   내 파편을 같은 그룹에서 read를 가진 다른 멤버가 읽게 한다
 *   link    읽을 수 있는 다른 멤버의 파편에 link 도구로 링크를 건다
 *   amend   읽을 수 있는 다른 멤버의 파편을 amend로 고친다
 *   forget  읽을 수 있는 다른 멤버의 파편을 id 지정 forget으로 지운다
 * 기본값은 read, share, link다. 권한 열이 생기기 전의 그룹 동작(서로 읽고 링크는 걸되 고치거나 지우지 못함)과 같다.
 *
 * 키 A가 키 B의 파편에 대해 가지는 권한은 A와 B가 함께 속한 그룹마다 따로 판정해 합친다. 한 그룹에서 A가
 * 권한 p와 read를 가지고 B가 share를 가지면 A는 B의 파편에 p를 가진다. 쓰기 권한(link, amend, forget)은
 * 읽을 수 있는 파편에만 쓴다. 읽지 못하는 파편은 조회 단계에서 보이지 않기 때문이다.
 *
 * 멤버 행의 shared_workspaces는 share가 여는 workspace 목록이다(NULL은 전체). 한 그룹이라도 전체를 열면 전체이고,
 * 목록끼리는 합친다. 목록이 있는 멤버 B의 파편은 요청의 workspace가 목록 안일 때만 읽힌다(requestGroupKeyIds).
 * 그때 B의 그 workspace 파편과 전역 파편이 보인다. id로 파편을 집는 경로는 파편의 workspace로 한 번 더 본다
 * (isShareReadable).
 */

export const GROUP_MEMBER_PERMISSIONS = Object.freeze(["read", "share", "link", "amend", "forget"]);

export const DEFAULT_MEMBER_PERMISSIONS = Object.freeze(["read", "share", "link"]);

/** 다른 멤버 파편에 대한 쓰기 권한. 세션 맥락의 groupGrants가 이 이름별로 대상 키 목록을 가진다. */
export const GROUP_WRITE_ACTIONS = Object.freeze(["link", "amend", "forget"]);

/** 그룹 권한 입력 오류(관리 API가 400으로 응답한다) */
export class GroupPermissionError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = "GroupPermissionError";
    this.code = "invalid_group_permissions";
  }
}

/** 공유 workspace 목록 상한 */
export const SHARED_WORKSPACES_MAX = 64;

/** 제어 문자(Unicode Cc) */
const CONTROL_CHARS = /\p{Cc}/u;

/**
 * 공유 workspace 목록 입력을 검사한다. null은 전체 공유다. 빈 배열은 공유하는 workspace가 없다는 뜻이다.
 *
 * @param {unknown} input
 * @returns {string[]|null}
 */
export function normalizeSharedWorkspaces(input) {
  if (input === null) return null;
  if (!Array.isArray(input)) throw new GroupPermissionError("shared_workspaces must be null or an array");
  const bad = input.filter((w) => typeof w !== "string" || w.trim() === "" || w.length > 128 || CONTROL_CHARS.test(w));
  if (bad.length > 0) throw new GroupPermissionError("shared_workspaces items must be 1-128 characters without control characters");
  const list = [...new Set(input.map((w) => w.trim()))];
  if (list.length > SHARED_WORKSPACES_MAX) throw new GroupPermissionError(`shared_workspaces allows at most ${SHARED_WORKSPACES_MAX} items`);
  return list;
}

/**
 * 권한 목록 입력을 검사해 정해진 순서의 중복 없는 배열로 만든다.
 *
 * @param {unknown} input
 * @returns {string[]}
 */
export function normalizeMemberPermissions(input) {
  if (!Array.isArray(input)) throw new GroupPermissionError("permissions must be an array");
  const unknown = input.filter((p) => typeof p !== "string" || !GROUP_MEMBER_PERMISSIONS.includes(p));
  if (unknown.length > 0) {
    throw new GroupPermissionError(`unknown permissions: ${unknown.map(String).join(", ")} (allowed: ${GROUP_MEMBER_PERMISSIONS.join(", ")})`);
  }
  return GROUP_MEMBER_PERMISSIONS.filter((p) => input.includes(p));
}

/**
 * 키 상태를 다시 읽지 못했을 때(재확인을 끈 설치)의 쓰기 권한. 멤버 권한이 생기기 전의 동작대로 읽을 수 있는
 * 다른 멤버 파편에 링크만 건다.
 *
 * @param {string|null} keyId
 * @param {string[]|null} groupKeyIds
 * @returns {{ link: string[], amend: string[], forget: string[] }}
 */
export function legacyGroupGrants(keyId, groupKeyIds) {
  const grants = emptyGroupGrants();
  if (keyId != null && Array.isArray(groupKeyIds)) grants.link = groupKeyIds.filter((id) => id !== keyId);
  return grants;
}

/**
 * 다른 멤버 파편에 대한 쓰기 권한이 하나도 없는 맥락. 그룹 권한을 알 수 없을 때도 이 값을 쓴다.
 *
 * @returns {{ link: string[], amend: string[], forget: string[] }}
 */
export function emptyGroupGrants() {
  return { link: [], amend: [], forget: [] };
}

/**
 * 판정 행에서 읽기 대상 목록, 쓰기 권한, 공유 workspace 제한을 만든다. 행은 (같은 그룹의 다른 멤버, 그룹)마다
 * 하나이고 같은 멤버의 행은 합친다. 읽을 수 없는 행은 쓰기 권한과 공유 범위에 넣지 않는다.
 *
 * @param {string} keyId 요청 키
 * @param {Array<{ key_id: string, can_read: boolean, can_link: boolean, can_amend: boolean, can_forget: boolean,
 *                 shared_workspaces?: string[]|null }>} rows
 * @returns {{ groupKeyIds: string[], groupGrants: { link: string[], amend: string[], forget: string[] },
 *             groupShareScopes: Record<string, string[]> }}
 */
export function groupAccessFromRows(keyId, rows) {
  const members = new Map();
  for (const row of rows) {
    if (row.key_id === keyId || row.can_read !== true) continue;
    const m = members.get(row.key_id) ?? { link: false, amend: false, forget: false, full: false, workspaces: new Set() };
    m.link   ||= row.can_link === true;
    m.amend  ||= row.can_amend === true;
    m.forget ||= row.can_forget === true;
    if (!Array.isArray(row.shared_workspaces)) m.full = true;
    else for (const w of row.shared_workspaces) m.workspaces.add(w);
    members.set(row.key_id, m);
  }
  const grants = emptyGroupGrants();
  const scopes = {};
  for (const [id, m] of members) {
    if (m.link)   grants.link.push(id);
    if (m.amend)  grants.amend.push(id);
    if (m.forget) grants.forget.push(id);
    if (!m.full) scopes[id] = [...m.workspaces].sort();
  }
  return { groupKeyIds: [keyId, ...members.keys()], groupGrants: grants, groupShareScopes: scopes };
}

/**
 * 신뢰할 수 있는 세션 맥락의 공유 workspace 제한만 남긴다. 형식이 틀린 항목은 빈 목록(아무 workspace도 공유하지
 * 않음)으로 다룬다.
 *
 * @param {unknown} raw
 * @returns {Record<string, string[]>}
 */
export function sanitizeShareScopes(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [id, list] of Object.entries(raw)) {
    out[id] = Array.isArray(list) ? list.filter((w) => typeof w === "string") : [];
  }
  return out;
}

/**
 * 이 요청에서 읽을 수 있는 키 목록. 공유 workspace 제한이 있는 멤버는 요청의 workspace가 그 목록 안일 때만 남긴다.
 * 요청에 workspace가 없으면(전역 화면) 제한이 있는 멤버는 빠진다.
 *
 * @param {string|null} keyId
 * @param {string[]|null} groupKeyIds 그룹 판정의 읽기 대상(자기 키 포함)
 * @param {Record<string, string[]>} shareScopes
 * @param {string|null} workspace 요청의 workspace(명시 인자 또는 키 기본값)
 * @returns {string[]|null}
 */
export function requestGroupKeyIds(keyId, groupKeyIds, shareScopes, workspace) {
  if (!Array.isArray(groupKeyIds)) return groupKeyIds;
  return groupKeyIds.filter((id) => {
    if (id === keyId || !Object.hasOwn(shareScopes, id)) return true;
    return typeof workspace === "string" && shareScopes[id].includes(workspace);
  });
}

/**
 * id로 집은 파편을 이 요청이 읽을 수 있는지 공유 workspace 제한으로 본다. 자기 파편, 마스터, 제한 없는 멤버의
 * 파편은 언제나 된다. 제한이 있는 멤버의 파편은 전역 파편이거나 workspace가 목록 안이어야 한다.
 *
 * @param {{ key_id?: string|null, workspace?: string|null }} fragment
 * @param {{ keyId: string|null, groupShareScopes?: Record<string, string[]>|null }} ctx
 * @returns {boolean}
 */
export function isShareReadable(fragment, { keyId, groupShareScopes }) {
  const owner = fragment?.key_id ?? null;
  if (keyId == null || owner === keyId || owner == null) return true;
  const list = groupShareScopes?.[owner];
  if (!Array.isArray(list)) return true;
  return fragment.workspace == null || list.includes(fragment.workspace);
}

/**
 * 요청 키가 ownerKeyId 소유 파편에 action을 할 수 있는지 본다. 마스터(keyId null)와 자기 파편은 언제나 된다.
 *
 * @param {{ keyId: string|null, groupGrants?: object|null }} ctx
 * @param {"link"|"amend"|"forget"} action
 * @param {string|null} ownerKeyId 대상 파편의 key_id
 * @returns {boolean}
 */
export function canActOnGroupFragment({ keyId, groupGrants }, action, ownerKeyId) {
  if (keyId == null) return true;
  if (ownerKeyId === keyId) return true;
  if (ownerKeyId == null || !GROUP_WRITE_ACTIONS.includes(action)) return false;
  const list = groupGrants?.[action];
  return Array.isArray(list) && list.includes(ownerKeyId);
}

/**
 * 자동 링크(co_retrieved, temporal)를 걸 수 있는 파편 소유 키. 자기 키와 link 권한을 받은 멤버 키다. 마스터(keyId
 * null)는 null을 돌려주며, 이는 소유 키가 없는(마스터) 파편끼리만 잇는다는 뜻이다. 마스터 세션이 모든 키의 파편을
 * 읽는다고 그 사이에 링크를 걸면 키 경계를 넘는 그래프가 생긴다.
 *
 * @param {string|null} keyId
 * @param {unknown} groupGrants
 * @returns {string[]|null}
 */
export function autoLinkOwnerKeys(keyId, groupGrants) {
  if (keyId == null) return null;
  return [keyId, ...sanitizeGroupGrants(groupGrants).link.filter((id) => id !== keyId)];
}

/**
 * 파편 소유 키가 자동 링크 대상인지 본다.
 *
 * @param {string|null} ownerKeyId 파편의 key_id
 * @param {string[]|null} owners autoLinkOwnerKeys 결과
 * @returns {boolean}
 */
export function isAutoLinkOwner(ownerKeyId, owners) {
  return owners === null ? ownerKeyId == null : owners.includes(ownerKeyId);
}

/**
 * 신뢰할 수 있는 세션 맥락의 쓰기 권한만 남긴다. 형식이 틀린 값은 권한 없음으로 다룬다.
 *
 * @param {unknown} raw
 * @returns {{ link: string[], amend: string[], forget: string[] }}
 */
export function sanitizeGroupGrants(raw) {
  const grants = emptyGroupGrants();
  if (!raw || typeof raw !== "object") return grants;
  for (const action of GROUP_WRITE_ACTIONS) {
    const list = raw[action];
    if (Array.isArray(list)) grants[action] = list.filter((id) => typeof id === "string" && id !== "");
  }
  return grants;
}
