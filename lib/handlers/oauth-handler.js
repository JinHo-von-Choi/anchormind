/**
 * OAuth 2.0 관련 핸들러
 * - GET  /.well-known/oauth-authorization-server
 * - GET  /.well-known/oauth-protected-resource
 * - POST /register (RFC 7591 Dynamic Client Registration)
 * - GET  /authorize + POST /authorize
 * - POST /token
 *
 * 작성자: 최진호
 * 작성일: 2026-04-04
 */

import { ACCESS_KEY, PORT, ALLOW_AUTO_DCR_REGISTER, dcrHourlyCap } from "../config.js";
import { sendJSON } from "../compression.js";
import {
  getAuthServerMetadata,
  getResourceMetadata,
  handleAuthorize,
  handleToken,
  buildConsentHtml,
  isAllowedRedirectUri
} from "../oauth.js";
import { registerClient, getClient, validateRedirectUri } from "../admin/OAuthClientStore.js";
import { validateApiKeyFromDB } from "../admin/ApiKeyStore.js";
import { logInfo, logError, logWarn } from "../logger.js";
import { safeCompare, extractBearerToken } from "../auth.js";
import { readJsonBody, readRawBody } from "../utils.js";
import { recordOAuthAutoRegisterBlocked, recordOAuthBoundClientRegistered } from "../metrics.js";

/** 발급 API 키 원문 형식(ApiKeyStore.generateRawKey). 무인증 DCR client_id(mmcp_<hex32>)와 겹치지 않는다. */
const RAW_API_KEY_FORMAT = /^mmcp_[a-z0-9]{1,8}_[0-9a-f]{32}$/;

/** 등록 시점에 키에 묶인 클라이언트 표식 */
const BOUND_CLIENT_NAME  = /^apikey:[0-9a-f-]{36}$/i;

/**
 * client_secret_basic(RFC 6749 2.3.1) 헤더를 해석한다.
 * Basic 형식이 아니면 null. 형식은 맞으나 해석할 수 없으면 기록 후 null.
 *
 * @param {string|undefined} header
 * @returns {{ clientId: string, clientSecret: string }|null}
 */
export function parseBasicClientAuth(header) {
  if (typeof header !== "string") return null;
  const m = header.match(/^Basic\s+([A-Za-z0-9+/=]+)\s*$/i);
  if (!m) return null;
  const decoded = Buffer.from(m[1], "base64").toString("utf8");
  const sep     = decoded.indexOf(":");
  if (sep < 0) {
    logWarn("[OAuth] /token Basic credentials without separator");
    return null;
  }
  const unescape = (v) => decodeURIComponent(v.replace(/\+/g, "%20"));
  try {
    return { clientId: unescape(decoded.slice(0, sep)), clientSecret: unescape(decoded.slice(sep + 1)) };
  } catch (err) {
    logWarn(`[OAuth] /token Basic credentials not decodable: ${err.message}`);
    return null;
  }
}

export { dcrHourlyCap };

/** 등록 상한 집계 창(1시간 고정 창). 프로세스 단위 */
const dcrWindow = { startedAt: 0, count: 0 };

function allowRegistration(now) {
  const cap = dcrHourlyCap();
  if (cap === 0) return true;
  if (now - dcrWindow.startedAt >= 3_600_000) {
    dcrWindow.startedAt = now;
    dcrWindow.count     = 0;
  }
  if (dcrWindow.count >= cap) return false;
  dcrWindow.count += 1;
  return true;
}

/** 시험 전용 초기화 */
export function _resetDcrWindowForTest() {
  dcrWindow.startedAt = 0;
  dcrWindow.count     = 0;
}

/**
 * 등록 요청의 redirect_uris 검사와 시간당 상한 검사. 거부하면 응답을 보내고 true를 돌려준다.
 * @returns {Promise<boolean>}
 */
async function rejectRegistration(req, res, redirectUris) {
  if (!Array.isArray(redirectUris) || !redirectUris.length) {
    await sendJSON(res, 400, { error: "invalid_client_metadata", error_description: "redirect_uris is required" }, req);
    return true;
  }
  if (allowRegistration(Date.now())) return false;
  logWarn(`[OAuth] /register hourly cap reached: cap=${dcrHourlyCap()}`);
  res.setHeader("Retry-After", "3600");
  await sendJSON(res, 429, { error: "too_many_requests" }, req);
  return true;
}

/**
 * GET /.well-known/oauth-authorization-server
 */
export async function handleOAuthServerMetadata(req, res) {
  logInfo(`[OAuth] ${req.method} ${req.url} (origin: ${req.headers.origin || req.headers.referer || "unknown"})`);
  const proto    = req.headers["x-forwarded-proto"] || (req.socket.encrypted ? "https" : "http");
  const baseUrl  = `${proto}://${req.headers.host || `localhost:${PORT}`}`;
  const metadata = getAuthServerMetadata(baseUrl);
  res.setHeader("Access-Control-Allow-Origin", "*");
  await sendJSON(res, 200, metadata, req);
}

/**
 * GET /.well-known/oauth-protected-resource
 */
export async function handleOAuthResourceMetadata(req, res) {
  logInfo(`[OAuth] ${req.method} ${req.url} (origin: ${req.headers.origin || req.headers.referer || "unknown"})`);
  const proto    = req.headers["x-forwarded-proto"] || (req.socket.encrypted ? "https" : "http");
  const baseUrl  = `${proto}://${req.headers.host || `localhost:${PORT}`}`;
  const metadata = getResourceMetadata(baseUrl);
  res.setHeader("Access-Control-Allow-Origin", "*");
  await sendJSON(res, 200, metadata, req);
}

/**
 * POST /register (RFC 7591 Dynamic Client Registration)
 */
export async function handleOAuthRegister(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  logInfo(`[OAuth] POST /register (origin: ${req.headers.origin || "unknown"})`);

  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    if (err.statusCode === 413) {
      await sendJSON(res, 413, { error: "invalid_client_metadata", error_description: "Request body too large" }, req);
      return;
    }
    await sendJSON(res, 400, { error: "invalid_client_metadata", error_description: "Invalid JSON body" }, req);
    return;
  }

  const redirectUris = body.redirect_uris;
  if (await rejectRegistration(req, res, redirectUris)) return;

  /**
   * Authorization: Bearer <API 키> 헤더가 있고 DB API 키로 검증되면,
   * client_id = "<name>_<keyIdHex8>" 형태의 URL-safe 이름으로 등록한다.
   * client_name = "apikey:<keyId>" 마커로 서버 내부 바인딩을 인코딩한다.
   *
   * 헤더가 없거나 유효하지 않은 토큰이면 기존 랜덤 client_id 생성으로 fallback.
   */
  let boundClientId   = null;
  let boundClientName = null;
  const authHeader    = req.headers.authorization;
  if (authHeader) {
    const _rawToken = extractBearerToken(authHeader);
    if (_rawToken) {
      const token = _rawToken.trim();
      try {
        const apiKeyResult = await validateApiKeyFromDB(token);
        if (apiKeyResult.valid) {
          const rawName     = apiKeyResult.name || apiKeyResult.keyId;
          const keyIdHex    = apiKeyResult.keyId.replace(/-/g, "").slice(0, 8);
          /** 항상 suffix 부착 — 동일 name 다른 keyId 충돌 방지 */
          boundClientId     = `${rawName}_${keyIdHex}`;
          boundClientName   = `apikey:${apiKeyResult.keyId}`;
          logInfo(`[OAuth] /register bound: client_id=${boundClientId}`);
          recordOAuthBoundClientRegistered();
        }
      } catch { /* 무효 토큰은 fallback */ }
    }
  }

  try {
    const client = await registerClient({
      client_id    : boundClientId || undefined,
      client_name  : boundClientName
                       || (/^apikey:/i.test(body.client_name || "") ? null : (body.client_name || null)),
      redirect_uris: redirectUris,
      scope        : body.scope || "mcp",
      client_uri   : body.client_uri || null,
      logo_uri     : body.logo_uri || null,
    });

    await sendJSON(res, 201, {
      client_id                 : client.client_id,
      client_name               : client.client_name,
      redirect_uris             : client.redirect_uris,
      grant_types               : client.grant_types,
      response_types            : client.response_types,
      scope                     : client.scope,
      token_endpoint_auth_method: boundClientId ? "client_secret_post" : "none",
    }, req);
  } catch (err) {
    logError("[OAuth] register error:", err);
    await sendJSON(res, 500, { error: "server_error" }, req);
  }
}

/**
 * 오류를 알릴 redirect_uri를 판정한다.
 * 등록된 클라이언트는 등록 URI와 정확히 같을 때, 그 밖에는 신뢰 목록에 있을 때만 검증된 것으로 본다.
 *
 * @param {string|null} redirectUri
 * @param {object|null} client - OAuthClientStore.getClient 결과
 * @returns {{ url: URL|null, verified: boolean }}
 */
export function resolveErrorRedirect(redirectUri, client) {
  let url;
  try {
    url = new URL(redirectUri);
  } catch {
    return { url: null, verified: false };
  }
  const verified = client ? validateRedirectUri(client, redirectUri) : isAllowedRedirectUri(redirectUri);
  return { url, verified };
}

/**
 * 오류 리다이렉트 대상 판정에 쓸 클라이언트를 조회한다.
 * 마스터 키 client_id는 조회하지 않는다. 조회 실패는 기록하고 null로 처리해 신뢰 목록 기준으로 판정한다.
 */
async function lookupClientForRedirect(clientId) {
  if (!clientId || (ACCESS_KEY && safeCompare(clientId, ACCESS_KEY))) return null;
  try {
    return await getClient(clientId);
  } catch (err) {
    logError("[OAuth] client lookup for error response failed:", err);
    return null;
  }
}

/**
 * /authorize 오류 응답.
 * 검증된 redirect_uri면 302, URI가 없거나 URL이 아니면 400 JSON.
 * 검증되지 않은 URI는 MEMENTO_OAUTH_REDIRECT_CHECK=enforce면 400, 그 밖(warn)은 기록 후 302.
 */
async function sendAuthorizeError(req, res, params, client, error, description) {
  const { url, verified } = resolveErrorRedirect(params.redirect_uri, client);
  const mode              = process.env.MEMENTO_OAUTH_REDIRECT_CHECK === "enforce" ? "enforce" : "warn";

  if (url && !verified) {
    logWarn(`[OAuth] error redirect target not registered: host=${url.host.slice(0, 128)} mode=${mode}`);
  }
  if (!url || (!verified && mode === "enforce")) {
    await sendJSON(res, 400, { error, error_description: description }, req);
    return;
  }

  url.searchParams.set("error", error);
  url.searchParams.set("error_description", description);
  if (params.state) url.searchParams.set("state", params.state);
  res.statusCode = 302;
  res.setHeader("Location", url.toString());
  res.end();
}

/**
 * GET /authorize (OAuth 2.0) — 동의 화면 표시
 * POST /authorize (OAuth 2.0) — 동의 결과 처리
 * 저장소 조회 등 처리 중 예외는 기록하고 500 JSON으로 응답한다.
 */
export async function handleOAuthAuthorize(req, res) {
  try {
    await processAuthorize(req, res);
  } catch (err) {
    logError("[OAuth] authorize error:", err);
    if (res.headersSent) {
      res.end();
      return;
    }
    await sendJSON(res, 500, { error: "server_error" }, req);
  }
}

async function processAuthorize(req, res) {
  logInfo(`[OAuth] ${req.method} /authorize (origin: ${req.headers.origin || req.headers.referer || "unknown"})`);
  if (req.method === "POST") {
    /** POST: 동의 화면 폼 제출 처리 */
    let rawBody;
    try {
      rawBody = await readRawBody(req);
    } catch (err) {
      if (err.statusCode === 413) {
        await sendJSON(res, 413, { error: "invalid_request", error_description: "Request body too large" }, req);
        return;
      }
      await sendJSON(res, 400, { error: "invalid_request", error_description: "Failed to read request body" }, req);
      return;
    }
    const formData = new URLSearchParams(rawBody);
    const params = {
      response_type        : formData.get("response_type"),
      client_id            : formData.get("client_id"),
      redirect_uri         : formData.get("redirect_uri"),
      code_challenge       : formData.get("code_challenge"),
      code_challenge_method: formData.get("code_challenge_method"),
      state                : formData.get("state"),
      scope                : formData.get("scope"),
      resource             : formData.get("resource"),
    };

    const decision = formData.get("decision");
    if (decision === "deny") {
      const client = await lookupClientForRedirect(params.client_id);
      await sendAuthorizeError(req, res, params, client, "access_denied", "User denied access");
      return;
    }

    /** decision === "allow": 인증 코드 발급 */
    const result = await handleAuthorize(params);

    if (result.error) {
      const client = await lookupClientForRedirect(params.client_id);
      await sendAuthorizeError(req, res, params, client, result.error, result.error_description);
      return;
    }

    res.statusCode = 302;
    res.setHeader("Location", result.redirect);
    res.end();
    return;
  }

  /** GET: 동의 화면 표시 */
  const url    = new URL(req.url || "/", "http://localhost");
  const params = {
    response_type        : url.searchParams.get("response_type"),
    client_id            : url.searchParams.get("client_id"),
    redirect_uri         : url.searchParams.get("redirect_uri"),
    code_challenge       : url.searchParams.get("code_challenge"),
    code_challenge_method: url.searchParams.get("code_challenge_method"),
    state                : url.searchParams.get("state"),
    scope                : url.searchParams.get("scope"),
    resource             : url.searchParams.get("resource")
  };

  const clientId    = params.client_id;
  let   clientName;
  let   isBoundClient = false;
  const { getClient: getOAuthClient } = await import("../admin/OAuthClientStore.js");
  const isAccessKey = ACCESS_KEY && safeCompare(clientId || "", ACCESS_KEY);

  if (!isAccessKey) {
    let client = await getOAuthClient(clientId);
    if (!client && RAW_API_KEY_FORMAT.test(clientId || "")) {
      /**
       * API 키 원문 client_id는 handleAuthorize가 직접 검증한다.
       * 검증 결과와 무관하게 클라이언트 행으로 저장하거나 기록하지 않는다.
       */
      const keyCheck = await validateApiKeyFromDB(clientId);
      if (!keyCheck.valid) {
        await sendAuthorizeError(req, res, params, null, "invalid_client", "Invalid client_id");
        return;
      }
      client = { client_name: keyCheck.name || "API Key Client", redirect_uris: [] };
    }
    if (!client && params.redirect_uri) {
      /**
       * v2.8.6 자동 등록 정책:
       * - redirect_uri가 신뢰 목록(OAUTH_TRUSTED_ORIGINS 기반 isAllowedRedirectUri)에 있으면 항상 허용.
       *   실질적 보안 경계는 /token의 client_secret 검증(v2.8.5). 바인딩되지 않은 토큰은
       *   auth.js의 REJECT_NONAPIKEY_OAUTH 정책에 의해 거부된다.
       * - 신뢰되지 않은 redirect_uri는 ALLOW_AUTO_DCR_REGISTER=true일 때만 등록.
       *   기본 false이므로 차단.
       */
      const { isAllowedRedirectUri }       = await import("../oauth.js");
      const { registerClient: regClient }  = await import("../admin/OAuthClientStore.js");
      const redirectTrusted                = isAllowedRedirectUri(params.redirect_uri);

      if (!redirectTrusted && !ALLOW_AUTO_DCR_REGISTER) {
        logWarn(`[OAuth] Auto-registration blocked for client: ${clientId} (untrusted redirect_uri)`);
        recordOAuthAutoRegisterBlocked();
        await sendAuthorizeError(req, res, params, null, "invalid_client", "Client not registered. Use POST /register first.");
        return;
      }

      try {
        logInfo(`[OAuth] Auto-registering client: ${clientId} with redirect_uri: ${params.redirect_uri} (trusted: ${redirectTrusted})`);
        await regClient({
          client_id:     clientId,
          client_name:   clientId,
          redirect_uris: [params.redirect_uri],
          scope:         params.scope || "mcp",
        });
        client = { client_name: clientId, redirect_uris: [params.redirect_uri] };
      } catch (regErr) {
        logError("[OAuth] Auto-register failed:", regErr);
      }
    }
    if (!client) {
      await sendAuthorizeError(req, res, params, null, "invalid_client", "Invalid client_id");
      return;
    }
    clientName    = client.client_name || clientId;
    isBoundClient = BOUND_CLIENT_NAME.test(client.client_name || "");
  } else {
    clientName = "Master Key Client";
  }

  /** redirect_uri가 허용 목록에 있으면 자동 승인한다. 키에 묶인 클라이언트는 동의 화면을 거친다 */
  const { isAllowedRedirectUri: isAllowed } = await import("../oauth.js");
  if (!isBoundClient && isAllowed(params.redirect_uri)) {
    const result = await handleAuthorize(params);
    if (result.redirect) {
      res.statusCode = 302;
      res.setHeader("Location", result.redirect);
      res.end();
      return;
    }
  }

  const html = buildConsentHtml(params, clientName);
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(html);
}

/**
 * POST /token (OAuth 2.0)
 */
export async function handleOAuthToken(req, res) {
  logInfo(`[OAuth] POST /token (origin: ${req.headers.origin || "unknown"})`);
  let body;
  try {
    const rawBody     = await readRawBody(req);
    const contentType = req.headers["content-type"] || "";
    if (contentType.includes("application/json")) {
      body = JSON.parse(rawBody);
    } else {
      body = Object.fromEntries(new URLSearchParams(rawBody));
    }
  } catch (err) {
    if (err.statusCode === 413) {
      await sendJSON(res, 413, { error: "invalid_request", error_description: "Request body too large" }, req);
      return;
    }
    await sendJSON(res, 400, { error: "invalid_request", error_description: "Failed to parse request body" }, req);
    return;
  }

  if (body === null || typeof body !== "object" || Array.isArray(body)) body = {};

  const basic = parseBasicClientAuth(req.headers.authorization);
  if (basic && body.client_secret === undefined) {
    body.client_secret = basic.clientSecret;
    if (body.client_id === undefined) body.client_id = basic.clientId;
  }

  const result = await handleToken(body);

  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");
  const { _success, ...tokenResponse } = result;
  const status = result.error === "invalid_client" ? 401 : (result.error ? 400 : 200);
  if (result.error) {
    logWarn(`[OAuth] /token ${result.error}: grant=${String(body.grant_type || "").slice(0, 32)}`);
  }
  await sendJSON(res, status, tokenResponse, req);
}
