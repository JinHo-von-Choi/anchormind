/**
 * GET /sse + POST /message 핸들러 (Legacy SSE)
 *
 * 작성자: 최진호
 * 작성일: 2026-04-04
 */

import { ACCESS_KEY, AUTH_DISABLED, RATE_LIMIT_WINDOW_MS } from "../config.js";
import { readSseQueryKey } from "../env-parse.js";
import { readJsonBody, sseWrite } from "../utils.js";
import { resolveClientIp } from "../http/helpers.js";
import { injectSessionContext } from "./mcp-handler.js";
import {
  createLegacySseSession,
  validateLegacySseSession,
  closeLegacySseSession,
  getLegacySession
} from "../sessions.js";
import { validateAuthentication, safeCompare } from "../auth.js";
import { getGroupKeyIds } from "../admin/ApiKeyStore.js";
import { logInfo, logWarn } from "../logger.js";
import { recordSseRateLimited } from "../metrics.js";
import { sessionRef } from "../logging/session-ref.js";
import { dispatchJsonRpc } from "../jsonrpc.js";

export function isLegacySseAuthDisabledMaster(accessKey, authDisabled) {
  return !accessKey && authDisabled === true;
}

/**
 * 쿼리스트링 키 처리 방식. 호출 시점의 MEMENTO_SSE_QUERY_KEY를 읽는다.
 * deny: 쿼리 키를 받지 않는다. 그 밖의 값과 미설정: allow.
 *
 * @returns {"allow"|"deny"}
 */
export function legacySseQueryKeyMode() {
  return readSseQueryKey(process.env);
}

/**
 * GET /sse (Legacy SSE)
 * Bearer 헤더 우선, 쿼리스트링 fallback (safeCompare 적용)
 * 세션을 만드는 인증 시도이므로 rateLimiter가 주어지면 IP 기준 제한을 먼저 적용한다.
 *
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse}  res
 * @param {{ allow: (clientIp: string) => boolean }} [rateLimiter]
 */
export async function handleLegacySseGet(req, res, rateLimiter) {
  if (rateLimiter && !rateLimiter.allow(resolveClientIp(req))) {
    recordSseRateLimited();
    logWarn("[SSE] connection request rejected by IP rate limit");
    res.writeHead(429, { "Retry-After": String(Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)) });
    res.end("Too Many Requests");
    return;
  }

  const url = new URL(req.url || "/", "http://localhost");

  let isAuthenticated  = false;
  let keyId            = null;
  let groupKeyIds      = null;
  let permissions      = null;
  let defaultWorkspace = null;
  let isMaster         = false;

  if (isLegacySseAuthDisabledMaster(ACCESS_KEY, AUTH_DISABLED)) {
    isAuthenticated = true;
    isMaster        = true;
  } else {
    /** 1. Authorization Bearer 헤더 우선 */
    const authResult = await validateAuthentication(req, null);
    if (authResult.valid) {
      isAuthenticated  = true;
      keyId            = authResult.keyId || null;
      groupKeyIds      = authResult.groupKeyIds ?? null;
      permissions      = authResult.permissions ?? null;
      defaultWorkspace = authResult.defaultWorkspace ?? null;
      isMaster         = authResult.isMaster === true;
    } else {
      /** 2. 쿼리스트링 fallback (하위 호환). deny 모드에서는 받지 않는다 */
      const rawKey    = url.searchParams.get("accessKey") || "";
      const userAgent = String(req.headers["user-agent"] || "unknown").slice(0, 64);

      if (rawKey && legacySseQueryKeyMode() === "deny") {
        logWarn(`[Legacy SSE] Query string authentication refused. ua=${userAgent}`);
        res.statusCode = 401;
        res.setHeader("WWW-Authenticate", "Bearer");
        res.end("Unauthorized: send the key in the Authorization header");
        return;
      }

      let accessKey   = rawKey;
      try { accessKey = decodeURIComponent(rawKey); } catch { /* 디코딩 실패 시 원본 사용 */ }

      if (accessKey && safeCompare(accessKey, ACCESS_KEY)) {
        isAuthenticated = true;
        isMaster        = true;
        logWarn(`[Legacy SSE] Query string authentication used. Prefer Authorization header. ua=${userAgent}`);
      }
    }
  }

  if (!isAuthenticated) {
    res.statusCode = 401;
    res.end("Unauthorized");
    return;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const sessionId = createLegacySseSession(res);
  const session   = getLegacySession(sessionId);
  session.authenticated     = isAuthenticated;
  session._keyId            = keyId;
  session._groupKeyIds      = groupKeyIds;
  session._permissions      = permissions;
  session._defaultWorkspace = defaultWorkspace;
  session._isMaster         = isMaster;

  logInfo(`[Legacy SSE] Session created: ${sessionRef(sessionId)}`);

  sseWrite(res, "endpoint", `/message?sessionId=${encodeURIComponent(sessionId)}`);

  req.on("close", () => {
    logInfo(`[Legacy SSE] Session closed: ${sessionRef(sessionId)}`);
    closeLegacySseSession(sessionId);
  });
}

/**
 * POST /message (Legacy SSE)
 */
export async function handleLegacySsePost(req, res) {
  const url       = new URL(req.url || "/", "http://localhost");
  const sessionId = url.searchParams.get("sessionId");

  if (!sessionId) {
    res.statusCode = 400;
    res.end("Missing session ID");
    return;
  }

  const validation = validateLegacySseSession(sessionId);

  if (!validation.valid) {
    res.statusCode = 404;
    res.end(validation.reason);
    return;
  }

  const session = validation.session;

  if (!session.authenticated) {
    res.statusCode = 401;
    res.end("Unauthorized");
    return;
  }

  let msg;
  try {
    msg = await readJsonBody(req);
  } catch (err) {
    if (err.statusCode === 413) {
      res.statusCode = 413;
      res.end("Payload too large");
      return;
    }
    res.statusCode = 400;
    res.end("Invalid JSON");
    return;
  }

  /** Stale 세션 폴백: _groupKeyIds 없고 _keyId 있으면 DB에서 재조회 (Phase 0 Task 0.2) */
  if (!session._groupKeyIds?.length && session._keyId) {
    const refetched = await getGroupKeyIds(session._keyId);
    if (refetched) {
      session._groupKeyIds = refetched;
      logInfo(`[Legacy SSE] Refetched group membership for stale session ${sessionRef(sessionId)}`);
    }
  }

  /** _keyId 주입 + 클라이언트 위조 차단 (Phase 1 Task 1.1) */
  injectSessionContext(msg, {
    sessionId,
    sessionKeyId:          session._keyId ?? null,
    sessionGroupKeyIds:    session._groupKeyIds ?? null,
    sessionPermissions:    session._permissions ?? null,
    sessionDefaultWorkspace: session._defaultWorkspace ?? null,
    sessionIsMaster:       session._isMaster === true
  });

  const { kind, response } = await dispatchJsonRpc(msg, {
    authenticated   : true,
    keyId           : session._keyId ?? null,
    groupKeyIds     : session._groupKeyIds ?? null,
    permissions     : session._permissions ?? null,
    isMaster        : session._isMaster === true,
    defaultWorkspace: session._defaultWorkspace ?? null,
    mode            : session._mode ?? null,
    sessionId,
    clientIp        : resolveClientIp(req),
    userAgent       : req?.headers?.["user-agent"] ?? "unknown"
  });

  if (kind === "ok" || kind === "error") {
    sseWrite(session.res, "message", response);
  }

  res.statusCode = 202;
  res.end();
}
