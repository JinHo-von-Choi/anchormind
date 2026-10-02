/**
 * 키에 묶인 OAuth 클라이언트의 토큰 교환 조건 시험.
 * 실제 /register, /authorize, /token 핸들러를 로컬 HTTP 서버에 물리고 저장소 계층만 대체한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */
import { describe, it, before, after, mock, beforeEach } from "node:test";
import assert                                            from "node:assert/strict";
import http                                              from "node:http";
import { createHash }                                    from "node:crypto";

process.env.DOTENV_CONFIG_PATH      ??= ".env.test";
process.env.MEMENTO_METRICS_DEFAULT ??= "off";
process.env.REDIS_ENABLED           ??= "false";
process.env.CACHE_ENABLED           ??= "false";

const VICTIM     = "550e8400-e29b-41d4-a716-446655440000";
const OTHER      = "660e8400-e29b-41d4-a716-446655440000";
const RAW_VICTIM = `mmcp_victim_${"a".repeat(32)}`;
const RAW_OTHER  = `mmcp_other_${"b".repeat(32)}`;
const BOUND_ID   = "victim-conn_550e8400";
const LOCAL_CB   = "http://localhost:33418/callback";
const APP_CB     = "https://victim-app.example/cb";

const keyRecord = {
  [VICTIM]: { valid: true, keyId: VICTIM, name: "victim", groupKeyIds: [VICTIM], permissions: ["read", "write"] },
  [OTHER] : { valid: true, keyId: OTHER,  name: "other",  groupKeyIds: [OTHER],  permissions: ["read", "write"] }
};
const registered = [];

const realStore = await import("../../lib/admin/OAuthClientStore.js");
const realKeys  = await import("../../lib/admin/ApiKeyStore.js");

mock.module("../../lib/admin/OAuthClientStore.js", {
  namedExports: {
    ...realStore,
    getClient     : async (id) => (id === BOUND_ID
      ? { client_id: BOUND_ID, client_name: `apikey:${VICTIM}`, redirect_uris: [LOCAL_CB, APP_CB] }
      : null),
    registerClient: async (opts) => {
      registered.push(opts);
      return { client_id: opts.client_id || "mmcp_0123456789abcdef0123456789abcdef", client_name: opts.client_name ?? null,
               redirect_uris: opts.redirect_uris, grant_types: ["authorization_code"], response_types: ["code"], scope: "mcp" };
    }
  }
});
mock.module("../../lib/admin/ApiKeyStore.js", {
  namedExports: {
    ...realKeys,
    validateApiKeyFromDB: async (raw) => (raw === RAW_VICTIM ? keyRecord[VICTIM] : raw === RAW_OTHER ? keyRecord[OTHER] : { valid: false }),
    validateApiKeyById  : async (id) => keyRecord[id] ?? { valid: false }
  }
});

const { handleOAuthAuthorize, handleOAuthToken, handleOAuthRegister } = await import("../../lib/handlers/oauth-handler.js");
const { validateAuthentication }                                      = await import("../../lib/auth.js");

const VERIFIER  = "v".repeat(64);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

let server;
let base;

before(async () => {
  server = http.createServer((req, res) => {
    if (req.url.startsWith("/token"))    return handleOAuthToken(req, res);
    if (req.url.startsWith("/register")) return handleOAuthRegister(req, res);
    return handleOAuthAuthorize(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

beforeEach(() => { registered.length = 0; });

function authorizeQuery(clientId, redirectUri) {
  return new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: redirectUri,
    code_challenge: CHALLENGE, code_challenge_method: "S256", state: "s"
  });
}

/** POST /authorize decision=allow 로 코드를 받는다. */
async function allowCode(clientId, redirectUri) {
  const body = authorizeQuery(clientId, redirectUri);
  body.set("decision", "allow");
  const res = await fetch(`${base}/authorize`, {
    method : "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    redirect: "manual"
  });
  assert.equal(res.status, 302);
  return new URL(res.headers.get("location")).searchParams.get("code");
}

async function exchange(code, redirectUri, extra = {}, headers = {}) {
  const res = await fetch(`${base}/token`, {
    method : "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body   : new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: VERIFIER, ...extra })
  });
  return { status: res.status, body: await res.json() };
}

describe("키에 묶인 클라이언트의 토큰 교환", () => {
  it("client_secret 없이 교환하면 invalid_client(401)로 거부한다", async () => {
    const code = await allowCode(BOUND_ID, APP_CB);
    const r    = await exchange(code, APP_CB);
    assert.equal(r.status, 401);
    assert.equal(r.body.error, "invalid_client");
    assert.equal(r.body.access_token, undefined);
  });

  it("다른 키를 client_secret으로 내면 거부한다", async () => {
    const code = await allowCode(BOUND_ID, APP_CB);
    const r    = await exchange(code, APP_CB, { client_secret: RAW_OTHER });
    assert.equal(r.status, 401);
    assert.equal(r.body.error, "invalid_client");
  });

  it("묶인 키를 client_secret으로 내면 그 키 범위의 토큰을 발급한다", async () => {
    const code = await allowCode(BOUND_ID, APP_CB);
    const r    = await exchange(code, APP_CB, { client_secret: RAW_VICTIM });
    assert.equal(r.status, 200);
    const auth = await validateAuthentication({ headers: { authorization: `Bearer ${r.body.access_token}` } }, null);
    assert.equal(auth.valid, true);
    assert.equal(auth.keyId, VICTIM);
  });

  it("client_secret_basic 헤더도 같은 판정에 쓴다", async () => {
    const code  = await allowCode(BOUND_ID, APP_CB);
    const basic = Buffer.from(`${BOUND_ID}:${RAW_VICTIM}`).toString("base64");
    const r     = await exchange(code, APP_CB, {}, { authorization: `Basic ${basic}` });
    assert.equal(r.status, 200);
  });

  it("묶인 클라이언트는 신뢰 redirect여도 GET에서 바로 코드를 내지 않고 동의 화면을 보인다", async () => {
    const res = await fetch(`${base}/authorize?${authorizeQuery(BOUND_ID, LOCAL_CB)}`, { redirect: "manual" });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /^text\/html/);
  });
});

describe("묶이지 않은 흐름", () => {
  it("미등록 client_id와 신뢰 redirect는 GET에서 코드를 내고, 키를 client_secret으로 내면 키 범위 토큰이 된다", async () => {
    const res = await fetch(`${base}/authorize?${authorizeQuery("claude-connector", LOCAL_CB)}`, { redirect: "manual" });
    assert.equal(res.status, 302);
    const code = new URL(res.headers.get("location")).searchParams.get("code");
    const r    = await exchange(code, LOCAL_CB, { client_secret: RAW_VICTIM });
    assert.equal(r.status, 200);
    const auth = await validateAuthentication({ headers: { authorization: `Bearer ${r.body.access_token}` } }, null);
    assert.equal(auth.keyId, VICTIM);
  });

  it("API 키 원문 client_id는 클라이언트 행으로 저장하지 않고 흐름을 이어 간다", async () => {
    const res = await fetch(`${base}/authorize?${authorizeQuery(RAW_VICTIM, LOCAL_CB)}`, { redirect: "manual" });
    assert.equal(res.status, 302);
    assert.equal(registered.length, 0);
  });
});

describe("/register 응답", () => {
  it("Bearer 키로 등록한 클라이언트는 client_secret_post 방식을 안내한다", async () => {
    const res  = await fetch(`${base}/register`, {
      method : "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${RAW_VICTIM}` },
      body   : JSON.stringify({ redirect_uris: [APP_CB] })
    });
    const body = await res.json();
    assert.equal(res.status, 201);
    assert.equal(body.token_endpoint_auth_method, "client_secret_post");
  });

  it("헤더 없이 등록한 클라이언트는 none을 유지한다", async () => {
    const res  = await fetch(`${base}/register`, {
      method : "POST",
      headers: { "content-type": "application/json" },
      body   : JSON.stringify({ redirect_uris: [APP_CB] })
    });
    assert.equal((await res.json()).token_endpoint_auth_method, "none");
  });
});
