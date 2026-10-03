/**
 * 관리자 계정 관리 라우트
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 모든 라우트는 능력 admin_user.manage(owner 전용)를 요구한다(admin-route-table.js). 비GET은 감사 이벤트를 남긴다.
 *   GET    /admin-users                     계정 목록(비밀번호 해시, TOTP 비밀 없음)
 *   POST   /admin-users/bootstrap           첫 owner 생성. 마스터 키 주체만, 계정이 0개일 때만(advisory 잠금으로 하나만 성공)
 *   POST   /admin-users                     계정 생성 { username, password, roles }
 *   PATCH  /admin-users/:id                 상태(active, disabled)와 비밀번호 변경. 세션 폐기
 *   DELETE /admin-users/:id                 계정 삭제
 *   PUT    /admin-users/:id/roles           역할 바인딩 교체. 그 계정의 세션 폐기, 자기 계정이면 자기 세션 회전
 *   POST   /admin-users/:id/totp-reset      TOTP와 복구 코드 초기화, 세션 폐기
 *   DELETE /admin-users/:id/sessions        그 계정의 모든 세션 폐기
 * 마지막 활성 owner의 삭제, 비활성화, owner 제거는 409 last_owner다. MEMENTO_ADMIN_USERS=off이면 모두 404다.
 */

import { adminUsersEnabled }        from "../config.js";
import { readJsonBody }             from "../utils.js";
import { logError }                 from "../logger.js";
import { ADMIN_BASE, safeErrorMessage } from "./admin-auth.js";
import { adminPrincipalOf }         from "./AdminAuthz.js";
import { noteAdminAudit }           from "./admin-audit-actions.js";
import { AdminUserStoreError }      from "./AdminUserStore.js";
import { adminUserStore, invalidateAdminUserCount, rotateOwnSession } from "./admin-user-auth.js";
import { checkPasswordPolicy, hashPassword, HashBusyError } from "./admin-password.js";
import { normalizeUsername, normalizeRoleBindings, AdminUserInputError } from "./admin-user-rules.js";

/** 400 입력 오류 */
class BadRequest extends Error {
  /**
   * @param {string} field
   * @param {string} reason
   */
  constructor(field, reason) {
    super(reason);
    this.field  = field;
    this.reason = reason;
  }
}

function send(res, status, body) {
  res.statusCode = status;
  res.end(JSON.stringify(body));
}

/** 감사 detail에 싣는 역할 목록(문자열 배열) */
const roleLabels = (roles) => roles.map((b) => (b.workspace ? `${b.role}@${b.workspace}` : b.role));

/**
 * 비밀번호 정책을 통과한 비밀번호의 해시.
 *
 * @param {unknown} password
 * @returns {Promise<string>}
 */
async function policyHash(password) {
  const policy = checkPasswordPolicy(password);
  if (!policy.ok) throw new BadRequest("password", policy.reason);
  return hashPassword(password);
}

/**
 * 요청 본문(객체).
 */
async function bodyOf(req) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    throw new BadRequest("body", err.statusCode === 413 ? "too_large" : "invalid_json");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new BadRequest("body", "json_object_required");
  return body;
}

/**
 * 자기 계정에 대한 권한 변경이면 자기 세션을 회전한다.
 */
async function rotateIfSelf(req, res, userId) {
  const principal = adminPrincipalOf(req);
  if (principal?.kind === "admin_session" && principal.id === userId) await rotateOwnSession(req, res, principal);
}

async function listUsers(req, res) {
  send(res, 200, { users: await adminUserStore().listUsers() });
}

async function bootstrapOwner(req, res) {
  if (adminPrincipalOf(req)?.kind !== "master") return send(res, 403, { error: "Forbidden", reason: "master_key_required" });
  const body = await bodyOf(req);
  const name = normalizeUsername(body.username);
  const user = await adminUserStore().bootstrapOwner({
    username: name.username, norm: name.norm, passwordHash: await policyHash(body.password), createdBy: "master"
  });
  invalidateAdminUserCount();
  noteAdminAudit(res, { targetId: user.id, detail: { roles: ["owner"] } });
  return send(res, 201, { user });
}

async function createUser(req, res) {
  const body     = await bodyOf(req);
  const name     = normalizeUsername(body.username);
  const bindings = normalizeRoleBindings(body.roles);
  const actor    = adminPrincipalOf(req);
  const user     = await adminUserStore().createUser({
    username: name.username, norm: name.norm, passwordHash: await policyHash(body.password), bindings, createdBy: actor?.id ?? null
  });
  invalidateAdminUserCount();
  noteAdminAudit(res, { targetId: user.id, detail: { roles: roleLabels(bindings) } });
  return send(res, 201, { user });
}

async function updateUser(req, res, m) {
  const body   = await bodyOf(req);
  const status = body.status === undefined ? undefined : body.status;
  if (status !== undefined && status !== "active" && status !== "disabled") throw new BadRequest("status", "active_or_disabled");
  if (status === undefined && body.password === undefined) throw new BadRequest("body", "status_or_password_required");
  const passwordHash = body.password === undefined ? undefined : await policyHash(body.password);
  const result = await adminUserStore().updateUser(m[1], { status, passwordHash });
  if (passwordHash) await rotateIfSelf(req, res, m[1]);
  noteAdminAudit(res, { detail: {
    before: { status: result.before.status }, after: { status: result.after.status },
    pwChanged: Boolean(passwordHash), revokedSessions: result.revokedSessions
  } });
  return send(res, 200, { user: result.after, revokedSessions: result.revokedSessions });
}

async function deleteUser(req, res, m) {
  const result = await adminUserStore().deleteUser(m[1]);
  invalidateAdminUserCount();
  noteAdminAudit(res, { detail: { roles: roleLabels(result.before.roles) } });
  return send(res, 200, { deleted: true, id: m[1] });
}

async function setRoles(req, res, m) {
  const body     = await bodyOf(req);
  const bindings = normalizeRoleBindings(body.roles);
  const result   = await adminUserStore().setRoles(m[1], bindings, { createdBy: adminPrincipalOf(req)?.id ?? null });
  await rotateIfSelf(req, res, m[1]);
  noteAdminAudit(res, { detail: {
    before: { roles: roleLabels(result.before.roles) }, after: { roles: roleLabels(result.after.roles) },
    revokedSessions: result.revokedSessions
  } });
  return send(res, 200, { user: result.after, revokedSessions: result.revokedSessions });
}

async function resetTotp(req, res, m) {
  if (!(await adminUserStore().resetTotp(m[1]))) throw new AdminUserStoreError("not_found", 404);
  const revoked = await adminUserStore().revokeUserSessions(m[1], "totp_reset");
  noteAdminAudit(res, { detail: { revokedSessions: revoked } });
  return send(res, 200, { reset: true, revokedSessions: revoked });
}

async function revokeSessions(req, res, m) {
  if (!(await adminUserStore().getUser(m[1]))) throw new AdminUserStoreError("not_found", 404);
  const revoked = await adminUserStore().revokeUserSessions(m[1], "admin_revoked");
  noteAdminAudit(res, { detail: { revokedSessions: revoked } });
  return send(res, 200, { revokedSessions: revoked });
}

const exact = (path) => (pathname) => (pathname === path ? [] : null);
const regex = (re)   => (pathname) => pathname.match(re);

/** 라우트 표. 구체 경로가 변수 경로보다 앞에 온다. */
const ROUTES = [
  { method: "GET",    match: exact(`${ADMIN_BASE}/admin-users`),                                              handler: listUsers },
  { method: "POST",   match: exact(`${ADMIN_BASE}/admin-users/bootstrap`),                                    handler: bootstrapOwner },
  { method: "POST",   match: exact(`${ADMIN_BASE}/admin-users`),                                              handler: createUser },
  { method: "PUT",    match: regex(new RegExp(`^${ADMIN_BASE}/admin-users/([0-9a-f-]{36})/roles$`)),          handler: setRoles },
  { method: "POST",   match: regex(new RegExp(`^${ADMIN_BASE}/admin-users/([0-9a-f-]{36})/totp-reset$`)),     handler: resetTotp },
  { method: "DELETE", match: regex(new RegExp(`^${ADMIN_BASE}/admin-users/([0-9a-f-]{36})/sessions$`)),       handler: revokeSessions },
  { method: "PATCH",  match: regex(new RegExp(`^${ADMIN_BASE}/admin-users/([0-9a-f-]{36})$`)),                handler: updateUser },
  { method: "DELETE", match: regex(new RegExp(`^${ADMIN_BASE}/admin-users/([0-9a-f-]{36})$`)),                handler: deleteUser }
];

/**
 * 오류를 응답으로 바꾼다.
 */
function sendError(res, err) {
  if (err instanceof BadRequest || err instanceof AdminUserInputError) {
    return send(res, 400, { error: "Bad Request", field: err.field, reason: err.reason });
  }
  if (err instanceof AdminUserStoreError) return send(res, err.status, { error: err.status === 404 ? "Not found" : "Conflict", reason: err.code });
  if (err instanceof HashBusyError) {
    res.setHeader("Retry-After", "1");
    return send(res, 503, { error: "Service Unavailable" });
  }
  logError("[Admin] admin user route error:", err);
  return send(res, 500, { error: safeErrorMessage(err) });
}

/**
 * /admin-users 라우트를 표에서 찾아 위임한다.
 *
 * @returns {Promise<boolean>} 처리 여부
 */
export async function handleAdminUsers(req, res, url) {
  const route = ROUTES.find((r) => r.method === req.method && r.match(url.pathname));
  if (!route) return false;
  if (!adminUsersEnabled()) {
    send(res, 404, { error: "Not found" });
    return true;
  }
  try {
    await route.handler(req, res, route.match(url.pathname));
  } catch (err) {
    sendError(res, err);
  }
  return true;
}
