/**
 * 유효 세션 요청에 함께 온 자격 증명 판정 시험.
 * 실제 checkSessionCredential과 rejectSessionCredential을 호출하고 자격 증명 조회(peekCredential)만 대체한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-11-12
 */
import { describe, it, beforeEach, after, mock } from "node:test";
import assert                                    from "node:assert/strict";

process.env.DOTENV_CONFIG_PATH      ??= ".env.test";
process.env.MEMENTO_METRICS_DEFAULT ??= "off";
process.env.REDIS_ENABLED           ??= "false";
process.env.CACHE_ENABLED           ??= "false";
process.env.MEMENTO_ACCESS_KEY      ??= "test-master-key";

const KEY_A = "7a1e0000-0000-4000-8000-00000000000a";
const KEY_B = "7a1e0000-0000-4000-8000-00000000000b";

/** 토큰 -> 조회 결과 */
const verdicts = new Map([
  ["token-a", { present: true, valid: true, keyId: KEY_A, isMaster: false }],
  ["token-b", { present: true, valid: true, keyId: KEY_B, isMaster: false }],
  ["expired", { present: true, valid: false }],
  ["down",    { present: true, unavailable: true }]
]);
let lookups = 0;

const realAuth = await import("../../lib/auth.js");
mock.module("../../lib/auth.js", {
  namedExports: {
    ...realAuth,
    peekCredential: async (token) => { lookups += 1; return verdicts.get(token) ?? { present: true, valid: false }; }
  }
});

const { checkSessionCredential, rejectSessionCredential, _resetSessionCredentialCacheForTest } =
  await import("../../lib/session-credential.js");

const SESSION = { sessionId: "e9509944-0482-4e7e-9a69-78cfb07b2f5c", keyId: KEY_A, isMaster: false };

function request(token) {
  return { headers: token ? { authorization: `Bearer ${token}`, host: "memory.example" } : { host: "memory.example" }, socket: {} };
}

function response() {
  const headers = {};
  return {
    headers, statusCode: 200, body: null,
    setHeader(name, value) { headers[name.toLowerCase()] = value; },
    end(text) { this.body = text; }
  };
}

describe("세션 자격 증명 판정", () => {
  beforeEach(() => {
    lookups = 0;
    _resetSessionCredentialCacheForTest();
    process.env.MEMENTO_SESSION_CREDENTIAL_CHECK = "enforce";
  });

  after(() => {
    delete process.env.MEMENTO_SESSION_CREDENTIAL_CHECK;
  });

  it("자격 증명이 없는 요청은 어느 모드에서도 거부하지 않는다", async () => {
    assert.deepEqual(await checkSessionCredential(request(null), SESSION), { result: "absent", reject: null });
  });

  it("세션 주체와 같은 자격 증명은 통과하고, 같은 자격 증명은 다시 조회하지 않는다", async () => {
    assert.equal((await checkSessionCredential(request("token-a"), SESSION)).result, "match");
    assert.equal((await checkSessionCredential(request("token-a"), SESSION)).result, "match");
    assert.equal(lookups, 1);
  });

  it("enforce는 무효한 자격 증명을 401과 WWW-Authenticate로, 다른 주체의 자격 증명을 403으로 거부한다", async () => {
    const invalid = await checkSessionCredential(request("expired"), SESSION);
    assert.deepEqual(invalid, { result: "invalid", reject: 401 });
    const res401 = response();
    assert.equal(rejectSessionCredential(request("expired"), res401, invalid, 7), true);
    assert.equal(res401.statusCode, 401);
    assert.match(res401.headers["www-authenticate"], /oauth-protected-resource/);
    assert.equal(JSON.parse(res401.body).id, 7);

    const other = await checkSessionCredential(request("token-b"), SESSION);
    assert.deepEqual(other, { result: "mismatch", reject: 403 });
  });

  it("warn은 무효하거나 다른 주체의 자격 증명도 거부하지 않는다", async () => {
    process.env.MEMENTO_SESSION_CREDENTIAL_CHECK = "warn";
    assert.deepEqual(await checkSessionCredential(request("expired"), SESSION), { result: "invalid", reject: null });
    assert.deepEqual(await checkSessionCredential(request("token-b"), SESSION), { result: "mismatch", reject: null });
  });

  it("저장소 조회에 실패했거나 주체를 알 수 없는 옛 세션은 판정하지 않는다", async () => {
    assert.deepEqual(await checkSessionCredential(request("down"), SESSION), { result: "skipped", reject: null });
    const legacy = { ...SESSION, isMaster: undefined };
    assert.deepEqual(await checkSessionCredential(request("token-b"), legacy), { result: "skipped", reject: null });
  });
});
