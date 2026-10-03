/**
 * 인증 경로의 키 수명 판정 시험(저장소 대체)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 키 저장소와 OAuth 저장소를 대체하고 실제 validateAuthentication을 거친다.
 *   - 허용 대역이 없는 키는 주소와 무관하게 통과한다. 사용량 기록에는 주소 원문이 아니라 지문을 넘긴다
 *   - 허용 대역이 있는 키는 요청 주소(신뢰 프록시 hop 수 적용)가 대역 밖이면 거부하고 사용량을 올리지 않는다
 *   - 바인딩된 OAuth 키도 같은 대역 판정을 받고, 거부되면 비 API 키 OAuth로 넘어가지 않는다
 *   - 만료, 폐기, 회전 겹침 종료는 사유별 거부 지표로 남는다
 */
import { describe, it, mock, beforeEach } from "node:test";
import assert                             from "node:assert/strict";

const state = {
  fromDb: async () => ({ valid: false }),
  byId  : async () => ({ valid: false }),
  token : async () => ({ valid: false })
};
const usage = [];

mock.module("../../lib/admin/ApiKeyStore.js", {
  exports: {
    validateApiKeyFromDB: (raw) => state.fromDb(raw),
    validateApiKeyById  : (id)  => state.byId(id),
    incrementUsage      : (keyId, ip) => { usage.push({ keyId, ip }); }
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
const { hashClientIp }           = await import("../../lib/admin/key-lifecycle.js");
const { ACCESS_KEY }             = await import("../../lib/config.js");

const KEY_ID = "550e8400-e29b-41d4-a716-4466554400e5";

/** 소켓 주소가 remote인 요청 */
const request = (token, remote, xff) => ({
  headers: { authorization: `Bearer ${token}`, ...(xff ? { "x-forwarded-for": xff } : {}) },
  socket : { remoteAddress: remote }
});

const validKey = (extra = {}) => async () => ({ valid: true, keyId: KEY_ID, groupKeyIds: [KEY_ID], permissions: ["read"], allowedCidrs: null, ...extra });

async function denied(reason) {
  const values = (await register.getSingleMetric("memento_auth_denied_total").get()).values;
  return values.find(v => v.labels.reason === reason)?.value ?? 0;
}

beforeEach(() => {
  state.fromDb = async () => ({ valid: false });
  state.byId   = async () => ({ valid: false });
  state.token  = async () => ({ valid: false });
  usage.length = 0;
});

describe("원시 API 키의 허용 대역", () => {
  it("허용 대역이 없는 키는 판정할 수 없는 주소에서도 통과하고 지문 없이 사용량을 기록한다", async () => {
    state.fromDb = validKey();
    const result = await validateAuthentication({ headers: { authorization: "Bearer mmcp_a" } }, null);
    assert.equal(result.valid, true);
    assert.equal(result.keyId, KEY_ID);
    assert.deepEqual(usage, [{ keyId: KEY_ID, ip: null }]);
  });

  it("대역 안 주소는 통과한다(IPv4 매핑 IPv6 소켓 주소 포함)", async () => {
    state.fromDb = validKey({ allowedCidrs: ["198.51.100.0/24"] });
    assert.equal((await validateAuthentication(request("mmcp_a", "::ffff:198.51.100.4"), null)).valid, true);
    assert.equal(usage.length, 1);
  });

  it("대역 밖 주소는 키 무효와 같은 응답으로 거부하고 사용량을 올리지 않는다", async () => {
    state.fromDb = validKey({ allowedCidrs: ["198.51.100.0/24"] });
    const before = await denied("cidr_denied");
    const result = await validateAuthentication(request("mmcp_a", "192.0.2.10"), null);
    assert.equal(result.valid, false);
    assert.equal(result.error, "Invalid or missing access key");
    assert.equal(result.unavailable, undefined);
    assert.equal(usage.length, 0);
    assert.equal(await denied("cidr_denied"), before + 1);
  });

  it("잘못된 목록을 가진 키는 거부한다", async () => {
    state.fromDb = validKey({ allowedCidrs: ["198.51.100.0/24", "not-a-cidr"] });
    assert.equal((await validateAuthentication(request("mmcp_a", "198.51.100.1"), null)).valid, false);
  });
});

describe("바인딩된 OAuth 키의 허용 대역", () => {
  beforeEach(() => {
    state.token = async () => ({ valid: true, client_id: "conn_550e8400", is_api_key: false, bound_key_id: KEY_ID });
  });

  it("대역 안 주소는 키 주체로 통과한다", async () => {
    state.byId = validKey({ allowedCidrs: ["203.0.113.0/24"] });
    const result = await validateAuthentication(request("oauth-token", "203.0.113.9"), null);
    assert.equal(result.valid, true);
    assert.equal(result.keyId, KEY_ID);
    assert.deepEqual(usage, [{ keyId: KEY_ID, ip: hashClientIp("203.0.113.9", ACCESS_KEY) }]);
    assert.match(usage[0].ip, /^[0-9a-f]{32}$/);
  });

  it("대역 밖 주소는 비 API 키 OAuth로 넘어가지 않고 거부한다", async () => {
    state.byId = validKey({ allowedCidrs: ["203.0.113.0/24"] });
    const result = await validateAuthentication(request("oauth-token", "198.51.100.1"), null);
    assert.equal(result.valid, false);
    assert.equal(result.oauth, undefined);
    assert.equal(usage.length, 0);
  });
});

describe("수명 거부 사유 지표", () => {
  for (const reason of ["expired", "revoked", "rotated"]) {
    it(`${reason}는 key_${reason}로 센다`, async () => {
      state.fromDb = async () => ({ valid: false, reason });
      const before = await denied(`key_${reason}`);
      const invalidBefore = await denied("invalid_key");
      const result = await validateAuthentication(request("mmcp_a", "192.0.2.1"), null);
      assert.equal(result.valid, false);
      assert.equal(result.error, "Invalid or missing access key");
      assert.equal(await denied(`key_${reason}`), before + 1);
      assert.equal(await denied("invalid_key"), invalidBefore);
    });
  }

  it("비활성과 한도 초과는 기존처럼 invalid_key로 센다", async () => {
    for (const reason of ["inactive", "limit_exceeded"]) {
      state.fromDb = async () => ({ valid: false, reason });
      const before = await denied("invalid_key");
      await validateAuthentication(request("mmcp_a", "192.0.2.1"), null);
      assert.equal(await denied("invalid_key"), before + 1, reason);
    }
  });
});

describe("키에 묶인 OAuth 토큰과 회전 퇴역", () => {
  beforeEach(() => {
    state.token = async () => ({ valid: true, client_id: "conn_550e8400", is_api_key: false, bound_key_id: KEY_ID, issued_at: Date.now() - 60_000 });
  });

  it("지난 퇴역 시각보다 먼저 발급된 토큰은 key_rotated로 거부하고 비 API 키 OAuth로 넘기지 않는다", async () => {
    state.byId   = validKey({ secretRetirements: [new Date(Date.now() - 1000)] });
    const before = await denied("key_rotated");
    const result = await validateAuthentication(request("oauth-token", "192.0.2.5"), null);
    assert.equal(result.valid, false);
    assert.equal(result.oauth, undefined);
    assert.equal(usage.length, 0);
    assert.equal(await denied("key_rotated"), before + 1);
  });

  it("퇴역 시각 뒤에 발급된 토큰과 퇴역 시각이 없는 키는 통과한다", async () => {
    state.byId = validKey({ secretRetirements: [new Date(Date.now() - 120_000)] });
    assert.equal((await validateAuthentication(request("oauth-token", "192.0.2.5"), null)).valid, true);
    state.byId = validKey();
    assert.equal((await validateAuthentication(request("oauth-token", "192.0.2.5"), null)).valid, true);
  });
});
