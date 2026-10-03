/**
 * 관리 인증 실패 누적과 지연 계산 시험.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */
import { describe, it, beforeEach, after } from "node:test";
import assert                              from "node:assert/strict";

process.env.DOTENV_CONFIG_PATH      ??= ".env.test";
process.env.MEMENTO_METRICS_DEFAULT ??= "off";
process.env.REDIS_ENABLED           ??= "false";
process.env.CACHE_ENABLED           ??= "false";

const {
  checkAdminAuthAttempt,
  recordAdminAuthFailure,
  recordAdminAuthSuccess,
  _resetAdminAuthGuardForTest
} = await import("../../lib/admin/admin-login-guard.js");

const T0 = 1_000_000;

beforeEach(() => {
  delete process.env.MEMENTO_ADMIN_AUTH_BACKOFF;
  _resetAdminAuthGuardForTest();
});

after(() => {
  delete process.env.MEMENTO_ADMIN_AUTH_BACKOFF;
});

describe("관리 인증 지연 계산", () => {
  it("기본(off)은 실패가 쌓여도 항상 허용한다", () => {
    for (let i = 0; i < 20; i++) recordAdminAuthFailure(T0);
    assert.deepEqual(checkAdminAuthAttempt(T0), { allowed: true, retryAfterSec: 0 });
  });

  it("on이어도 5회까지는 허용하고 6회째부터 1, 2, 4초 지연한다", () => {
    process.env.MEMENTO_ADMIN_AUTH_BACKOFF = "on";
    for (let i = 0; i < 5; i++) recordAdminAuthFailure(T0);
    assert.equal(checkAdminAuthAttempt(T0).allowed, true);
    recordAdminAuthFailure(T0);
    assert.deepEqual(checkAdminAuthAttempt(T0), { allowed: false, retryAfterSec: 1 });
    assert.equal(checkAdminAuthAttempt(T0 + 1000).allowed, true);
    recordAdminAuthFailure(T0 + 1000);
    assert.equal(checkAdminAuthAttempt(T0 + 1000).retryAfterSec, 2);
    recordAdminAuthFailure(T0 + 3000);
    assert.equal(checkAdminAuthAttempt(T0 + 3000).retryAfterSec, 4);
  });

  it("지연은 60초를 넘지 않는다", () => {
    process.env.MEMENTO_ADMIN_AUTH_BACKOFF = "on";
    for (let i = 0; i < 40; i++) recordAdminAuthFailure(T0);
    assert.equal(checkAdminAuthAttempt(T0).retryAfterSec, 60);
  });

  it("마지막 실패로부터 60초가 지나면 누적을 새로 센다", () => {
    process.env.MEMENTO_ADMIN_AUTH_BACKOFF = "on";
    for (let i = 0; i < 4; i++) recordAdminAuthFailure(T0);
    assert.equal(recordAdminAuthFailure(T0 + 61_000), 1);
    assert.equal(checkAdminAuthAttempt(T0 + 61_000).allowed, true);
    assert.equal(recordAdminAuthFailure(T0 + 61_500), 2);
  });

  it("성공하면 누적과 지연이 사라진다", () => {
    process.env.MEMENTO_ADMIN_AUTH_BACKOFF = "on";
    for (let i = 0; i < 8; i++) recordAdminAuthFailure(T0);
    recordAdminAuthSuccess();
    assert.equal(checkAdminAuthAttempt(T0).allowed, true);
    assert.equal(recordAdminAuthFailure(T0), 1);
  });
});

const { loginDelayMs, createKeyedLoginGuard } = await import("../../lib/admin/admin-login-guard.js");

describe("로그인 실패 지연 함수", () => {
  it("문턱(5회)까지는 0이고 그 뒤 1, 2, 4초로 늘며 60초를 넘지 않는다", () => {
    assert.deepEqual([0, 1, 5].map((n) => loginDelayMs(n)), [0, 0, 0]);
    assert.deepEqual([6, 7, 8, 9].map((n) => loginDelayMs(n)), [1000, 2000, 4000, 8000]);
    assert.equal(loginDelayMs(12), 60_000);
    assert.equal(loginDelayMs(1000), 60_000);
  });

  it("문턱과 상한을 바꿀 수 있다", () => {
    assert.equal(loginDelayMs(20, { threshold: 20 }), 0);
    assert.equal(loginDelayMs(21, { threshold: 20 }), 1000);
    assert.equal(loginDelayMs(30, { threshold: 20, maxMs: 5000 }), 5000);
  });

  it("음수, 정수 아님은 0이다", () => {
    assert.equal(loginDelayMs(-1), 0);
    assert.equal(loginDelayMs(Number.NaN), 0);
  });
});

describe("키별 로그인 실패 지연(계정, 클라이언트 주소)", () => {
  it("스위치와 관계없이 키마다 따로 세고 문턱 뒤 지연한다", () => {
    const guard = createKeyedLoginGuard({ threshold: 5 });
    for (let i = 0; i < 6; i++) guard.recordFailure("alice", T0);
    assert.deepEqual(guard.check("alice", T0), { allowed: false, retryAfterSec: 1 });
    assert.deepEqual(guard.check("bob", T0), { allowed: true, retryAfterSec: 0 });
    assert.equal(guard.check("alice", T0 + 1000).allowed, true);
  });

  it("성공은 그 키의 누적만 지운다", () => {
    const guard = createKeyedLoginGuard({ threshold: 1 });
    guard.recordFailure("a", T0);
    guard.recordFailure("a", T0);
    guard.recordFailure("b", T0);
    guard.recordFailure("b", T0);
    guard.recordSuccess("a");
    assert.equal(guard.check("a", T0).allowed, true);
    assert.equal(guard.check("b", T0).allowed, false);
  });

  it("마지막 실패 뒤 최대 지연 시간이 지나면 새로 센다", () => {
    const guard = createKeyedLoginGuard({ threshold: 2 });
    guard.recordFailure("k", T0);
    guard.recordFailure("k", T0);
    assert.equal(guard.recordFailure("k", T0 + 61_000), 1);
  });

  it("항목 수 상한을 넘으면 가장 오래된 키부터 지운다", () => {
    const guard = createKeyedLoginGuard({ threshold: 0, maxEntries: 2 });
    guard.recordFailure("k1", T0);
    guard.recordFailure("k2", T0);
    guard.recordFailure("k3", T0);
    assert.equal(guard.size(), 2);
    assert.equal(guard.check("k1", T0).allowed, true);
    assert.equal(guard.check("k3", T0).allowed, false);
  });
});
