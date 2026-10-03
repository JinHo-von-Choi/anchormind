/**
 * 관리 세션 만료와 회전, 쿠키 속성, CSRF 판정, 마지막 owner 보호 순수 시험.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */
import { describe, it } from "node:test";
import assert           from "node:assert/strict";

const {
  SESSION_ABSOLUTE_TTL_MS, SESSION_IDLE_TTL_MS, LAST_SEEN_WRITE_INTERVAL_MS,
  sessionStatus, shouldTouchSession, newSessionValues, rotatedSessionValues, hashToken,
  sessionCookieHeaders, clearSessionCookieHeaders, readCookies, USER_SESSION_COOKIE, CSRF_COOKIE,
  csrfDecision, expectedOrigins, ownerChangeDecision, roleChangeRemovesOwner
} = await import("../../lib/admin/admin-session-policy.js");

const T0 = Date.parse("2026-10-03T00:00:00Z");

function row(overrides = {}) {
  return {
    created_at         : new Date(T0),
    last_seen_at       : new Date(T0),
    absolute_expires_at: new Date(T0 + SESSION_ABSOLUTE_TTL_MS),
    revoked_at         : null,
    ...overrides
  };
}

describe("세션 만료", () => {
  it("절대 12시간, 유휴 30분이다", () => {
    assert.equal(SESSION_ABSOLUTE_TTL_MS, 12 * 3600 * 1000);
    assert.equal(SESSION_IDLE_TTL_MS, 30 * 60 * 1000);
  });

  it("유휴 30분 안에 쓰이면 계속 유효하다", () => {
    assert.equal(sessionStatus(row(), T0 + SESSION_IDLE_TTL_MS - 1), "active");
    assert.equal(sessionStatus(row({ last_seen_at: new Date(T0 + 11 * 3600 * 1000) }), T0 + 11.4 * 3600 * 1000), "active");
  });

  it("마지막 사용 뒤 30분이 지나면 유휴 만료다", () => {
    assert.equal(sessionStatus(row(), T0 + SESSION_IDLE_TTL_MS), "expired_idle");
  });

  it("계속 쓰여도 계열 생성 뒤 12시간이 지나면 절대 만료다", () => {
    const busy = row({ last_seen_at: new Date(T0 + SESSION_ABSOLUTE_TTL_MS - 1000) });
    assert.equal(sessionStatus(busy, T0 + SESSION_ABSOLUTE_TTL_MS), "expired_absolute");
  });

  it("폐기된 세션은 만료 여부와 관계없이 revoked다", () => {
    assert.equal(sessionStatus(row({ revoked_at: new Date(T0 + 1) }), T0 + 2), "revoked");
  });

  it("마지막 사용 시각 기록은 1분 간격으로만 한다", () => {
    assert.equal(LAST_SEEN_WRITE_INTERVAL_MS, 60_000);
    assert.equal(shouldTouchSession(row(), T0 + 59_999), false);
    assert.equal(shouldTouchSession(row(), T0 + 60_000), true);
  });
});

describe("세션 발급과 회전", () => {
  it("로그인은 새 계열을 만들고 토큰과 CSRF 토큰은 해시만 저장한다", () => {
    const s = newSessionValues({ userId: "u1", now: T0 });
    assert.match(s.token, /^[A-Za-z0-9_-]{43}$/);
    assert.match(s.csrf, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(s.row.token_hash, hashToken(s.token));
    assert.equal(s.row.csrf_hash, hashToken(s.csrf));
    assert.equal(s.row.family_id, s.row.id);
    assert.equal(s.row.user_id, "u1");
    assert.equal(s.row.absolute_expires_at.getTime(), T0 + SESSION_ABSOLUTE_TTL_MS);
    assert.ok(!Object.values(s.row).includes(s.token));
    const again = newSessionValues({ userId: "u1", now: T0 });
    assert.notEqual(again.row.family_id, s.row.family_id);
    assert.notEqual(again.token, s.token);
  });

  it("회전은 같은 계열, 같은 절대 만료로 새 토큰을 낸다", () => {
    const first   = newSessionValues({ userId: "u1", now: T0 });
    const rotated = rotatedSessionValues(first.row, { now: T0 + 3600_000 });
    assert.equal(rotated.row.family_id, first.row.family_id);
    assert.equal(rotated.row.user_id, "u1");
    assert.equal(rotated.row.absolute_expires_at.getTime(), first.row.absolute_expires_at.getTime());
    assert.notEqual(rotated.row.id, first.row.id);
    assert.notEqual(rotated.row.token_hash, first.row.token_hash);
    assert.notEqual(rotated.row.csrf_hash, first.row.csrf_hash);
  });
});

describe("쿠키", () => {
  it("세션 쿠키는 HttpOnly, SameSite=Strict, 관리 경로 한정이고 TLS 뒤에서만 Secure다", () => {
    const [session, csrf] = sessionCookieHeaders({ token: "tok", csrf: "cs", secure: false, path: "/admin" });
    assert.match(session, new RegExp(`^${USER_SESSION_COOKIE}=tok;`));
    assert.match(session, /; HttpOnly/);
    assert.match(session, /; SameSite=Strict/);
    assert.match(session, /; Path=\/admin/);
    assert.match(session, /; Max-Age=43200/);
    assert.doesNotMatch(session, /Secure/);
    assert.match(csrf, new RegExp(`^${CSRF_COOKIE}=cs;`));
    assert.doesNotMatch(csrf, /HttpOnly/);
    assert.match(csrf, /; SameSite=Strict/);
    const secured = sessionCookieHeaders({ token: "tok", csrf: "cs", secure: true, path: "/admin" });
    assert.ok(secured.every((c) => /; Secure/.test(c)));
  });

  it("쿠키 지우기는 같은 이름과 경로에 Max-Age=0이다", () => {
    const cleared = clearSessionCookieHeaders({ secure: false, path: "/admin" });
    assert.equal(cleared.length, 2);
    assert.ok(cleared.every((c) => /Max-Age=0/.test(c) && /Path=\/admin/.test(c)));
  });

  it("쿠키 헤더를 이름별로 읽는다", () => {
    assert.deepEqual(readCookies(`a=1; ${USER_SESSION_COOKIE}=x=y; ${CSRF_COOKIE}=z`), { a: "1", [USER_SESSION_COOKIE]: "x=y", [CSRF_COOKIE]: "z" });
    assert.deepEqual(readCookies(""), {});
  });
});

describe("CSRF 판정", () => {
  const csrf      = "token-123";
  const csrfHash  = hashToken(csrf);
  const origins   = new Set(["https://admin.example.com"]);
  const base      = { method: "POST", origin: "https://admin.example.com", allowedOrigins: origins,
    cookieToken: csrf, headerToken: csrf, sessionCsrfHash: csrfHash };

  it("GET, HEAD, OPTIONS는 판정하지 않는다", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      assert.deepEqual(csrfDecision({ ...base, method, origin: undefined, headerToken: undefined }), { ok: true });
    }
  });

  it("비GET은 Origin이 반드시 있어야 하고 허용 출처여야 한다", () => {
    assert.deepEqual(csrfDecision({ ...base, origin: undefined }), { ok: false, reason: "origin_missing" });
    assert.deepEqual(csrfDecision({ ...base, origin: "null" }), { ok: false, reason: "origin_mismatch" });
    assert.deepEqual(csrfDecision({ ...base, origin: "https://evil.example" }), { ok: false, reason: "origin_mismatch" });
  });

  it("이중 제출: 헤더와 쿠키 값이 같고 세션에 저장된 해시와 맞아야 한다", () => {
    assert.deepEqual(csrfDecision(base), { ok: true });
    assert.deepEqual(csrfDecision({ ...base, headerToken: undefined }), { ok: false, reason: "token_missing" });
    assert.deepEqual(csrfDecision({ ...base, cookieToken: undefined }), { ok: false, reason: "token_missing" });
    assert.deepEqual(csrfDecision({ ...base, headerToken: "other" }), { ok: false, reason: "token_mismatch" });
    assert.deepEqual(csrfDecision({ ...base, headerToken: "forged", cookieToken: "forged" }), { ok: false, reason: "token_mismatch" });
  });

  it("허용 출처는 요청의 Host와 프로토콜에서 나온 자기 출처와 ADMIN_ALLOWED_ORIGINS다", () => {
    const req = { headers: { host: "mem.example.com", "x-forwarded-proto": "https" }, socket: {} };
    assert.deepEqual([...expectedOrigins(req, new Set(["https://ops.example.com"]))].sort(),
      ["https://mem.example.com", "https://ops.example.com"]);
    const plain = { headers: { host: "localhost:57001" }, socket: {} };
    assert.deepEqual([...expectedOrigins(plain, new Set())], ["http://localhost:57001"]);
  });
});

describe("마지막 owner 보호", () => {
  it("활성 owner가 대상 하나뿐이면 삭제, 비활성화, owner 제거를 거부한다", () => {
    const owners = ["a"];
    assert.deepEqual(ownerChangeDecision({ activeOwnerIds: owners, targetId: "a", removesOwner: true }), { ok: false, reason: "last_owner" });
  });

  it("다른 활성 owner가 있으면 허용한다", () => {
    assert.deepEqual(ownerChangeDecision({ activeOwnerIds: ["a", "b"], targetId: "a", removesOwner: true }), { ok: true });
  });

  it("owner가 아닌 계정의 변경과 owner를 남기는 변경은 허용한다", () => {
    assert.deepEqual(ownerChangeDecision({ activeOwnerIds: ["a"], targetId: "c", removesOwner: true }), { ok: true });
    assert.deepEqual(ownerChangeDecision({ activeOwnerIds: ["a"], targetId: "a", removesOwner: false }), { ok: true });
  });

  it("역할 변경이 owner를 없애는지 판정한다(전역 owner 바인딩 기준)", () => {
    const current = [{ role: "owner", workspace: null }];
    assert.equal(roleChangeRemovesOwner(current, [{ role: "admin", workspace: null }]), true);
    assert.equal(roleChangeRemovesOwner(current, [{ role: "owner", workspace: null }, { role: "viewer", workspace: "w" }]), false);
    assert.equal(roleChangeRemovesOwner(current, [{ role: "owner", workspace: "w" }]), true);
    assert.equal(roleChangeRemovesOwner([{ role: "viewer", workspace: null }], []), false);
  });
});
