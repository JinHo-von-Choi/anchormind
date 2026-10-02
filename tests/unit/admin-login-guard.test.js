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
