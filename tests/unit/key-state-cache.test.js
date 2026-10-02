/**
 * 키 상태 재확인 캐시의 조회 실패 처리 시험.
 * 실제 key-state-cache를 호출하고 키 상태 조회 함수와 경고 로그만 대체한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */
import { describe, it, beforeEach, mock } from "node:test";
import assert                             from "node:assert/strict";

process.env.DOTENV_CONFIG_PATH      ??= ".env.test";
process.env.MEMENTO_METRICS_DEFAULT ??= "off";
process.env.REDIS_ENABLED           ??= "false";
process.env.CACHE_ENABLED           ??= "false";

const KEY_ID  = "7a1e0000-0000-4000-8000-0000000000aa";
const ACTIVE  = { exists: true, status: "active", permissions: ["read"] };
const REVOKED = { exists: true, status: "inactive", permissions: ["read"] };

let lookups = [];
let lookup  = async () => ACTIVE;
const warns = [];

const realKeys = await import("../../lib/admin/ApiKeyStore.js");
mock.module("../../lib/admin/ApiKeyStore.js", {
  namedExports: { ...realKeys, getKeyAuthState: async (keyId) => { lookups.push(keyId); return lookup(keyId); } }
});
const realLogger = await import("../../lib/logger.js");
mock.module("../../lib/logger.js", {
  namedExports: { ...realLogger, logWarn: (...args) => { warns.push(args.join(" ")); } }
});

const { getCachedKeyState, invalidateKeyState, KEY_STATE_FAILURE_WINDOW_MS } = await import("../../lib/admin/key-state-cache.js");
const { register }                                                           = await import("../../lib/metrics.js");

async function recheckErrors() {
  const values = (await register.getSingleMetric("mcp_auth_store_errors_total").get()).values;
  return values.find(v => v.labels.operation === "session_recheck")?.value ?? 0;
}

const failing = async () => { throw new Error("db down"); };

/** 실패 창은 조회가 실제로 걸린 시간만큼 뒤로 밀리므로, 창 경계 검사는 이 여유만큼 떨어져서 한다. */
const PAST_WINDOW_MS = KEY_STATE_FAILURE_WINDOW_MS + 60_000;

beforeEach(() => {
  delete process.env.MEMENTO_SESSION_KEY_RECHECK_MS;
  invalidateKeyState(KEY_ID);
  lookups.length = 0;
  warns.length   = 0;
  lookup         = async () => ACTIVE;
});

describe("키 상태 조회 실패 창", () => {
  it("실패 창 안의 요청은 조회를 다시 하지 않고 판정 불가를 돌려준다", async () => {
    lookup = failing;
    const t0 = 1_000_000;
    for (let i = 0; i < 20; i++) {
      assert.equal(await getCachedKeyState(KEY_ID, t0 + i * 100), null);
    }
    assert.equal(lookups.length, 1);
  });

  it("경고는 창마다 키당 한 번만 남긴다", async () => {
    lookup = failing;
    const t0 = 2_000_000;
    for (let i = 0; i < 10; i++) await getCachedKeyState(KEY_ID, t0 + i * 100);
    assert.equal(warns.length, 1);
    await getCachedKeyState(KEY_ID, t0 + PAST_WINDOW_MS);
    assert.equal(warns.length, 2);
  });

  it("실패 조회는 session_recheck 라벨로 집계하고 창 안에서는 늘리지 않는다", async () => {
    lookup       = failing;
    const before = await recheckErrors();
    const t0     = 3_000_000;
    for (let i = 0; i < 5; i++) await getCachedKeyState(KEY_ID, t0 + i);
    assert.equal(await recheckErrors(), before + 1);
  });

  it("창이 지나면 조회를 다시 하고 성공하면 캐시를 갱신한다", async () => {
    lookup   = failing;
    const t0 = 4_000_000;
    assert.equal(await getCachedKeyState(KEY_ID, t0), null);
    lookup = async () => REVOKED;
    assert.equal(await getCachedKeyState(KEY_ID, t0 + KEY_STATE_FAILURE_WINDOW_MS - 1), null);
    assert.deepEqual(await getCachedKeyState(KEY_ID, t0 + PAST_WINDOW_MS), REVOKED);
    assert.equal(lookups.length, 2);
    assert.deepEqual(await getCachedKeyState(KEY_ID, t0 + PAST_WINDOW_MS + 1), REVOKED);
    assert.equal(lookups.length, 2);
  });

  it("실패 창 안에서도 직전 캐시 값을 돌려준다", async () => {
    const t0 = 5_000_000;
    assert.deepEqual(await getCachedKeyState(KEY_ID, t0), ACTIVE);
    lookup = failing;
    const afterTtl = t0 + 30_001;
    assert.deepEqual(await getCachedKeyState(KEY_ID, afterTtl), ACTIVE);
    assert.deepEqual(await getCachedKeyState(KEY_ID, afterTtl + 10), ACTIVE);
    assert.equal(lookups.length, 2);
  });

  it("조회 소요 시간만큼 창이 앞서 소진되지 않는다", async () => {
    lookup   = async () => { await new Promise((r) => setTimeout(r, 40)); throw new Error("timeout"); };
    const t0 = 6_000_000;
    await getCachedKeyState(KEY_ID, t0);
    await getCachedKeyState(KEY_ID, t0 + 41);
    assert.equal(lookups.length, 1);
  });

  it("느린 조회가 실패해도 창은 실제 소요 시간만큼 뒤로 밀려 유지된다", async () => {
    lookup   = async () => { await new Promise((r) => setTimeout(r, 20)); throw new Error("timeout"); };
    const t0 = 6_500_000;
    assert.equal(await getCachedKeyState(KEY_ID, t0), null);
    assert.equal(await getCachedKeyState(KEY_ID, t0 + KEY_STATE_FAILURE_WINDOW_MS + 5), null);
    assert.equal(lookups.length, 1);
    lookup = async () => ACTIVE;
    assert.deepEqual(await getCachedKeyState(KEY_ID, t0 + PAST_WINDOW_MS), ACTIVE);
    assert.equal(lookups.length, 2);
  });

  it("무효화하면 실패 창도 지운다", async () => {
    lookup   = failing;
    const t0 = 7_000_000;
    await getCachedKeyState(KEY_ID, t0);
    invalidateKeyState(KEY_ID);
    lookup = async () => ACTIVE;
    assert.deepEqual(await getCachedKeyState(KEY_ID, t0 + 10), ACTIVE);
    assert.equal(lookups.length, 2);
  });

  it("조회 중에 무효화되면 늦게 끝난 결과를 캐시하지 않는다", async () => {
    let release;
    const gate = new Promise((resolve) => { release = () => resolve(ACTIVE); });
    lookup   = () => gate;
    const t0 = 8_000_000;
    const inflight = getCachedKeyState(KEY_ID, t0);
    invalidateKeyState(KEY_ID);
    release();
    assert.deepEqual(await inflight, ACTIVE);
    lookup = async () => REVOKED;
    assert.deepEqual(await getCachedKeyState(KEY_ID, t0 + 10), REVOKED);
    assert.equal(lookups.length, 2);
  });
});
