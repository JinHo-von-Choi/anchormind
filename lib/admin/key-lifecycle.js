/**
 * API 키 수명 판정과 편집 값 검증
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 원시 키 인증은 api_key_secrets 행(비밀)을 먼저 찾고, 없으면 api_keys.key_hash 행(레거시 출처)을 쓴다.
 * 찾은 행의 판정 순서는 다음과 같다.
 *   1. 키 상태: 폐기(revoked_at) → 비활성(status) → 만료(expires_at)
 *   2. 비밀 행: 폐기(status) → 회전 겹침 종료(valid_until). 레거시 출처는 이 단계가 없다
 *   3. 일일 호출 한도(limit_exceeded)
 * 수명 열이 모두 비어 있는 키(기존 키)는 비활성과 한도 판정만 남아 결과가 같다.
 * 저장소와 HTTP에 의존하지 않는다.
 */

import crypto from "node:crypto";
import { KeyPolicyValidationError } from "./key-policy.js";
import { validateCidrList, normalizeClientAddress } from "./key-cidr.js";
import { envInt } from "../config.js";
import {
  DEFAULT_KEY_ROTATION_GRACE_HOURS, MAX_KEY_ROTATION_GRACE_HOURS,
  DEFAULT_KEY_LAST_USED_INTERVAL_SEC, MAX_KEY_LAST_USED_INTERVAL_SEC
} from "./key-lifecycle-limits.js";

/** 원시 키 조회 출처 */
export const KEY_SECRET_SOURCE = Object.freeze({ SECRET: "secret", LEGACY: "legacy" });

/** api_key_secrets.status 값 */
export const KEY_SECRET_STATUS = Object.freeze({ ACTIVE: "active", REVOKED: "revoked" });

/** 회전 겹침 기본값과 상한(시간) */
export const DEFAULT_ROTATION_GRACE_HOURS = DEFAULT_KEY_ROTATION_GRACE_HOURS;
export const MAX_ROTATION_GRACE_HOURS     = MAX_KEY_ROTATION_GRACE_HOURS;

/**
 * 회전 겹침 기본값(시간). 호출 시점의 MEMENTO_KEY_ROTATION_GRACE_HOURS를 읽는다. 범위 밖은 기본값이다.
 *
 * @returns {number}
 */
export function keyRotationGraceHours() {
  return envInt("MEMENTO_KEY_ROTATION_GRACE_HOURS", DEFAULT_KEY_ROTATION_GRACE_HOURS,
    { min: 0, max: MAX_KEY_ROTATION_GRACE_HOURS, fallback: true });
}

/**
 * 키별 마지막 사용 기록 간격(ms). 호출 시점의 MEMENTO_KEY_LAST_USED_INTERVAL_SEC를 읽는다. 0이면 요청마다 기록한다.
 *
 * @returns {number}
 */
export function keyLastUsedIntervalMs() {
  return envInt("MEMENTO_KEY_LAST_USED_INTERVAL_SEC", DEFAULT_KEY_LAST_USED_INTERVAL_SEC,
    { min: 0, max: MAX_KEY_LAST_USED_INTERVAL_SEC, fallback: true }) * 1000;
}

/** PATCH /keys/:id로 바꿀 수 있는 수명 열 */
export const KEY_LIFECYCLE_FIELDS = Object.freeze(["expires_at", "description", "owner", "kind", "allowed_cidrs"]);

export const KEY_DESCRIPTION_MAX = 500;
export const KEY_OWNER_MAX       = 128;
export const KEY_REVOKE_REASON_MAX = 500;
export const KEY_KIND_PATTERN    = /^[a-z][a-z0-9_-]{0,31}$/;

const HOUR_MS        = 3_600_000;

/**
 * 키 상태 때문에 수명 변경을 할 수 없을 때의 오류. code: key_revoked(폐기한 키의 활성화, 회전),
 * already_revoked(이미 폐기한 키의 폐기).
 */
export class KeyLifecycleConflictError extends Error {
  /**
   * @param {"key_revoked"|"already_revoked"} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "KeyLifecycleConflictError";
    this.code = code;
  }
}
const IP_HASH_LENGTH = 32;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS  = /[\u0000-\u001f\u007f]/;

/**
 * 시각 값(Date, 문자열, null)을 ms로 읽는다. 읽을 수 없으면 NaN.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
function timeOf(value) {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.getTime() : Date.parse(String(value));
}

/**
 * 시각이 지났는지(같은 시각 포함). 읽을 수 없는 값은 지난 것으로 본다.
 *
 * @param {unknown} value
 * @param {number} now
 * @returns {boolean}
 */
function reached(value, now) {
  const at = timeOf(value);
  if (at === null) return false;
  return Number.isNaN(at) || at <= now;
}

/**
 * 키 상태 판정. 세션 재확인과 id 조회도 같은 함수를 쓴다.
 *
 * @param {{ status: string, revoked_at?: unknown, expires_at?: unknown }} key
 * @param {number} now
 * @returns {{ valid: true }|{ valid: false, reason: "revoked"|"inactive"|"expired" }}
 */
export function evaluateKeyState(key, now) {
  if (key.revoked_at !== null && key.revoked_at !== undefined) return { valid: false, reason: "revoked" };
  if (key.status !== "active")                                    return { valid: false, reason: "inactive" };
  if (reached(key.expires_at, now))                               return { valid: false, reason: "expired" };
  return { valid: true };
}

/**
 * 비밀 행 판정. 레거시 출처는 통과한다.
 *
 * @param {{ secret_source: string, secret_status?: string|null, secret_valid_until?: unknown }} row
 * @param {number} now
 * @returns {{ valid: true }|{ valid: false, reason: "revoked"|"rotated" }}
 */
function evaluateSecret(row, now) {
  if (row.secret_source !== KEY_SECRET_SOURCE.SECRET)     return { valid: true };
  if (row.secret_status !== KEY_SECRET_STATUS.ACTIVE)     return { valid: false, reason: "revoked" };
  if (reached(row.secret_valid_until, now))               return { valid: false, reason: "rotated" };
  return { valid: true };
}

/**
 * 원시 키 조회 결과 한 행의 판정.
 *
 * @param {object} row 키 열, secret_source, secret_status, secret_valid_until, usage_today, daily_limit
 * @param {number} now
 * @returns {{ valid: boolean, reason?: string }}
 */
export function evaluateKeyCredential(row, now) {
  const state = evaluateKeyState(row, now);
  if (!state.valid) return state;
  const secret = evaluateSecret(row, now);
  if (!secret.valid) return secret;
  if (Number(row.usage_today) >= Number(row.daily_limit)) return { valid: false, reason: "limit_exceeded" };
  return { valid: true };
}

/**
 * 회전 직전 비밀의 겹침 종료 시각.
 *
 * @param {number} now
 * @param {number} graceHours
 * @returns {Date}
 */
export function rotationValidUntil(now, graceHours) {
  return new Date(now + graceHours * HOUR_MS);
}

/**
 * 요청 본문의 회전 겹침 시간. 없으면 기본값이다.
 *
 * @param {unknown} value
 * @param {number} def
 * @returns {number}
 */
export function resolveGraceHours(value, def) {
  if (value === undefined || value === null) return def;
  if (!Number.isInteger(value) || value < 0 || value > MAX_ROTATION_GRACE_HOURS) {
    throw new KeyPolicyValidationError("graceHours", `graceHours must be an integer between 0 and ${MAX_ROTATION_GRACE_HOURS}`);
  }
  return value;
}

/**
 * 짧은 문자열 열. 빈 문자열과 null은 지운다(null).
 *
 * @param {string} field
 * @param {unknown} value
 * @param {number} max
 * @returns {string|null}
 */
function optionalText(field, value, max) {
  if (value === null) return null;
  if (typeof value !== "string") throw new KeyPolicyValidationError(field, `${field} must be a string or null`);
  const text = value.trim();
  if (text.length === 0) return null;
  if (text.length > max) throw new KeyPolicyValidationError(field, `${field} must be at most ${max} characters`);
  if (CONTROL_CHARS.test(text)) throw new KeyPolicyValidationError(field, `${field} must not contain control characters`);
  return text;
}

/**
 * 만료 시각. ISO 8601 문자열 또는 null.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
function expiryValue(value) {
  if (value === null) return null;
  const at = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(at)) throw new KeyPolicyValidationError("expires_at", "expires_at must be an ISO 8601 timestamp or null");
  return new Date(at).toISOString();
}

/**
 * 키 종류. 소문자로 시작하는 32자 이하 식별자 또는 null.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
function kindValue(value) {
  const text = optionalText("kind", value, 32);
  if (text !== null && !KEY_KIND_PATTERN.test(text)) {
    throw new KeyPolicyValidationError("kind", "kind must match ^[a-z][a-z0-9_-]{0,31}$");
  }
  return text;
}

const FIELD_VALIDATORS = Object.freeze({
  expires_at   : expiryValue,
  description  : (v) => optionalText("description", v, KEY_DESCRIPTION_MAX),
  owner        : (v) => optionalText("owner", v, KEY_OWNER_MAX),
  kind         : kindValue,
  allowed_cidrs: validateCidrList
});

/**
 * PATCH /keys/:id 본문 검증. 수명 필드 중 전달된 것만 돌려준다.
 *
 * @param {unknown} body
 * @returns {object}
 * @throws {KeyPolicyValidationError}
 */
export function validateKeyLifecyclePatch(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new KeyPolicyValidationError("body", "body must be a JSON object");
  }
  const patch = {};
  for (const field of KEY_LIFECYCLE_FIELDS) {
    if (Object.hasOwn(body, field)) patch[field] = FIELD_VALIDATORS[field](body[field]);
  }
  if (Object.keys(patch).length === 0) {
    throw new KeyPolicyValidationError("body", `body must contain at least one of ${KEY_LIFECYCLE_FIELDS.join(", ")}`);
  }
  return patch;
}

/**
 * 폐기 사유. 공백을 지운 1자 이상 문자열.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function validateRevokeReason(value) {
  const text = typeof value === "string" ? optionalText("reason", value, KEY_REVOKE_REASON_MAX) : null;
  if (text === null) throw new KeyPolicyValidationError("reason", "reason is required");
  return text;
}

/**
 * 마지막 사용 주소 지문. 비밀값(pepper)을 키로 쓴 HMAC-SHA256의 앞 32자다. 주소가 아니면 null.
 *
 * @param {unknown} ip
 * @param {string} pepper
 * @returns {string|null}
 */
export function hashClientIp(ip, pepper) {
  const client = normalizeClientAddress(ip);
  if (!client) return null;
  return crypto.createHmac("sha256", `memento-key-ip:${pepper ?? ""}`).update(client.address).digest("hex").slice(0, IP_HASH_LENGTH);
}

/**
 * 감사 detail 값. 시각은 ISO 문자열로 바꾼다.
 *
 * @param {string} field
 * @param {unknown} value
 * @returns {unknown}
 */
function auditValue(field, value) {
  if (value === null || value === undefined) return null;
  if (field === "expires_at") return new Date(timeOf(value)).toISOString();
  return value;
}

/**
 * 수명 열 변경의 감사 detail. 설명은 변경 여부만 남긴다.
 *
 * @param {object} before
 * @param {object} after
 * @returns {{ changed: string[], before: object, after: object }}
 */
export function diffKeyLifecycle(before, after) {
  const detail = { changed: [], before: {}, after: {} };
  for (const field of KEY_LIFECYCLE_FIELDS) {
    const prev = auditValue(field, before[field]);
    const next = auditValue(field, after[field]);
    if (JSON.stringify(prev) === JSON.stringify(next)) continue;
    detail.changed.push(field);
    if (field === "description") continue;
    detail.before[field] = prev;
    detail.after[field]  = next;
  }
  return detail;
}
