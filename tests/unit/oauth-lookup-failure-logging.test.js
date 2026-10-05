/**
 * OAuth 키 조회 실패 기록 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-05
 *
 * API 키 조회가 실패해도 /authorize와 /token은 키에 묶이지 않은 클라이언트로 계속 진행한다.
 * 이 낙하가 일어났다는 사실이 경고 로그로 남는지, 그리고 진행 결과 자체는 바뀌지 않는지 확인한다.
 * 조회 실패의 원인 기록은 ApiKeyStore가 맡으므로 여기서는 낙하 사실만 본다.
 */

import { describe, it, mock, beforeEach } from "node:test";
import assert                              from "node:assert/strict";
import { createHash }                      from "node:crypto";

const VICTIM    = "550e8400-e29b-41d4-a716-446655440000";
const REDIRECT  = "https://example.test/cb";
const VERIFIER  = "v".repeat(64);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

const realStore  = await import("../../lib/admin/OAuthClientStore.js");
const realKeys   = await import("../../lib/admin/ApiKeyStore.js");
const realLogger = await import("../../lib/logger.js");

const warn = mock.fn();
let stored       = null;
let failRawKey   = null;
let failById     = false;

const dbError = (code) => Object.assign(new Error("lookup failed"), { code });

mock.module("../../lib/logger.js", {
  namedExports: { ...realLogger, logWarn: warn }
});
mock.module("../../lib/admin/OAuthClientStore.js", {
  namedExports: { ...realStore, getClient: async () => stored }
});
mock.module("../../lib/admin/ApiKeyStore.js", {
  namedExports: {
    ...realKeys,
    validateApiKeyFromDB: async (raw) => {
      if (failRawKey !== null && raw === failRawKey) throw dbError("57P01");
      return { valid: false };
    },
    validateApiKeyById: async () => {
      if (failById) throw dbError("ECONNRESET");
      return { valid: true, keyId: VICTIM };
    }
  }
});

const { handleAuthorize, handleToken, validateAccessToken } = await import("../../lib/oauth.js");

const warnings = () => warn.mock.calls.map(c => String(c.arguments[0]));

beforeEach(() => {
  warn.mock.resetCalls();
  stored     = null;
  failRawKey = null;
  failById   = false;
});

describe("OAuth 키 조회 실패 기록", () => {
  it("client_id 키 조회가 실패하면 낙하 사실을 남기고 다음 검증으로 간다", async () => {
    failRawKey = "mmcp_dbdown";
    const result = await handleAuthorize({
      response_type        : "code",
      client_id            : "mmcp_dbdown",
      redirect_uri         : "https://untrusted.test/cb",
      code_challenge       : CHALLENGE,
      code_challenge_method: "S256"
    });

    assert.equal(result.success, false, "등록되지 않은 클라이언트의 신뢰되지 않은 redirect_uri는 그대로 거부된다");
    const lines = warnings().filter(l => l.includes("API key client lookup failed"));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /code=57P01/);
    assert.doesNotMatch(lines[0], /mmcp_dbdown/, "키 원문은 로그에 남기지 않는다");
  });

  it("묶인 키 조회가 실패하면 낙하 사실을 남기되 발급은 키에 묶이지 않은 클라이언트로 진행한다", async () => {
    stored   = { client_id: "legit-conn_550e8400", client_name: `apikey:${VICTIM}`, redirect_uris: [REDIRECT] };
    failById = true;

    const auth = await handleAuthorize({
      response_type        : "code",
      client_id            : "legit-conn_550e8400",
      redirect_uri         : REDIRECT,
      code_challenge       : CHALLENGE,
      code_challenge_method: "S256",
      state                : "s"
    });

    assert.equal(auth.success, true);
    const lines = warnings().filter(l => l.includes("bound API key lookup failed"));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /code=ECONNRESET/);

    const tok = await handleToken({
      grant_type   : "authorization_code",
      code         : auth.code,
      redirect_uri : REDIRECT,
      code_verifier: VERIFIER
    });
    const valid = await validateAccessToken(tok.access_token);
    assert.equal(valid.bound_key_id, null, "조회가 실패하면 키 묶음은 인정되지 않는다");
  });

  it("/token의 client_secret 키 조회가 실패하면 낙하 사실을 남기고 토큰은 발급한다", async () => {
    stored = { client_id: "plain-client", client_name: "plain-client", redirect_uris: [REDIRECT] };
    const auth = await handleAuthorize({
      response_type        : "code",
      client_id            : "plain-client",
      redirect_uri         : REDIRECT,
      code_challenge       : CHALLENGE,
      code_challenge_method: "S256"
    });
    assert.equal(auth.success, true);

    failRawKey = "boom-secret";
    const tok = await handleToken({
      grant_type   : "authorization_code",
      code         : auth.code,
      redirect_uri : REDIRECT,
      code_verifier: VERIFIER,
      client_secret: "boom-secret"
    });

    assert.ok(tok.access_token, "조회 실패가 토큰 발급을 막지 않는다");
    const lines = warnings().filter(l => l.includes("client_secret key lookup failed"));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /code=57P01/);
    assert.doesNotMatch(lines[0], /boom-secret/, "secret 원문은 로그에 남기지 않는다");
  });

  it("조회가 정상이면 낙하 경고를 남기지 않는다", async () => {
    stored = { client_id: "legit-conn_550e8400", client_name: `apikey:${VICTIM}`, redirect_uris: [REDIRECT] };
    const auth = await handleAuthorize({
      response_type        : "code",
      client_id            : "legit-conn_550e8400",
      redirect_uri         : REDIRECT,
      code_challenge       : CHALLENGE,
      code_challenge_method: "S256"
    });
    assert.equal(auth.success, true);
    assert.deepEqual(warnings().filter(l => l.includes("lookup failed")), []);
  });
});
