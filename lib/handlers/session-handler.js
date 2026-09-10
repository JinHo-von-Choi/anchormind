/**
 * 세션 관리 HTTP 핸들러
 * - POST /session/rotate
 *
 * 작성자: 최진호
 * 작성일: 2026-04-20
 */

import { sendJSON }                        from "../compression.js";
import { validateAuthentication }          from "../auth.js";
import { rotateSession }                   from "../sessions.js";
import { readJsonBody }                    from "../utils.js";
import { logInfo, logError }               from "../logger.js";
import { ALLOWED_ORIGINS, ADMIN_ALLOWED_ORIGINS } from "../config.js";
import { checkRotateRateLimit }            from "./_rotate-ratelimit.js";

/**
 * POST /session/rotate
 *
 * 현재 세션을 종료하고 동일한 인증 컨텍스트를 이어받은 신규 세션을 발급한다.
 * 세션 고정 공격(Session Fixation) 방지 목적의 명시적 교체 엔드포인트.
 *
 * 요청:
 *   Authorization: Bearer <token>
 *   Mcp-Session-Id: <sessionId>
 *   Content-Type: application/json
 *   Body: { "reason"?: string }  (optional)
 *
 * 응답 200:
 *   { "oldSessionId": string, "newSessionId": string, "expiresAt": number, "reason": string }
 *
 * 오류:
 *   401 — 인증 실패 또는 세션 만료
 *   403 — Origin 차단 (MCP_STRICT_ORIGIN=true 시)
 *   404 — 세션을 찾을 수 없음
 *   500 — 서버 내부 오류
 */
/**
 * rotate 엔드포인트 전용 CSRF Origin 검증.
 *
 * 화이트리스트(ALLOWED_ORIGINS + ADMIN_ALLOWED_ORIGINS)에 없는 Origin을 403으로 거부한다.
 * - Origin 헤더 없음(CLI/curl): 거부한다 — rotate는 명시적 Origin 전송을 요구.
 *   단, localhost/127.0.0.1 출처 요청은 허용 (개발/테스트 편의).
 * - localhost/127.0.0.1 Origin: 항상 허용.
 * - 화이트리스트 완전 비어 있는 경우: 모든 Origin 허용 (기존 동작 유지).
 *
 * @param {import("node:http").IncomingMessage} req
 * @returns {boolean}
 */
function isRotateOriginAllowed(req) {
  const origin = req.headers.origin;

  /** Origin 없음 — localhost 소켓이면 허용, 그 외 거부 */
  if (!origin) {
    const ip = req.socket?.remoteAddress ?? "";
    return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
  }

  /** localhost / 127.0.0.1 Origin 항상 허용 */
  if (
    origin === "http://localhost" ||
    origin === "https://localhost" ||
    /^https?:\/\/localhost(:\d+)?$/.test(origin) ||
    /^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)
  ) {
    return true;
  }

  /** 화이트리스트가 모두 비어 있으면 모든 Origin 허용 (하위 호환) */
  if (ALLOWED_ORIGINS.size === 0 && ADMIN_ALLOWED_ORIGINS.size === 0) {
    return true;
  }

  const combined = new Set([...ALLOWED_ORIGINS, ...ADMIN_ALLOWED_ORIGINS]);
  return combined.has(origin);
}

export async function handleSessionRotate(req, res) {
  /** CSRF Origin 검증 */
  if (!isRotateOriginAllowed(req)) {
    const originVal = req.headers.origin || "(none)";
    logInfo(`[Session/Rotate] CSRF: Origin rejected: ${originVal}`);
    await sendJSON(res, 403, { error: "forbidden", error_description: "Origin not allowed" }, req);
    return;
  }

  /** Rate-limit 검증 (IP당 분당 MEMENTO_ROTATE_RATE_LIMIT_PER_MIN회) */
  const rl = checkRotateRateLimit(req);
  if (!rl.allowed) {
    logInfo(`[Session/Rotate] Rate-limit exceeded — retryAfter=${rl.retryAfter}s`);
    res.setHeader("Retry-After", String(rl.retryAfter));
    await sendJSON(res, 429, { error: "too_many_requests", error_description: "Rate limit exceeded", retryAfter: rl.retryAfter }, req);
    return;
  }

  /** 인증 검증 */
  const auth = await validateAuthentication(req, null);
  if (!auth.valid) {
    await sendJSON(res, 401, { error: "unauthorized", error_description: "Valid Bearer token required" }, req);
    return;
  }

  /** 세션 ID 추출 */
  const sessionId = req.headers["mcp-session-id"];
  if (!sessionId) {
    await sendJSON(res, 400, { error: "bad_request", error_description: "Mcp-Session-Id header is required" }, req);
    return;
  }

  /** 요청 본문 파싱 (reason 옵션) */
  let reason = "explicit_rotate";
  try {
    const body = await readJsonBody(req);
    if (body && typeof body.reason === "string" && body.reason.trim()) {
      reason = body.reason.trim().slice(0, 128);
    }
  } catch {
    /** 본문 없거나 파싱 실패 시 기본값 유지 */
  }

  logInfo(`[Session/Rotate] sessionId=${sessionId.slice(0, 8)}... request accepted`);

  try {
    const result = await rotateSession(sessionId, {
      reason,
      requesterIdentity: {
        keyId: auth.keyId ?? null,
        isMaster: auth.isMaster === true,
        groupKeyIds: auth.groupKeyIds ?? null,
        permissions: auth.permissions ?? null
      }
    });
    await sendJSON(res, 200, {
      oldSessionId: result.oldSessionId,
      newSessionId: result.newSessionId,
      expiresAt:    result.expiresAt,
      reason
    }, req);
  } catch (err) {
    const statusCode = err.statusCode ?? 500;

    if (statusCode === 404) {
      await sendJSON(res, 404, { error: "not_found", error_description: "Session not found" }, req);
      return;
    }

    if (statusCode === 401) {
      await sendJSON(res, 401, { error: "session_expired", error_description: "Session has expired" }, req);
      return;
    }

    if (statusCode === 403) {
      await sendJSON(res, 403, { error: "forbidden", error_description: "Session identity mismatch" }, req);
      return;
    }

    if (statusCode === 503) {
      await sendJSON(res, 503, { error: "temporarily_unavailable", error_description: "Session persistence unavailable" }, req);
      return;
    }

    logError("[Session/Rotate] Unexpected error:", err);
    await sendJSON(res, 500, { error: "server_error", error_description: "Failed to rotate session" }, req);
  }
}
