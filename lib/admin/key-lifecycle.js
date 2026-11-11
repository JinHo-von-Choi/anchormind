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
 * 수명 열이 모두 비어 있고 비밀 행이 활성이며 무기한인 키는 비활성과 한도 판정만 받는다.
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
 * 키나 서버 상태 때문에 수명 변경을 할 수 없을 때의 오류. code: key_revoked(폐기한 키의 활성화, 회전),
 * already_revoked(이미 폐기한 키의 폐기), trust_proxy_hops_unset(TRUST_PROXY_HOPS 미설정 상태의 허용 대역 쓰기).
 */
export class KeyLifecycleConflictError extends Error {
  /**
   * @param {"key_revoked"|"already_revoked"|"trust_proxy_hops_unset"} code
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

const STRICT_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|([+-])(\d{2}):(\d{2}))$/;

/**
 * 해당 월의 날 수
 *
 * @param {number} year
 * @param {number} month 1~12
 * @returns {number}
 */
function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Z 또는 명시 오프셋(+hh:mm, -hh:mm)이 있는 ISO 8601 시각만 ms로 읽는다. 날짜만 있는 값, 오프셋 없는 값,
 * 없는 날짜와 범위 밖 시각, 오프셋 14시간 초과는 null이다. 서버 시간대와 무관하다.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
export function parseStrictTimestamp(value) {
  if (typeof value !== "string") return null;
  const m = STRICT_TIMESTAMP.exec(value);
  if (!m) return null;
  const [year, month, day, hour, minute] = [m[1], m[2], m[3], m[4], m[5]].map(Number);
  const second = m[6] === undefined ? 0 : Number(m[6]);
  const millis = m[7] === undefined ? 0 : Number(m[7].padEnd(3, "0").slice(0, 3));
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  let offsetMinutes = 0;
  if (m[8] !== "Z") {
    const [oh, om] = [Number(m[10]), Number(m[11])];
    if (oh > 14 || om > 59 || (oh === 14 && om > 0)) return null;
    offsetMinutes = (m[9] === "-" ? -1 : 1) * (oh * 60 + om);
  }
  return Date.UTC(year, month - 1, day, hour, minute, second, millis) - offsetMinutes * 60_000;
}

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
 * 회전 퇴역 시각 중 이미 지난 가장 늦은 시각(ms). 키의 현재가 아닌 비밀 행의 valid_until 목록에서 고른다.
 * 그 시각보다 먼저 만든 세션과 OAuth 토큰은 이전 키로 연 것일 수 있으므로 끝낸다.
 *
 * @param {Array<Date|string|number>|null|undefined} retirements
 * @param {number} now
 * @returns {number|null}
 */
export function accessCutoff(retirements, now) {
  let cutoff = null;
  for (const value of retirements ?? []) {
    const at = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(String(value));
    if (!Number.isNaN(at) && at <= now && (cutoff === null || at > cutoff)) cutoff = at;
  }
  return cutoff;
}

/**
 * 이 키의 세션이나 OAuth 토큰이 회전 퇴역으로 끝났는지. 생성 시각을 모르면 퇴역 시각이 지난 경우 끝난 것으로 본다.
 *
 * @param {number|null|undefined} createdAt 세션 createdAt 또는 토큰 created_at(ms)
 * @param {Array<Date|string|number>|null|undefined} retirements
 * @param {number} now
 * @returns {boolean}
 */
export function isAccessRetired(createdAt, retirements, now) {
  const cutoff = accessCutoff(retirements, now);
  if (cutoff === null) return false;
  return !(typeof createdAt === "number" && Number.isFinite(createdAt) && createdAt >= cutoff);
}

/**
 * 허용 대역 목록 쓰기 전제. TRUST_PROXY_HOPS가 설정되지 않으면 요청 주소가 X-Forwarded-For 첫 항목이라
 * 클라이언트가 고를 수 있으므로 목록 설정을 거부한다. 해제(null)는 허용한다.
 *
 * @param {object} patch 검증한 수명 열 값
 * @param {boolean} hopsConfigured TRUST_PROXY_HOPS 설정 여부
 * @throws {KeyLifecycleConflictError}
 */
export function assertCidrWritable(patch, hopsConfigured) {
  if (!Object.hasOwn(patch, "allowed_cidrs") || patch.allowed_cidrs === null || hopsConfigured) return;
  throw new KeyLifecycleConflictError("trust_proxy_hops_unset",
    "allowed_cidrs requires TRUST_PROXY_HOPS to be set to the number of trusted reverse proxies in front of the server (0 when reached directly)");
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
  const at = parseStrictTimestamp(value);
  if (at === null) {
    throw new KeyPolicyValidationError("expires_at", "expires_at must be an ISO 8601 timestamp with Z or an explicit offset (e.g. 2027-01-01T00:00:00Z) or null");
  }
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
