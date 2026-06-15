/**
 * 인증 로직
 *
 * 작성자: 최진호
 * 작성일: 2026-01-30
 */

import { timingSafeEqual, createHash } from "node:crypto";
import { ACCESS_KEY, AUTH_DISABLED, OAUTH_TOKEN_TTL_SECONDS, REJECT_NONAPIKEY_OAUTH } from "./config.js";
import { logWarn } from "./logger.js";
import { validateAccessToken } from "./oauth.js";
import {
  validateApiKeyFromDB,
  validateApiKeyById,
  incrementUsage
} from "./admin/ApiKeyStore.js";
import { extendOAuthToken } from "./redis.js";
import { recordAuthDenied, recordOAuthNonApiKeyRejected, recordTenantIsolationBlocked, recordOAuthBoundClientAuthenticated } from "./metrics.js";

/**
 * Authorization 헤더에서 Bearer 토큰을 추출한다.
 *
 * @param {string|undefined} authHeader - req.headers.authorization 값
 * @returns {string|null} 토큰 문자열, 또는 헤더가 없거나 Bearer 형식이 아니면 null
 */
export function extractBearerToken(authHeader) {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

/**
 * 인증 설정 해석 — 순수 함수 (테스트 가능)
 *
 * @param {string}  accessKey   - MEMENTO_ACCESS_KEY 값
 * @param {boolean} authDisabled - MEMENTO_AUTH_DISABLED=true 여부
 * @returns {{ accessKey: string, authDisabled: boolean }}
 */
export function resolveAuthConfig(accessKey, authDisabled) {
  return { accessKey, authDisabled };
}

/**
 * 단순 bearerToken 기반 인증 결정 — 순수 함수 (테스트 가능)
 *
 * OAuth/DB API 키 검증은 포함하지 않는다.
 * fail-closed 진입부와 master 키 직접 비교만 처리.
 *
 * @param {string}       accessKey    - MEMENTO_ACCESS_KEY 값
 * @param {boolean}      authDisabled - MEMENTO_AUTH_DISABLED=true 여부
 * @param {string|null}  bearerToken  - Authorization 헤더에서 추출한 토큰 (없으면 null)
 * @returns {{ valid: boolean, reason?: string, error?: string, keyId?: null, authDisabled?: boolean }}
 */
export function buildAuthDecision(accessKey, authDisabled, bearerToken) {
  /** Fail-closed: ACCESS_KEY 미설정 + AUTH_DISABLED 아님 → 거부 */
  if (!accessKey && !authDisabled) {
    return { valid: false, reason: "access_key_required", error: "access_key_required" };
  }

  /** AUTH_DISABLED opt-in: 모든 요청을 master로 허용 */
  if (!accessKey && authDisabled) {
    return { valid: true, authDisabled: true, keyId: null };
  }

  /** master 키 직접 비교 */
  if (bearerToken && safeCompare(bearerToken, accessKey)) {
    return { valid: true, keyId: null };
  }

  return { valid: false };
}

/**
 * 타이밍 안전 문자열 비교 (Timing Attack 방지)
 * SHA-256 해시 후 timingSafeEqual 비교 (length early-return 없음)
 */
export function safeCompare(a, b) {
  const hashA = createHash("sha256").update(String(a)).digest();
  const hashB = createHash("sha256").update(String(b)).digest();
  return timingSafeEqual(hashA, hashB);
}

/**
 * JSON-RPC 에러 응답 생성 (인증용)
 */
function authJsonRpcError(id, code, message) {
  return {
    jsonrpc: "2.0",
    id,
    error : { code, message }
  };
}

/**
 * initialize 요청 여부 확인
 */
export function isInitializeRequest(msg) {
  return msg && typeof msg === "object" && msg.method === "initialize";
}

/**
 * 인증 검증
 * 우선순위:
 * 1. MEMENTO_ACCESS_KEY 헤더
 * 2. Authorization: Bearer <key> 헤더 (ACCESS_KEY 또는 OAuth 토큰)
 * 3. initialize 요청의 params.accessKey
 */
export async function validateAuthentication(req, msg) {
  if (!ACCESS_KEY) {
    return { valid: true, keyId: null, groupKeyIds: null };
  }

  /** 1. MEMENTO_ACCESS_KEY 헤더 체크 */
  const legacyKey          = req.headers["memento-access-key"];

  if (legacyKey && safeCompare(legacyKey, ACCESS_KEY)) {
    return { valid: true, keyId: null, groupKeyIds: null };
  }

  /** 2. Authorization 헤더 체크 */
  const authHeader         = req.headers.authorization;

  if (authHeader) {
    const token            = extractBearerToken(authHeader);

    if (token) {

      /** ACCESS_KEY 직접 비교 */
      if (safeCompare(token, ACCESS_KEY)) {
        return { valid: true, keyId: null, groupKeyIds: null };
      }

      /** OAuth 토큰 검증 */
      const oauthResult    = await validateAccessToken(token);
      if (oauthResult.valid) {
        extendOAuthToken(token, OAUTH_TOKEN_TTL_SECONDS).catch(() => {});

        /** 1순위: bound_key_id 경로 (v2.8.4 — name-based client_id 바인딩) */
        if (oauthResult.bound_key_id) {
          try {
            const apiKeyById = await validateApiKeyById(oauthResult.bound_key_id);
            if (apiKeyById.valid) {
              incrementUsage(apiKeyById.keyId);
              recordOAuthBoundClientAuthenticated();
              return { valid: true, oauth: true, keyId: apiKeyById.keyId, groupKeyIds: apiKeyById.groupKeyIds, permissions: apiKeyById.permissions, defaultWorkspace: apiKeyById.defaultWorkspace ?? null };
            }
          } catch { /* bound_key_id 조회 실패 시 2순위로 낙하 */ }
        }

        /** 2순위: is_api_key=true + client_id가 API 키 문자열 경로 (v2.8.3 호환) */
        if (oauthResult.is_api_key) {
          try {
            const apiKeyResult = await validateApiKeyFromDB(oauthResult.client_id);
            if (apiKeyResult.valid) {
              incrementUsage(apiKeyResult.keyId);
              return { valid: true, oauth: true, keyId: apiKeyResult.keyId, groupKeyIds: apiKeyResult.groupKeyIds, permissions: apiKeyResult.permissions, defaultWorkspace: apiKeyResult.defaultWorkspace ?? null, defaultMode: apiKeyResult.defaultMode ?? null };
            }
          } catch { /* fallback to generic oauth */ }
        }

        /** 3순위: non-API-key OAuth → master 권한 취약점 차단 */
        if (REJECT_NONAPIKEY_OAUTH && ACCESS_KEY && !AUTH_DISABLED) {
          logWarn(`[Auth] Rejected non-API-key OAuth client: ${String(oauthResult.client_id || "").substring(0, 8)}***`);
          recordOAuthNonApiKeyRejected();
          recordTenantIsolationBlocked("oauth_nonapikey_denied");
          recordAuthDenied("oauth_nonapikey_denied");
          return { valid: false, error: "non-API-key OAuth denied" };
        }
        return { valid: true, oauth: true, client_id: oauthResult.client_id };
      }

      /** DB API 키 검증 (fallback — 마스터 키/OAuth 모두 실패 시) */
      try {
        const dbResult     = await validateApiKeyFromDB(token);
        if (dbResult.valid) {
          incrementUsage(dbResult.keyId);
          return { valid: true, keyId: dbResult.keyId, groupKeyIds: dbResult.groupKeyIds, permissions: dbResult.permissions, defaultWorkspace: dbResult.defaultWorkspace ?? null, defaultMode: dbResult.defaultMode ?? null };
        }
      } catch (dbErr) {
        logWarn("[Auth] DB key check error:", dbErr.message);
      }
    }
  }

  /** 3. initialize 요청의 params.accessKey 체크 */
  if (msg && isInitializeRequest(msg)) {
    const accessKey        = msg.params?.accessKey;

    if (accessKey && safeCompare(accessKey, ACCESS_KEY)) {
      return { valid: true, keyId: null, groupKeyIds: null };
    }
  }

  recordAuthDenied("invalid_key");
  return {
    valid: false,
    error: "Invalid or missing access key"
  };
}

/**
 * 마스터 키 전용 동기 검증 (admin 라우트용)
 * DB API 키는 포함하지 않음 — 환경변수 ACCESS_KEY만 허용
 *
 * @param {import('http').IncomingMessage} req
 * @returns {boolean}
 */
export function validateMasterKey(req) {
  if (!ACCESS_KEY && AUTH_DISABLED) return true;
  if (!ACCESS_KEY) return false;

  const auth           = req.headers.authorization;
  if (!auth) return false;

  const token          = extractBearerToken(auth);
  if (!token) return false;

  return safeCompare(token, ACCESS_KEY);
}

/**
 * 인증 필수 검증 (통합 헬퍼)
 * 인증 실패 시 응답 전송 및 false 반환
 */
export async function requireAuthentication(req, res, msg = null, msgId = null) {
  const authCheck          = await validateAuthentication(req, msg);

  if (!authCheck.valid) {
    const proto   = req.headers["x-forwarded-proto"] || (req.socket.encrypted ? "https" : "http");
    const baseUrl = `${proto}://${req.headers.host || "localhost:57332"}`;
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("WWW-Authenticate",
      `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`);
    res.end(JSON.stringify(authJsonRpcError(msgId, -32000, authCheck.error)));
    return false;
  }

  return true;
}
