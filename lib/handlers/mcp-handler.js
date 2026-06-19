/**
 * POST /mcp + GET /mcp + DELETE /mcp 핸들러 (Streamable HTTP)
 *
 * 작성자: 최진호
 * 작성일: 2026-04-04
 * 수정일: 2026-06-15
 */

import { ACCESS_KEY, PORT, RATE_LIMIT_WINDOW_MS, REDIS_ENABLED, SESSION_TTL_MS, SUPPORTED_PROTOCOL_VERSIONS } from "../config.js";
import { getRateLimitUsageCached } from "./_ratelimit-cache.js";
import { recordHttpRequest, recordTenantIsolationBlocked, recordSessionRecovery, recordSession404, recordOriginRejected, recordProtocolVersionRejected } from "../metrics.js";
import { readJsonBody } from "../utils.js";
import { sendJSON } from "../compression.js";
import {
  createStreamableSession,
  createStreamableSessionWithId,
  validateStreamableSession,
  closeStreamableSession,
  streamableSessions
} from "../sessions.js";
import { getSession as getSessionFromRedis } from "../redis.js";
import { saveSession as saveSessionToRedis } from "../redis.js";
import { bindTokenToSession, getSessionIdByToken } from "../redis.js";
import crypto from "crypto";
import { isInitializeRequest, requireAuthentication, validateAuthentication, extractBearerToken } from "../auth.js";
import { getGroupKeyIds } from "../admin/ApiKeyStore.js";
import { logInfo } from "../logger.js";
import { jsonRpcError, dispatchJsonRpc } from "../jsonrpc.js";
import { getAllowedOrigin, isOriginAllowed } from "./_common.js";
import { getPreset } from "../memory/ModeRegistry.js";
import { tool_batchRemember, tool_memoryConsolidate } from "../tools/memory.js";

/**
 * 인증된 요청에서 토큰-세션 재사용용 캐시 키를 파생한다.
 * 우선순위: Authorization Bearer → memento-access-key → initialize.params.accessKey.
 * 토큰 원문은 저장하지 않고 sha256 단축 해시만 키로 사용한다. master 세션은 keyId가 null이므로
 * 같은 마스터 키라도 정상적으로 하나의 세션을 공유한다.
 *
 * @returns {string|null} `token:<hash16>` 또는 null (토큰을 식별할 수 없는 경우)
 */
export function deriveTokenKey(req, msg, authCheck) {
  const raw = (() => {
    const authHeader = req.headers.authorization;
    if (authHeader) {
      const m = extractBearerToken(authHeader);
      if (m) return m;
    }
    if (req.headers["memento-access-key"]) return req.headers["memento-access-key"];
    if (msg?.method === "initialize" && msg.params?.accessKey) return msg.params.accessKey;
    return null;
  })();

  if (!raw) return null;

  const hash = crypto.createHash("sha256").update(String(raw)).digest("hex").slice(0, 16);
  /** keyId 네임스페이스까지 포함해 cross-tenant 오인식을 차단 */
  const ns = authCheck?.keyId || "master";
  return `${ns}:${hash}`;
}

/**
 * tools/call arguments에 서버 인증 컨텍스트를 주입한다 — 순수 함수 (테스트 가능)
 *
 * (1) arguments가 falsy해도 빈 객체를 생성하여 _keyId 주입을 보장한다.
 * (2) 클라이언트가 직접 전송한 _keyId/_groupKeyIds/_sessionId/_permissions/_defaultWorkspace를
 *     무조건 delete 후 서버 인증 결과로 재주입하여 cross-tenant 위조를 차단한다.
 * (3) 감사 로그 목적의 _clientIp/_userAgent도 서버에서만 주입한다 (클라이언트 위조 차단).
 *
 * @param {object} msg - JSON-RPC 메시지 (변형하여 반환)
 * @param {{ sessionId, sessionKeyId, sessionGroupKeyIds, sessionPermissions, sessionDefaultWorkspace, clientIp?, userAgent? }} ctx
 * @returns {object} 동일 msg 참조 (arguments 필드 갱신됨)
 */
export function injectSessionContext(msg, ctx) {
  if (!msg || msg.method !== "tools/call") return msg;

  if (!msg.params) msg.params = {};

  /** arguments가 falsy한 경우 빈 객체 생성 */
  if (!msg.params.arguments) {
    msg.params.arguments = {};
  }

  /** 클라이언트 위조 차단: 클라이언트가 직접 전송한 내부 필드 제거 */
  delete msg.params.arguments._keyId;
  delete msg.params.arguments._groupKeyIds;
  delete msg.params.arguments._sessionId;
  delete msg.params.arguments._permissions;
  delete msg.params.arguments._defaultWorkspace;
  delete msg.params.arguments._mode;
  delete msg.params.arguments._clientIp;
  delete msg.params.arguments._userAgent;

  /** 서버 인증 결과로 재주입 */
  msg.params.arguments._sessionId         = ctx.sessionId;
  msg.params.arguments._keyId             = ctx.sessionKeyId;
  msg.params.arguments._groupKeyIds       = ctx.sessionGroupKeyIds;
  msg.params.arguments._permissions       = ctx.sessionPermissions;
  msg.params.arguments._defaultWorkspace  = ctx.sessionDefaultWorkspace;
  msg.params.arguments._mode              = ctx.sessionMode;
  msg.params.arguments._clientIp          = ctx.clientIp  ?? "unknown";
  msg.params.arguments._userAgent         = ctx.userAgent ?? "unknown";

  return msg;
}

/**
 * sessionId가 있는 요청의 세션 복구/검증을 처리한다.
 *
 * 반환값:
 *   { done: true }                                         — 응답 완료, 호출자는 즉시 return
 *   { done: false, sessionKeyId, sessionGroupKeyIds,
 *     sessionPermissions, sessionDefaultWorkspace,
 *     sessionMode }                                        — 세션 컨텍스트 채워짐
 *
 * @param {import('http').IncomingMessage}  req
 * @param {import('http').ServerResponse}   res
 * @param {string}  sessionId
 * @param {object}  msg
 * @returns {Promise<object>}
 */
async function _resolveExistingSession(req, res, sessionId, msg) {
  const validation = await validateStreamableSession(sessionId);

  if (!validation.valid) {
    /** Session not found / expired 시 인증 유효 여부 확인 후 자동 복구 */
    const isRecoverable = validation.reason === "Session not found"
                       || validation.reason === "Session expired";
    if (isRecoverable) {
      const authResult = await validateAuthentication(req, msg);
      if (authResult.valid) {
        const incomingKeyId = authResult.keyId ?? null;

        /** keyId 교차 검증: Redis에 기존 세션이 있으면 keyId 일치 확인 */
        if (REDIS_ENABLED) {
          const existingRedis = await getSessionFromRedis(sessionId);
          if (existingRedis && existingRedis.keyId !== incomingKeyId) {
            recordTenantIsolationBlocked("session_recover_keyid_mismatch");
            recordSessionRecovery("keyid_mismatch");
            await sendJSON(res, 403, jsonRpcError(null, -32000, "Forbidden"), req);
            return { done: true };
          }
        }

        const sessionKeyId            = incomingKeyId;
        const sessionGroupKeyIds      = authResult.groupKeyIds ?? null;
        const sessionPermissions      = authResult.permissions ?? null;
        const sessionDefaultWorkspace = authResult.defaultWorkspace ?? null;
        const sessionMode             = _resolveMode(req, msg, authResult.defaultMode ?? null, sessionKeyId);

        /** 동일 sessionId로 복구 (클라이언트 데이터 보존) */
        await createStreamableSessionWithId(
          sessionId,
          true,
          sessionKeyId,
          sessionGroupKeyIds,
          sessionPermissions,
          sessionDefaultWorkspace,
          sessionMode
        );
        recordSessionRecovery("same_id_success");
        logInfo(`[Streamable] Session recovered with same-id: ${sessionId} (keyId: ${authResult.keyId ?? "master"})`);

        return { done: false, sessionKeyId, sessionGroupKeyIds, sessionPermissions, sessionDefaultWorkspace, sessionMode };
      } else {
        /** 2c-1: sessionId 있으나 Redis에 없고 인증 실패 → 404 Not Found */
        recordSessionRecovery("not_found");
        recordSession404();
        await sendJSON(res, 404, jsonRpcError(msg?.id ?? null, -32000, "Session not found"), req);
        return { done: true };
      }
    } else {
      /** 2c-1: Session expired 상태 → 404 Not Found */
      recordSession404();
      await sendJSON(res, 404, jsonRpcError(msg?.id ?? null, -32000, "Session not found"), req);
      return { done: true };
    }
  } else {
    const session               = validation.session;
    let sessionKeyId            = session.keyId ?? null;
    let sessionGroupKeyIds      = session.groupKeyIds ?? null;
    const sessionPermissions    = session.permissions ?? null;
    const sessionDefaultWorkspace = session.defaultWorkspace ?? null;
    const sessionMode           = session.mode ?? null;

    /** Stale 세션 폴백: groupKeyIds 없고 keyId 있으면 DB에서 재조회 후 Redis 갱신 */
    if (!sessionGroupKeyIds?.length && sessionKeyId) {
      const refetched = await getGroupKeyIds(sessionKeyId);
      if (refetched) {
        sessionGroupKeyIds      = refetched;
        session.groupKeyIds     = refetched;
        if (REDIS_ENABLED) {
          const persistable = { ...session };
          delete persistable.getSseResponse;
          delete persistable.setSseResponse;
          delete persistable.close;
          delete persistable._restoredFromRedis;
          await saveSessionToRedis(sessionId, persistable, Math.ceil(SESSION_TTL_MS / 1000));
        }
        logInfo(`[Session] Refetched groupKeyIds for stale session ${sessionId} (keyId: ${sessionKeyId})`);
      }
    }

    if (!session.authenticated) {
      if (!await requireAuthentication(req, res, msg, null)) {
        return { done: true };
      }
      session.authenticated = true;
    }

    return { done: false, sessionKeyId, sessionGroupKeyIds, sessionPermissions, sessionDefaultWorkspace, sessionMode };
  }
}

/**
 * sessionId 없는 initialize 요청에서 인증 후 신규 세션을 생성(또는 토큰 기반 재사용)한다.
 *
 * 반환값:
 *   { done: true }                                         — 응답 완료, 호출자는 즉시 return
 *   { done: false, sessionId, sessionKeyId, sessionGroupKeyIds,
 *     sessionPermissions, sessionDefaultWorkspace,
 *     sessionMode }                                        — 세션 ID 및 컨텍스트 채워짐
 *
 * @param {import('http').IncomingMessage}  req
 * @param {import('http').ServerResponse}   res
 * @param {object}  msg
 * @returns {Promise<object>}
 */
async function _createInitializeSession(req, res, msg) {
  const authCheck = await validateAuthentication(req, msg);

  if (!authCheck.valid) {
    const proto   = req.headers["x-forwarded-proto"] || (req.socket.encrypted ? "https" : "http");
    const baseUrl = `${proto}://${req.headers.host || `localhost:${PORT}`}`;
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("WWW-Authenticate",
      `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`);
    res.end(JSON.stringify(jsonRpcError(msg.id ?? null, -32000, authCheck.error)));
    return { done: true };
  }

  const sessionKeyId            = authCheck.keyId ?? null;
  const sessionGroupKeyIds      = authCheck.groupKeyIds ?? null;
  const sessionPermissions      = authCheck.permissions ?? null;
  const sessionDefaultWorkspace = authCheck.defaultWorkspace ?? null;
  const sessionMode             = _resolveMode(req, msg, authCheck.defaultMode ?? null, sessionKeyId);

  /**
   * 토큰-세션 재사용 (claude.ai 커넥터가 Mcp-Session-Id 헤더를 버리는 문제 대응).
   * 동일 Bearer/MEMENTO_ACCESS_KEY/initialize.accessKey 토큰으로 들어오면
   * 기존 활성 세션을 재사용하여 매 initialize마다 새 세션이 생성되는 것을 차단한다.
   */
  const tokenKey = deriveTokenKey(req, msg, authCheck);
  let sessionId      = null;
  let reusedExisting = false;

  if (tokenKey) {
    const existingSid = await getSessionIdByToken(tokenKey);
    if (existingSid) {
      const validation = await validateStreamableSession(existingSid);
      if (validation.valid) {
        sessionId = existingSid;
        reusedExisting = true;
        recordSessionRecovery("token_matched");
        logInfo(`[Streamable] Session reused by token: ${sessionId}${sessionKeyId ? ` (keyId: ${sessionKeyId})` : " (master)"}`);
      }
    }
  }

  if (!reusedExisting) {
    sessionId = await createStreamableSession(true, sessionKeyId, sessionGroupKeyIds, sessionPermissions, sessionDefaultWorkspace, sessionMode);
    recordSessionRecovery("new_session");
    logInfo(`[Streamable] Authenticated session created: ${sessionId}${sessionKeyId ? ` (keyId: ${sessionKeyId})` : " (master)"}${sessionMode ? ` (mode: ${sessionMode})` : ""}`);

    if (tokenKey) {
      await bindTokenToSession(tokenKey, sessionId, Math.ceil(SESSION_TTL_MS / 1000));
    }
  }

  return { done: false, sessionId, sessionKeyId, sessionGroupKeyIds, sessionPermissions, sessionDefaultWorkspace, sessionMode };
}

/**
 * MCP-Protocol-Version 헤더를 검증한다.
 *
 * 반환값:
 *   { rejected: true }  — 검증 실패, 응답 완료, 호출자는 즉시 return
 *   { rejected: false } — 검증 통과
 *
 * @param {import('http').IncomingMessage}  req
 * @param {import('http').ServerResponse}   res
 * @param {object}  msg
 * @param {string}  sessionId
 * @returns {Promise<{ rejected: boolean }>}
 */
async function _validateProtocolVersion(req, res, msg, sessionId) {
  if (msg.method === "initialize") return { rejected: false };

  const protoHeader     = req.headers["mcp-protocol-version"];
  const effectiveVersion = protoHeader || "2025-03-26";

  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(effectiveVersion)) {
    recordProtocolVersionRejected(protoHeader || "missing");
    await sendJSON(res, 400, jsonRpcError(msg?.id ?? null, -32000, "Unsupported protocol version"), req);
    return { rejected: true };
  }

  if (!protoHeader) {
    logInfo(`[Protocol] MCP-Protocol-Version header missing, falling back to 2025-03-26 for session ${sessionId?.slice(0, 8)}...`);
  } else {
    const session = streamableSessions.get(sessionId);
    if (session?.negotiatedVersion && session.negotiatedVersion !== protoHeader) {
      recordProtocolVersionRejected(protoHeader);
      await sendJSON(res, 400, jsonRpcError(msg?.id ?? null, -32000, "Protocol version mismatch"), req);
      return { rejected: true };
    }
  }

  return { rejected: false };
}

/**
 * JSON-RPC 디스패치 후 응답을 전송하고 메트릭을 기록한다.
 *
 * @param {import('http').IncomingMessage}  req
 * @param {import('http').ServerResponse}   res
 * @param {object}      msg
 * @param {string}      sessionId
 * @param {string|null} sessionKeyId
 * @param {string|null} sessionMode
 * @param {bigint}      startTime
 */
async function _dispatchAndRespond(req, res, msg, sessionId, sessionKeyId, sessionMode, startTime) {
  const { kind, response } = await dispatchJsonRpc(msg, { keyId: sessionKeyId, mode: sessionMode });

  /** 2c-3: initialize 응답에서 negotiatedVersion을 세션에 저장 */
  if (msg.method === "initialize" && kind !== "accepted" && response?.result?.protocolVersion) {
    const session = streamableSessions.get(sessionId);
    if (session) {
      session.negotiatedVersion = response.result.protocolVersion;
    }
  }

  if (kind === "accepted") {
    res.statusCode = 202;
    res.setHeader("MCP-Session-Id", sessionId);
    res.end();
    return;
  }

  res.setHeader("MCP-Session-Id", sessionId);

  /** M3: Rate Limit 헤더 주입 (인증된 API 키 요청에만, master=null 제외) */
  if (sessionKeyId) {
    try {
      const usage = await getRateLimitUsageCached(sessionKeyId);
      if (usage && usage.limit !== null) {
        res.setHeader("X-RateLimit-Limit",     String(usage.limit));
        res.setHeader("X-RateLimit-Remaining", String(usage.remaining));
        res.setHeader("X-RateLimit-Resource",  "fragments");
      }
    } catch (_) {
      /** 헤더 주입 실패는 응답 자체를 막지 않는다 */
    }
  }

  await sendJSON(res, 200, response, req);

  const duration = Number(process.hrtime.bigint() - startTime) / 1e9;
  recordHttpRequest(req.method, "/mcp", 200, duration);
}

/**
 * POST /mcp (Streamable HTTP)
 */
export async function handleMcpPost(req, res, startTime, rateLimiter) {
  res.setHeader("Access-Control-Allow-Origin", getAllowedOrigin(req));
  res.setHeader("Access-Control-Expose-Headers", "MCP-Session-Id");

  /** 2c-2: Origin 헤더 검증 (MCP_STRICT_ORIGIN=true 시 적용) */
  if (!isOriginAllowed(req)) {
    const originVal = req.headers.origin || "unknown";
    recordOriginRejected(originVal);
    await sendJSON(res, 403, jsonRpcError(null, -32000, "Origin not allowed"), req);
    return;
  }

  const clientIp = req.headers["x-forwarded-for"]?.split(",")[0]?.trim()
                || req.socket.remoteAddress
                || "unknown";

  let sessionId             = req.headers["mcp-session-id"] || new URL(req.url || "/", "http://localhost").searchParams.get("sessionId") || new URL(req.url || "/", "http://localhost").searchParams.get("mcp-session-id");
  let sessionKeyId          = null;
  let sessionGroupKeyIds    = null;
  let sessionPermissions    = null;
  let sessionDefaultWorkspace = null;
  let sessionMode           = null;
  let msg;

  try {
    msg = await readJsonBody(req);
  } catch (err) {
    if (err.statusCode === 413) {
      await sendJSON(res, 413, jsonRpcError(null, -32000, "Payload too large"), req);
      return;
    }
    await sendJSON(res, 400, jsonRpcError(null, -32700, "Parse error"), req);
    return;
  }

  /** 빈 body → JSON.parse("null")이 null을 resolve. JSON-RPC 메시지는 객체여야 함. */
  if (!msg || typeof msg !== "object") {
    await sendJSON(res, 400, jsonRpcError(null, -32700, "Invalid Request"), req);
    return;
  }

  if (sessionId) {
    const result = await _resolveExistingSession(req, res, sessionId, msg);
    if (result.done) return;
    sessionKeyId            = result.sessionKeyId;
    sessionGroupKeyIds      = result.sessionGroupKeyIds;
    sessionPermissions      = result.sessionPermissions;
    sessionDefaultWorkspace = result.sessionDefaultWorkspace;
    sessionMode             = result.sessionMode;
  }

  if (!sessionId && isInitializeRequest(msg)) {
    const result = await _createInitializeSession(req, res, msg);
    if (result.done) return;
    sessionId               = result.sessionId;
    sessionKeyId            = result.sessionKeyId;
    sessionGroupKeyIds      = result.sessionGroupKeyIds;
    sessionPermissions      = result.sessionPermissions;
    sessionDefaultWorkspace = result.sessionDefaultWorkspace;
    sessionMode             = result.sessionMode;
  }

  if (!sessionId) {
    await sendJSON(res, 400, jsonRpcError(
      msg?.id ?? null,
      -32000,
      "Session required. Send an 'initialize' request first to create a session, " +
      "then include the returned MCP-Session-Id header in subsequent requests."
    ), req);
    return;
  }

  /** Rate Limit: keyId 있으면 키 기반, 없으면 IP 기반 */
  if (!rateLimiter.allow(clientIp, sessionKeyId)) {
    res.writeHead(429, { "Retry-After": String(Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)) });
    res.end(JSON.stringify(jsonRpcError(null, -32000, "Too many requests")));
    return;
  }

  injectSessionContext(msg, {
    sessionId,
    sessionKeyId,
    sessionGroupKeyIds,
    sessionPermissions,
    sessionDefaultWorkspace,
    sessionMode,
    clientIp,
    userAgent: req.headers["user-agent"] || "unknown"
  });

  if (msg.method === "resources/read" && msg.params) {
    msg.params._keyId       = sessionKeyId;
    msg.params._groupKeyIds = sessionGroupKeyIds;
  }

  /** 2c-3: MCP-Protocol-Version 헤더 검증
   *
   *  - initialize 요청: 헤더 검증 생략 (협상 이전 단계)
   *  - 그 외: 헤더 없으면 2025-03-26 fallback (스펙 요구사항)
   *           헤더 있으면 지원 목록 확인 + 세션의 negotiatedVersion과 대조
   */
  const protoCheck = await _validateProtocolVersion(req, res, msg, sessionId);
  if (protoCheck.rejected) return;

  /** M4: batch_remember / memory_consolidate SSE 스트림 분기
   *
   * 트리거 조건:
   *   - msg.method === "tools/call"
   *   - msg.params.name 이 "batch_remember" 또는 "memory_consolidate"
   *   - Accept 헤더에 "text/event-stream" 포함  OR  params.arguments.stream === true
   *
   * 비-스트림 경로는 기존 dispatchJsonRpc 흐름과 동일하게 유지된다 (하위 호환).
   */
  await _dispatchAndRespond(req, res, msg, sessionId, sessionKeyId, sessionMode, startTime);
}

/**
 * GET /mcp (Streamable HTTP SSE)
 */
export async function handleMcpGet(req, res) {
  res.setHeader("Access-Control-Allow-Origin", getAllowedOrigin(req));
  res.setHeader("Access-Control-Expose-Headers", "MCP-Session-Id");

  /** 2c-2: Origin 헤더 검증 */
  if (!isOriginAllowed(req)) {
    const originVal = req.headers.origin || "unknown";
    recordOriginRejected(originVal);
    res.statusCode = 403;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "Origin not allowed" }));
    return;
  }

  const url       = new URL(req.url || "/", "http://localhost");
  const sessionId = req.headers["mcp-session-id"] || url.searchParams.get("sessionId") || url.searchParams.get("mcp-session-id");

  if (!sessionId) {
    res.statusCode = 400;
    res.end("Missing session ID");
    return;
  }

  const validation = await validateStreamableSession(sessionId);

  if (!validation.valid) {
    res.statusCode = 400;
    res.end(validation.reason);
    return;
  }

  const session = validation.session;

  if (!session.authenticated) {
    res.statusCode = 401;
    res.end("Unauthorized");
    return;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("MCP-Session-Id", sessionId);

  session.setSseResponse(res);

  req.on("close", () => {
    /** SSE 연결 종료 — 세션은 유지, SSE 응답 및 heartbeat만 해제 */
    session.setSseResponse(null);
    logInfo(`[Streamable] SSE closed, session preserved: ${sessionId?.slice(0, 8)}...`);
  });
}

/**
 * DELETE /mcp (Streamable HTTP)
 */
export async function handleMcpDelete(req, res) {
  res.setHeader("Access-Control-Allow-Origin", getAllowedOrigin(req));
  res.setHeader("Access-Control-Expose-Headers", "MCP-Session-Id");

  /** 2c-2: Origin 헤더 검증 */
  if (!isOriginAllowed(req)) {
    const originVal = req.headers.origin || "unknown";
    recordOriginRejected(originVal);
    res.statusCode = 403;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "Origin not allowed" }));
    return;
  }

  const url       = new URL(req.url || "/", "http://localhost");
  const sessionId = req.headers["mcp-session-id"] || url.searchParams.get("sessionId") || url.searchParams.get("mcp-session-id");

  if (!sessionId) {
    res.statusCode = 400;
    res.end("Missing session ID");
    return;
  }

  const validation = await validateStreamableSession(sessionId);

  if (!validation.valid) {
    res.statusCode = 400;
    res.end(validation.reason);
    return;
  }

  /** 인증 검사 — 미인증 요청 차단 */
  const authResult = await validateAuthentication(req, null);
  if (!authResult.valid) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  /** keyId 비교 — master key(keyId=null)는 모든 세션 종료 허용 */
  const sessionKeyId   = validation.session.keyId ?? null;
  const requesterKeyId = authResult.keyId ?? null;
  if (requesterKeyId !== null && requesterKeyId !== sessionKeyId) {
    recordTenantIsolationBlocked("session_delete");
    res.statusCode = 403;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "Forbidden" }));
    return;
  }

  await closeStreamableSession(sessionId);
  logInfo(`[Streamable] Session deleted: ${sessionId}`);

  res.statusCode = 200;
  res.end();
}

/**
 * Mode 결정 — 헤더 > initialize params.mode > DB default_mode 순서
 *
 * 알 수 없는 preset 이름이 지정되면 null로 폴백 (전체 도구 노출).
 *
 * @param {import('http').IncomingMessage} req
 * @param {object|null} msg
 * @param {string|null} dbDefaultMode
 * @param {string|null} _keyId
 * @returns {string|null}
 */
function _resolveMode(req, msg, dbDefaultMode, _keyId) {
  /** 1. X-Memento-Mode 헤더 (최우선) */
  const headerMode = req.headers["x-memento-mode"] ?? null;
  if (headerMode) {
    return getPreset(headerMode) ? headerMode : null;
  }

  /** 2. initialize params.mode */
  if (msg && msg.method === "initialize" && msg.params?.mode) {
    const paramsMode = msg.params.mode;
    return getPreset(paramsMode) ? paramsMode : null;
  }

  /** 3. DB default_mode fallback */
  if (dbDefaultMode) {
    return getPreset(dbDefaultMode) ? dbDefaultMode : null;
  }

  return null;
}


/**
 * 테스트 전용: tools/call 메시지를 표준 응답 경로로 처리한다.
 * 운영 경로(handleMcpPost)와 동일하게 _dispatchAndRespond로 위임한다.
 */
export async function handleToolCallForTest(req, res, msg, sessionId, sessionKeyId, sessionMode) {
  const startTime = process.hrtime.bigint();
  await _dispatchAndRespond(req, res, msg, sessionId, sessionKeyId, sessionMode, startTime);
}
