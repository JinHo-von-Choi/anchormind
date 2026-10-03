/**
 * 감사 이벤트 payload (순수 함수)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 생산자는 buildAuditPayload로 outbox payload를 만들고, 소비자는 readAuditPayload로 다시 검증해
 * admin_audit_events 행 값으로 바꾼다. 두 함수는 같은 규칙을 쓴다.
 *
 * payload(판 1)
 *   { v: 1, action, outcome, occurredAt, actor: { kind, keyId, session, ip },
 *     target: { type, id } | null, workspace, detail }
 *
 * detail 규칙: 기억 본문과 비밀은 담지 않는다.
 *   - 키 이름이 본문이나 비밀을 가리키면(DENIED_KEY) 거부한다. 단 Sha256, Length로 끝나는 키는
 *     각각 16진 64자와 0 이상의 정수일 때만 받는다(본문 지문).
 *   - 문자열 값은 비밀 형식을 표식으로 바꾸고(SensitiveScanner.maskText), 제어 문자를 공백으로 바꾸며
 *     DETAIL_STRING_MAX자로 자른다.
 *   - 값은 null, 불리언, 유한한 수, 문자열, 스칼라 배열(DETAIL_ARRAY_MAX개까지), 객체(깊이 3까지)다.
 */

import crypto       from "node:crypto";
import { maskText } from "../security/SensitiveScanner.js";

export const AUDIT_TOPIC           = "audit.record";
export const AUDIT_PAYLOAD_VERSION = 1;
export const AUDIT_OUTCOMES        = Object.freeze(["success", "failure", "denied"]);
export const AUDIT_ACTOR_KINDS     = Object.freeze(["master", "key", "anonymous", "system"]);

export const DETAIL_STRING_MAX = 200;
export const DETAIL_ARRAY_MAX  = 64;
export const DETAIL_KEYS_MAX   = 32;
export const DETAIL_DEPTH_MAX  = 3;
export const TARGET_ID_MAX     = 200;
export const WORKSPACE_MAX     = 128;
export const ACTOR_KEY_MAX     = 64;
export const ACTOR_SESSION_MAX = 8;
export const ACTOR_IP_MAX      = 64;

const ACTION_PATTERN      = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
const ACTION_MAX          = 64;
const TARGET_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
const DETAIL_KEY_PATTERN  = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const KEY_ID_PATTERN      = /^[A-Za-z0-9_-]{1,64}$/;
const DENIED_KEY          = /secret|token|passw|passphrase|authorization|cookie|credential|api_?key|content|body|text|summary|raw/i;
const FINGERPRINT_KEY     = /(Sha256|Length)$/;
const SHA256_PATTERN      = /^[0-9a-f]{64}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS       = /[\u0000-\u001f\u007f]/g;
const ANONYMOUS_KEY_IDS   = new Set(["none", "unknown"]);

/** payload 규칙 위반. field가 문제의 필드다. */
export class AuditEventError extends Error {
  /**
   * @param {string} field
   * @param {string} message
   */
  constructor(field, message) {
    super(message);
    this.name  = "AuditEventError";
    this.code  = "AUDIT_INVALID_EVENT";
    this.field = field;
  }
}

/**
 * @param {unknown} action
 * @returns {boolean}
 */
export function isValidAuditAction(action) {
  return typeof action === "string" && action.length <= ACTION_MAX && ACTION_PATTERN.test(action);
}

/**
 * 문자열을 상한까지 자른다. 문자열이 아니거나 비면 null.
 *
 * @param {unknown} value
 * @param {number} max
 * @returns {string|null}
 */
function clip(value, max) {
  if (value === undefined || value === null) return null;
  const text = String(value).replace(CONTROL_CHARS, " ");
  return text.length === 0 ? null : text.slice(0, max);
}

/**
 * 감사 행위자. 입력은 buildAuditActor, adminAuditActor의 결과({ keyId, sessionId, clientIp }) 또는 "system"이다.
 * keyId "master"는 마스터, 키 형식의 keyId는 키, 그 밖(none, unknown, 없음)은 익명이다.
 *
 * @param {{ keyId?: string|null, sessionId?: string|null, clientIp?: string|null }|"system"|null|undefined} source
 * @returns {{ kind: string, keyId: string|null, session: string|null, ip: string|null }}
 */
export function auditActor(source) {
  if (source === "system") return { kind: "system", keyId: null, session: null, ip: null };
  const keyId   = source?.keyId == null ? null : String(source.keyId);
  const session = clip(source?.sessionId, ACTOR_SESSION_MAX);
  const ip      = clip(source?.clientIp, ACTOR_IP_MAX);
  if (keyId === "master") return { kind: "master", keyId: null, session, ip };
  if (keyId !== null && !ANONYMOUS_KEY_IDS.has(keyId) && KEY_ID_PATTERN.test(keyId)) {
    return { kind: "key", keyId, session, ip };
  }
  return { kind: "anonymous", keyId: null, session, ip };
}

/**
 * 본문 지문. 본문 대신 감사에 남긴다.
 *
 * @param {unknown} text
 * @returns {{ sha256: string, length: number }|null}
 */
export function contentFingerprint(text) {
  if (typeof text !== "string") return null;
  return {
    sha256: crypto.createHash("sha256").update(text, "utf8").digest("hex"),
    length: [...text].length
  };
}

/**
 * 스칼라 값 하나를 정리한다.
 *
 * @param {string} path
 * @param {unknown} value
 * @returns {null|boolean|number|string}
 */
function sanitizeScalar(path, value) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new AuditEventError("detail", `${path}: 유한한 수만 받는다`);
    return value;
  }
  if (typeof value === "string") return maskText(value).replace(CONTROL_CHARS, " ").slice(0, DETAIL_STRING_MAX);
  throw new AuditEventError("detail", `${path}: 받을 수 없는 값의 형태(${typeof value})`);
}

/**
 * 본문 지문 키의 값을 검사한다.
 *
 * @param {string} path
 * @param {string} key
 * @param {unknown} value
 * @returns {string|number}
 */
function checkedFingerprint(path, key, value) {
  if (key.endsWith("Sha256") && typeof value === "string" && SHA256_PATTERN.test(value)) return value;
  if (key.endsWith("Length") && Number.isInteger(value) && value >= 0) return value;
  throw new AuditEventError("detail", `${path}: ${key}는 sha256 16진 문자열이나 0 이상의 정수여야 한다`);
}

/**
 * 객체 하나를 정리한다.
 *
 * @param {string} path
 * @param {object} source
 * @param {number} depth
 * @returns {object}
 */
function sanitizeObject(path, source, depth) {
  if (depth > DETAIL_DEPTH_MAX) throw new AuditEventError("detail", `${path}: 중첩은 ${DETAIL_DEPTH_MAX}단계까지다`);
  const entries = Object.entries(source).filter(([, v]) => v !== undefined);
  if (entries.length > DETAIL_KEYS_MAX) throw new AuditEventError("detail", `${path}: 키는 ${DETAIL_KEYS_MAX}개까지다`);
  const out = {};
  for (const [key, value] of entries) {
    const at = `${path}.${key}`;
    if (!DETAIL_KEY_PATTERN.test(key)) throw new AuditEventError("detail", `${at}: 키 이름 형식이 아니다`);
    if (FINGERPRINT_KEY.test(key)) {
      out[key] = checkedFingerprint(at, key, value);
      continue;
    }
    if (DENIED_KEY.test(key)) throw new AuditEventError("detail", `${at}: 본문이나 비밀을 가리키는 키는 담지 않는다`);
    out[key] = sanitizeValue(at, value, depth);
  }
  return out;
}

/**
 * 값 하나를 정리한다.
 *
 * @param {string} path
 * @param {unknown} value
 * @param {number} depth 현재 객체 깊이
 * @returns {unknown}
 */
function sanitizeValue(path, value, depth) {
  if (Array.isArray(value)) return value.slice(0, DETAIL_ARRAY_MAX).map((v, i) => sanitizeScalar(`${path}[${i}]`, v));
  if (value !== null && typeof value === "object") return sanitizeObject(path, value, depth + 1);
  return sanitizeScalar(path, value);
}

/**
 * detail을 감사 규칙에 맞게 정리한다. 생략하면 빈 객체다.
 *
 * @param {unknown} detail
 * @returns {object}
 */
export function sanitizeAuditDetail(detail) {
  if (detail === undefined || detail === null) return {};
  if (typeof detail !== "object" || Array.isArray(detail)) {
    throw new AuditEventError("detail", "detail은 일반 객체여야 한다");
  }
  return sanitizeObject("detail", detail, 1);
}

/**
 * 대상을 검사한다. 생략하면 null이다.
 *
 * @param {unknown} target
 * @returns {{ type: string, id: string|null }|null}
 */
function checkedTarget(target) {
  if (target === undefined || target === null) return null;
  if (typeof target !== "object" || !TARGET_TYPE_PATTERN.test(target.type ?? "")) {
    throw new AuditEventError("target", "target.type은 소문자로 시작하는 32자 이하의 이름이어야 한다");
  }
  return { type: target.type, id: clip(target.id, TARGET_ID_MAX) };
}

/**
 * 시각을 밀리초 ISO 문자열로 바꾼다.
 *
 * @param {unknown} value
 * @returns {string}
 */
function checkedTime(value) {
  const date = value instanceof Date ? value : new Date(typeof value === "string" ? value : Number.NaN);
  if (Number.isNaN(date.getTime())) throw new AuditEventError("occurredAt", "occurredAt은 ISO 시각이어야 한다");
  return date.toISOString();
}

/**
 * outbox payload를 만든다.
 *
 * @param {{ action: string, outcome?: string, actor?: object|string|null, target?: { type: string, id?: string|null }|null,
 *           workspace?: string|null, detail?: object, occurredAt?: Date|string }} event
 * @returns {object}
 */
export function buildAuditPayload({ action, outcome = "success", actor = null, target = null, workspace = null, detail, occurredAt = new Date() }) {
  if (!isValidAuditAction(action)) throw new AuditEventError("action", "action은 점으로 구분한 소문자 조각이고 64자 이하여야 한다");
  if (!AUDIT_OUTCOMES.includes(outcome)) throw new AuditEventError("outcome", `outcome은 ${AUDIT_OUTCOMES.join(", ")} 중 하나다`);
  return {
    v         : AUDIT_PAYLOAD_VERSION,
    action,
    outcome,
    occurredAt: checkedTime(occurredAt),
    actor     : auditActor(actor),
    target    : checkedTarget(target),
    workspace : clip(workspace, WORKSPACE_MAX),
    detail    : sanitizeAuditDetail(detail)
  };
}

/**
 * payload의 행위자 값을 검사한다.
 *
 * @param {unknown} actor
 * @returns {{ kind: string, keyId: string|null, session: string|null, ip: string|null }}
 */
function checkedActor(actor) {
  if (!actor || typeof actor !== "object" || !AUDIT_ACTOR_KINDS.includes(actor.kind)) {
    throw new AuditEventError("actor", `actor.kind는 ${AUDIT_ACTOR_KINDS.join(", ")} 중 하나다`);
  }
  const keyId = actor.kind === "key" ? clip(actor.keyId, ACTOR_KEY_MAX) : null;
  if (actor.kind === "key" && (keyId === null || !KEY_ID_PATTERN.test(keyId))) {
    throw new AuditEventError("actor", "키 행위자는 키 id를 가진다");
  }
  return { kind: actor.kind, keyId, session: clip(actor.session, ACTOR_SESSION_MAX), ip: clip(actor.ip, ACTOR_IP_MAX) };
}

/**
 * 소비자 쪽 판독. payload를 다시 검증해 admin_audit_events 행 값으로 바꾼다.
 *
 * @param {unknown} payload
 * @returns {{ occurredAt: string, action: string, outcome: string, actorKind: string, actorKeyId: string|null,
 *             actorSession: string|null, actorIp: string|null, targetType: string|null, targetId: string|null,
 *             workspace: string|null, detail: object }}
 */
export function readAuditPayload(payload) {
  if (!payload || typeof payload !== "object") throw new AuditEventError("payload", "payload는 객체여야 한다");
  if (payload.v !== AUDIT_PAYLOAD_VERSION) throw new AuditEventError("v", `payload 판 ${String(payload.v)}은 읽을 수 없다`);
  if (!isValidAuditAction(payload.action)) throw new AuditEventError("action", "action 형식이 아니다");
  if (!AUDIT_OUTCOMES.includes(payload.outcome)) throw new AuditEventError("outcome", "outcome 값이 아니다");
  const actor  = checkedActor(payload.actor);
  const target = checkedTarget(payload.target);
  return {
    occurredAt  : checkedTime(payload.occurredAt),
    action      : payload.action,
    outcome     : payload.outcome,
    actorKind   : actor.kind,
    actorKeyId  : actor.keyId,
    actorSession: actor.session,
    actorIp     : actor.ip,
    targetType  : target?.type ?? null,
    targetId    : target?.id ?? null,
    workspace   : clip(payload.workspace, WORKSPACE_MAX),
    detail      : sanitizeAuditDetail(payload.detail)
  };
}

/**
 * HTTP 응답 상태의 감사 결과 분류.
 *
 * @param {number} status
 * @returns {"success"|"failure"|"denied"}
 */
export function outcomeForStatus(status) {
  if (status === 401 || status === 403) return "denied";
  return status < 400 ? "success" : "failure";
}
