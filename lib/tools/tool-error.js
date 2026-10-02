/**
 * 도구 응답에 싣는 오류 문구
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 도구 처리기가 잡은 예외를 클라이언트 응답의 error 필드로 바꾼다. 처리기가
 * 의도해 던진 업무 오류(입력 검증, 권한, 한도)는 문구를 그대로 쓰고, DB 드라이버
 * 오류, 운영체제 호출 오류, 자바스크립트 실행 오류는 고정 문구로 바꾼다. 원문은
 * 호출자가 감사 기록과 서버 로그에 남긴다.
 */

import pg from "pg";

export const INTERNAL_TOOL_ERROR = "Internal error";

const RUNTIME_ERROR_TYPES = [TypeError, ReferenceError, RangeError, SyntaxError, EvalError, URIError];
const SQLSTATE            = /^[0-9A-Z]{5}$/;

/**
 * @param {unknown} err
 * @returns {string}
 */
export function toolErrorMessage(err) {
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
