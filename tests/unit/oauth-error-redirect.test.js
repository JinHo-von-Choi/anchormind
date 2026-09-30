/**
 * /authorize 오류 응답 경로 단위 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-09-30
 */
import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";

process.env.DOTENV_CONFIG_PATH      ??= ".env.test";
process.env.MEMENTO_METRICS_DEFAULT ??= "off";
process.env.REDIS_ENABLED           ??= "false";
process.env.CACHE_ENABLED           ??= "false";

const REG_URI   = "https://client.example/cb";
const OTHER_URI = "https://elsewhere.example/cb";
const LOCAL_URI = "http://localhost:5555/cb";
const REG       = { client_id: "reg-client", client_name: "Reg", redirect_uris: [REG_URI] };

const realStore = await import("../../lib/admin/OAuthClientStore.js");
const realKeys  = await import("../../lib/admin/ApiKeyStore.js");

mock.module("../../lib/admin/OAuthClientStore.js", {
  namedExports: {
    ...realStore,
    getClient     : async (id) => (id === REG.client_id ? REG : null),
    registerClient: async (opts) => ({ ...opts })
  }
});
mock.module("../../lib/admin/ApiKeyStore.js", {
  namedExports: { ...realKeys, validateApiKeyFromDB: async () => ({ valid: false }) }
});

const { handleOAuthAuthorize, resolveErrorRedirect } = await import("../../lib/handlers/oauth-handler.js");

const PKCE = {
  response_type        : "code",
  code_challenge       : createHash("sha256").update("v".repeat(64)).digest("base64url"),
  code_challenge_method: "S256",
  state                : "s1"
};

let server;
let base;

before(async () => {
  server = http.createServer((req, res) => { handleOAuthAuthorize(req, res); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  delete process.env.MEMENTO_OAUTH_REDIRECT_CHECK;
  server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
});

/**
 * 모드를 지정해 /authorize를 호출하고 상태, Location, JSON 본문의 error를 돌려준다.
 */
async function call(mode, { query = null, form = null }) {
  if (mode) process.env.MEMENTO_OAUTH_REDIRECT_CHECK = mode;
  else delete process.env.MEMENTO_OAUTH_REDIRECT_CHECK;

  const qs  = query ? `?${new URLSearchParams(query)}` : "";
  const res = await fetch(`${base}/authorize${qs}`, {
    method  : form ? "POST" : "GET",
    redirect: "manual",
    signal  : AbortSignal.timeout(2000),
    headers : form ? { "content-type": "application/x-www-form-urlencoded" } : {},
    body    : form ? new URLSearchParams(form).toString() : undefined
  });
  const text = await res.text();
  let error  = null;
  try { error = JSON.parse(text).error ?? null; } catch { error = null; }
  return { status: res.status, location: res.headers.get("location"), error };
}

const hostOf = (loc) => (loc ? new URL(loc).host : null);

describe("resolveErrorRedirect", () => {
  it("값이 없거나 URL이 아니면 url이 null이다", () => {
    assert.equal(resolveErrorRedirect(null, null).url, null);
    assert.equal(resolveErrorRedirect("::not a url::", REG).url, null);
  });

  it("등록된 클라이언트는 등록 URI와 정확히 같을 때만 검증된다", () => {
    assert.equal(resolveErrorRedirect(REG_URI, REG).verified, true);
    assert.equal(resolveErrorRedirect(`${REG_URI}/`, REG).verified, false);
    assert.equal(resolveErrorRedirect(OTHER_URI, REG).verified, false);
  });

  it("클라이언트가 없으면 신뢰 목록 기준으로 검증한다", () => {
    assert.equal(resolveErrorRedirect(LOCAL_URI, null).verified, true);
    assert.equal(resolveErrorRedirect(OTHER_URI, null).verified, false);
  });
});

describe("GET /authorize 미등록 클라이언트", () => {
  const query = { ...PKCE, client_id: "unknown-client", redirect_uri: OTHER_URI };

  it("warn(기본)은 현행대로 302를 유지한다", async () => {
    const r = await call(null, { query });
    assert.equal(r.status, 302);
    assert.equal(hostOf(r.location), "elsewhere.example");
  });

  it("enforce는 검증되지 않은 대상으로 이동시키지 않고 400을 준다", async () => {
    const r = await call("enforce", { query });
    assert.equal(r.status, 400);
    assert.equal(r.location, null);
    assert.equal(r.error, "invalid_client");
  });
});

describe("POST /authorize 거부", () => {
  it("등록 URI로는 두 모드 모두 access_denied와 state를 붙여 302", async () => {
    for (const mode of [null, "enforce"]) {
      const r = await call(mode, { form: { ...PKCE, decision: "deny", client_id: REG.client_id, redirect_uri: REG_URI } });
      assert.equal(r.status, 302);
      const loc = new URL(r.location);
      assert.equal(`${loc.origin}${loc.pathname}`, REG_URI);
      assert.equal(loc.searchParams.get("error"), "access_denied");
      assert.equal(loc.searchParams.get("state"), "s1");
    }
  });

  it("enforce에서 등록되지 않은 URI는 400", async () => {
    const r = await call("enforce", { form: { ...PKCE, decision: "deny", client_id: REG.client_id, redirect_uri: OTHER_URI } });
    assert.equal(r.status, 400);
    assert.equal(r.location, null);
  });

  it("미등록 클라이언트라도 신뢰 목록의 URI면 enforce에서도 302", async () => {
    const r = await call("enforce", { form: { ...PKCE, decision: "deny", client_id: "unknown-client", redirect_uri: LOCAL_URI } });
    assert.equal(r.status, 302);
    assert.equal(hostOf(r.location), "localhost:5555");
  });

  it("redirect_uri가 없거나 URL이 아니면 두 모드 모두 제한 시간 안에 400", async () => {
    for (const mode of [null, "enforce"]) {
      for (const uri of [undefined, "::not a url::"]) {
        const form = { ...PKCE, decision: "deny", client_id: REG.client_id };
        if (uri !== undefined) form.redirect_uri = uri;
        const r = await call(mode, { form });
        assert.equal(r.status, 400);
        assert.equal(r.error, "access_denied");
      }
    }
  });
});

describe("POST /authorize 허용 후 오류", () => {
  const form = { ...PKCE, decision: "allow", client_id: REG.client_id, redirect_uri: OTHER_URI };

  it("warn은 현행대로 302를 유지한다", async () => {
    const r = await call(null, { form });
    assert.equal(r.status, 302);
  });

  it("enforce에서 등록되지 않은 URI는 400 invalid_request", async () => {
    const r = await call("enforce", { form });
    assert.equal(r.status, 400);
    assert.equal(r.location, null);
    assert.equal(r.error, "invalid_request");
  });
});
