/**
 * 하네스 훅 HTTP 처리기
 * - POST /hooks/{client}/{event}
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * client는 claude-code, codex이고 event는 SessionStart, Stop, SessionEnd다(lib/hooks/hook-contract.js).
 *
 * SessionStart: context를 하네스 형식(hookSpecificOutput.additionalContext)으로 200 응답한다.
 * Stop, SessionEnd: 요약 후보(최근 대화 발췌, 64 KB 이하)를 민감 정보 검사 뒤 outbox(topic hook.reflect)에
 * 기록하고 202로 응답한다. 회고는 outbox 소비자(lib/hooks/hook-reflect-consumer.js)가 수행하며, 이 처리기는
 * 회고를 직접 부르지 않는다.
 *
 * 검사 순서: 스위치와 경로 허용 목록(404), Content-Type(415), 헤더 크기(431), IP 요청 한도(429), 인증(401,
 * 저장소 장애는 설정에 따라 503), 권한(403, SessionStart는 read, 회고는 write), 키 요청 한도(429), 본문 크기(413),
 * JSON 문법(400), 중첩 깊이(400), 입력 계약(400, 413, 422). 인증 전에는 본문을 읽지 않는다.
 *
 * 응답 본문은 오류 코드만 담고 요청 본문을 되돌려 보내지 않는다. 로그에는 클라이언트, 이벤트, 오류 코드만
 * 남기고 발췌, 키, 세션 id를 남기지 않는다.
 */

import { sendJSON }                                  from "../compression.js";
import { validateAuthentication }                    from "../auth.js";
import { checkPermission }                           from "../rbac.js";
import { hookEndpointsEnabled, sensitiveScanMode, RATE_LIMIT_WINDOW_MS, AUTH_STORE_UNAVAILABLE_STATUS } from "../config.js";
import { readJsonBody, resolveClientIp, authStoreUnavailableStatus } from "../http/helpers.js";
import { recordHttpRequest }                         from "../metrics.js";
import { logWarn, logError }                         from "../logger.js";
import { getPrimaryPool }                            from "../tools/db.js";
import { getAllowedWorkspaces }                      from "../admin/ApiKeyStore.js";
import { scanText }                                  from "../security/SensitiveScanner.js";
import { enqueueStandalone, OutboxValidationError }  from "../outbox/Outbox.js";
import {
  HOOK_LIMITS, HOOK_REFLECT_TOPIC, HOOK_PAYLOAD_VERSION, HookInputError,
  parseHookRoute, isJsonContentType, headerBytes, withinJsonDepth, isReflectEvent,
  validateHookBody, workspaceCandidates, resolveHookWorkspace, hookIdempotencyKey,
  formatSessionStartOutput, hookTokenBudget
} from "../hooks/hook-contract.js";
import { recordHookCall }                            from "../hooks/hook-metrics.js";

/** 응답을 보낸 뒤 처리를 끝내기 위한 표지 */
class HookResponse extends Error {
  /**
   * @param {number} status
   * @param {string} outcome 지표 결과 라벨
   * @param {object} body
   * @param {Record<string, string>} [headers]
   */
  constructor(status, outcome, body, headers = {}) {
    super(body.error ?? outcome);
    this.name    = "HookResponse";
    this.status  = status;
    this.outcome = outcome;
    this.body    = body;
    this.headers = headers;
  }
}

/** 오류 응답 */
const fail = (status, outcome, error, headers) => new HookResponse(status, outcome, { error }, headers);

/**
 * SessionStart의 context 조회. tool_context를 처음 쓸 때 불러온다.
 *
 * @param {object} args
 * @returns {Promise<object>}
 */
async function defaultContext(args) {
  const { tool_context } = await import("../tools/memory.js");
  return tool_context(args);
}

/** 기본 의존성 */
const DEFAULT_DEPS = Object.freeze({
  enabled                : hookEndpointsEnabled,
  authenticate           : validateAuthentication,
  authUnavailableStatus  : () => AUTH_STORE_UNAVAILABLE_STATUS,
  allowedWorkspaces      : getAllowedWorkspaces,
  context                : defaultContext,
  enqueue                : (event) => enqueueStandalone(getPrimaryPool(), event),
  scanMode               : sensitiveScanMode,
  now                    : () => new Date()
});

/**
 * 요청 한도 응답
 *
 * @returns {HookResponse}
 */
function rateLimited() {
  return fail(429, "rate_limited", "too_many_requests", { "Retry-After": String(Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)) });
}

/**
 * 인증과 권한을 확인한다.
 *
 * @param {object} deps
 * @param {import("node:http").IncomingMessage} req
 * @param {string} event
 * @returns {Promise<object>} 인증 결과
 */
async function authorize(deps, req, event) {
  const auth = await deps.authenticate(req, null);
  if (!auth.valid) {
    if (authStoreUnavailableStatus(auth, deps.authUnavailableStatus()) === 503) {
      throw fail(503, "unavailable", "temporarily_unavailable", { "Retry-After": "10" });
    }
    throw fail(401, "unauthorized", "unauthorized", { "WWW-Authenticate": "Bearer" });
  }
  const tool = isReflectEvent(event) ? "reflect" : "context";
  if (!checkPermission(auth.permissions, tool, auth.isMaster === true).allowed) {
    throw fail(403, "forbidden", "forbidden");
  }
  return auth;
}

/**
 * 본문을 읽고 크기, 문법, 깊이를 검사한다.
 *
 * @param {import("node:http").IncomingMessage} req
 * @returns {Promise<unknown>}
 */
async function readBody(req) {
  let body;
  try {
    body = await readJsonBody(req, HOOK_LIMITS.bodyMaxBytes);
  } catch (err) {
    if (err.statusCode === 413) throw fail(413, "invalid", "payload_too_large");
    throw fail(400, "invalid", "invalid_json");
  }
  if (!withinJsonDepth(body, HOOK_LIMITS.jsonMaxDepth)) throw fail(400, "invalid", "json_too_deep");
  return body;
}

/**
 * 키의 allowed_workspaces 안에 드는 workspace 후보를 고른다. 마스터 키와 허가 집합이 없는 키는 null이다.
 *
 * @param {object} deps
 * @param {object} auth
 * @param {{ cwd: string|null, gitRemote: string|null }} input
 * @returns {Promise<string|null>}
 */
async function derivedWorkspace(deps, auth, input) {
  if (!auth.keyId) return null;
  const allowed  = await deps.allowedWorkspaces(auth.keyId);
  const resolved = resolveHookWorkspace(workspaceCandidates(input), allowed, null);
  return resolved.source === "derived" ? resolved.workspace : null;
}

/**
 * 도구 핸들러가 받는 인증 내부 필드
 *
 * @param {object} auth
 * @param {import("node:http").IncomingMessage} req
 * @returns {object}
 */
function authFields(auth, req) {
  return {
    _keyId           : auth.keyId ?? null,
    _groupKeyIds     : auth.groupKeyIds ?? null,
    _permissions     : auth.permissions ?? null,
    _defaultWorkspace: auth.defaultWorkspace ?? null,
    _isMaster        : auth.isMaster === true,
    _clientIp        : resolveClientIp(req),
    _userAgent       : req.headers["user-agent"] || "unknown"
  };
}

/**
 * SessionStart: context를 하네스 형식으로 돌려준다.
 *
 * @returns {Promise<HookResponse>}
 */
async function sessionStart(deps, req, route, auth, workspace) {
  const result = await deps.context({
    tokenBudget: hookTokenBudget(route.client),
    ...(workspace ? { workspace } : {}),
    ...authFields(auth, req)
  });
  if (!result || result.success !== true) throw fail(500, "error", "context_failed");
  return new HookResponse(200, "context", formatSessionStartOutput(route.client, result.injectionText ?? ""));
}

/**
 * Stop, SessionEnd: 민감 정보를 가린 요약 후보를 outbox에 기록한다.
 *
 * @returns {Promise<HookResponse>}
 */
async function enqueueReflect(deps, route, auth, input, workspace) {
  const scanned = scanText(input.excerpt);
  const rules   = [...new Set(scanned.rules.map(r => r.id))];
  if (rules.length > 0 && deps.scanMode() === "reject") {
    return new HookResponse(422, "sensitive_rejected", { error: "sensitive_content", rules });
  }

  const keyId = auth.keyId ?? null;
  const event = {
    topic      : HOOK_REFLECT_TOPIC,
    aggregateId: hookIdempotencyKey({ keyId, client: route.client, sessionId: input.sessionId, event: route.event }),
    payload    : {
      v             : HOOK_PAYLOAD_VERSION,
      client        : route.client,
      event         : route.event,
      sessionId     : input.sessionId,
      keyId,
      workspace,
      excerpt       : scanned.text,
      excerptBytes  : Buffer.byteLength(scanned.text, "utf8"),
      sensitiveRules: rules,
      receivedAt    : deps.now().toISOString()
    }
  };

  let written;
  try {
    written = await deps.enqueue(event);
  } catch (err) {
    if (err instanceof OutboxValidationError) throw fail(413, "invalid", "payload_too_large");
    throw err;
  }
  if (!written) throw fail(503, "unavailable", "queue_unavailable", { "Retry-After": "60" });
  return new HookResponse(202, "accepted", { accepted: true });
}

/**
 * 요청 하나를 처리해 보낼 응답을 정한다.
 *
 * @returns {Promise<HookResponse>}
 */
async function decide(deps, req, route, rateLimiter) {
  if (!deps.enabled() || !route) throw fail(404, "not_found", "not_found");
  if (!isJsonContentType(req.headers["content-type"])) throw fail(415, "invalid", "unsupported_media_type");
  if (headerBytes(req.rawHeaders ?? []) > HOOK_LIMITS.headerMaxBytes) throw fail(431, "invalid", "headers_too_large");

  const clientIp = resolveClientIp(req);
  if (!rateLimiter.allow(clientIp, null)) throw rateLimited();

  const auth = await authorize(deps, req, route.event);
  if (auth.keyId && !rateLimiter.allow(clientIp, auth.keyId)) throw rateLimited();

  const body = await readBody(req);
  let input;
  try {
    input = validateHookBody(route.event, body);
  } catch (err) {
    if (err instanceof HookInputError) throw fail(err.status, "invalid", err.code);
    throw err;
  }

  const workspace = await derivedWorkspace(deps, auth, input);
  return isReflectEvent(route.event)
    ? enqueueReflect(deps, route, auth, input, workspace)
    : sessionStart(deps, req, route, auth, workspace);
}

/**
 * 의존성을 주입한 처리기를 만든다(시험용). 운영 경로는 handleHookPost를 쓴다.
 *
 * @param {Partial<typeof DEFAULT_DEPS>} [overrides]
 * @returns {(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, ctx: { rateLimiter: object, startTime?: bigint, pathname: string }) => Promise<void>}
 */
export function createHookHandler(overrides = {}) {
  const deps = { ...DEFAULT_DEPS, ...overrides };

  return async function hookHandler(req, res, { rateLimiter, startTime = process.hrtime.bigint(), pathname }) {
    const route = parseHookRoute(pathname);
    const reply = await decide(deps, req, route, rateLimiter).catch(err => toReply(err, route));

    if (reply.status >= 500) logWarn(`[Hook] ${routeLabel(route)} -> ${reply.status} ${reply.body.error ?? ""}`);
    recordHookCall(route?.client, route?.event, reply.outcome);
    for (const [name, value] of Object.entries(reply.headers)) res.setHeader(name, value);
    res.setHeader("Cache-Control", "no-store");
    await sendJSON(res, reply.status, reply.body, req);
    recordHttpRequest("POST", "/hooks", reply.status, Number(process.hrtime.bigint() - startTime) / 1e9);
  };
}

/** 로그용 경로 표기. 허용 목록 밖이면 other다. */
function routeLabel(route) {
  return `${route?.client ?? "other"}/${route?.event ?? "other"}`;
}

/**
 * 처리 중 던진 값을 응답으로 바꾼다. 예상하지 못한 오류는 이름과 코드만 기록하고 500이다.
 *
 * @param {unknown} err
 * @param {{ client: string, event: string }|null} route
 * @returns {HookResponse}
 */
function toReply(err, route) {
  if (err instanceof HookResponse) return err;
  logError(`[Hook] ${routeLabel(route)} failed: ${err?.name ?? "Error"} code=${err?.code ?? "none"}`);
  return fail(500, "error", "server_error");
}

const defaultHandler = createHookHandler();

/**
 * POST /hooks/{client}/{event}
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse}   res
 * @param {bigint} startTime
 * @param {object} rateLimiter DualRateLimiter
 * @param {string} pathname
 */
export async function handleHookPost(req, res, startTime, rateLimiter, pathname) {
  await defaultHandler(req, res, { rateLimiter, startTime, pathname });
}
