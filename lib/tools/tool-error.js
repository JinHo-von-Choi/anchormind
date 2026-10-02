/**
 * 도구 응답에 싣는 오류 문구
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 도구 처리기가 잡은 예외를 클라이언트 응답의 error 필드로 바꾼다. 처리기가
 * 의도해 던진 업무 오류(입력 검증, 권한, 한도)는 문구를 그대로 쓰고, DB 드라이버
 * 오류, 운영체제 호출 오류, 자바스크립트 실행 오류는 고정 문구로 바꾼다. 원문은
 * 호출자가 감사 기록과 서버 로그에 남긴다. 저장소 CHECK 제약 위반은 인자 값 오류이므로
 * 파라미터 이름과 허용 값 목록을 담은 안내 문구로 바꾼다.
 */

import pg from "pg";
import {
  rememberDefinition, amendDefinition, linkDefinition, toolFeedbackDefinition
} from "./memory-schemas.js";

export const INTERNAL_TOOL_ERROR = "Internal error";

const RUNTIME_ERROR_TYPES = [TypeError, ReferenceError, RangeError, SyntaxError, EvalError, URIError];
const SQLSTATE            = /^[0-9A-Z]{5}$/;
const CHECK_VIOLATION     = "23514";

/** 저장소 CHECK 제약 이름과 도구 파라미터 이름의 대응 */
const CHECK_CONSTRAINT_PARAMS = Object.freeze({
  fragments_type_check                  : "type",
  fragments_resolution_status_check     : "resolutionStatus",
  fragments_assertion_status_check      : "assertionStatus",
  fragments_affect_check                : "affect",
  fragment_links_relation_type_check    : "relationType",
  tool_feedback_trigger_type_check      : "trigger_type",
  tool_feedback_irrelevance_reason_check: "irrelevance_reason"
});

/** 허용 값 목록을 가져올 도구 정의 */
const TOOL_DEFINITIONS = Object.freeze({
  remember     : rememberDefinition,
  amend        : amendDefinition,
  link         : linkDefinition,
  tool_feedback: toolFeedbackDefinition
});

/**
 * @param {unknown} err
 * @returns {string|null} 인자 오류 파라미터 이름, 해당하지 않으면 null
 */
function violatedParam(err) {
  if (!(err instanceof pg.DatabaseError) || err.code !== CHECK_VIOLATION) return null;
  return CHECK_CONSTRAINT_PARAMS[err.constraint] ?? null;
}

/**
 * @param {unknown} err
 * @param {string}  [toolName] 인자 오류 안내에 허용 값을 싣을 도구 이름
 * @returns {string}
 */
export function toolErrorMessage(err, toolName) {
  const param = violatedParam(err);
  if (param) {
    const allowed = TOOL_DEFINITIONS[toolName]?.inputSchema?.properties?.[param]?.enum;
    const detail  = Array.isArray(allowed)
      ? `must be one of ${allowed.join("|")}`
      : "has a value outside the accepted set";
    return `Invalid arguments${toolName ? ` for ${toolName}` : ""}: ${param}: ${detail}`;
  }
  if (!(err instanceof Error) || typeof err.message !== "string" || err.message === "") {
    return INTERNAL_TOOL_ERROR;
  }
  if (err instanceof pg.DatabaseError)                          return INTERNAL_TOOL_ERROR;
  if (RUNTIME_ERROR_TYPES.some((T) => err instanceof T))        return INTERNAL_TOOL_ERROR;
  if (typeof err.code === "string" && SQLSTATE.test(err.code))  return INTERNAL_TOOL_ERROR;
  if (err.severity !== undefined || err.routine !== undefined)  return INTERNAL_TOOL_ERROR;
  if (err.syscall !== undefined || err.errno !== undefined)     return INTERNAL_TOOL_ERROR;
  return err.message;
}

/**
 * 도구 응답 객체로 만든다. 인자 값 오류에는 code INVALID_ARGUMENT 를 싣는다.
 *
 * @param {unknown} err
 * @param {string}  [toolName]
 * @returns {{success: false, error: string, code?: string}}
 */
export function toolErrorResponse(err, toolName) {
  const response = { success: false, error: toolErrorMessage(err, toolName) };
  if (violatedParam(err)) response.code = "INVALID_ARGUMENT";
  return response;
}
