/**
 * 경고 로그용 호출자 표기
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 서버가 주입한 호출 문맥(_auditActor, _keyId, _sessionId, _userAgent)에서
 * 키 참조, 세션 앞 8자, 길이를 줄인 User-Agent만 꺼낸다. 키 원문은 다루지 않는다.
 */

import { redactString } from "../logger.js";
import { sessionRef }   from "./session-ref.js";

const USER_AGENT_MAX_LENGTH = 64;

/**
 * 키 패턴을 가리고 제어 문자를 제거한 뒤 최대 길이로 자른 User-Agent.
 *
 * @param {unknown} userAgent
 * @returns {string}
 */
export function sanitizeUserAgent(userAgent) {
  if (typeof userAgent !== "string") return "unknown";
  const cleaned = redactString(userAgent).replace(/[\p{Cc}\u2028\u2029]/gu, "").slice(0, USER_AGENT_MAX_LENGTH);
  return cleaned || "unknown";
}

/**
 * 도구 호출 인자에 주입된 서버 문맥에서 호출자 표기 문자열을 만든다.
 *
 * @param {object} args - 서버가 문맥을 주입한 도구 인자
 * @returns {string} 예: "key=<keyId> sid=<앞 8자>... ua=<User-Agent>"
 */
export function formatCallerRef(args) {
  const actor = args?._auditActor;
  const keyId = actor?.keyId ?? (args?._isMaster === true ? "master" : (args?._keyId ?? "none"));
  const sid   = actor?.sessionId ?? args?._sessionId;
  return `key=${keyId} sid=${sessionRef(sid)} ua=${sanitizeUserAgent(args?._userAgent)}`;
}
