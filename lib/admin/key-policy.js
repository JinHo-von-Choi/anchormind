/**
 * API 키 정책 값 검증과 변경 기록 형식
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * default_mode, allowed_workspaces, symbolic_hard_gate 세 열의 편집 값을 검증하고,
 * 변경 전후를 비교해 감사 기록 한 줄로 만든다. 저장소와 HTTP에 의존하지 않는다.
 */

import { getPreset, listPresets } from "../memory/ModeRegistry.js";
import { TRUSTED_ORIGIN_PERMISSION } from "../rbac.js";

/** 편집 가능한 정책 열. 검증기, 저장소 갱신문, 감사 기록이 같은 목록을 쓴다. */
export const KEY_POLICY_FIELDS = Object.freeze(["default_mode", "allowed_workspaces", "symbolic_hard_gate"]);

/** allowed_workspaces 항목 수 상한 */
export const MAX_ALLOWED_WORKSPACES = 64;

/** workspace 문자열 길이 상한 */
export const MAX_WORKSPACE_LENGTH = 128;

/** 키에 부여할 수 있는 권한 값. trusted_origin은 read 또는 write와 함께만 둔다. */
export const KEY_PERMISSION_VALUES = Object.freeze(["read", "write", TRUSTED_ORIGIN_PERMISSION]);

/** 권한 목록에 하나는 있어야 하는 도구 권한 */
const TOOL_PERMISSION_VALUES = Object.freeze(["read", "write"]);

/**
 * 권한 목록이 받을 수 있는 값으로만 이루어지고 도구 권한을 하나 이상 가졌는지 본다.
 *
 * @param {unknown} permissions
 * @returns {boolean}
 */
export function isValidPermissionList(permissions) {
  return Array.isArray(permissions)
    && permissions.every((p) => KEY_PERMISSION_VALUES.includes(p))
    && permissions.some((p) => TOOL_PERMISSION_VALUES.includes(p));
}

/** 권한 목록 검증 실패 문구 */
export const PERMISSION_LIST_MESSAGE =
  "permissions must contain 'read' and/or 'write', optionally with 'trusted_origin'";

/** 감사 기록 한 값의 최대 길이 */
const AUDIT_VALUE_MAX_LENGTH = 300;

/** 감사 기록에 남기는 대상 키 id 길이(maskAuditPath와 같은 8자) */
const AUDIT_TARGET_LENGTH = 8;

/** 제어 문자(U+0000 부터 U+001F, U+007F) 포함 여부 */
function hasControlChar(text) {
  return Array.from(text).some((ch) => {
    const code = ch.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
}

/** 정책 값이 규칙에 맞지 않을 때의 오류. field는 문제가 된 필드 이름이다. */
export class KeyPolicyValidationError extends Error {
  /**
   * @param {string} field
   * @param {string} message
   */
  constructor(field, message) {
    super(message);
    this.name  = "KeyPolicyValidationError";
    this.code  = "invalid_key_policy";
    this.field = field;
  }
}

const defaultRegistry = { getPreset, listPresets };

/**
 * 설정할 수 있는 mode 이름. requiresMaster preset은 API 키에 부여할 수 없다.
 *
 * @param {{ getPreset: Function, listPresets: Function }} registry
 * @returns {string[]}
 */
function assignableModes(registry) {
  return registry.listPresets().filter((name) => registry.getPreset(name)?.requiresMaster !== true);
}

/**
 * @param {unknown} value
 * @param {{ getPreset: Function, listPresets: Function }} registry
 * @returns {string|null}
 */
function validateDefaultMode(value, registry) {
  if (value === null) return null;
  const options = () => assignableModes(registry).join(", ");
  if (typeof value !== "string" || value === "") {
    throw new KeyPolicyValidationError("default_mode", `default_mode must be null or one of: ${options()}`);
  }
  const preset = registry.getPreset(value);
  if (!preset || preset.requiresMaster === true) {
    throw new KeyPolicyValidationError("default_mode", `default_mode must be null or one of: ${options()}`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @returns {string[]|null}
 */
function validateAllowedWorkspaces(value) {
  if (value === null) return null;
  if (!Array.isArray(value)) {
    throw new KeyPolicyValidationError("allowed_workspaces", "allowed_workspaces must be null or an array of strings");
  }
  for (const item of value) {
    if (typeof item !== "string" || item === "" || item !== item.trim()) {
      throw new KeyPolicyValidationError("allowed_workspaces", "allowed_workspaces entries must be non-empty strings without surrounding whitespace");
    }
    if (item.length > MAX_WORKSPACE_LENGTH) {
      throw new KeyPolicyValidationError("allowed_workspaces", `allowed_workspaces entries must be at most ${MAX_WORKSPACE_LENGTH} characters`);
    }
    if (hasControlChar(item)) {
      throw new KeyPolicyValidationError("allowed_workspaces", "allowed_workspaces entries must not contain control characters");
    }
  }
  const unique = [...new Set(value)];
  if (unique.length > MAX_ALLOWED_WORKSPACES) {
    throw new KeyPolicyValidationError("allowed_workspaces", `allowed_workspaces must have at most ${MAX_ALLOWED_WORKSPACES} entries`);
  }
  return unique;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function validateHardGate(value) {
  if (typeof value !== "boolean") {
    throw new KeyPolicyValidationError("symbolic_hard_gate", "symbolic_hard_gate must be a boolean");
  }
  return value;
}

/**
 * 정책 편집 본문을 검증하고 정규화한다. 전달된 필드만 결과에 담는다.
 *
 * @param {unknown} body
 * @param {{ registry?: { getPreset: Function, listPresets: Function } }} [options]
 * @returns {{ default_mode?: string|null, allowed_workspaces?: string[]|null, symbolic_hard_gate?: boolean }}
 * @throws {KeyPolicyValidationError}
 */
export function validateKeyPolicyPatch(body, { registry = defaultRegistry } = {}) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new KeyPolicyValidationError("body", "body must be a JSON object");
  }
  for (const field of Object.keys(body)) {
    if (!KEY_POLICY_FIELDS.includes(field)) {
      throw new KeyPolicyValidationError(field, `unknown policy field: ${field}`);
    }
  }
  const provided = KEY_POLICY_FIELDS.filter((field) => Object.hasOwn(body, field));
  if (provided.length === 0) {
    throw new KeyPolicyValidationError("body", `at least one of ${KEY_POLICY_FIELDS.join(", ")} is required`);
  }

  const patch = {};
  if (provided.includes("default_mode"))        patch.default_mode        = validateDefaultMode(body.default_mode, registry);
  if (provided.includes("allowed_workspaces"))  patch.allowed_workspaces  = validateAllowedWorkspaces(body.allowed_workspaces);
  if (provided.includes("symbolic_hard_gate"))  patch.symbolic_hard_gate  = validateHardGate(body.symbolic_hard_gate);
  return patch;
}

/**
 * 키 생성 시 받은 권한 배열을 검증한다.
 *
 * @param {unknown} permissions
 * @returns {string[]}
 * @throws {KeyPolicyValidationError}
 */
export function validatePermissionList(permissions) {
  if (!isValidPermissionList(permissions)) {
    throw new KeyPolicyValidationError("permissions", PERMISSION_LIST_MESSAGE);
  }
  return [...new Set(permissions)];
}

/** @param {unknown} a @param {unknown} b */
function sameValue(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => item === b[i]);
  }
  return a === b;
}

/**
 * 변경 전후 정책에서 값이 달라진 필드를 모은다.
 *
 * @param {object} before
 * @param {object} after
 * @returns {{ field: string, before: unknown, after: unknown }[]}
 */
export function diffKeyPolicy(before, after) {
  return KEY_POLICY_FIELDS
    .filter((field) => !sameValue(before[field] ?? null, after[field] ?? null))
    .map((field) => ({ field, before: before[field] ?? null, after: after[field] ?? null }));
}

/** @param {unknown} value */
function auditValue(value) {
  const text = JSON.stringify(value);
  return text.length > AUDIT_VALUE_MAX_LENGTH ? `${text.slice(0, AUDIT_VALUE_MAX_LENGTH)}...` : text;
}

/**
 * 감사 기록의 details 문자열을 만든다. 정책 열은 비밀 값이 아니므로 이전과 이후 값을 싣는다.
 * 대상 키는 일반 관리 요청 기록과 같이 앞 8자만 `target=`으로 남긴다. 행위자의 `key=`와 겹치지 않는다.
 *
 * @param {string} keyId
 * @param {{ field: string, before: unknown, after: unknown }[]} changes
 * @returns {string}
 */
export function formatKeyPolicyAuditDetails(keyId, changes) {
  const target = `target=${String(keyId).slice(0, AUDIT_TARGET_LENGTH)}`;
  if (changes.length === 0) return `${target} policy unchanged`;
  const parts = changes.map((c) => `${c.field} ${auditValue(c.before)} -> ${auditValue(c.after)}`);
  return `${target} policy ${parts.join(", ")}`;
}
