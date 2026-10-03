/**
 * 관리 응답 마스킹(메타만 판정)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 능력 방식이 M(메타만)인 판정(auditor의 mem.read, export.data)은 응답에서 기억 내용을 지운다. 내용 필드는
 * { redacted: true, sha256, length }로 바꾸고 나머지 필드(id, 유형, 시각, 수치)는 둔다. 판정이 마스킹이 아니면
 * 값과 응답 객체를 건드리지 않는다.
 */

import { contentFingerprint } from "../logging/audit-event.js";
import { logWarn }            from "../logger.js";

/** 기억 내용을 담는 응답 필드 이름 */
export const CONTENT_FIELDS = Object.freeze(["content", "preview", "label", "context_summary", "keywords", "summary", "text"]);

const CONTENT_FIELD_SET = new Set(CONTENT_FIELDS);

/** 해석할 수 없는 응답 줄을 대신하는 값 */
const UNREADABLE_LINE = JSON.stringify({ redacted: true });

/**
 * 내용 값 하나를 지문으로 바꾼다.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function maskContent(value) {
  if (value === null || value === undefined) return value;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return { redacted: true, ...contentFingerprint(text) };
}

/**
 * 값을 깊이 따라가며 내용 필드를 가린 사본을 만든다.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function maskValue(value) {
  if (Array.isArray(value)) return value.map(maskValue);
  if (value === null || typeof value !== "object") return value;
  const out = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = CONTENT_FIELD_SET.has(key) ? maskContent(v) : maskValue(v);
  }
  return out;
}

/**
 * 판정이 마스킹이면 내용 필드를 가린 사본을, 아니면 같은 값을 돌려준다.
 *
 * @param {{ redact?: boolean }|null|undefined} decision
 * @param {unknown} value
 * @returns {unknown}
 */
export function redactForPrincipal(decision, value) {
  if (decision?.redact !== true) return value;
  return maskValue(value);
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
