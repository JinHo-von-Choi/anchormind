/**
 * 훅 인증 결과 캐시 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

import { createHookAuthCache, authCacheKey } from "../../lib/hooks/hook-auth-cache.js";

const req = (token) => ({ headers: token ? { authorization: `Bearer ${token}` } : {} });

function setup({ auth = async () => ({ valid: true, keyId: "k1", permissions: ["read", "write"], groupKeyIds: ["k1"] }),
  state = async () => ({ exists: true, status: "active", permissions: ["read", "write"] }), ttl = 30_000 } = {}) {
  let now    = 1_000;
  const seen = { auth: 0, usage: [], state: 0 };
  const cache = createHookAuthCache({
    authenticate: async (r) => { seen.auth++; return auth(r); },
    keyState    : async (id) => { seen.state++; return state(id); },
    countUsage  : (id) => seen.usage.push(id),
    ttlMs       : () => ttl,
    clock       : () => now
  });
  return { cache, seen, advance: (ms) => { now += ms; } };
}

describe("createHookAuthCache", () => {
  it("같은 키는 보존 시간 안에서 전체 인증 없이 재사용하고 사용량은 매번 센다", async () => {
    const t = setup();
    await t.cache.authenticate(req("a"));
    await t.cache.authenticate(req("a"));
    await t.cache.authenticate(req("a"));
    assert.equal(t.seen.auth, 1);
    assert.deepEqual(t.seen.usage, ["k1", "k1"]);
    t.advance(30_001);
    await t.cache.authenticate(req("a"));
    assert.equal(t.seen.auth, 2);
  });

  it("키 상태가 비활성이거나 삭제되면 항목을 지우고 전체 인증을 다시 한다", async () => {
    let status = "active";
    let valid  = true;
    const t = setup({
      auth : async () => (valid ? { valid: true, keyId: "k1", permissions: ["write"] } : { valid: false }),
      state: async () => ({ exists: true, status, permissions: ["write"] })
    });
    await t.cache.authenticate(req("a"));
    status = "inactive";
    valid  = false;
    const r = await t.cache.authenticate(req("a"));
    assert.equal(r.valid, false);
    assert.equal(t.seen.auth, 2);
    assert.equal(t.cache.size(), 0);
  });

  it("권한은 키 상태의 값을 쓴다", async () => {
    const t = setup({ state: async () => ({ exists: true, status: "active", permissions: ["read"] }) });
    await t.cache.authenticate(req("a"));
    const r = await t.cache.authenticate(req("a"));
    assert.deepEqual(r.permissions, ["read"]);
  });

  it("실패, 마스터, OAuth 결과와 인증 헤더 없는 요청은 담지 않으며 보존 시간 0이면 캐시하지 않는다", async () => {
    for (const result of [{ valid: false }, { valid: true, keyId: null, isMaster: true }, { valid: true, keyId: "k", oauth: true }]) {
      const t = setup({ auth: async () => result });
      await t.cache.authenticate(req("a"));
      await t.cache.authenticate(req("a"));
      assert.equal(t.seen.auth, 2, JSON.stringify(result));
    }
    const none = setup();
    await none.cache.authenticate(req(null));
    await none.cache.authenticate(req(null));
    assert.equal(none.seen.auth, 2);
    const off = setup({ ttl: 0 });
    await off.cache.authenticate(req("a"));
    await off.cache.authenticate(req("a"));
    assert.equal(off.seen.auth, 2);
  });

  it("캐시 키는 헤더의 해시이고 키 문자열을 담지 않는다", () => {
    const key = authCacheKey(req("mmcp_secret_value"));
    assert.match(key, /^[0-9a-f]{64}$/);
    assert.notEqual(key, authCacheKey(req("mmcp_other")));
    assert.equal(authCacheKey(req(null)), null);
  });
});
