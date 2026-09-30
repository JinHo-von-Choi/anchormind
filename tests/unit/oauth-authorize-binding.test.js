import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

/**
 * /authorize 의 키 바인딩 인정 조건 단위 시험.
 * 서버가 부여한 client_id 형식(<이름>_<keyId 앞 8자>)일 때만 바인딩을 인정한다.
 */
const VICTIM   = "550e8400-e29b-41d4-a716-446655440000";
const REDIRECT = "https://example.test/cb";

const realStore = await import("../../lib/admin/OAuthClientStore.js");
const realKeys  = await import("../../lib/admin/ApiKeyStore.js");

let stored = null;

mock.module("../../lib/admin/OAuthClientStore.js", {
  namedExports: { ...realStore, getClient: async () => stored }
});
mock.module("../../lib/admin/ApiKeyStore.js", {
  namedExports: {
    ...realKeys,
    validateApiKeyFromDB: async () => ({ valid: false }),
    validateApiKeyById  : async () => ({ valid: true, keyId: VICTIM })
  }
});

const { handleAuthorize, handleToken, validateAccessToken } = await import("../../lib/oauth.js");

const VERIFIER  = "v".repeat(64);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

async function issueToken(clientId) {
  const auth = await handleAuthorize({
    response_type        : "code",
    client_id            : clientId,
    redirect_uri         : REDIRECT,
    code_challenge       : CHALLENGE,
    code_challenge_method: "S256",
    state                : "s"
  });
  assert.equal(auth.success, true);
  const tok = await handleToken({
    grant_type   : "authorization_code",
    code         : auth.code,
    redirect_uri : REDIRECT,
    code_verifier: VERIFIER
  });
  return validateAccessToken(tok.access_token);
}

describe("/authorize 키 바인딩 인정 조건", () => {
  it("서버가 부여한 client_id 형식이면 바인딩을 인정한다", async () => {
    stored = { client_id: "legit-conn_550e8400", client_name: `apikey:${VICTIM}`, redirect_uris: [REDIRECT] };
    const v = await issueToken("legit-conn_550e8400");
    assert.equal(v.bound_key_id, VICTIM);
  });

  it("무인증 등록 형식의 client_id 는 마커가 있어도 바인딩하지 않는다", async () => {
    stored = { client_id: "mmcp_0123456789abcdef0123456789abcdef", client_name: `apikey:${VICTIM}`, redirect_uris: [REDIRECT] };
    const v = await issueToken("mmcp_0123456789abcdef0123456789abcdef");
    assert.equal(v.bound_key_id, null);
    assert.equal(v.is_api_key, false);
  });
});
