/**
 * MCP 세션 ID 수신과 표기
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 세션 ID는 수명 동안 인증 수단으로 쓰인다. 수신 경로(헤더, 쿼리)를 구분하고,
 * 서버가 발급하는 형식(UUID)인지 판정한다.
 * 처리 방식은 MEMENTO_SESSION_ID_POLICY(warn 기본 | enforce)로 정하며 lib/config.js의
 * sessionIdPolicy()가 호출 시점의 값을 돌려준다.
 */

const SERVER_ISSUED_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * 요청에서 세션 ID와 수신 경로를 읽는다. 헤더가 쿼리보다 우선한다.
 *
 * @param {import("http").IncomingMessage} req
 * @returns {{ sessionId: string|null, source: "header"|"query"|null }}
 */
export function readSessionId(req) {
  const header = req.headers["mcp-session-id"];
  if (header) return { sessionId: String(header), source: "header" };
  const url   = new URL(req.url || "/", "http://localhost");
  const query = url.searchParams.get("sessionId") || url.searchParams.get("mcp-session-id");
  return query ? { sessionId: query, source: "query" } : { sessionId: null, source: null };
}

/**
 * 서버가 발급한 형식(crypto.randomUUID)인지 판정한다.
 *
 * @param {string} sessionId
 * @returns {boolean}
 */
export function isServerIssuedSessionId(sessionId) {
  return SERVER_ISSUED_ID.test(String(sessionId || ""));
}
