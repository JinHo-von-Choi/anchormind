/**
 * 인증 저장소 조회 실패 판정 시험
 *
 * api_keys 조회가 실패한 요청은 키 무효와 구분된 결과(unavailable)로 끝나고,
 * 비 API 키 OAuth 거부 지표를 올리지 않는다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */
import { describe, it, mock, beforeEach } from "node:test";
import assert                             from "node:assert/strict";

const state = {
  fromDb: async () => ({ valid: false }),
  byId  : async () => ({ valid: false }),
  token : async () => ({ valid: false })
};

mock.module("../../lib/admin/ApiKeyStore.js", {
  exports: {
    validateApiKeyFromDB: (raw) => state.fromDb(raw),
    validateApiKeyById  : (id)  => state.byId(id),
    incrementUsage      : () => {}
  }
});
mock.module("../../lib/oauth.js", {
  exports: { validateAccessToken: (t) => state.token(t) }
});
mock.module("../../lib/redis.js", {
  exports: { extendOAuthToken: async () => {} }
});

const { validateAuthentication } = await import("../../lib/auth.js");
const { register }               = await import("../../lib/metrics.js");

const bearer = (token) => ({ headers: { authorization: `Bearer ${token}` } });

async function counterValue(name, labels = {}) {
  const values = (await register.getSingleMetric(name).get()).values;
  const match  = values.find(v => Object.entries(labels).every(([k, val]) => v.labels[k] === val));
  return match ? match.value : 0;
}

describe("인증 저장소 조회 실패", () => {
  beforeEach(() => {
    state.fromDb = async () => ({ valid: false });
    state.byId   = async () => ({ valid: false });
    state.token  = async () => ({ valid: false });
  });

  it("원시 키 조회가 실패하면 unavailable로 끝난다", async () => {
    state.fromDb = async () => { const e = new Error("connect ECONNREFUSED"); e.code = "ECONNREFUSED"; throw e; };
    const before = await counterValue("memento_auth_denied_total", { reason: "store_unavailable" });
    const result = await validateAuthentication(bearer("mmcp_raw_key_value"), null);
    assert.equal(result.valid, false);
    assert.equal(result.unavailable, true);
    assert.equal(await counterValue("memento_auth_denied_total", { reason: "store_unavailable" }), before + 1);
  });

  it("원시 키가 없는 키면 기존 거부 결과다", async () => {
    const result = await validateAuthentication(bearer("mmcp_unknown_key"), null);
    assert.equal(result.valid, false);
    assert.equal(result.unavailable, undefined);
    assert.equal(result.error, "Invalid or missing access key");
  });

  it("바인딩된 OAuth 토큰의 키 조회 실패는 비 API 키 거부로 세지 않는다", async () => {
    state.token  = async () => ({ valid: true, client_id: "conn_550e8400", is_api_key: false, bound_key_id: "550e8400-e29b-41d4-a716-446655440000" });
    state.byId   = async () => ({ valid: false, reason: "store_unavailable" });
    const before = await counterValue("mcp_oauth_nonapikey_rejected_total");
    const result = await validateAuthentication(bearer("oauth-access-token"), null);
    assert.equal(result.valid, false);
    assert.equal(result.unavailable, true);
    assert.equal(await counterValue("mcp_oauth_nonapikey_rejected_total"), before);
  });

  it("바인딩된 키가 비활성이면 기존 비 API 키 거부다", async () => {
    state.token  = async () => ({ valid: true, client_id: "conn_550e8400", is_api_key: false, bound_key_id: "550e8400-e29b-41d4-a716-446655440000" });
    state.byId   = async () => ({ valid: false, reason: "inactive" });
    const result = await validateAuthentication(bearer("oauth-access-token"), null);
    assert.equal(result.valid, false);
    assert.equal(result.unavailable, undefined);
    assert.equal(result.error, "non-API-key OAuth denied");
  });

  it("마스터 키는 저장소를 보지 않는다", async () => {
    state.fromDb = async () => { throw new Error("must not be called"); };
    const result = await validateAuthentication(bearer(process.env.MEMENTO_ACCESS_KEY), null);
    assert.equal(result.valid, true);
    assert.equal(result.isMaster, true);
  });
});
