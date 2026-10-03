/**
 * 관리 API 요청 주체 해석
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 마스터 키 Bearer와 마스터 키 로그인 세션 쿠키는 owner 주체다(admin-auth.validateAdminAccess, 인증 방식은 그대로).
 * 자기 정보 라우트(라우트 표의 인증 표지 항목, GET /me와 GET /me/explain)에 한해 Bearer를 활성 API 키로도 해석해
 * API 키 주체(service)를 만든다. 그 밖의 관리 라우트에서 API 키는 주체가 되지 않는다.
 *
 * 자기 정보 라우트의 Bearer 처리 순서
 *   1. 관리 인증 지연(admin-login-guard) 중이면 키 조회 없이 null(호출자가 429로 응답한다).
 *   2. 토큰이 마스터 키든 아니든 API 키 조회를 한 번 한다. 마스터 키 여부에 따라 저장소 왕복 수가 달라지지 않는다.
 *   3. 마스터 키면 owner, 활성 API 키면 service, 그 밖은 다른 관리 라우트와 같이 실패로 기록하고 null이다.
 * 해석하지 못하면 null이며 호출자가 401 또는 429로 응답한다.
 *
 * Bearer가 없는 요청은 유효한 마스터 키 로그인 세션 쿠키가 있으면 owner, 없고 관리자 계정 세션 쿠키가 있으면
 * 그 세션의 계정 주체(admin_session, admin-user-auth.resolveUserSessionPrincipal)다.
 */

import { validateAdminAccess, hasValidMasterCookie } from "./admin-auth.js";
import { resolveUserSessionPrincipal }             from "./admin-user-auth.js";
import { checkAdminAuthAttempt }                   from "./admin-login-guard.js";
import { validateMasterKey, extractBearerToken }   from "../auth.js";
import {
  validateApiKeyFromDB,
  getAllowedWorkspaces,
  WORKSPACE_LOOKUP_FAILED
} from "./ApiKeyStore.js";
import { findAdminRoute }                          from "./admin-route-table.js";
import { CAP_AUTHENTICATED }                       from "./capabilities.js";
import { masterPrincipal, apiKeyPrincipal }        from "./AdminAuthz.js";
import { logWarn }                                 from "../logger.js";

/**
 * 자기 정보 라우트인지 본다.
 *
 * @param {string} method
 * @param {string} subPath
 * @returns {boolean}
 */
function isSelfRoute(method, subPath) {
  return findAdminRoute(method, subPath)?.entry.cap === CAP_AUTHENTICATED;
}

/**
 * Bearer 토큰을 활성 API 키로 해석한다. 키가 아니거나 조회에 실패하면 null이다.
 * allowed_workspaces 조회에 실패하면 빈 목록(어떤 workspace도 범위 밖)으로 둔다.
 *
 * @param {string} token
 * @returns {Promise<object|null>}
 */
async function apiKeyPrincipalFromToken(token) {
  let key;
  try {
    key = await validateApiKeyFromDB(token);
  } catch (err) {
    logWarn(`[AdminPrincipal] API key lookup failed: ${err.message}`);
    return null;
  }
  if (!key?.valid) return null;
  const allowed = await getAllowedWorkspaces(key.keyId);
  return apiKeyPrincipal({
    keyId            : key.keyId,
    permissions      : key.permissions,
    allowedWorkspaces: allowed === WORKSPACE_LOOKUP_FAILED ? [] : allowed
  });
}

/**
 * 관리 API 요청의 주체를 해석한다.
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {string} subPath ADMIN_BASE를 뺀 경로
 * @returns {Promise<object|null>}
 */
export async function resolveAdminPrincipal(req, subPath) {
  const token = extractBearerToken(req.headers.authorization);
  if (!token && !hasValidMasterCookie(req)) {
    const userPrincipal = await resolveUserSessionPrincipal(req);
    if (userPrincipal) return userPrincipal;
  }
  if (!token || !isSelfRoute(req.method, subPath)) return validateAdminAccess(req) ? masterPrincipal() : null;
  if (!checkAdminAuthAttempt().allowed) return null;
  const keyPrincipal = await apiKeyPrincipalFromToken(token);
  if (keyPrincipal && !validateMasterKey(req)) return keyPrincipal;
  return validateAdminAccess(req) ? masterPrincipal() : null;
}
