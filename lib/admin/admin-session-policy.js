/**
 * 관리 세션 정책(순수 함수)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 세션
 *   토큰과 CSRF 토큰은 32바이트 난수(base64url)이고 저장소에는 sha256 hex만 둔다. 로그인은 새 계열(family_id =
 *   첫 세션 id)을 만들고, 회전은 같은 계열과 같은 절대 만료로 새 토큰을 낸다. 절대 만료는 계열 생성 뒤 12시간,
 *   유휴 만료는 마지막 사용 뒤 30분이다. 마지막 사용 시각은 1분 간격으로만 기록한다.
 * 쿠키
 *   세션 쿠키는 HttpOnly, SameSite=Strict, Path=관리 경로, Max-Age 12시간, TLS 뒤에서만 Secure다. CSRF 쿠키는
 *   콘솔 스크립트가 읽어 헤더로 다시 보내므로 HttpOnly가 아니다.
 * CSRF
 *   GET, HEAD, OPTIONS 밖의 요청은 Origin 헤더가 반드시 있어야 하고 자기 출처(Host와 프로토콜) 또는
 *   ADMIN_ALLOWED_ORIGINS 안이어야 한다. 그리고 X-CSRF-Token 헤더와 CSRF 쿠키 값이 같고 그 해시가 세션에
 *   저장된 해시와 같아야 한다(세션에 묶인 이중 제출).
 * 마지막 owner
 *   활성 owner(전역 owner 바인딩을 가진 활성 계정)가 대상 하나뿐이면 그 계정의 삭제, 비활성화, owner 제거를
 *   거부한다. 저장소는 같은 잠금 아래에서 이 판정을 한다(AdminUserStore).
 */

import crypto from "node:crypto";

export const SESSION_ABSOLUTE_TTL_MS     = 12 * 60 * 60 * 1000;
export const SESSION_IDLE_TTL_MS         = 30 * 60 * 1000;
export const LAST_SEEN_WRITE_INTERVAL_MS = 60 * 1000;

export const USER_SESSION_COOKIE = "mmcp_admin";
export const CSRF_COOKIE         = "mmcp_csrf";
export const CSRF_HEADER         = "x-csrf-token";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * 토큰 해시(sha256 hex).
 *
 * @param {string} token
 * @returns {string}
 */
export function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

/**
 * 32바이트 난수 토큰(base64url).
 *
 * @returns {string}
 */
function randomToken() {
  return crypto.randomBytes(32).toString("base64url");
}

/**
 * 시각 값을 ms로 바꾼다.
 *
 * @param {Date|string|number} value
 * @returns {number}
 */
function ms(value) {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

/**
 * 세션 행의 상태.
 *
 * @param {{ revoked_at: Date|null, last_seen_at: Date, absolute_expires_at: Date }} session
 * @param {number} now
 * @returns {"active"|"revoked"|"expired_absolute"|"expired_idle"}
 */
export function sessionStatus(session, now) {
  if (session.revoked_at) return "revoked";
  if (now >= ms(session.absolute_expires_at)) return "expired_absolute";
  if (now >= ms(session.last_seen_at) + SESSION_IDLE_TTL_MS) return "expired_idle";
  return "active";
}

/**
 * 마지막 사용 시각을 새로 기록할 때인지 본다.
 *
 * @param {{ last_seen_at: Date }} session
 * @param {number} now
 * @returns {boolean}
 */
export function shouldTouchSession(session, now) {
  return now - ms(session.last_seen_at) >= LAST_SEEN_WRITE_INTERVAL_MS;
}

/**
 * 로그인 세션 값. 새 계열을 만든다.
 *
 * @param {{ userId: string, now: number, ip?: string|null }} args
 * @returns {{ token: string, csrf: string, row: object }}
 */
export function newSessionValues({ userId, now, ip = null }) {
  const id    = crypto.randomUUID();
  const token = randomToken();
  const csrf  = randomToken();
  return {
    token,
    csrf,
    row: {
      id,
      family_id          : id,
      user_id            : userId,
      token_hash         : hashToken(token),
      csrf_hash          : hashToken(csrf),
      created_at         : new Date(now),
      last_seen_at       : new Date(now),
      absolute_expires_at: new Date(now + SESSION_ABSOLUTE_TTL_MS),
      created_ip         : ip
    }
  };
}

/**
 * 회전 세션 값. 같은 계열, 같은 절대 만료다.
 *
 * @param {{ family_id: string, user_id: string, absolute_expires_at: Date, created_ip?: string|null }} current
 * @param {{ now: number }} args
 * @returns {{ token: string, csrf: string, row: object }}
 */
export function rotatedSessionValues(current, { now }) {
  const token = randomToken();
  const csrf  = randomToken();
  return {
    token,
    csrf,
    row: {
      id                 : crypto.randomUUID(),
      family_id          : current.family_id,
      user_id            : current.user_id,
      token_hash         : hashToken(token),
      csrf_hash          : hashToken(csrf),
      created_at         : new Date(now),
      last_seen_at       : new Date(now),
      absolute_expires_at: new Date(ms(current.absolute_expires_at)),
      created_ip         : current.created_ip ?? null
    }
  };
}

/**
 * 세션 쿠키와 CSRF 쿠키의 Set-Cookie 값.
 *
 * @param {{ token: string, csrf: string, secure: boolean, path: string }} args
 * @returns {string[]}
 */
export function sessionCookieHeaders({ token, csrf, secure, path }) {
  const tail   = `; SameSite=Strict${secure ? "; Secure" : ""}; Path=${path}; Max-Age=${SESSION_ABSOLUTE_TTL_MS / 1000}`;
  return [
    `${USER_SESSION_COOKIE}=${token}; HttpOnly${tail}`,
    `${CSRF_COOKIE}=${csrf}${tail}`
  ];
}

/**
 * 두 쿠키를 지우는 Set-Cookie 값.
 *
 * @param {{ secure: boolean, path: string }} args
 * @returns {string[]}
 */
export function clearSessionCookieHeaders({ secure, path }) {
  const tail = `; SameSite=Strict${secure ? "; Secure" : ""}; Path=${path}; Max-Age=0`;
  return [`${USER_SESSION_COOKIE}=; HttpOnly${tail}`, `${CSRF_COOKIE}=${tail}`];
}

/**
 * Cookie 헤더를 이름별 값으로 읽는다. 값 안의 = 는 그대로 둔다.
 *
 * @param {string|undefined} header
 * @returns {Record<string, string>}
 */
export function readCookies(header) {
  const out = {};
  for (const pair of String(header || "").split(";")) {
    const idx = pair.indexOf("=");
    if (idx <= 0) continue;
    const name = pair.slice(0, idx).trim();
    if (name && !Object.hasOwn(out, name)) out[name] = pair.slice(idx + 1).trim();
  }
  return out;
}

/**
 * 요청이 TLS 뒤에서 왔는지 본다(admin-auth의 마스터 쿠키와 같은 규칙).
 *
 * @param {{ headers: object, socket?: { encrypted?: boolean } }} req
 * @returns {boolean}
 */
export function isSecureRequest(req) {
  return req.headers["x-forwarded-proto"] === "https" || Boolean(req.socket?.encrypted);
}

/**
 * 비GET 요청이 받아들일 Origin 집합: 자기 출처와 ADMIN_ALLOWED_ORIGINS.
 *
 * @param {{ headers: object, socket?: object }} req
 * @param {Set<string>} allowedOrigins
 * @returns {Set<string>}
 */
export function expectedOrigins(req, allowedOrigins) {
  const out  = new Set(allowedOrigins);
  const host = req.headers.host;
  if (typeof host === "string" && host !== "") out.add(`${isSecureRequest(req) ? "https" : "http"}://${host}`);
  return out;
}

/**
 * 같은 길이의 해시 hex 두 개를 상수 시간으로 비교한다.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function sameHash(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * CSRF 판정.
 *
 * @param {{ method: string, origin?: string, allowedOrigins: Set<string>, cookieToken?: string,
 *           headerToken?: string, sessionCsrfHash: string }} args
 * @returns {{ ok: true }|{ ok: false, reason: "origin_missing"|"origin_mismatch"|"token_missing"|"token_mismatch" }}
 */
export function csrfDecision({ method, origin, allowedOrigins, cookieToken, headerToken, sessionCsrfHash }) {
  if (SAFE_METHODS.has(String(method).toUpperCase())) return { ok: true };
  if (typeof origin !== "string" || origin === "") return { ok: false, reason: "origin_missing" };
  if (!allowedOrigins.has(origin)) return { ok: false, reason: "origin_mismatch" };
  if (typeof headerToken !== "string" || headerToken === "" || typeof cookieToken !== "string" || cookieToken === "") {
    return { ok: false, reason: "token_missing" };
  }
  const headerHash = hashToken(headerToken);
  if (!sameHash(headerHash, hashToken(cookieToken)) || !sameHash(headerHash, sessionCsrfHash)) {
    return { ok: false, reason: "token_mismatch" };
  }
  return { ok: true };
}

/**
 * 바인딩 목록에 전역 owner가 있는지 본다.
 *
 * @param {Array<{ role: string, workspace: string|null }>} bindings
 * @returns {boolean}
 */
export function hasGlobalOwner(bindings) {
  return bindings.some((b) => b.role === "owner" && (b.workspace === null || b.workspace === undefined));
}

/**
 * 역할 변경이 전역 owner를 없애는지 본다.
 *
 * @param {Array<{ role: string, workspace: string|null }>} current
 * @param {Array<{ role: string, workspace: string|null }>} next
 * @returns {boolean}
 */
export function roleChangeRemovesOwner(current, next) {
  return hasGlobalOwner(current) && !hasGlobalOwner(next);
}

/**
 * 마지막 owner 보호 판정.
 *
 * @param {{ activeOwnerIds: string[], targetId: string, removesOwner: boolean }} args
 * @returns {{ ok: true }|{ ok: false, reason: "last_owner" }}
 */
export function ownerChangeDecision({ activeOwnerIds, targetId, removesOwner }) {
  if (!removesOwner || !activeOwnerIds.includes(targetId)) return { ok: true };
  return activeOwnerIds.some((id) => id !== targetId) ? { ok: true } : { ok: false, reason: "last_owner" };
}
