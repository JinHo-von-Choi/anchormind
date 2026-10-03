/**
 * 관리 응답 마스킹(메타만 판정)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 능력 방식이 M(메타만)인 판정(auditor의 mem.read, export.data)은 응답에서 허용 목록에 있는 값만 남긴다.
 *   숫자, 참거짓, null                      그대로
 *   REDACT_ALLOWED_FIELDS의 문자열 필드      값이 그 필드의 형식(식별자, 열거 값, 시각)에 맞을 때만 그대로
 *   REDACT_NUMERIC_FIELDS 이름의 숫자 문자열  그대로(PostgreSQL 집계 값)
 *   그 밖의 문자열                          { redacted: true, sha256, length }
 *   객체 키                                 식별자 형식(영문, 숫자, 밑줄 64자 이하)이 아니면 redacted_<해시 12자>
 * 판정이 마스킹이 아니면 값과 응답 객체를 건드리지 않는다.
 */

import crypto                 from "node:crypto";
import { contentFingerprint } from "../logging/audit-event.js";
import { logWarn }            from "../logger.js";

const ID_FORMAT   = /^[A-Za-z0-9_-]{1,64}$/;
const ENUM_FORMAT = /^[a-z][a-z0-9_]{0,31}$/;
const TIME_FORMAT = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?)?$/;

/** 마스킹 판정에서 그대로 남는 문자열 필드와 값 형식 */
export const REDACT_ALLOWED_FIELDS = Object.freeze({
  id               : ID_FORMAT,
  fragment_id      : ID_FORMAT,
  from_id          : ID_FORMAT,
  to_id            : ID_FORMAT,
  key_id           : ID_FORMAT,
  type             : ENUM_FORMAT,
  kind             : ENUM_FORMAT,
  relation_type    : ENUM_FORMAT,
  direction        : ENUM_FORMAT,
  ttl_tier         : ENUM_FORMAT,
  assertion_status : ENUM_FORMAT,
  resolution_status: ENUM_FORMAT,
  query_type       : ENUM_FORMAT,
  created_at       : TIME_FORMAT,
  updated_at       : TIME_FORMAT,
  accessed_at      : TIME_FORMAT,
  verified_at      : TIME_FORMAT,
  amended_at       : TIME_FORMAT,
  valid_from       : TIME_FORMAT,
  valid_to         : TIME_FORMAT,
  last_used_at     : TIME_FORMAT
});

/** 숫자 문자열을 그대로 두는 집계 필드 이름 */
export const REDACT_NUMERIC_FIELDS = /^(total|count|cnt|total_searches|avg_result_count|zero_hit_count|avg_ms|p50|p90|p99|importance|weight|access_count|bytes|[a-z_]+_count)$/;

const NUMERIC_STRING = /^-?\d+(?:\.\d+)?$/;
const SAFE_KEY       = /^[A-Za-z0-9_]{1,64}$/;

/** 해석할 수 없는 응답 줄을 대신하는 값 */
const UNREADABLE_LINE = JSON.stringify({ redacted: true });

/**
 * 문자열 하나를 지문으로 바꾼다.
 *
 * @param {string} text
 * @returns {{ redacted: true, sha256: string, length: number }}
 */
function maskString(text) {
  return { redacted: true, ...contentFingerprint(text) };
}

/**
 * 문자열 값을 남길지 본다.
 *
 * @param {string|null} key
 * @param {string} text
 * @returns {boolean}
 */
function keepString(key, text) {
  if (key !== null && Object.hasOwn(REDACT_ALLOWED_FIELDS, key)) return REDACT_ALLOWED_FIELDS[key].test(text);
  return key !== null && REDACT_NUMERIC_FIELDS.test(key) && NUMERIC_STRING.test(text);
}

/**
 * 객체 키를 남기거나 해시 이름으로 바꾼다.
 *
 * @param {string} key
 * @returns {string}
 */
function safeKey(key) {
  return SAFE_KEY.test(key) ? key : `redacted_${crypto.createHash("sha256").update(key, "utf8").digest("hex").slice(0, 12)}`;
}

/**
 * 값을 깊이 따라가며 허용 목록 밖의 값을 가린 사본을 만든다.
 *
 * @param {unknown} value
 * @param {string|null} key 값을 담은 필드 이름(배열 원소는 배열의 필드 이름)
 * @returns {unknown}
 */
function maskValue(value, key) {
  if (value === null || value === undefined || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return keepString(key, value) ? value : maskString(value);
  if (Array.isArray(value)) return value.map((v) => maskValue(v, key));
  if (typeof value !== "object") return maskString(String(value));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[safeKey(k)] = maskValue(v, SAFE_KEY.test(k) ? k : null);
  return out;
}

/**
 * 판정이 마스킹이면 허용 목록 밖의 값을 가린 사본을, 아니면 같은 값을 돌려준다.
 *
 * @param {{ redact?: boolean }|null|undefined} decision
 * @param {unknown} value
 * @returns {unknown}
 */
export function redactForPrincipal(decision, value) {
  if (decision?.redact !== true) return value;
  return maskValue(value, null);
}

/**
 * JSON 한 줄을 가린다. JSON이 아니면 내용이 남지 않도록 대체 값으로 바꾼다.
 *
 * @param {object} decision
 * @param {string} line
 * @returns {string}
 */
function redactLine(decision, line) {
  if (line === "") return line;
  try {
    return JSON.stringify(redactForPrincipal(decision, JSON.parse(line)));
  } catch (err) {
    logWarn(`[AdminRedact] response line is not JSON and is replaced: ${err.message}`);
    return UNREADABLE_LINE;
  }
}

/**
 * 응답 조각(본문 전체 또는 JSON Lines 줄들)을 가린다.
 *
 * @param {object} decision
 * @param {unknown} chunk
 * @returns {unknown}
 */
function redactChunk(decision, chunk) {
  if (chunk === null || chunk === undefined || typeof chunk === "function") return chunk;
  const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
  return text.split("\n").map((line) => redactLine(decision, line)).join("\n");
}

/**
 * 판정이 마스킹이면 응답의 write와 end가 내보내는 JSON을 가리게 한다. 아니면 아무것도 바꾸지 않는다.
 *
 * @param {import("node:http").ServerResponse} res
 * @param {{ redact?: boolean }} decision
 */
export function applyResponseRedaction(res, decision) {
  if (decision?.redact !== true) return;
  const end   = res.end.bind(res);
  const write = res.write.bind(res);
  res.end   = (chunk, ...rest) => end(redactChunk(decision, chunk), ...rest);
  res.write = (chunk, ...rest) => write(redactChunk(decision, chunk), ...rest);
}
