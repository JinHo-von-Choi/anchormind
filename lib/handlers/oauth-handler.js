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

import { ACCESS_KEY, PORT, ALLOW_AUTO_DCR_REGISTER } from "../config.js";
import { sendJSON } from "../compression.js";
import {
  getAuthServerMetadata,
  getResourceMetadata,
  handleAuthorize,
  handleToken,
  buildConsentHtml
} from "../oauth.js";
import { registerClient } from "../admin/OAuthClientStore.js";
import { validateApiKeyFromDB } from "../admin/ApiKeyStore.js";
import { logInfo, logError, logWarn } from "../logger.js";
import { safeCompare, extractBearerToken } from "../auth.js";
import { readJsonBody, readRawBody } from "../utils.js";
import { recordOAuthAutoRegisterBlocked, recordOAuthBoundClientRegistered } from "../metrics.js";

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
  if (!Array.isArray(redirectUris) || !redirectUris.length) {
    await sendJSON(res, 400, { error: "invalid_client_metadata", error_description: "redirect_uris is required" }, req);
    return;
  }

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
          logInfo(`[OAuth] /register bound: client_id=${boundClientId} (keyId: ${apiKeyResult.keyId})`);
          recordOAuthBoundClientRegistered();
        }
      } catch { /* 무효 토큰은 fallback */ }
    }
  }

  try {
    const client = await registerClient({
      client_id    : boundClientId || undefined,
      client_name  : boundClientName || body.client_name || null,
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
      token_endpoint_auth_method: "none",
    }, req);
  } catch (err) {
    logError("[OAuth] register error:", err);
    await sendJSON(res, 500, { error: "server_error" }, req);
  }
}

/**
 * GET /authorize (OAuth 2.0) — 동의 화면 표시
 * POST /authorize (OAuth 2.0) — 동의 결과 처리
 */
export async function handleOAuthAuthorize(req, res) {
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
      const errorUrl = new URL(params.redirect_uri);
      errorUrl.searchParams.set("error", "access_denied");
      errorUrl.searchParams.set("error_description", "User denied access");
      if (params.state) errorUrl.searchParams.set("state", params.state);
      res.statusCode = 302;
      res.setHeader("Location", errorUrl.toString());
      res.end();
      return;
    }

    /** decision === "allow": 인증 코드 발급 */
    const result = await handleAuthorize(params);

    if (result.error) {
      if (params.redirect_uri) {
        const errorUrl = new URL(params.redirect_uri);
        errorUrl.searchParams.set("error", result.error);
        errorUrl.searchParams.set("error_description", result.error_description);
        if (params.state) errorUrl.searchParams.set("state", params.state);
        res.statusCode = 302;
        res.setHeader("Location", errorUrl.toString());
        res.end();
      } else {
        await sendJSON(res, 400, result, req);
      }
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
  let   clientName  = "An application";
  const { getClient: getOAuthClient } = await import("../admin/OAuthClientStore.js");
  const isAccessKey = ACCESS_KEY && safeCompare(clientId || "", ACCESS_KEY);

  if (!isAccessKey) {
    let client = await getOAuthClient(clientId);
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
        const errorUrl = new URL(params.redirect_uri);
        errorUrl.searchParams.set("error", "invalid_client");
        errorUrl.searchParams.set("error_description", "Client not registered. Use POST /register first.");
        if (params.state) errorUrl.searchParams.set("state", params.state);
        res.statusCode = 302;
        res.setHeader("Location", errorUrl.toString());
        res.end();
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
      if (params.redirect_uri) {
        const errorUrl = new URL(params.redirect_uri);
        errorUrl.searchParams.set("error", "invalid_client");
        errorUrl.searchParams.set("error_description", "Invalid client_id");
        if (params.state) errorUrl.searchParams.set("state", params.state);
        res.statusCode = 302;
        res.setHeader("Location", errorUrl.toString());
        res.end();
      } else {
        await sendJSON(res, 400, { error: "invalid_client", error_description: "Invalid client_id" }, req);
      }
      return;
    }
    clientName = client.client_name || clientId;
  } else {
    clientName = "Master Key Client";
  }

  /** redirect_uri가 허용 목록에 있으면 자동 승인 (신뢰된 클라이언트) */
  const { isAllowedRedirectUri: isAllowed } = await import("../oauth.js");
  if (isAllowed(params.redirect_uri)) {
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

  const result = await handleToken(body);

  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");
  const { success, ...tokenResponse } = result;
  await sendJSON(res, result.error ? 400 : 200, tokenResponse, req);
}
