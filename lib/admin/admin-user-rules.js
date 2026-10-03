/**
 * 관리자 계정 규칙(순수 함수)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 계정 이름: 1~64자의 영문자, 숫자, 점, 밑줄, 하이픈, @. 중복 판정은 NFC 정규화한 소문자(username_norm)로 한다.
 * 역할 바인딩: 역할은 Core 프리셋 가운데 사람에게 주는 것(service 제외), workspace는 없거나(전역) 1~128자이고
 * 제어 문자가 없다. owner는 설치 전체 역할이라 전역 바인딩만 받는다. 같은 (역할, workspace)는 하나로 합친다.
 * TOTP: owner 또는 admin 역할 바인딩이 있는 계정은 TOTP 등록이 필수다.
 * 복구 코드: 10개, 코드마다 10자(base32 소문자, 5자씩 하이픈), 저장은 계정 id를 섞은 sha256 hex만 한다.
 */

import crypto from "node:crypto";

import { ROLE_PRESETS } from "./capabilities.js";

export const USERNAME_MAX          = 64;
export const WORKSPACE_MAX         = 128;
export const TOTP_REQUIRED_ROLES   = Object.freeze(["owner", "admin"]);
export const ASSIGNABLE_ROLES      = Object.freeze(Object.keys(ROLE_PRESETS).filter((r) => r !== "service"));
export const RECOVERY_CODE_COUNT   = 10;
export const MAX_BINDINGS_PER_USER = 64;

const USERNAME_PATTERN   = /^[A-Za-z0-9._@-]{1,64}$/;
const RECOVERY_ALPHABET  = "abcdefghijklmnopqrstuvwxyz234567";
const RECOVERY_PATTERN   = /^[a-z2-7]{10}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS      = /[\u0000-\u001f\u007f]/;

/** 계정 입력 값 오류. field와 reason을 응답에 싣는다(입력 값은 싣지 않는다). */
export class AdminUserInputError extends Error {
  /**
   * @param {string} field
   * @param {string} reason
   */
  constructor(field, reason) {
    super(`${field}: ${reason}`);
    this.name   = "AdminUserInputError";
    this.field  = field;
    this.reason = reason;
  }
}

/**
 * 계정 이름을 검사하고 표시 값과 중복 판정 값을 돌려준다.
 *
 * @param {unknown} username
 * @returns {{ username: string, norm: string }}
 */
export function normalizeUsername(username) {
  if (typeof username !== "string") throw new AdminUserInputError("username", "required");
  const display = username.normalize("NFC").trim();
  if (!USERNAME_PATTERN.test(display)) throw new AdminUserInputError("username", "format");
  return { username: display, norm: display.toLowerCase() };
}

/**
 * 로그인 입력의 계정 이름을 중복 판정 값으로 바꾼다. 형식이 틀리면 null이다(없는 계정과 같이 다룬다).
 *
 * @param {unknown} username
 * @returns {string|null}
 */
export function loginUsernameNorm(username) {
  try {
    return normalizeUsername(username).norm;
  } catch (err) {
    if (err instanceof AdminUserInputError) return null;
    throw err;
  }
}

/**
 * 바인딩 workspace 값 형식(1~128자, 제어 문자 없음).
 *
 * @param {unknown} workspace
 * @returns {boolean}
 */
function isWorkspaceValue(workspace) {
  return typeof workspace === "string" && workspace.length > 0 && workspace.length <= WORKSPACE_MAX && !CONTROL_CHARS.test(workspace);
}

/**
 * 역할 바인딩 입력을 검사하고 정리한다.
 *
 * @param {unknown} roles [{ role, workspace? }]
 * @returns {Array<{ role: string, workspace: string|null }>}
 */
export function normalizeRoleBindings(roles) {
  if (!Array.isArray(roles) || roles.length === 0) throw new AdminUserInputError("roles", "required");
  if (roles.length > MAX_BINDINGS_PER_USER) throw new AdminUserInputError("roles", "too_many");
  const out  = [];
  const seen = new Set();
  for (const item of roles) {
    const role      = typeof item === "string" ? item : item?.role;
    const workspace = typeof item === "object" && item !== null && item.workspace != null ? item.workspace : null;
    if (typeof role !== "string" || !ASSIGNABLE_ROLES.includes(role)) throw new AdminUserInputError("roles", "unknown_role");
    if (workspace !== null && !isWorkspaceValue(workspace)) throw new AdminUserInputError("roles", "workspace_format");
    if (role === "owner" && workspace !== null) throw new AdminUserInputError("roles", "owner_must_be_global");
    const key = `${role}\u0000${workspace ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ role, workspace });
  }
  return out;
}

/**
 * 바인딩이 TOTP를 요구하는지 본다.
 *
 * @param {Array<{ role: string }>} bindings
 * @returns {boolean}
 */
export function requiresTotp(bindings) {
  return bindings.some((b) => TOTP_REQUIRED_ROLES.includes(b.role));
}

/**
 * TOTP 봉인의 AAD. 계정 id에 묶는다.
 *
 * @param {string} userId
 * @returns {string}
 */
export function totpSealAad(userId) {
  return `anchormind.admin_user.totp:${userId}`;
}

/**
 * 복구 코드 목록을 만든다.
 *
 * @param {number} [count]
 * @returns {string[]}
 */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT) {
  const codes = new Set();
  while (codes.size < count) {
    const bytes = crypto.randomBytes(10);
    const text  = [...bytes].map((b) => RECOVERY_ALPHABET[b & 31]).join("");
    codes.add(`${text.slice(0, 5)}-${text.slice(5)}`);
  }
  return [...codes];
}

/**
 * 입력 복구 코드를 비교 형식으로 바꾼다. 형식이 틀리면 null이다.
 *
 * @param {unknown} code
 * @returns {string|null}
 */
export function normalizeRecoveryCode(code) {
  if (typeof code !== "string") return null;
  const clean = code.toLowerCase().replace(/[\s-]/g, "");
  return RECOVERY_PATTERN.test(clean) ? clean : null;
}

/**
 * 복구 코드 해시(계정 id를 섞은 sha256 hex).
 *
 * @param {string} userId
 * @param {string} normalizedCode normalizeRecoveryCode의 결과
 * @returns {string}
 */
export function recoveryCodeHash(userId, normalizedCode) {
  return crypto.createHash("sha256").update(`anchormind.recovery:${userId}:${normalizedCode}`).digest("hex");
}

/**
 * 로그인 실패 계수의 계정 키. 계정 이름을 그대로 메모리에 두지 않는다.
 *
 * @param {string} norm
 * @returns {string}
 */
export function accountGuardKey(norm) {
  return crypto.createHash("sha256").update(`anchormind.login:${norm}`).digest("hex");
}
