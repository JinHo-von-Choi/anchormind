import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

/**
 * /register 의 client_name 저장 규칙 단위 시험.
 * 저장소 계층은 대체하고 핸들러가 넘기는 값만 관찰한다.
 */
const saved = [];

const realStore = await import("../../lib/admin/OAuthClientStore.js");

mock.module("../../lib/admin/OAuthClientStore.js", {
  namedExports: {
    ...realStore,
    registerClient: async (opts) => {
      saved.push(opts);
      return {
        client_id      : opts.client_id || "mmcp_test",
        client_name    : opts.client_name ?? null,
        redirect_uris  : opts.redirect_uris,
        grant_types    : ["authorization_code"],
        response_types : ["code"],
        scope          : "mcp"
      };
    }
  }
});

const { handleOAuthRegister } = await import("../../lib/handlers/oauth-handler.js");

describe("POST /register client_name 처리", () => {
  let server;
  let base;

  before(async () => {
    server = http.createServer((req, res) => { handleOAuthRegister(req, res); });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => new Promise(resolve => server.close(resolve)));

  const post = (body) => fetch(`${base}/register`, {
    method : "POST",
    headers: { "content-type": "application/json" },
    body   : JSON.stringify(body)
  });

  const VICTIM = "550e8400-e29b-41d4-a716-446655440000";

  for (const name of [`apikey:${VICTIM}`, `APIKEY:${VICTIM}`, `apikey:${VICTIM.toUpperCase()}`]) {
    it(`인증 없는 요청의 "${name}" 는 저장하지 않는다`, async () => {
      saved.length = 0;
      const res = await post({ client_name: name, redirect_uris: ["https://example.test/cb"] });
      assert.equal(res.status, 201);
      assert.equal(saved.length, 1);
      assert.equal(saved[0].client_name, null);
    });
  }

  it("일반 client_name 은 그대로 저장한다", async () => {
    saved.length = 0;
    const res = await post({ client_name: "My Connector", redirect_uris: ["https://example.test/cb"] });
    assert.equal(res.status, 201);
    assert.equal(saved[0].client_name, "My Connector");
  });
});
