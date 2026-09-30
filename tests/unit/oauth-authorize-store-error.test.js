/**
 * /authorize 저장소 오류 응답 경로 단위 시험
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

const TRUSTED_URI = "http://localhost:5555/cb";
const REG_URI     = "https://client.example/cb";
const REG         = { client_id: "reg-client", client_name: "Reg", redirect_uris: [REG_URI] };

const realStore = await import("../../lib/admin/OAuthClientStore.js");
const realKeys  = await import("../../lib/admin/ApiKeyStore.js");

let failLookup   = true;
let failRegister = false;

mock.module("../../lib/admin/OAuthClientStore.js", {
  namedExports: {
    ...realStore,
    getClient     : async (id) => {
      if (failLookup) throw new Error("relation \"oauth_clients\" does not exist");
      return id === REG.client_id ? REG : null;
    },
    registerClient: async (opts) => {
      if (failRegister) throw new Error("insert failed");
      return { ...opts };
    }
  }
});
mock.module("../../lib/admin/ApiKeyStore.js", {
  namedExports: { ...realKeys, validateApiKeyFromDB: async () => ({ valid: false }) }
});

const { handleOAuthAuthorize } = await import("../../lib/handlers/oauth-handler.js");

const PKCE = {
  response_type        : "code",
  code_challenge       : createHash("sha256").update("v".repeat(64)).digest("base64url"),
  code_challenge_method: "S256",
  state                : "s1"
};

let server;
let base;
let rejections = 0;

const onRejection = () => { rejections += 1; };

before(async () => {
  process.on("unhandledRejection", onRejection);
  server = http.createServer((req, res) => { handleOAuthAuthorize(req, res); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  process.off("unhandledRejection", onRejection);
  server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
});

/**
 * /authorize를 호출하고 상태와 JSON 본문의 error를 돌려준다. 응답이 없으면 시간 초과로 실패한다.
 */
async function call({ query = null, form = null }) {
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
  return { status: res.status, error, text };
}

/** 마이크로태스크와 타이머를 비워 늦게 보고되는 거부를 수집한다. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("/authorize 저장소 조회 실패", () => {
  it("GET은 500 server_error로 응답하고 미처리 거부를 남기지 않는다", async () => {
    failLookup     = true;
    const before   = rejections;
    const r        = await call({ query: { ...PKCE, client_id: "x", redirect_uri: TRUSTED_URI } });
    await settle();
    assert.equal(r.status, 500);
    assert.equal(r.error, "server_error");
    assert.equal(rejections, before);
  });

  it("POST allow는 500 server_error로 응답하고 미처리 거부를 남기지 않는다", async () => {
    failLookup     = true;
    const before   = rejections;
    const r        = await call({ form: { ...PKCE, decision: "allow", client_id: "x", redirect_uri: TRUSTED_URI } });
    await settle();
    assert.equal(r.status, 500);
    assert.equal(r.error, "server_error");
    assert.equal(rejections, before);
  });

  it("오류 본문에 조회 오류의 내부 문구를 싣지 않는다", async () => {
    failLookup = true;
    const r    = await call({ query: { ...PKCE, client_id: "x", redirect_uri: TRUSTED_URI } });
    assert.equal(r.text.includes("oauth_clients"), false);
  });

  it("POST deny는 조회 실패를 기록하고 신뢰 목록 기준으로 302를 유지한다", async () => {
    failLookup   = true;
    const before = rejections;
    const r      = await call({ form: { ...PKCE, decision: "deny", client_id: "x", redirect_uri: TRUSTED_URI } });
    await settle();
    assert.equal(r.status, 302);
    assert.equal(rejections, before);
  });
});

describe("/authorize 자동 등록 실패", () => {
  it("등록 실패는 기존대로 invalid_client 오류 응답으로 끝난다", async () => {
    failLookup   = false;
    failRegister = true;
    const before = rejections;
    const r      = await call({ query: { ...PKCE, client_id: "fresh-client", redirect_uri: TRUSTED_URI } });
    await settle();
    failRegister = false;
    assert.equal(r.status, 302);
    assert.equal(rejections, before);
  });
});

describe("/authorize 정상 경로", () => {
  it("저장소가 정상이면 등록 클라이언트의 동의 화면을 200으로 보여준다", async () => {
    failLookup = false;
    const r    = await call({ query: { ...PKCE, client_id: REG.client_id, redirect_uri: REG_URI } });
    assert.equal(r.status, 200);
  });
});
