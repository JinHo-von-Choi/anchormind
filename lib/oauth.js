/**
 * OAuth 2.0 + PKCE 인증 모듈
 *
 * 작성자: 최진호
 * 작성일: 2026-01-30
 * 수정일: 2026-02-13 (Redis 통합)
 *
 * MCP 프로토콜 사양에 따른 OAuth 2.1 구현
 * - RFC8414: Authorization Server Metadata
 * - RFC9728: Protected Resource Metadata
 * - PKCE (RFC7636)
 */

import crypto from "crypto";
import { ACCESS_KEY, REDIS_ENABLED, OAUTH_ALLOWED_REDIRECT_URIS, OAUTH_TRUSTED_ORIGINS, OAUTH_TOKEN_TTL_SECONDS, OAUTH_REFRESH_TTL_SECONDS } from "./config.js";
import { logInfo } from "./logger.js";
import { safeCompare } from "./auth.js";
import { getClient, validateRedirectUri } from "./admin/OAuthClientStore.js";
import {
  saveOAuthCode,
  consumeOAuthCode,
  saveOAuthToken,
  getOAuthToken,
  deleteOAuthToken
} from "./redis.js";
import { recordOAuthBoundClientAuthorized } from "./metrics.js";

/**
 * redirect_uri 허용 여부 판정
 * 1. localhost/127.0.0.1 → 항상 허용
 * 2. OAUTH_TRUSTED_ORIGINS → origin(도메인) 단위 허용 (동적 경로 대응)
 * 3. OAUTH_ALLOWED_REDIRECT_URIS → 정확 URI 일치 (하위 호환)
 */
export function isAllowedRedirectUri(uri) {
  if (!uri) return false;
  try {
    const parsed = new URL(uri);
    if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") return true;
    const origin = parsed.origin;
    if (OAUTH_TRUSTED_ORIGINS.includes(origin)) return true;
  } catch { return false; }
  return OAUTH_ALLOWED_REDIRECT_URIS.includes(uri);
}

/** 인증 코드 저장소 (메모리 - fallback) */
const authCodes         = new Map();

/** 액세스 토큰 저장소 (메모리 - fallback) */
const accessTokens      = new Map();

/** 코드/토큰 만료 시간 */
const CODE_TTL_MS       = 10 * 60 * 1000;
const CODE_TTL_SECONDS  = 600;
const TOKEN_TTL_SECONDS   = OAUTH_TOKEN_TTL_SECONDS;
const TOKEN_TTL_MS        = OAUTH_TOKEN_TTL_SECONDS * 1000;
const REFRESH_TTL_SECONDS = OAUTH_REFRESH_TTL_SECONDS;

/**
 * Base64URL 인코딩
 */
function base64UrlEncode(buffer) {
  return buffer.toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

/**
 * PKCE code_challenge 검증 (S256)
 */
function verifyCodeChallenge(codeVerifier, codeChallenge) {
  const hash     = crypto.createHash("sha256").update(codeVerifier).digest();
  const computed = base64UrlEncode(hash);
  return computed === codeChallenge;
}

/**
 * 랜덤 문자열 생성
 */
function generateRandomString(length = 32) {
  return base64UrlEncode(crypto.randomBytes(length));
}

/**
 * Authorization Server Metadata (RFC8414)
 */
export function getAuthServerMetadata(baseUrl) {
  return {
    issuer                                    : baseUrl,
    authorization_endpoint                    : `${baseUrl}/authorize`,
    token_endpoint                            : `${baseUrl}/token`,
    response_types_supported                  : ["code"],
    grant_types_supported                     : ["authorization_code", "refresh_token"],
    code_challenge_methods_supported          : ["S256"],
    token_endpoint_auth_methods_supported     : ["none", "client_secret_post", "client_secret_basic"],
    scopes_supported                          : ["mcp"],
    registration_endpoint                     : `${baseUrl}/register`,
    service_documentation                     : `${baseUrl}/docs`
  };
}

/**
 * Protected Resource Metadata (RFC9728)
 */
export function getResourceMetadata(baseUrl) {
  return {
    resource              : `${baseUrl}/mcp`,
    authorization_servers : [baseUrl],
    scopes_supported      : ["mcp"],
    bearer_methods_supported: ["header"]
  };
}

/**
 * 인증 요청 처리 (GET /authorize)
 */
export async function handleAuthorize(params) {
  const {
    response_type,
    client_id,
    redirect_uri,
    code_challenge,
    code_challenge_method,
    state,
    scope,
    resource
  } = params;

  /** 필수 파라미터 검증 */
  if (response_type !== "code") {
    return { success: false, error: "unsupported_response_type", error_description: "Only 'code' response type is supported" };
  }

  if (!redirect_uri) {
    return { success: false, error: "invalid_request", error_description: "redirect_uri is required" };
  }

  if (!code_challenge) {
    return { success: false, error: "invalid_request", error_description: "code_challenge is required (PKCE)" };
  }

  if (code_challenge_method !== "S256") {
    return { success: false, error: "invalid_request", error_description: "Only S256 code_challenge_method is supported" };
  }

  /** client_id 검증: ACCESS_KEY → DB API 키 → DCR 클라이언트(name-based 포함) */
  let oauthClient    = null;
  let isApiKeyClient = false;
  let boundKeyId     = null;
  const isAccessKey  = ACCESS_KEY && safeCompare(client_id || "", ACCESS_KEY);

  if (!isAccessKey) {
    /** 1순위: client_id 전체 문자열이 API 키인 경우 (v2.8.3 호환 경로) */
    const { validateApiKeyFromDB, validateApiKeyById } = await import("./admin/ApiKeyStore.js");
    try {
      const apiKeyResult = await validateApiKeyFromDB(client_id);
      if (apiKeyResult.valid) {
        isApiKeyClient = true;
      }
    } catch { /* DB 오류 시 무시하고 다음 검증으로 */ }

    if (!isApiKeyClient) {
      /** 2순위: DCR 등록된 클라이언트 조회 (v2.8.4 name-based binding 포함) */
      oauthClient = await getClient(client_id);
      if (oauthClient) {
        /** client_name = "apikey:<uuid>" 패턴이면 bound_key_id 경로 */
        const cnMatch = (oauthClient.client_name || "").match(/^apikey:([0-9a-f-]{36})$/i);
        if (cnMatch) {
          const extractedKeyId = cnMatch[1];
          const expectedSuffix = `_${extractedKeyId.replace(/-/g, "").slice(0, 8)}`.toLowerCase();
          /** 서버가 부여한 client_id 형식일 때만 키 바인딩을 인정한다 */
          if (String(client_id).toLowerCase().endsWith(expectedSuffix)) {
            try {
              const byIdResult = await validateApiKeyById(extractedKeyId);
              if (byIdResult.valid) {
                isApiKeyClient = true;
                boundKeyId     = extractedKeyId;
                recordOAuthBoundClientAuthorized();
              }
            } catch { /* 조회 실패 시 non-API-key 경로로 낙하 */ }
          }
        }
      } else {
        /** DCR 없이 접근하는 클라이언트 (claude.ai 등) — redirect_uri가 trusted면 허용 */
        if (!isAllowedRedirectUri(redirect_uri)) {
          return { success: false, error: "invalid_client", error_description: "Invalid client_id" };
        }
        /** anonymous client로 처리 — isApiKeyClient=false, oauthClient=null 유지 */
      }
    }
  }

  /** redirect_uri 검증 */
  if (oauthClient) {
    if (!validateRedirectUri(oauthClient, redirect_uri)) {
      return { success: false, error: "invalid_request", error_description: "redirect_uri not registered for this client" };
    }
  } else if (!isAllowedRedirectUri(redirect_uri)) {
    return { success: false, error: "invalid_request", error_description: "redirect_uri is not allowed" };
  }

  /** 인증 코드 생성 */
  const code = generateRandomString(32);

  const codeData = {
    client_id,
    redirect_uri,
    code_challenge,
    scope          : scope || "mcp",
    state,
    is_api_key     : isApiKeyClient,
    bound_key_id   : boundKeyId || null,
    resource       : resource || null,
    created_at     : Date.now(),
    expires_at     : Date.now() + CODE_TTL_MS
  };

  /** 코드 저장 (Redis 또는 메모리) */
  if (REDIS_ENABLED) {
    await saveOAuthCode(code, codeData, CODE_TTL_SECONDS);
  } else {
    authCodes.set(code, codeData);
  }

  logInfo(`[OAuth] Authorization code issued for client: ${client_id?.substring(0, 8)}***`);

  /** 리다이렉트 URL 구성 */
  const redirectUrl = new URL(redirect_uri);
  redirectUrl.searchParams.set("code", code);
  if (state) {
    redirectUrl.searchParams.set("state", state);
  }

  return {
    success    : true,
    code,
    redirectUri: redirect_uri,
    redirect   : redirectUrl.toString()
  };
}

/**
 * 토큰 요청 처리 (POST /token)
 */
export async function handleToken(params) {
  const {
    grant_type,
    code,
    redirect_uri,
    code_verifier,
    refresh_token,
    client_secret,
    resource
  } = params;

  /**
   * client_secret으로 API 키 바인딩 추출:
   * claude.ai 등 OAuth 클라이언트는 사용자가 UI에 입력한 API 키를
   * POST /token body의 client_secret 파라미터로 전송한다.
   * 여기서 검증 성공 시 tokenData에 is_api_key=true + bound_key_id를 주입하여
   * 이후 MCP 요청이 정상 tenant 격리된 세션으로 인증되도록 한다.
   */
  let secretBoundKeyId = null;
  if (client_secret && typeof client_secret === "string") {
    try {
      const { validateApiKeyFromDB } = await import("./admin/ApiKeyStore.js");
      const apiKeyResult = await validateApiKeyFromDB(client_secret);
      if (apiKeyResult.valid) {
        secretBoundKeyId = apiKeyResult.keyId;
        logInfo(`[OAuth] /token client_secret bound to API key (keyId: ${apiKeyResult.keyId})`);
      }
    } catch { /* 무효 secret은 기존 is_api_key 플래그로 fallback */ }
  }

  /** Refresh Token 처리 */
  if (grant_type === "refresh_token") {
    if (!refresh_token) {
      return { success: false, error: "invalid_request", error_description: "refresh_token is required" };
    }

    let tokenData;
    if (REDIS_ENABLED) {
      tokenData = await getOAuthToken(refresh_token);
    } else {
      tokenData = accessTokens.get(refresh_token);
    }

    if (!tokenData || tokenData.type !== "refresh") {
      return { success: false, error: "invalid_grant", error_description: "Invalid refresh token" };
    }

    if (Date.now() > tokenData.expires_at) {
      if (REDIS_ENABLED) {
        await deleteOAuthToken(refresh_token);
      } else {
        accessTokens.delete(refresh_token);
      }
      return { success: false, error: "invalid_grant", error_description: "Refresh token expired" };
    }

    /** 새 액세스 토큰 발급 */
    const newAccessToken  = generateRandomString(32);
    const newRefreshToken = generateRandomString(32);

    const effectiveBoundId = secretBoundKeyId || tokenData.bound_key_id || null;
    const effectiveIsApiKey = effectiveBoundId ? true : (tokenData.is_api_key || false);

    const newAccessData = {
      type         : "access",
      client_id    : tokenData.client_id,
      scope        : tokenData.scope,
      is_api_key   : effectiveIsApiKey,
      bound_key_id : effectiveBoundId,
      resource     : resource || tokenData.resource || null,
      created_at   : Date.now(),
      expires_at   : Date.now() + TOKEN_TTL_MS
    };

    const newRefreshData = {
      type         : "refresh",
      client_id    : tokenData.client_id,
      scope        : tokenData.scope,
      is_api_key   : effectiveIsApiKey,
      bound_key_id : effectiveBoundId,
      resource     : resource || tokenData.resource || null,
      created_at   : Date.now(),
      expires_at   : Date.now() + REFRESH_TTL_SECONDS * 1000
    };

    if (REDIS_ENABLED) {
      await saveOAuthToken(newAccessToken, newAccessData, TOKEN_TTL_SECONDS);
      await saveOAuthToken(newRefreshToken, newRefreshData, REFRESH_TTL_SECONDS);
      await deleteOAuthToken(refresh_token);
    } else {
      accessTokens.set(newAccessToken, newAccessData);
      accessTokens.set(newRefreshToken, newRefreshData);
      accessTokens.delete(refresh_token);
    }

    return {
      success      : true,
      access_token : newAccessToken,
      token_type   : "Bearer",
      expires_in   : Math.floor(TOKEN_TTL_MS / 1000),
      refresh_token: newRefreshToken,
      scope        : tokenData.scope
    };
  }

  /** Authorization Code 처리 */
  if (grant_type !== "authorization_code") {
    return { success: false, error: "unsupported_grant_type", error_description: "Only authorization_code and refresh_token are supported" };
  }

  if (!code) {
    return { success: false, error: "invalid_request", error_description: "code is required" };
  }

  if (!code_verifier) {
    return { success: false, error: "invalid_request", error_description: "code_verifier is required (PKCE)" };
  }

  /** 인증 코드 검증 및 소비 (일회용) */
  let codeData;
  if (REDIS_ENABLED) {
    codeData = await consumeOAuthCode(code);
  } else {
    codeData = authCodes.get(code);
    if (codeData) {
      authCodes.delete(code);
    }
  }

  if (!codeData) {
    return { success: false, error: "invalid_grant", error_description: "Invalid authorization code" };
  }

  /** 만료 확인 */
  if (Date.now() > codeData.expires_at) {
    return { success: false, error: "invalid_grant", error_description: "Authorization code expired" };
  }

  /** redirect_uri 검증 */
  if (codeData.redirect_uri !== redirect_uri) {
    return { success: false, error: "invalid_grant", error_description: "redirect_uri mismatch" };
  }

  /** PKCE 검증 */
  if (!verifyCodeChallenge(code_verifier, codeData.code_challenge)) {
    return { success: false, error: "invalid_grant", error_description: "code_verifier validation failed" };
  }

  /** 액세스 토큰 생성 */
  const accessToken  = generateRandomString(32);
  const refreshToken = generateRandomString(32);

  const effectiveBoundId = secretBoundKeyId || codeData.bound_key_id || null;
  const effectiveIsApiKey = effectiveBoundId ? true : (codeData.is_api_key || false);

  const accessData = {
    type         : "access",
    client_id    : codeData.client_id,
    scope        : codeData.scope,
    is_api_key   : effectiveIsApiKey,
    bound_key_id : effectiveBoundId,
    resource     : resource || codeData.resource || null,
    created_at   : Date.now(),
    expires_at   : Date.now() + TOKEN_TTL_MS
  };

  const refreshData = {
    type         : "refresh",
    client_id    : codeData.client_id,
    scope        : codeData.scope,
    is_api_key   : effectiveIsApiKey,
    bound_key_id : effectiveBoundId,
    resource     : resource || codeData.resource || null,
    created_at   : Date.now(),
    expires_at   : Date.now() + TOKEN_TTL_MS * 24
  };

  if (REDIS_ENABLED) {
    await saveOAuthToken(accessToken, accessData, TOKEN_TTL_SECONDS);
    await saveOAuthToken(refreshToken, refreshData, REFRESH_TTL_SECONDS);
  } else {
    accessTokens.set(accessToken, accessData);
    accessTokens.set(refreshToken, refreshData);
  }

  logInfo(`[OAuth] Access token issued for client: ${codeData.client_id?.substring(0, 8)}***`);

  return {
    success      : true,
    access_token : accessToken,
    token_type   : "Bearer",
    expires_in   : Math.floor(TOKEN_TTL_MS / 1000),
    refresh_token: refreshToken,
    scope        : codeData.scope
  };
}

/**
 * 액세스 토큰 검증
 */
export async function validateAccessToken(token) {
  if (!token) {
    return { valid: false, reason: "No token provided" };
  }

  let tokenData;
  if (REDIS_ENABLED) {
    tokenData = await getOAuthToken(token);
  } else {
    tokenData = accessTokens.get(token);
  }

  if (!tokenData || tokenData.type !== "access") {
    return { valid: false, reason: "Invalid token" };
  }

  if (Date.now() > tokenData.expires_at) {
    if (REDIS_ENABLED) {
      await deleteOAuthToken(token);
    } else {
      accessTokens.delete(token);
    }
    return { valid: false, reason: "Token expired" };
  }

  return { valid: true, client_id: tokenData.client_id, scope: tokenData.scope, is_api_key: tokenData.is_api_key || false, bound_key_id: tokenData.bound_key_id || null };
}

/**
 * 동의 화면 HTML 생성
 * @param {object} params - OAuth 요청 파라미터
 * @param {string} clientName - 표시할 클라이언트 이름
 * @returns {string} HTML 문자열
 */
export function buildConsentHtml(params, clientName) {
  const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return `<!DOCTYPE html>
<html><head><title>Authorize — Memento MCP</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{background:#050a18;color:#e8edf8;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{background:#0c1530;padding:2rem;border-radius:8px;border:1px solid rgba(255,255,255,0.07);max-width:420px;width:90%;text-align:center}
h2{margin:0 0 8px;font-size:1.25rem}
p{color:#94a3b8;font-size:14px;margin:8px 0 24px;line-height:1.5}
.app{color:#e8edf8;font-weight:600}
.scope{background:#1e293b;padding:4px 12px;border-radius:4px;font-size:13px;display:inline-block;margin:8px 4px;color:#8b9dc3}
.actions{margin-top:24px;display:flex;gap:12px;justify-content:center}
button{padding:10px 32px;border:none;border-radius:6px;font-weight:600;cursor:pointer;font-size:14px}
.allow{background:linear-gradient(135deg,#5b8ef0,#8b5cf6);color:#fff}
.allow:hover{opacity:0.9}
.deny{background:transparent;color:#94a3b8;border:1px solid rgba(255,255,255,0.15)}
.deny:hover{border-color:rgba(255,255,255,0.3)}</style>
</head><body><div class="card">
<h2>Authorize Access</h2>
<p><span class="app">${esc(clientName || "An application")}</span> wants to access your Memento MCP server.</p>
<div><span class="scope">${esc(params.scope || "mcp")}</span></div>
<form method="POST" action="/authorize">
<input type="hidden" name="response_type" value="${esc(params.response_type)}">
<input type="hidden" name="client_id" value="${esc(params.client_id)}">
<input type="hidden" name="redirect_uri" value="${esc(params.redirect_uri)}">
<input type="hidden" name="code_challenge" value="${esc(params.code_challenge)}">
<input type="hidden" name="code_challenge_method" value="${esc(params.code_challenge_method)}">
<input type="hidden" name="state" value="${esc(params.state || "")}">
<input type="hidden" name="scope" value="${esc(params.scope || "mcp")}">
<div class="actions">
<button type="submit" name="decision" value="allow" class="allow">Allow</button>
<button type="submit" name="decision" value="deny" class="deny">Deny</button>
</div></form></div></body></html>`;
}

/**
 * 만료된 코드/토큰 정리
 */
export function cleanupExpiredOAuthData() {
  const now = Date.now();
  let cleanedCodes  = 0;
  let cleanedTokens = 0;

  for (const [code, data] of authCodes) {
    if (now > data.expires_at) {
      authCodes.delete(code);
      cleanedCodes++;
    }
  }

  for (const [token, data] of accessTokens) {
    if (now > data.expires_at) {
      accessTokens.delete(token);
      cleanedTokens++;
    }
  }

  if (cleanedCodes > 0 || cleanedTokens > 0) {
    logInfo(`[OAuth] Cleaned up ${cleanedCodes} codes, ${cleanedTokens} tokens`);
  }
}
