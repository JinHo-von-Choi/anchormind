/**
 * 키 회전 퇴역 뒤 OAuth 토큰 시험(저장소 대체)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-04
 *
 * 키에 묶인 access token은 발급 시각(issued_at)을 돌려준다. 키의 지난 회전 퇴역 시각보다 먼저 발급된 refresh token은
 * 거부하고, 그 뒤에 발급된 토큰과 client_secret으로 현재 키를 다시 제시한 요청은 받는다. 퇴역 시각이 없는 키는 그대로다.
 */
import { describe, it, mock, beforeEach } from "node:test";
import assert                              from "node:assert/strict";
import { createHash }                      from "node:crypto";

const KEY_ID   = "550e8400-e29b-41d4-a716-4466554400b2";
const REDIRECT = "https://example.test/cb";
const RAW_KEY  = `mmcp_rotor_${"d".repeat(32)}`;

const realStore = await import("../../lib/admin/OAuthClientStore.js");
const realKeys  = await import("../../lib/admin/ApiKeyStore.js");

let retirements = [];

mock.module("../../lib/admin/OAuthClientStore.js", {
  namedExports: { ...realStore, getClient: async () => ({ client_id: "conn_550e8400", client_name: `apikey:${KEY_ID}`, redirect_uris: [REDIRECT] }) }
});
mock.module("../../lib/admin/ApiKeyStore.js", {
  namedExports: {
    ...realKeys,
    validateApiKeyFromDB: async (raw) => (raw === RAW_KEY ? { valid: true, keyId: KEY_ID } : { valid: false }),
    validateApiKeyById  : async () => ({ valid: true, keyId: KEY_ID, secretRetirements: retirements })
  }
});

const { handleAuthorize, handleToken, validateAccessToken } = await import("../../lib/oauth.js");

const VERIFIER  = "w".repeat(64);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

async function issue() {
  const auth = await handleAuthorize({
    response_type: "code", client_id: "conn_550e8400", redirect_uri: REDIRECT,
    code_challenge: CHALLENGE, code_challenge_method: "S256", state: "s"
  });
  return handleToken({ grant_type: "authorization_code", code: auth.code, redirect_uri: REDIRECT, code_verifier: VERIFIER, client_secret: RAW_KEY });
}

beforeEach(() => { retirements = []; });

describe("키에 묶인 OAuth 토큰과 회전 퇴역", () => {
  it("access token 검증 결과에 발급 시각이 있다", async () => {
    const before = Date.now();
    const tok    = await issue();
    const v      = await validateAccessToken(tok.access_token);
    assert.equal(v.bound_key_id, KEY_ID);
    assert.ok(v.issued_at >= before && v.issued_at <= Date.now());
  });

  it("퇴역 시각이 없으면 refresh가 된다", async () => {
    const tok = await issue();
    const r   = await handleToken({ grant_type: "refresh_token", refresh_token: tok.refresh_token });
    assert.equal(r.access_token !== undefined, true, JSON.stringify(r));
  });

  it("지난 퇴역 시각보다 먼저 발급된 refresh token은 invalid_grant다", async () => {
    const tok   = await issue();
    retirements = [new Date(Date.now() + 5)];
    await new Promise((resolve) => setTimeout(resolve, 15));
    const r = await handleToken({ grant_type: "refresh_token", refresh_token: tok.refresh_token });
    assert.equal(r.success, false);
    assert.equal(r.error, "invalid_grant");
  });

  it("client_secret으로 현재 키를 제시하면 다시 묶어 발급한다", async () => {
    const tok   = await issue();
    retirements = [new Date(Date.now() + 5)];
    await new Promise((resolve) => setTimeout(resolve, 15));
    const r = await handleToken({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_secret: RAW_KEY });
    assert.ok(r.access_token, JSON.stringify(r));
  });
});
