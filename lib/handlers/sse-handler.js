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
import { getCachedKeyState, isKeyStateRevoked, sessionKeyContext } from "../keys/key-state-cache.js";
import { identityFromKeyState } from "../keys/key-identity.js";
import { logInfo, logWarn } from "../logger.js";
import { recordSseRateLimited } from "../metrics.js";
import { sessionRef } from "../logging/session-ref.js";
import { refuseSessionCredential } from "../session-credential.js";
import { dispatchJsonRpc } from "../jsonrpc.js";
import { clientNameFromInitialize } from "../memory/provenance.js";

/**
 * initialize 요청이면 clientInfo.name을 세션에 남긴다. 그 밖의 요청은 기존 값을 둔다.
 *
 * @param {object} session
 * @param {object} msg
 */
function recordClientName(session, msg) {
  if (msg?.method === "initialize") session._clientName = clientNameFromInitialize(msg);
}

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
  let shareScopes      = null;

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
      shareScopes      = authResult.groupShareScopes ?? null;
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
  session._groupShareScopes = shareScopes;
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
 * Stale 세션 폴백: _groupKeyIds 없고 _keyId 있으면 DB에서 재조회한다.
 *
 * @param {object} session
 * @param {string} sessionId
 */
async function refreshLegacyGroupKeys(session, sessionId) {
  if (session._groupKeyIds?.length || !session._keyId) return;
  const refetched = await getGroupKeyIds(session._keyId);
  if (refetched) {
    session._groupKeyIds = refetched;
    logInfo(`[Legacy SSE] Refetched group membership for stale session ${sessionRef(sessionId)}`);
  }
}

/**
 * 키 세션의 키 상태 재확인. 비활성, 삭제, 폐기, 만료, 허용 대역 밖 주소, 지난 회전 퇴역 시각보다 먼저 만든 세션이면 true.
 * 재확인이 꺼졌거나 조회에 실패하면 false(판정 불가)다. 쓸 수 있는 세션이면 권한, 그룹 접근, 기본 workspace를
 * 현재 키 상태로 바꾼다. 다른 멤버 파편에 대한 쓰기 권한은 키 상태를 읽었을 때만 둔다.
 *
 * @param {object} session
 * @param {import("http").IncomingMessage} req
 * @returns {Promise<boolean>}
 */
async function legacySessionKeyRevoked(session, req) {
  session._groupGrants = null;
  if (!session._keyId) return false;
  const keyState = await getCachedKeyState(session._keyId);
  if (isKeyStateRevoked(keyState, sessionKeyContext(session, resolveClientIp(req)))) return true;
  const fresh = identityFromKeyState(keyState, {
    keyId: session._keyId, groupKeyIds: session._groupKeyIds ?? null, groupShareScopes: session._groupShareScopes ?? null
  });
  session._groupGrants      = fresh.groupGrants;
  session._groupShareScopes = fresh.groupShareScopes;
  if (fresh.permissions)       session._permissions      = fresh.permissions;
  if (fresh.groupKeyIds)       session._groupKeyIds      = fresh.groupKeyIds;
  if ("defaultWorkspace" in fresh) session._defaultWorkspace = fresh.defaultWorkspace;
  return false;
}

/**
 * POST /message (Legacy SSE)
 */
/**
 * 유효한 옛 SSE 세션의 메시지를 받지 않을 조건. 함께 온 자격 증명이 거부 대상이거나 /mcp와 같은
 * 키·주소별 요청 한도를 넘었으면 응답을 보내고 true를 돌려준다.
 *
 * @returns {Promise<boolean>}
 */
async function refuseLegacyPost(req, res, session, sessionId, rateLimiter) {
  if (await refuseSessionCredential(req, res, { sessionId, keyId: session._keyId, isMaster: session._isMaster })) return true;
  if (!rateLimiter || rateLimiter.allow(resolveClientIp(req), session._keyId ?? null)) return false;
  res.writeHead(429, { "Retry-After": String(Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)) });
  res.end("Too many requests");
  return true;
}

/**
 * 메시지 본문을 읽는다. 읽지 못하면 413 또는 400으로 응답하고 undefined를 돌려준다.
 *
 * @returns {Promise<unknown>}
 */
async function readLegacyBody(req, res) {
  try {
    return await readJsonBody(req);
  } catch (err) {
    res.statusCode = err.statusCode === 413 ? 413 : 400;
    res.end(err.statusCode === 413 ? "Payload too large" : "Invalid JSON");
    return undefined;
  }
}

export async function handleLegacySsePost(req, res, rateLimiter) {
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

  if (await legacySessionKeyRevoked(session, req)) {
    await closeLegacySseSession(sessionId);
    logInfo(`[Legacy SSE] closed for inactive key: ${sessionRef(sessionId)}`);
    res.statusCode = 404;
    res.end("Session not found");
    return;
  }

  if (await refuseLegacyPost(req, res, session, sessionId, rateLimiter)) return;

  const msg = await readLegacyBody(req, res);
  if (msg === undefined) return;

  await refreshLegacyGroupKeys(session, sessionId);

  /** _keyId 주입 + 클라이언트 위조 차단 */
  injectSessionContext(msg, {
    sessionId,
    sessionKeyId:          session._keyId ?? null,
    sessionGroupKeyIds:    session._groupKeyIds ?? null,
    sessionPermissions:    session._permissions ?? null,
    sessionDefaultWorkspace: session._defaultWorkspace ?? null,
    sessionIsMaster:       session._isMaster === true
  });

  recordClientName(session, msg);
  const { kind, response } = await dispatchJsonRpc(msg, {
    authenticated   : true,
    clientName      : session._clientName,
    keyId           : session._keyId ?? null,
    groupKeyIds     : session._groupKeyIds ?? null,
    groupGrants     : session._groupGrants,
    groupShareScopes: session._groupShareScopes,
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
