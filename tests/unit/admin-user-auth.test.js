/**
 * 관리자 계정 로그인, TOTP, DB 세션, CSRF 행동 시험(실제 handleAdminApi, 메모리 저장소 대역)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 저장소(AdminUserStore)만 메모리 대역으로 바꾸고 HTTP로 실제 관리 라우터를 부른다. 감사 기록기는 이벤트를 모은다.
 */

import { describe, it, before, after, beforeEach, mock } from "node:test";
import assert                                           from "node:assert/strict";
import http                                             from "node:http";
import crypto                                           from "node:crypto";

process.env.DOTENV_CONFIG_PATH      ??= ".env.test";
process.env.MEMENTO_METRICS_DEFAULT ??= "off";
process.env.REDIS_ENABLED           ??= "false";
process.env.CACHE_ENABLED           ??= "false";

const SEAL_KEY = `v1:${crypto.randomBytes(32).toString("base64")}`;

const auditEvents = [];
mock.module("../../lib/logging/audit-outbox.js", {
  exports: { recordAudit: async (event) => { auditEvents.push(event); return null; }, enqueueAudit: async () => null }
});

const realPassword = await import("../../lib/admin/admin-password.js");
const dummyCalls   = { n: 0 };
mock.module("../../lib/admin/admin-password.js", {
  namedExports: {
    ...realPassword,
    verifyAgainstDummy: async (pw) => { dummyCalls.n += 1; return realPassword.verifyAgainstDummy(pw); }
  }
});

const { handleAdminApi }               = await import("../../lib/admin/admin-routes.js");
const { ADMIN_BASE }                   = await import("../../lib/admin/admin-auth.js");
const { _setAdminUserStoreForTest }    = await import("../../lib/admin/admin-user-auth.js");
const { AdminUserStoreError }          = await import("../../lib/admin/AdminUserStore.js");
const { _resetAdminAuthGuardForTest }  = await import("../../lib/admin/admin-login-guard.js");
const { ACCESS_KEY }                   = await import("../../lib/config.js");
const { totpAt, base32Decode }         = await import("../../lib/admin/admin-totp.js");
const { hashToken, SESSION_IDLE_TTL_MS } = await import("../../lib/admin/admin-session-policy.js");

const WEAK = { ...realPassword.SCRYPT_PARAMS, ln: 10 };
const PW   = "correct horse battery staple";

/** 메모리 저장소 대역. admin-user-auth와 admin-users가 부르는 메서드만 구현한다. */
class FakeStore {
  constructor() {
    this.users    = new Map();
    this.sessions = new Map();
    this.codes    = [];
  }

  async addUser({ username, roles, status = "active" }) {
    const id = crypto.randomUUID();
    this.users.set(id, {
      id, username, username_norm: username.toLowerCase(), status, bindings: roles,
      password_hash: await realPassword.hashPassword(PW, { params: WEAK }),
      totp_secret_sealed: null, totp_enabled_at: null, totp_last_step: null,
      totp_pending_sealed: null, totp_enroll_token_hash: null, totp_enroll_expires_at: null
    });
    return id;
  }

  async countUsers() { return this.users.size; }
  async findLoginUser(norm) { return [...this.users.values()].find((u) => u.username_norm === norm) ?? null; }
  async recordLogin(id, { passwordHash }) { if (passwordHash) this.users.get(id).password_hash = passwordHash; }
  async insertSession(row) { this.sessions.set(row.id, { ...row, revoked_at: null, revoke_reason: null }); }
  async findSession(tokenHash) {
    const s = [...this.sessions.values()].find((x) => x.token_hash === tokenHash);
    if (!s) return null;
    const u = this.users.get(s.user_id);
    return { ...s, username: u.username, user_status: u.status, bindings: u.bindings };
  }
  async touchSession(id, now) { this.sessions.get(id).last_seen_at = new Date(now); }
  #revoke(pred, reason) {
    let n = 0;
    for (const s of this.sessions.values()) {
      if (!s.revoked_at && pred(s)) { s.revoked_at = new Date(); s.revoke_reason = reason; n += 1; }
    }
    return n;
  }
  async revokeSession(id, reason) { return this.#revoke((s) => s.id === id, reason); }
  async revokeFamily(familyId, reason) { return this.#revoke((s) => s.family_id === familyId, reason); }
  async revokeUserSessions(userId, reason) { return this.#revoke((s) => s.user_id === userId, reason); }
  async startTotpEnrollment(id, { pendingSealed, tokenHash, expiresAt }) {
    Object.assign(this.users.get(id), { totp_pending_sealed: pendingSealed, totp_enroll_token_hash: tokenHash, totp_enroll_expires_at: expiresAt });
  }
  async findEnrollment(tokenHash, now) {
    return [...this.users.values()].find((u) => u.totp_enroll_token_hash === tokenHash && u.totp_enroll_expires_at.getTime() > now
      && u.status === "active" && !u.totp_secret_sealed) ?? null;
  }
  async completeTotpEnrollment(id, { sealed, step, tokenHash, codeHashes }) {
    const u = this.users.get(id);
    if (u.totp_enroll_token_hash !== tokenHash) return false;
    Object.assign(u, { totp_secret_sealed: sealed, totp_enabled_at: new Date(), totp_last_step: step, totp_pending_sealed: null, totp_enroll_token_hash: null });
    this.codes = this.codes.filter((c) => c.user_id !== id).concat(codeHashes.map((h) => ({ user_id: id, code_hash: h, used_at: null })));
    return true;
  }
  async consumeTotpStep(id, step) {
    const u = this.users.get(id);
    if (u.totp_last_step !== null && u.totp_last_step >= step) return false;
    u.totp_last_step = step;
    return true;
  }
  async resealTotp() {}
  async consumeRecoveryCode(id, hash) {
    const c = this.codes.find((x) => x.user_id === id && x.code_hash === hash && !x.used_at);
    if (!c) return false;
    c.used_at = new Date();
    return true;
  }
  async listUsers() { return [...this.users.values()].map((u) => ({ id: u.id, username: u.username, roles: u.bindings })); }
  async getUser(id) { const u = this.users.get(id); return u ? { id: u.id, username: u.username, roles: u.bindings } : null; }
  async setRoles(id, bindings) {
    const u = this.users.get(id);
    if (!u) throw new AdminUserStoreError("not_found", 404);
    const before = { roles: u.bindings };
    u.bindings = bindings;
    const revokedSessions = await this.revokeUserSessions(id, "privilege_changed");
    return { before, after: { id, roles: bindings }, revokedSessions };
  }
  async deleteUser() { throw new AdminUserStoreError("last_owner", 409); }
  async bootstrapOwner() { throw new AdminUserStoreError("already_bootstrapped", 409); }
}

let server;
let base;
let origin;
let store;

before(async () => {
  server = http.createServer((req, res) => handleAdminApi(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  base   = `${origin}${ADMIN_BASE}`;
});

after(async () => {
  delete process.env.MEMENTO_ADMIN_SEAL_KEY;
  delete process.env.MEMENTO_ADMIN_USERS;
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  process.env.MEMENTO_ADMIN_SEAL_KEY = SEAL_KEY;
  delete process.env.MEMENTO_ADMIN_USERS;
  store = new FakeStore();
  _setAdminUserStoreForTest(store);
  _resetAdminAuthGuardForTest();
  auditEvents.length = 0;
  dummyCalls.n = 0;
});

/** Set-Cookie 헤더들 */
const setCookies = (res) => res.headers.getSetCookie();
/** 응답 쿠키에서 이름별 값 */
function cookieJar(res) {
  const jar = {};
  for (const c of setCookies(res)) {
    const [pair] = c.split(";");
    const idx = pair.indexOf("=");
    jar[pair.slice(0, idx)] = pair.slice(idx + 1);
  }
  return jar;
}
const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");

async function login(body, headers = {}) {
  const res  = await fetch(`${base}/auth`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const text = await res.text();
  return { res, status: res.status, body: text ? JSON.parse(text) : null, jar: cookieJar(res) };
}

async function call(path, { jar, method = "GET", headers = {}, body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(jar ? { cookie: cookieHeader(jar) } : {}), ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body   : body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  return { res, status: res.status, body: text ? JSON.parse(text) : null };
}

const csrfHeaders = (jar) => ({ origin, "x-csrf-token": jar.mmcp_csrf });

describe("스위치와 계정 0개에서 마스터 키 경로는 그대로다", () => {
  it("계정이 0개면 username JSON 로그인도 마스터 키 경로의 응답이다", async () => {
    const out = await login({ username: "nobody", password: PW });
    assert.equal(out.status, 401);
    assert.deepEqual(out.body, { error: "Invalid admin key" });
    assert.equal(dummyCalls.n, 0);
  });

  it("스위치 off면 계정이 있어도 마스터 키 경로이고 계정 라우트는 404다", async () => {
    await store.addUser({ username: "viewer1", roles: [{ role: "viewer", workspace: null }] });
    process.env.MEMENTO_ADMIN_USERS = "off";
    const out = await login({ username: "viewer1", password: PW });
    assert.deepEqual(out.body, { error: "Invalid admin key" });
    const users = await call("/admin-users", { headers: { authorization: `Bearer ${ACCESS_KEY}` } });
    assert.equal(users.status, 404);
  });

  it("마스터 키 Bearer 로그인은 마스터 세션 쿠키(SameSite=Lax)와 { ok: true }다", async () => {
    await store.addUser({ username: "viewer1", roles: [{ role: "viewer", workspace: null }] });
    const res = await fetch(`${base}/auth`, { method: "POST", headers: { authorization: `Bearer ${ACCESS_KEY}` } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.match(setCookies(res)[0], /^mmcp_session=[^;]+; HttpOnly; SameSite=Lax;/);
    const me = await call("/me", { headers: { authorization: `Bearer ${ACCESS_KEY}` } });
    assert.equal(me.body.principal.kind, "master");
  });
});

describe("계정 로그인과 세션", () => {
  it("TOTP가 필요 없는 역할은 비밀번호로 로그인하고 HttpOnly, SameSite=Strict 세션 쿠키와 CSRF 쿠키를 받는다", async () => {
    const id  = await store.addUser({ username: "Viewer1", roles: [{ role: "viewer", workspace: null }] });
    const out = await login({ username: "viewer1", password: PW });
    assert.equal(out.status, 200);
    assert.equal(out.body.user.id, id);
    const [session, csrf] = setCookies(out.res);
    assert.match(session, /^mmcp_admin=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/v1\/internal\/model\/nothing; Max-Age=43200$/);
    assert.match(csrf, /^mmcp_csrf=[A-Za-z0-9_-]{43}; SameSite=Strict; Path=/);
    const row = [...store.sessions.values()][0];
    assert.equal(row.token_hash, hashToken(out.jar.mmcp_admin));
    assert.ok(!Object.values(row).includes(out.jar.mmcp_admin));
    assert.equal(out.body.csrf, out.jar.mmcp_csrf);
    const me = await call("/me", { jar: out.jar });
    assert.equal(me.status, 200);
    assert.deepEqual(me.body.principal, { kind: "admin_session", id, roles: ["viewer"], username: "Viewer1" });
    const success = auditEvents.find((e) => e.action === "admin.auth" && e.outcome === "success");
    assert.equal(success.actor.adminUserId, id);
  });

  it("오래된 비용 매개변수의 해시는 로그인 성공 뒤 현재 기본값으로 다시 해시한다", async () => {
    const id = await store.addUser({ username: "viewer1", roles: [{ role: "viewer", workspace: null }] });
    await login({ username: "viewer1", password: PW });
    assert.match(store.users.get(id).password_hash, /^\$scrypt\$ln=15,r=8,p=1\$/);
  });

  it("없는 계정, 틀린 비밀번호, 비활성 계정은 같은 401 본문이고 없는 계정도 scrypt를 한 번 돌린다", async () => {
    await store.addUser({ username: "viewer1", roles: [{ role: "viewer", workspace: null }] });
    await store.addUser({ username: "gone", roles: [{ role: "viewer", workspace: null }], status: "disabled" });
    const unknown  = await login({ username: "nobody", password: PW });
    assert.equal(dummyCalls.n, 1);
    const wrong    = await login({ username: "viewer1", password: "wrong password here" });
    const disabled = await login({ username: "gone", password: PW });
    for (const out of [unknown, wrong, disabled]) {
      assert.equal(out.status, 401);
      assert.deepEqual(out.body, { error: "Invalid credentials" });
      assert.deepEqual(setCookies(out.res), []);
    }
    const denied = auditEvents.filter((e) => e.action === "admin.auth" && e.outcome === "denied");
    assert.equal(denied.length, 3);
    for (const e of denied) assert.ok(!JSON.stringify(e).includes("nobody") && !JSON.stringify(e).includes("wrong password"));
  });

  it("계정별 실패가 문턱을 넘으면 맞는 비밀번호도 429이고 없는 계정도 같다", async () => {
    await store.addUser({ username: "viewer1", roles: [{ role: "viewer", workspace: null }] });
    for (const name of ["viewer1", "ghost"]) {
      for (let i = 0; i < 6; i++) assert.equal((await login({ username: name, password: "wrong password here" })).status, 401);
      const blocked = await login({ username: name, password: PW });
      assert.equal(blocked.status, 429, name);
      assert.ok(Number(blocked.res.headers.get("retry-after")) >= 1);
    }
  });

  it("유휴 30분이 지난 세션은 거부한다", async () => {
    await store.addUser({ username: "viewer1", roles: [{ role: "viewer", workspace: null }] });
    const out = await login({ username: "viewer1", password: PW });
    const row = [...store.sessions.values()][0];
    row.last_seen_at = new Date(Date.now() - SESSION_IDLE_TTL_MS - 1000);
    assert.equal((await call("/me", { jar: out.jar })).status, 401);
  });

  it("회전으로 폐기된 토큰이 다시 오면 그 계열 전체를 폐기한다", async () => {
    await store.addUser({ username: "viewer1", roles: [{ role: "viewer", workspace: null }] });
    const out = await login({ username: "viewer1", password: PW });
    const old = [...store.sessions.values()][0];
    old.revoked_at = new Date();
    old.revoke_reason = "rotated";
    store.sessions.set("next", { ...old, id: "next", token_hash: "f".repeat(64), revoked_at: null, revoke_reason: null });
    assert.equal((await call("/me", { jar: out.jar })).status, 401);
    assert.equal(store.sessions.get("next").revoke_reason, "rotated_token_reused");
  });

  it("다시 로그인하면 요청에 있던 이전 세션 계열은 폐기된다", async () => {
    await store.addUser({ username: "viewer1", roles: [{ role: "viewer", workspace: null }] });
    const first  = await login({ username: "viewer1", password: PW });
    const second = await login({ username: "viewer1", password: PW }, { cookie: cookieHeader(first.jar) });
    assert.equal(second.status, 200);
    assert.equal((await call("/me", { jar: first.jar })).status, 401);
    assert.equal((await call("/me", { jar: second.jar })).status, 200);
  });
});

describe("CSRF", () => {
  async function session() {
    await store.addUser({ username: "viewer1", roles: [{ role: "viewer", workspace: null }] });
    return (await login({ username: "viewer1", password: PW })).jar;
  }

  it("비GET은 Origin이 없거나 다른 출처면 403이다", async () => {
    const jar = await session();
    const missing = await call("/auth/logout", { jar, method: "POST", headers: { "x-csrf-token": jar.mmcp_csrf } });
    assert.deepEqual([missing.status, missing.body.reason], [403, "csrf_origin_missing"]);
    const foreign = await call("/auth/logout", { jar, method: "POST", headers: { origin: "https://evil.example", "x-csrf-token": jar.mmcp_csrf } });
    assert.deepEqual([foreign.status, foreign.body.reason], [403, "csrf_origin_mismatch"]);
  });

  it("이중 제출 토큰이 없거나 세션의 토큰이 아니면 403이다", async () => {
    const jar = await session();
    const none = await call("/auth/logout", { jar, method: "POST", headers: { origin } });
    assert.deepEqual([none.status, none.body.reason], [403, "csrf_token_missing"]);
    const forged = await call("/auth/logout", { jar: { ...jar, mmcp_csrf: "forged" }, method: "POST", headers: { origin, "x-csrf-token": "forged" } });
    assert.deepEqual([forged.status, forged.body.reason], [403, "csrf_token_mismatch"]);
  });

  it("Origin과 토큰이 맞으면 로그아웃하고 그 세션은 더 쓰지 못한다", async () => {
    const jar = await session();
    const out = await call("/auth/logout", { jar, method: "POST", headers: csrfHeaders(jar) });
    assert.equal(out.status, 200);
    assert.ok(setCookies(out.res).every((c) => /Max-Age=0/.test(c)));
    assert.equal((await call("/me", { jar })).status, 401);
  });

  it("GET은 CSRF 판정 없이 통과하고 마스터 키 Bearer의 비GET은 판정하지 않는다", async () => {
    const jar = await session();
    assert.equal((await call("/me", { jar })).status, 200);
    const master = await call("/auth/logout", { method: "POST", headers: { authorization: `Bearer ${ACCESS_KEY}` } });
    assert.equal(master.status, 200);
  });
});

describe("owner와 admin의 TOTP", () => {
  async function enroll() {
    const id    = await store.addUser({ username: "owner1", roles: [{ role: "owner", workspace: null }] });
    const first = await login({ username: "owner1", password: PW });
    return { id, first };
  }

  it("등록 전 owner는 세션 없이 등록 토큰과 비밀을 받는다", async () => {
    const { first } = await enroll();
    assert.equal(first.status, 200);
    assert.equal(first.body.enrollRequired, true);
    assert.match(first.body.secret, /^[A-Z2-7]{32}$/);
    assert.match(first.body.otpauthUri, /^otpauth:\/\/totp\/AnchorMind:owner1\?/);
    assert.deepEqual(setCookies(first.res), []);
  });

  it("봉인 키가 없으면 등록을 시작하지 않는다(503)", async () => {
    delete process.env.MEMENTO_ADMIN_SEAL_KEY;
    const { id, first } = await enroll();
    assert.equal(first.status, 503);
    assert.equal(first.body.reason, "totp_seal_key_missing");
    assert.equal(store.users.get(id).totp_pending_sealed, null);
  });

  it("등록 완료는 복구 코드 10개를 한 번 싣고 세션을 만들며, 비밀은 봉인 값으로만 저장된다", async () => {
    const { id, first } = await enroll();
    const secret = base32Decode(first.body.secret);
    const bad = await call("/auth/totp", { method: "POST", body: { enrollToken: first.body.enrollToken, code: "000000" } });
    assert.equal(bad.status, 401);
    const done = await call("/auth/totp", { method: "POST", body: { enrollToken: first.body.enrollToken, code: totpAt(secret, Date.now() / 1000) } });
    assert.equal(done.status, 200);
    assert.equal(done.body.recoveryCodes.length, 10);
    assert.match(store.users.get(id).totp_secret_sealed, /^s1\.v1\./);
    assert.ok(!store.users.get(id).totp_secret_sealed.includes(first.body.secret));
    assert.ok(store.codes.every((c) => /^[0-9a-f]{64}$/.test(c.code_hash)));
    assert.equal(cookieJar(done.res).mmcp_admin.length, 43);
    const again = await call("/auth/totp", { method: "POST", body: { enrollToken: first.body.enrollToken, code: totpAt(secret, Date.now() / 1000) } });
    assert.equal(again.status, 401);
  });

  it("등록 뒤 로그인은 TOTP가 필요하고 같은 코드의 재사용과 쓴 복구 코드는 거부한다", async () => {
    const { id, first } = await enroll();
    const secret = base32Decode(first.body.secret);
    const enrolled = await call("/auth/totp", { method: "POST", body: { enrollToken: first.body.enrollToken, code: totpAt(secret, Date.now() / 1000 - 30) } });
    const codes = enrolled.body.recoveryCodes;
    assert.equal((await login({ username: "owner1", password: PW })).status, 401);
    const code = totpAt(secret, Date.now() / 1000);
    const ok   = await login({ username: "owner1", password: PW, totp: code });
    assert.equal(ok.status, 200);
    assert.equal((await login({ username: "owner1", password: PW, totp: code })).status, 401);
    assert.equal((await login({ username: "owner1", password: PW, recoveryCode: codes[0].toUpperCase() })).status, 200);
    assert.equal((await login({ username: "owner1", password: PW, recoveryCode: codes[0] })).status, 401);
    assert.equal(store.codes.filter((c) => c.user_id === id && c.used_at).length, 1);
  });
});

describe("계정 관리 라우트", () => {
  it("owner만 부르고(viewer는 403), 부트스트랩은 마스터 키 주체만 부른다", async () => {
    await store.addUser({ username: "viewer1", roles: [{ role: "viewer", workspace: null }] });
    const viewer = (await login({ username: "viewer1", password: PW })).jar;
    const list = await call("/admin-users", { jar: viewer });
    assert.deepEqual([list.status, list.body.cap], [403, "admin_user.manage"]);
    const master = await call("/admin-users", { headers: { authorization: `Bearer ${ACCESS_KEY}` } });
    assert.equal(master.status, 200);
    assert.equal(master.body.users.length, 1);
    const boot = await call("/admin-users/bootstrap", { method: "POST", headers: { authorization: `Bearer ${ACCESS_KEY}` }, body: { username: "o", password: PW } });
    assert.deepEqual([boot.status, boot.body.reason], [409, "already_bootstrapped"]);
  });

  it("계정 생성은 비밀번호 정책과 역할 형식을 검사한다", async () => {
    await store.addUser({ username: "viewer1", roles: [{ role: "viewer", workspace: null }] });
    const auth = { authorization: `Bearer ${ACCESS_KEY}` };
    const short = await call("/admin-users", { method: "POST", headers: auth, body: { username: "new1", password: "short", roles: ["viewer"] } });
    assert.deepEqual([short.status, short.body.field, short.body.reason], [400, "password", "too_short"]);
    const role = await call("/admin-users", { method: "POST", headers: auth, body: { username: "new1", password: PW, roles: ["service"] } });
    assert.deepEqual([role.status, role.body.reason], [400, "unknown_role"]);
  });

  it("마지막 owner 거절은 409 last_owner다", async () => {
    const id = await store.addUser({ username: "viewer1", roles: [{ role: "viewer", workspace: null }] });
    const out = await call(`/admin-users/${id}`, { method: "DELETE", headers: { authorization: `Bearer ${ACCESS_KEY}` } });
    assert.deepEqual([out.status, out.body.reason], [409, "last_owner"]);
  });

  it("자기 역할을 바꾸면 자기 세션이 같은 계열로 회전되고 이전 토큰은 무효다", async () => {
    const id = await store.addUser({ username: "boss", roles: [{ role: "owner", workspace: null }] });
    store.users.get(id).bindings = [{ role: "owner", workspace: null }];
    const s = await import("../../lib/admin/admin-session-policy.js");
    const values = s.newSessionValues({ userId: id, now: Date.now() });
    await store.insertSession(values.row);
    const jar = { mmcp_admin: values.token, mmcp_csrf: values.csrf };
    const out = await call(`/admin-users/${id}/roles`, { jar, method: "PUT", headers: csrfHeaders(jar), body: { roles: ["owner", "viewer"] } });
    assert.equal(out.status, 200);
    const next = cookieJar(out.res);
    assert.notEqual(next.mmcp_admin, values.token);
    assert.equal((await call("/me", { jar })).status, 401);
    const me = await call("/me", { jar: next });
    assert.equal(me.status, 200);
    assert.deepEqual(me.body.principal.roles, ["owner", "viewer"]);
    const rows = [...store.sessions.values()];
    assert.equal(new Set(rows.map((r) => r.family_id)).size, 1);
    const event = auditEvents.find((e) => e.action === "admin.user.roles_update");
    assert.equal(event.actor.adminUserId, id);
    assert.deepEqual(event.detail.after, { roles: ["owner", "viewer"] });
  });
});
