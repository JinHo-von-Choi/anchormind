/**
 * DCR 클라이언트 정리, 등록 상한, 갱신 토큰 만료 시험.
 * 실제 purgeUnusedClients, handleOAuthRegister, handleAuthorize/handleToken을 호출한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */
import { describe, it, before, after, beforeEach, mock } from "node:test";
import assert                                            from "node:assert/strict";
import http                                              from "node:http";
import { createHash }                                    from "node:crypto";

process.env.DOTENV_CONFIG_PATH      ??= ".env.test";
process.env.MEMENTO_METRICS_DEFAULT ??= "off";
process.env.REDIS_ENABLED           ??= "false";
process.env.CACHE_ENABLED           ??= "false";

const KEY_ID  = "550e8400-e29b-41d4-a716-446655440000";
const RAW_KEY = `mmcp_owner_${"d".repeat(32)}`;

const realStore = await import("../../lib/admin/OAuthClientStore.js");
const realKeys  = await import("../../lib/admin/ApiKeyStore.js");
mock.module("../../lib/admin/OAuthClientStore.js", {
  namedExports: {
    ...realStore,
    getClient     : async () => null,
    registerClient: async (opts) => ({ client_id: "mmcp_0123456789abcdef0123456789abcdef", client_name: null,
      redirect_uris: opts.redirect_uris, grant_types: ["authorization_code"], response_types: ["code"], scope: "mcp" })
  }
});
mock.module("../../lib/admin/ApiKeyStore.js", {
  namedExports: {
    ...realKeys,
    validateApiKeyFromDB: async (raw) => (raw === RAW_KEY ? { valid: true, keyId: KEY_ID } : { valid: false }),
    validateApiKeyById  : async (id) => (id === KEY_ID ? { valid: true, keyId: KEY_ID } : { valid: false })
  }
});

const { purgeUnusedClients }                            = await import("../../lib/admin/OAuthClientStore.js");
const { handleOAuthRegister, _resetDcrWindowForTest }   = await import("../../lib/handlers/oauth-handler.js");
const { handleAuthorize, handleToken }                  = await import("../../lib/oauth.js");
const { OAUTH_REFRESH_TTL_SECONDS }                     = await import("../../lib/config.js");

/** SQL과 인자를 기록하고 정해 둔 결과를 돌려주는 풀 대역 */
function recordingPool({ count = 3, sample = [], deletes = [] } = {}) {
  const calls = [];
  const queue = [...deletes];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/COUNT\(\*\)/.test(sql))  return { rows: [{ n: count }] };
      if (/^\s*SELECT client_id/.test(sql)) return { rows: sample };
      if (/^\s*DELETE/.test(sql))   return { rowCount: queue.shift() ?? 0 };
      throw new Error(`unexpected SQL: ${sql.slice(0, 40)}`);
    }
  };
}

describe("purgeUnusedClients", () => {
  it("기본은 삭제하지 않고 후보 수와 가린 표본만 돌려준다", async () => {
    const pool = recordingPool({ count: 426, sample: [
      { client_id: "mmcp_0123456789abcdef0123456789abcdef", created_at: "2026-08-01", first_redirect: "https://antigravity.google/cb" },
      { client_id: RAW_KEY, created_at: "2026-08-02", first_redirect: "http://localhost:1/cb" }
    ] });
    const r = await purgeUnusedClients(pool, {});
    assert.equal(r.execute, false);
    assert.equal(r.candidates, 426);
    assert.equal(r.deleted, 0);
    assert.equal(r.sample[0].redirect_host, "antigravity.google");
    assert.equal(r.sample[1].client_id, "mmcp_****");
    assert.equal(pool.calls.some((c) => /DELETE/.test(c.sql)), false);
  });

  it("대상 조건은 미사용, 기준일 경과, 키 묶음 제외다", async () => {
    const pool = recordingPool();
    await purgeUnusedClients(pool, { olderThanDays: 45 });
    const where = pool.calls[0].sql;
    assert.match(where, /last_used_at IS NULL/);
    assert.match(where, /make_interval\(days => \$1\)/);
    assert.match(where, /client_name !~\* '\^apikey:'/);
    assert.equal(pool.calls[0].params[0], 45);
  });

  it("execute는 batchSize보다 적게 지워질 때까지 나눠 지운다", async () => {
    const pool = recordingPool({ deletes: [200, 200, 26] });
    const r    = await purgeUnusedClients(pool, { execute: true });
    assert.equal(r.deleted, 426);
    assert.equal(pool.calls.filter((c) => /DELETE/.test(c.sql)).length, 3);
  });

  it("기준일이 양의 정수가 아니면 거부한다", async () => {
    await assert.rejects(() => purgeUnusedClients(recordingPool(), { olderThanDays: 0 }), /olderThanDays/);
  });
});

describe("/register 시간당 상한", () => {
  let server;
  let base;
  before(async () => {
    server = http.createServer((req, res) => handleOAuthRegister(req, res));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => {
    delete process.env.MEMENTO_DCR_MAX_PER_HOUR;
    return new Promise((resolve) => server.close(resolve));
  });
  beforeEach(() => _resetDcrWindowForTest());

  const registerResponse = (rawKey) => fetch(`${base}/register`, {
    method : "POST",
    headers: { "content-type": "application/json", ...(rawKey ? { authorization: `Bearer ${rawKey}` } : {}) },
    body   : JSON.stringify({ redirect_uris: ["http://localhost:1/cb"] })
  });
  const register      = () => registerResponse().then((r) => r.status);
  const registerBound = (rawKey = RAW_KEY) => registerResponse(rawKey).then((r) => r.status);

  it("상한을 넘으면 429", async () => {
    process.env.MEMENTO_DCR_MAX_PER_HOUR = "2";
    assert.deepEqual([await register(), await register(), await register()], [201, 201, 429]);
  });

  it("0이면 상한이 없다", async () => {
    process.env.MEMENTO_DCR_MAX_PER_HOUR = "0";
    for (let i = 0; i < 5; i++) assert.equal(await register(), 201);
  });

  it("키에 묶인 등록은 무인증 등록과 별도 집계라 무인증 상한이 차도 통과한다", async () => {
    process.env.MEMENTO_DCR_MAX_PER_HOUR = "2";
    assert.deepEqual([await register(), await register(), await register()], [201, 201, 429]);
    assert.equal(await registerBound(), 201);
    assert.equal(await registerBound(), 201);
    assert.equal(await registerBound(), 429);
    assert.equal(await register(), 429);
  });

  it("유효하지 않은 Bearer는 무인증 집계에 들어간다", async () => {
    process.env.MEMENTO_DCR_MAX_PER_HOUR = "1";
    assert.equal(await registerBound("mmcp_owner_" + "e".repeat(32)), 201);
    assert.equal(await register(), 429);
  });

  it("429의 Retry-After는 현재 창의 남은 초를 올림한 값이다", async (t) => {
    process.env.MEMENTO_DCR_MAX_PER_HOUR = "1";
    t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 9, 3) });
    assert.equal(await register(), 201);
    t.mock.timers.tick(1_000_500);
    const res = await registerResponse();
    assert.equal(res.status, 429);
    assert.equal(res.headers.get("retry-after"), "2600");
  });

  it("창 끝 직전의 Retry-After는 1 이상이다", async (t) => {
    process.env.MEMENTO_DCR_MAX_PER_HOUR = "1";
    t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 9, 3) });
    assert.equal(await register(), 201);
    t.mock.timers.tick(3_600_000 - 1);
    const res = await registerResponse();
    assert.equal(res.status, 429);
    assert.equal(res.headers.get("retry-after"), "1");
  });
});

describe("갱신 토큰 만료", () => {
  it("갱신 토큰은 OAUTH_REFRESH_TTL_SECONDS가 지나면 거부된다", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 9, 3) });
    const verifier  = "w".repeat(64);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const auth      = await handleAuthorize({
      response_type: "code", client_id: RAW_KEY, redirect_uri: "http://localhost:1/cb",
      code_challenge: challenge, code_challenge_method: "S256", state: "s"
    });
    const tok = await handleToken({ grant_type: "authorization_code", code: auth.code, redirect_uri: "http://localhost:1/cb", code_verifier: verifier });
    assert.ok(tok.refresh_token);
    t.mock.timers.tick(OAUTH_REFRESH_TTL_SECONDS * 1000 + 1000);
    const again = await handleToken({ grant_type: "refresh_token", refresh_token: tok.refresh_token });
    assert.equal(again.error, "invalid_grant");
    assert.equal(again.error_description, "Refresh token expired");
  });
});
