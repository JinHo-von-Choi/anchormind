/**
 * 관리자 계정 로그인, TOTP 등록, DB 세션, CSRF 집행
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * MEMENTO_ADMIN_USERS=on이고 관리자 계정이 하나 이상 있을 때만 동작한다. 그 밖에는 마스터 키 경로(admin-auth.js)만
 * 쓰이고 이 모듈은 요청을 건드리지 않는다.
 *
 * 로그인(POST /auth, Authorization 없는 JSON 본문 { username, password, totp | recoveryCode })
 *   1. 클라이언트 주소와 계정(이름 해시)별 실패 지연 중이면 429. 없는 계정도 같은 계수를 쓴다.
 *   2. 계정이 없으면 같은 비용의 scrypt를 한 번 돌리고(verifyAgainstDummy) 같은 401을 돌려준다.
 *   3. 비밀번호가 맞고 TOTP가 등록돼 있으면 TOTP 코드(앞뒤 한 단계, 받은 단계보다 큰 단계만) 또는 복구 코드 하나를 요구한다.
 *      owner나 admin 역할인데 등록 전이면 세션 없이 등록 토큰과 비밀을 돌려준다(봉인 키가 없으면 503).
 *   4. 성공하면 새 세션 계열을 만들고(요청에 이전 계정 세션 쿠키가 있으면 그 계열은 폐기) 쿠키 둘을 싣는다.
 *   실패 응답은 원인과 관계없이 같은 401 본문이다.
 * TOTP 등록 완료(POST /auth/totp { enrollToken, code }): 코드가 맞으면 봉인 비밀을 옮기고 복구 코드 10개를 한 번만
 *   응답에 싣고 세션을 만든다.
 * 세션(쿠키 mmcp_admin): 토큰 해시로 찾고 만료(절대 12시간, 유휴 30분)와 폐기, 계정 상태를 본다. 회전으로 폐기된
 *   토큰이 다시 오면 그 계열 전체를 폐기한다. 주체는 kind admin_session, 바인딩은 admin_role_bindings다.
 * CSRF: 계정 세션 주체의 비GET 요청은 Origin 필수 검사와 세션에 묶인 이중 제출 토큰을 통과해야 한다.
 */

import crypto from "node:crypto";

import { adminUsersEnabled, adminSealKeyRing, ADMIN_ALLOWED_ORIGINS } from "../config.js";
import { readJsonBody, resolveClientIp } from "../http/helpers.js";
import { logWarn, logError } from "../logger.js";
import { getPrimaryPool } from "../tools/db.js";
import { ADMIN_BASE, handleAuth, auditAdminAuth, adminUserAuditActor } from "./admin-auth.js";
import { AdminUserStore } from "./AdminUserStore.js";
import { ADMIN_TOTP_ENROLL_ACTION } from "./admin-route-table.js";
import { adminPrincipalOf } from "./AdminAuthz.js";
import { createKeyedLoginGuard } from "./admin-login-guard.js";
import { verifyPassword, verifyAgainstDummy, needsRehash, hashPassword, HashBusyError, PASSWORD_MAX_LENGTH } from "./admin-password.js";
import { verifyTotp, generateTotpSecret, otpauthUri, base32Encode } from "./admin-totp.js";
import { sealSecret, unsealSecret, needsReseal, SealError } from "./admin-seal.js";
import {
  USER_SESSION_COOKIE, CSRF_COOKIE, CSRF_HEADER, hashToken, sessionStatus, shouldTouchSession, newSessionValues,
  rotatedSessionValues, sessionCookieHeaders, clearSessionCookieHeaders, readCookies, isSecureRequest, csrfDecision,
  expectedOrigins
} from "./admin-session-policy.js";
import {
  loginUsernameNorm, requiresTotp, totpSealAad, generateRecoveryCodes, normalizeRecoveryCode, recoveryCodeHash,
  accountGuardKey
} from "./admin-user-rules.js";

export const TOTP_ISSUER          = "AnchorMind";
export const ENROLL_TTL_MS        = 10 * 60 * 1000;
export const USER_COUNT_CACHE_MS  = 5_000;
export const IP_FAILURE_THRESHOLD = 20;

const LOGIN_BODY_MAX = 8 * 1024;

const accountGuard = createKeyedLoginGuard();
const ipGuard      = createKeyedLoginGuard({ threshold: IP_FAILURE_THRESHOLD });

let store     = null;
let userCount = { value: 0, at: -Infinity };

/**
 * 관리자 계정 저장소(주 풀).
 *
 * @returns {AdminUserStore}
 */
export function adminUserStore() {
  store ??= new AdminUserStore(getPrimaryPool());
  return store;
}

/** 시험 전용: 저장소 교체와 상태 초기화 */
export function _setAdminUserStoreForTest(next) {
  store     = next;
  userCount = { value: 0, at: -Infinity };
  accountGuard.reset();
  ipGuard.reset();
}

/** 계정 수 캐시를 비운다(계정 생성, 삭제 뒤). */
export function invalidateAdminUserCount() {
  userCount = { value: 0, at: -Infinity };
}

/**
 * 관리자 계정 경로가 켜져 있는지 본다: 스위치 on이고 계정이 하나 이상. 계정 수는 5초 캐시한다.
 * 계정 수를 읽지 못하면 false(마스터 키 경로만)다.
 *
 * @param {number} [now]
 * @returns {Promise<boolean>}
 */
export async function adminUsersActive(now = Date.now()) {
  if (!adminUsersEnabled()) return false;
  if (now - userCount.at < USER_COUNT_CACHE_MS) return userCount.value > 0;
  try {
    userCount = { value: await adminUserStore().countUsers(), at: now };
  } catch (err) {
    logWarn(`[AdminUsers] user count unavailable: ${err.message}`);
    return false;
  }
  return userCount.value > 0;
}

/**
 * JSON 응답.
 */
function sendJson(res, status, body, headers = {}) {
  res.statusCode = status;
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}

const invalidCredentials = (res) => sendJson(res, 401, { error: "Invalid credentials" });

/**
 * 계정 세션 쿠키를 싣는다.
 */
function setSessionCookies(req, res, { token, csrf }) {
  res.setHeader("Set-Cookie", sessionCookieHeaders({ token, csrf, secure: isSecureRequest(req), path: ADMIN_BASE }));
}

/**
 * 새 세션 계열을 만들고 쿠키를 싣는다. 요청에 이전 계정 세션이 있으면 그 계열을 폐기한다.
 *
 * @returns {Promise<{ csrf: string }>}
 */
async function issueSession(req, res, userId, now = Date.now()) {
  const previous = readCookies(req.headers.cookie)[USER_SESSION_COOKIE];
  if (previous) {
    const old = await adminUserStore().findSession(hashToken(previous));
    if (old) await adminUserStore().revokeFamily(old.family_id, "replaced_by_login");
  }
  const values = newSessionValues({ userId, now, ip: resolveClientIp(req) });
  await adminUserStore().insertSession(values.row);
  setSessionCookies(req, res, values);
  return { csrf: values.csrf };
}

/**
 * 로그인 실패를 기록하고 401로 응답한다.
 */
function failLogin(req, res, keys) {
  accountGuard.recordFailure(keys.account);
  ipGuard.recordFailure(keys.ip);
  auditAdminAuth(false, "password", { keyId: "unknown", clientIp: keys.ip });
  invalidCredentials(res);
}

/**
 * 두 지연 판정기 가운데 하나라도 지연 중이면 429로 응답하고 true다.
 */
function throttled(res, keys) {
  const a = ipGuard.check(keys.ip);
  const b = keys.account ? accountGuard.check(keys.account) : { allowed: true, retryAfterSec: 0 };
  if (a.allowed && b.allowed) return false;
  sendJson(res, 429, { error: "Too Many Requests" }, { "Retry-After": String(Math.max(a.retryAfterSec, b.retryAfterSec)) });
  return true;
}

/**
 * 비밀번호를 확인한다. 없는 계정은 같은 비용의 검증을 돌린다.
 *
 * @returns {Promise<boolean>}
 */
async function passwordMatches(user, password) {
  if (typeof password !== "string" || password.length > PASSWORD_MAX_LENGTH * 4) {
    await verifyAgainstDummy("x".repeat(16));
    return false;
  }
  if (!user) return verifyAgainstDummy(password);
  return verifyPassword(password, user.password_hash);
}

/**
 * 등록된 계정의 두 번째 요소(TOTP 코드 또는 복구 코드)를 확인한다.
 *
 * @returns {Promise<"ok"|"fail"|"unavailable">}
 */
async function secondFactor(user, body, now) {
  const recovery = normalizeRecoveryCode(body.recoveryCode);
  if (recovery) return (await adminUserStore().consumeRecoveryCode(user.id, recoveryCodeHash(user.id, recovery))) ? "ok" : "fail";
  const ring   = adminSealKeyRing();
  const secret = ring ? unsealOrNull(ring, user.totp_secret_sealed, user.id) : null;
  if (!secret) return "unavailable";
  const checked = verifyTotp(secret, body.totp, { nowSec: now / 1000, lastStep: user.totp_last_step });
  if (!checked.ok || !(await adminUserStore().consumeTotpStep(user.id, checked.step))) return "fail";
  if (needsReseal(ring, user.totp_secret_sealed)) {
    await adminUserStore().resealTotp(user.id, user.totp_secret_sealed, sealSecret(ring, secret, totpSealAad(user.id)));
  }
  return "ok";
}

/**
 * 봉인 비밀을 푼다. 키 목록에 없는 키이거나 값이 맞지 않으면 경고를 남기고 null이다.
 *
 * @returns {Buffer|null}
 */
function unsealOrNull(ring, sealed, userId) {
  try {
    return unsealSecret(ring, sealed, totpSealAad(userId));
  } catch (err) {
    if (!(err instanceof SealError)) throw err;
    logWarn(`[AdminUsers] TOTP secret not usable for user ${userId}: ${err.reason}`);
    return null;
  }
}

/**
 * TOTP 등록을 시작하고 등록 토큰과 비밀을 응답한다.
 */
async function startEnrollment(res, user, now) {
  const ring = adminSealKeyRing();
  if (!ring) return sendJson(res, 503, { error: "Service Unavailable", reason: "totp_seal_key_missing" });
  const secret = generateTotpSecret();
  const token  = crypto.randomBytes(32).toString("base64url");
  await adminUserStore().startTotpEnrollment(user.id, {
    pendingSealed: sealSecret(ring, secret, totpSealAad(user.id)),
    tokenHash    : hashToken(token),
    expiresAt    : new Date(now + ENROLL_TTL_MS)
  });
  return sendJson(res, 200, {
    enrollRequired: true,
    enrollToken   : token,
    secret        : base32Encode(secret),
    otpauthUri    : otpauthUri({ issuer: TOTP_ISSUER, account: user.username, secret }),
    expiresInSec  : ENROLL_TTL_MS / 1000
  });
}

/**
 * 비밀번호가 맞은 뒤의 처리: 두 번째 요소, 등록 요구, 세션 발급.
 */
async function completeLogin(req, res, user, body, keys, now) {
  if (user.totp_secret_sealed) {
    const factor = await secondFactor(user, body, now);
    if (factor === "unavailable") return sendJson(res, 503, { error: "Service Unavailable", reason: "totp_seal_key_missing" });
    if (factor === "fail") return failLogin(req, res, keys);
  } else if (requiresTotp(user.bindings)) {
    return startEnrollment(res, user, now);
  }
  accountGuard.recordSuccess(keys.account);
  const rehash = needsRehash(user.password_hash) ? await hashPassword(body.password) : null;
  await adminUserStore().recordLogin(user.id, { passwordHash: rehash });
  const { csrf } = await issueSession(req, res, user.id, now);
  auditAdminAuth(true, "password", adminUserAuditActor(req, { id: user.id }));
  return sendJson(res, 200, { ok: true, user: { id: user.id, username: user.username }, csrf });
}

/**
 * 계정 로그인.
 *
 * @param {object} req
 * @param {import("node:http").ServerResponse} res
 * @param {{ username: string, password: string, totp?: string, recoveryCode?: string }} body
 * @param {number} [now]
 */
export async function handleUserLogin(req, res, body, now = Date.now()) {
  const norm = loginUsernameNorm(body.username);
  const keys = { ip: resolveClientIp(req), account: accountGuardKey(norm ?? String(body.username).slice(0, 64).toLowerCase()) };
  if (throttled(res, keys)) return;
  try {
    const user = norm ? await adminUserStore().findLoginUser(norm) : null;
    const ok   = await passwordMatches(user, body.password);
    if (!user || !ok || user.status !== "active") return failLogin(req, res, keys);
    return await completeLogin(req, res, user, body, keys, now);
  } catch (err) {
    if (err instanceof HashBusyError) return sendJson(res, 503, { error: "Service Unavailable" }, { "Retry-After": "1" });
    throw err;
  }
}

/**
 * Origin 헤더가 있으면 허용 출처여야 한다(로그인 요청).
 */
function loginOriginAllowed(req) {
  const origin = req.headers.origin;
  return typeof origin !== "string" || expectedOrigins(req, ADMIN_ALLOWED_ORIGINS).has(origin);
}

/**
 * POST /auth 진입. 관리자 계정 경로가 켜져 있고 Authorization 없는 JSON 본문에 username이 있으면 계정 로그인,
 * 그 밖에는 마스터 키 로그인(admin-auth.handleAuth)이다.
 *
 * @param {object} req
 * @param {import("node:http").ServerResponse} res
 */
export async function handleAuthEntry(req, res) {
  const isJson = (req.headers["content-type"] || "").includes("application/json");
  if (req.headers.authorization || !isJson || !(await adminUsersActive())) return handleAuth(req, res);
  let body;
  try {
    body = await readJsonBody(req, LOGIN_BODY_MAX);
  } catch (err) {
    return sendJson(res, err.statusCode === 413 ? 413 : 400, { error: err.statusCode === 413 ? "Payload too large" : "Invalid JSON" });
  }
  if (!body || typeof body !== "object" || typeof body.username !== "string") return handleAuth(req, res);
  if (!loginOriginAllowed(req)) return sendJson(res, 403, { error: "Forbidden", reason: "csrf_origin_mismatch" });
  try {
    return await handleUserLogin(req, res, body);
  } catch (err) {
    logError("[AdminUsers] login failed:", err);
    return sendJson(res, 500, { error: "Internal error" });
  }
}

/**
 * 등록 완료 요청 본문. 읽지 못하면 경고를 남기고 null이다.
 *
 * @returns {Promise<object|null>}
 */
async function readEnrollBody(req) {
  try {
    return await readJsonBody(req, LOGIN_BODY_MAX);
  } catch (err) {
    logWarn(`[AdminUsers] TOTP enrollment body not readable: ${err.message}`);
    return null;
  }
}

/**
 * TOTP 등록 실패를 기록하고 401로 응답한다.
 */
function failEnrollment(res, keys) {
  ipGuard.recordFailure(keys.ip);
  auditAdminAuth(false, "totp_enroll", { keyId: "unknown", clientIp: keys.ip }, ADMIN_TOTP_ENROLL_ACTION);
  invalidCredentials(res);
}

/**
 * POST /auth/totp: TOTP 등록 완료.
 *
 * @param {object} req
 * @param {import("node:http").ServerResponse} res
 * @param {number} [now]
 */
export async function handleTotpEnroll(req, res, now = Date.now()) {
  const keys = { ip: resolveClientIp(req), account: null };
  if (!(await adminUsersActive()) || !loginOriginAllowed(req)) return sendJson(res, 404, { error: "Not found" });
  if (throttled(res, keys)) return;
  const body = await readEnrollBody(req);
  const ring = adminSealKeyRing();
  const user = typeof body?.enrollToken === "string" ? await adminUserStore().findEnrollment(hashToken(body.enrollToken), now) : null;
  if (!ring || !user) return failEnrollment(res, keys);
  const secret  = unsealOrNull(ring, user.totp_pending_sealed, user.id);
  const checked = secret ? verifyTotp(secret, body.code, { nowSec: now / 1000 }) : { ok: false };
  const codes   = generateRecoveryCodes();
  const done    = checked.ok && await adminUserStore().completeTotpEnrollment(user.id, {
    sealed    : sealSecret(ring, secret, totpSealAad(user.id)),
    step      : checked.step,
    tokenHash : hashToken(body.enrollToken),
    codeHashes: codes.map((c) => recoveryCodeHash(user.id, normalizeRecoveryCode(c)))
  });
  if (!done) return failEnrollment(res, keys);
  const { csrf } = await issueSession(req, res, user.id, now);
  auditAdminAuth(true, "totp_enroll", adminUserAuditActor(req, { id: user.id }), ADMIN_TOTP_ENROLL_ACTION);
  return sendJson(res, 200, { ok: true, user: { id: user.id, username: user.username }, csrf, recoveryCodes: codes });
}

/**
 * 요청의 계정 세션 쿠키를 주체로 해석한다. 쿠키가 없거나 무효면 null이다.
 *
 * @param {object} req
 * @param {number} [now]
 * @returns {Promise<object|null>}
 */
export async function resolveUserSessionPrincipal(req, now = Date.now()) {
  const token = readCookies(req.headers.cookie)[USER_SESSION_COOKIE];
  if (!token || !adminUsersEnabled()) return null;
  const session = await adminUserStore().findSession(hashToken(token));
  if (!session) return null;
  const status = sessionStatus(session, now);
  if (status === "revoked" && session.revoke_reason === "rotated") {
    await adminUserStore().revokeFamily(session.family_id, "rotated_token_reused");
    logWarn(`[AdminUsers] rotated session token reused; family revoked (user ${session.user_id})`);
  }
  if (status !== "active" || session.user_status !== "active") return null;
  if (shouldTouchSession(session, now)) await adminUserStore().touchSession(session.id, now);
  return {
    kind    : "admin_session",
    id      : session.user_id,
    username: session.username,
    bindings: Array.isArray(session.bindings) ? session.bindings : [],
    deny    : [],
    session : {
      id               : session.id,
      familyId         : session.family_id,
      csrfHash         : session.csrf_hash,
      absoluteExpiresAt: session.absolute_expires_at,
      createdIp        : session.created_ip ?? null
    }
  };
}

/**
 * 계정 세션 주체의 비GET 요청에 CSRF 판정을 건다. 거부면 403을 쓰고 false다. 다른 주체는 그대로 true다.
 *
 * @param {object} req
 * @param {import("node:http").ServerResponse} res
 * @param {object} principal
 * @returns {boolean}
 */
export function enforceUserCsrf(req, res, principal) {
  if (principal?.kind !== "admin_session") return true;
  const cookies  = readCookies(req.headers.cookie);
  const decision = csrfDecision({
    method         : req.method,
    origin         : req.headers.origin,
    allowedOrigins : expectedOrigins(req, ADMIN_ALLOWED_ORIGINS),
    cookieToken    : cookies[CSRF_COOKIE],
    headerToken    : req.headers[CSRF_HEADER],
    sessionCsrfHash: principal.session.csrfHash
  });
  if (decision.ok) return true;
  sendJson(res, 403, { error: "Forbidden", reason: `csrf_${decision.reason}` });
  return false;
}

/**
 * 자기 세션을 회전한다(권한 변경 뒤). 같은 계열, 같은 절대 만료로 새 행을 넣고 쿠키를 바꾼다.
 *
 * @param {object} req
 * @param {import("node:http").ServerResponse} res
 * @param {object} principal admin_session 주체
 * @param {number} [now]
 */
export async function rotateOwnSession(req, res, principal, now = Date.now()) {
  const current = {
    family_id          : principal.session.familyId,
    user_id            : principal.id,
    absolute_expires_at: principal.session.absoluteExpiresAt,
    created_ip         : principal.session.createdIp
  };
  const values = rotatedSessionValues(current, { now });
  await adminUserStore().revokeSession(principal.session.id, "rotated");
  await adminUserStore().insertSession(values.row);
  setSessionCookies(req, res, values);
}

/**
 * POST /auth/logout. 계정 세션이면 그 계열을 폐기하고 쿠키를 지운다. 다른 주체는 바꾸는 것 없이 200이다.
 *
 * @param {object} req
 * @param {import("node:http").ServerResponse} res
 * @param {URL} url
 * @returns {Promise<boolean>} 처리 여부
 */
export async function handleAuthLogout(req, res, url) {
  if (req.method !== "POST" || url.pathname !== `${ADMIN_BASE}/auth/logout`) return false;
  const principal = adminPrincipalOf(req);
  if (principal?.kind === "admin_session") {
    await adminUserStore().revokeFamily(principal.session.familyId, "logout");
    res.setHeader("Set-Cookie", clearSessionCookieHeaders({ secure: isSecureRequest(req), path: ADMIN_BASE }));
  }
  sendJson(res, 200, { ok: true });
  return true;
}
