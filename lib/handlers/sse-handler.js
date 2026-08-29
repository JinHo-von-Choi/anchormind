/**
 * GET /sse + POST /message 핸들러 (Legacy SSE)
 *
 * 작성자: 최진호
 * 작성일: 2026-04-04
 */

import { ACCESS_KEY } from "../config.js";
import { readJsonBody, sseWrite } from "../utils.js";
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
import { dispatchJsonRpc } from "../jsonrpc.js";

/**
 * GET /sse (Legacy SSE)
 * Bearer 헤더 우선, 쿼리스트링 fallback (safeCompare 적용)
 */
export async function handleLegacySseGet(req, res) {
  const url = new URL(req.url || "/", "http://localhost");

  let isAuthenticated  = false;
  let keyId            = null;
  let groupKeyIds      = null;
  let permissions      = null;
  let defaultWorkspace = null;

  if (!ACCESS_KEY) {
    isAuthenticated = true;
  } else {
    /** 1. Authorization Bearer 헤더 우선 */
    const authResult = await validateAuthentication(req, null);
    if (authResult.valid) {
      isAuthenticated  = true;
      keyId            = authResult.keyId || null;
      groupKeyIds      = authResult.groupKeyIds ?? null;
      permissions      = authResult.permissions ?? null;
      defaultWorkspace = authResult.defaultWorkspace ?? null;
    } else {
      /** 2. 쿼리스트링 fallback (하위 호환) — safeCompare 적용 */
      const rawKey    = url.searchParams.get("accessKey") || "";
      let accessKey   = rawKey;
      try { accessKey = decodeURIComponent(rawKey); } catch { /* 디코딩 실패 시 원본 사용 */ }

      if (accessKey && safeCompare(accessKey, ACCESS_KEY)) {
        isAuthenticated = true;
        logWarn("[Legacy SSE] Query string authentication used. Prefer Authorization header.");
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

  logInfo(`[Legacy SSE] Session created: ${sessionId}`);

  sseWrite(res, "endpoint", `/message?sessionId=${encodeURIComponent(sessionId)}`);

  req.on("close", () => {
    logInfo(`[Legacy SSE] Session closed: ${sessionId}`);
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
      logInfo(`[Legacy SSE] Refetched groupKeyIds for stale session ${sessionId} (keyId: ${session._keyId})`);
    }
  }

  /** _keyId 주입 + 클라이언트 위조 차단 (Phase 1 Task 1.1) */
  injectSessionContext(msg, {
    sessionId,
    sessionKeyId:          session._keyId ?? null,
    sessionGroupKeyIds:    session._groupKeyIds ?? null,
    sessionPermissions:    session._permissions ?? null,
    sessionDefaultWorkspace: session._defaultWorkspace ?? null
  });

  const { kind, response } = await dispatchJsonRpc(msg, { keyId: session._keyId ?? null });

  if (kind === "ok" || kind === "error") {
    sseWrite(session.res, "message", response);
  }

  res.statusCode = 202;
  res.end();
}
