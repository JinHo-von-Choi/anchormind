/**
 * 로그 표기용 세션 ID
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 세션 ID는 수명 동안 인증 수단으로 쓰이므로 로그와 외부 프롬프트에는 앞 8자만 남긴다.
 */

/**
 * @param {string|null|undefined} sessionId
 * @returns {string}
 */
export function sessionRef(sessionId) {
  return sessionId ? `${String(sessionId).slice(0, 8)}...` : "none";
}
