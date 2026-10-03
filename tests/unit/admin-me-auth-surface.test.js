/**
 * 자기 정보 라우트(GET /me, GET /me/explain)의 인증 경로 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-04
 *
 * 실제 handleAdminApi와 실제 API 키 조회(ApiKeyStore)를 부르고 DB 풀만 질의 수를 세는 가짜로 바꾼다.
 *   1. 올바른 마스터 키, 틀린 마스터 키, 틀린 API 키가 모두 같은 수의 저장소 왕복을 쓴다.
 *   2. 틀린 Bearer는 다른 관리 라우트와 같이 관리 인증 실패로 세어져 지연(backoff)에 이른다.
 *   3. 지연 중에는 키 조회 없이 429이며, 올바른 마스터 키도 같다.
 */

import { describe, it, before, after, beforeEach, mock } from "node:test";
import assert                                           from "node:assert/strict";
import http                                             from "node:http";

process.env.DOTENV_CONFIG_PATH      ??= ".env.test";
process.env.MEMENTO_METRICS_DEFAULT ??= "off";
process.env.REDIS_ENABLED           ??= "false";
process.env.CACHE_ENABLED           ??= "false";

const queries  = [];
const stubPool = { query: async (sql) => { queries.push(String(sql)); return { rows: [], rowCount: 0 }; } };
const realDb   = await import("../../lib/tools/db.js");
mock.module("../../lib/tools/db.js", { namedExports: { ...realDb, getPrimaryPool: () => stubPool } });

const { handleAdminApi }              = await import("../../lib/admin/admin-routes.js");
const { ADMIN_BASE }                  = await import("../../lib/admin/admin-auth.js");
const { _resetAdminAuthGuardForTest } = await import("../../lib/admin/admin-login-guard.js");
const { ACCESS_KEY }                  = await import("../../lib/config.js");

let server;
let base;
const SAVED_BACKOFF = process.env.MEMENTO_ADMIN_AUTH_BACKOFF;

before(async () => {
  server = http.createServer((req, res) => handleAdminApi(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}${ADMIN_BASE}`;
});

after(async () => {
  if (SAVED_BACKOFF === undefined) delete process.env.MEMENTO_ADMIN_AUTH_BACKOFF;
  else process.env.MEMENTO_ADMIN_AUTH_BACKOFF = SAVED_BACKOFF;
  _resetAdminAuthGuardForTest();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  _resetAdminAuthGuardForTest();
  queries.length = 0;
});

const WRONG_MASTER = "x".repeat(ACCESS_KEY.length);
const WRONG_KEY    = "mmcp_0000000000000000000000000000000000000000";

/** 요청 하나를 보내고 상태와 그 요청이 쓴 저장소 왕복 수를 돌려준다. */
async function call(path, token) {
  const before = queries.length;
  const res    = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
  await res.text();
  return { status: res.status, roundTrips: queries.length - before };
}

describe("저장소 왕복 수", () => {
  for (const path of ["/me", "/me/explain?cap=mem.read"]) {
    it(`${path}: 올바른 마스터 키, 틀린 마스터 키, 틀린 API 키의 왕복 수가 같다`, async () => {
      const master = await call(path, ACCESS_KEY);
      const wrongM = await call(path, WRONG_MASTER);
      const wrongK = await call(path, WRONG_KEY);
      assert.equal(master.status, 200);
      assert.equal(wrongM.status, 401);
      assert.equal(wrongK.status, 401);
      assert.equal(master.roundTrips, 1);
      assert.equal(wrongM.roundTrips, master.roundTrips);
      assert.equal(wrongK.roundTrips, master.roundTrips);
    });
  }
});

describe("실패 집계와 지연", () => {
  it("틀린 Bearer는 관리 인증 실패로 세어지고 문턱을 넘으면 키 조회 없이 429다", async () => {
    process.env.MEMENTO_ADMIN_AUTH_BACKOFF = "on";
    try {
      for (let i = 0; i < 5; i++) assert.equal((await call("/me", WRONG_KEY)).status, 401, `attempt ${i}`);
      assert.equal((await call("/me", WRONG_KEY)).status, 429, "문턱을 넘는 실패는 다른 관리 라우트와 같이 429로 끝난다");
      queries.length = 0;
      for (const token of [ACCESS_KEY, WRONG_MASTER, WRONG_KEY]) {
        const out = await call("/me", token);
        assert.equal(out.status, 429, token === ACCESS_KEY ? "master" : "wrong");
        assert.equal(out.roundTrips, 0);
      }
      assert.equal((await call("/stats", ACCESS_KEY)).status, 429);
    } finally {
      delete process.env.MEMENTO_ADMIN_AUTH_BACKOFF;
    }
  });

  it("다른 관리 라우트의 실패와 자기 정보 라우트의 실패가 같은 집계에 쌓인다", async () => {
    process.env.MEMENTO_ADMIN_AUTH_BACKOFF = "on";
    try {
      for (let i = 0; i < 3; i++) await call("/keys", WRONG_MASTER);
      for (let i = 0; i < 3; i++) await call("/me", WRONG_MASTER);
      assert.equal((await call("/me", ACCESS_KEY)).status, 429);
    } finally {
      delete process.env.MEMENTO_ADMIN_AUTH_BACKOFF;
    }
  });
});
