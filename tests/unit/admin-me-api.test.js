/**
 * GET /me, GET /me/explain 관리 API 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 실제 handleAdminApi를 부르고 API 키 저장소 조회만 대체한다. 마스터 키는 owner 주체, 활성 API 키 Bearer는
 * 자기 정보 라우트에서만 service 주체가 되며, 다른 관리 라우트에서는 지금처럼 401이다. explain은 결정 표의
 * 판정과 거부 단계를 돌려주고 토큰 값은 싣지 않는다.
 */

import { describe, it, before, after, mock } from "node:test";
import assert                                from "node:assert/strict";
import http                                  from "node:http";

process.env.DOTENV_CONFIG_PATH      ??= ".env.test";
process.env.MEMENTO_METRICS_DEFAULT ??= "off";
process.env.REDIS_ENABLED           ??= "false";
process.env.CACHE_ENABLED           ??= "false";

const KEY_TOKEN = "mmcp_test_reader_token_0001";
const KEY_ID    = "7a1e0000-0000-4000-8000-0000000000e2";

const realKeys = await import("../../lib/admin/ApiKeyStore.js");
mock.module("../../lib/admin/ApiKeyStore.js", {
  namedExports: {
    ...realKeys,
    validateApiKeyFromDB: async (token) => (token === KEY_TOKEN
      ? { valid: true, keyId: KEY_ID, name: "reader", permissions: ["read"], groupKeyIds: [KEY_ID] }
      : { valid: false }),
    getAllowedWorkspaces: async () => ["ws-a"]
  }
});

const { handleAdminApi }             = await import("../../lib/admin/admin-routes.js");
const { ADMIN_BASE }                 = await import("../../lib/admin/admin-auth.js");
const { _resetAdminAuthGuardForTest } = await import("../../lib/admin/admin-login-guard.js");
const { ACCESS_KEY }                 = await import("../../lib/config.js");
const { CAPABILITIES }               = await import("../../lib/admin/capabilities.js");

let server;
let base;

before(async () => {
  server = http.createServer((req, res) => handleAdminApi(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}${ADMIN_BASE}`;
});

after(async () => {
  _resetAdminAuthGuardForTest();
  await new Promise((resolve) => server.close(resolve));
});

const get = (path, token) => fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });

describe("GET /me", () => {
  it("마스터 키는 owner 주체이고 모든 능력을 가진다", async () => {
    const res  = await get("/me", ACCESS_KEY);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.principal, { kind: "master", id: "master", roles: ["owner"] });
    assert.deepEqual(body.capabilities.map((c) => c.cap), [...CAPABILITIES]);
    assert.ok(body.capabilities.every((c) => c.range.all === true));
  });

  it("API 키는 service 주체이고 permissions가 준 능력과 키 범위만 보인다", async () => {
    const res  = await get("/me", KEY_TOKEN);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(!text.includes(KEY_TOKEN));
    const body = JSON.parse(text);
    assert.deepEqual(body.principal, { kind: "api_key", id: KEY_ID, roles: ["service"] });
    assert.deepEqual(body.capabilities, [{ cap: "mem.read", mode: "S", range: { all: false, workspaces: ["ws-a"] } }]);
  });

  it("키가 아닌 Bearer는 401이다", async () => {
    _resetAdminAuthGuardForTest();
    const res = await get("/me", "not-a-key");
    assert.equal(res.status, 401);
    _resetAdminAuthGuardForTest();
  });
});

describe("GET /me/explain", () => {
  it("능력이 없으면 capability 단계 거부와 근거를 돌려준다", async () => {
    const body = await (await get("/me/explain?cap=mem.write&workspace=ws-a", KEY_TOKEN)).json();
    assert.equal(body.allowed, false);
    assert.equal(body.deniedAt, "capability");
    assert.deepEqual(body.steps.find((s) => s.step === "capability").permissions, ["read"]);
  });

  it("범위 밖 workspace는 workspace 단계 거부, 범위 안은 허용이다", async () => {
    const out = await (await get("/me/explain?cap=mem.read&workspace=ws-b", KEY_TOKEN)).json();
    assert.equal(out.deniedAt, "workspace");
    assert.equal(out.reason, "workspace_out_of_range");
    const inside = await (await get("/me/explain?cap=mem.read&workspace=ws-a", KEY_TOKEN)).json();
    assert.equal(inside.allowed, true);
    assert.equal(inside.mode, "S");
  });

  it("마스터 키는 owner 전용 능력도 허용이다", async () => {
    const body = await (await get("/me/explain?cap=system.update", ACCESS_KEY)).json();
    assert.equal(body.allowed, true);
    assert.equal(body.principal.kind, "master");
  });

  it("cap이 없거나 모르는 능력이거나 workspace 형식이 틀리면 400과 필드 이름이다", async () => {
    for (const [query, field] of [["", "cap"], ["?cap=mem.all", "cap"], [`?cap=mem.read&workspace=${"w".repeat(129)}`, "workspace"]]) {
      const res = await get(`/me/explain${query}`, ACCESS_KEY);
      assert.equal(res.status, 400, query);
      assert.equal((await res.json()).field, field);
    }
  });
});

describe("API 키와 다른 관리 라우트", () => {
  it("API 키 Bearer로 키 목록과 기억 목록을 부르면 401이다", async () => {
    _resetAdminAuthGuardForTest();
    for (const path of ["/keys", "/memory/fragments?workspace=ws-a", "/stats"]) {
      const res = await get(path, KEY_TOKEN);
      assert.equal(res.status, 401, path);
    }
    _resetAdminAuthGuardForTest();
  });
});
