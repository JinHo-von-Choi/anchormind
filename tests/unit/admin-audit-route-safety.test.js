/**
 * 관리 요청 감사 경로의 안전성 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-04
 *
 * 실제 handleAdminApi를 HTTP 서버로 띄우고 감사 기록기와 DB 풀만 대체해 본다.
 *   1. 형식이 틀린 퍼센트 인코딩 경로(%FF)의 비GET 요청 뒤에도 서버가 살아 있고 감사 이벤트가 원래 조각으로 남는다.
 *   2. 내보내기 처리기는 선언된 경로(/export, /audit/export)에서만 돌고, 다른 경로 끝의 /export는 404이며 아무것도 읽지 않는다.
 * 구조 검사: 관리 모듈은 경로 끝 비교(pathname.endsWith)로 라우트를 판정하지 않고, 첨부 파일을 내려 주는 GET 처리기를
 * 가진 모듈은 GET 감사 행위를 선언한다.
 */

import { describe, it, before, after, mock } from "node:test";
import assert                                from "node:assert/strict";
import http                                  from "node:http";
import { readFileSync, readdirSync }         from "node:fs";
import path                                  from "node:path";
import { fileURLToPath }                     from "node:url";

process.env.DOTENV_CONFIG_PATH      ??= ".env.test";
process.env.MEMENTO_METRICS_DEFAULT ??= "off";
process.env.REDIS_ENABLED           ??= "false";
process.env.CACHE_ENABLED           ??= "false";

const events  = [];
const queries = [];
mock.module("../../lib/logging/audit-outbox.js", {
  exports: { recordAudit: async (e) => { events.push(e); return null; }, enqueueAudit: async () => null }
});
const realDb = await import("../../lib/tools/db.js");
const stubPool = { query: async (sql) => { queries.push(sql); return { rows: [], rowCount: 0 }; }, connect: async () => assert.fail("연결을 빌리면 안 된다") };
mock.module("../../lib/tools/db.js", { exports: { ...realDb, getPrimaryPool: () => stubPool } });
const realKeys = await import("../../lib/admin/ApiKeyStore.js");
mock.module("../../lib/admin/ApiKeyStore.js", {
  exports: { ...realKeys, deleteApiKey: async () => { throw new Error("Key not found"); } }
});

const { handleAdminApi }                  = await import("../../lib/admin/admin-routes.js");
const { ADMIN_BASE }                      = await import("../../lib/admin/admin-auth.js");
const { ACCESS_KEY }                      = await import("../../lib/config.js");
const { decodePathSegment, findAdminAuditAction, ADMIN_AUDIT_ACTIONS } = await import("../../lib/admin/admin-audit-actions.js");

const ROOT      = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ADMIN_DIR = path.join(ROOT, "lib", "admin");
const auth      = { authorization: `Bearer ${ACCESS_KEY}` };

let server;
let base;

before(async () => {
  server = http.createServer((req, res) => handleAdminApi(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}${ADMIN_BASE}`;
});

after(async () => {
  await new Promise((r) => setTimeout(r, 50));
  await new Promise((resolve) => server.close(resolve));
});

/** 원시 경로로 요청한다(fetch는 %FF를 고치지 않지만 경로를 그대로 보내려고 http.request를 쓴다). */
function rawRequest(method, rawPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${rawPath}`, { method, headers: auth }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end();
  });
}

async function eventFor(action) {
  for (let i = 0; i < 50 && !events.some((e) => e.action === action); i++) await new Promise((r) => setTimeout(r, 10));
  return events.find((e) => e.action === action);
}

describe("형식이 틀린 퍼센트 인코딩", () => {
  it("조각 풀기는 던지지 않고 원래 조각을 돌려준다", () => {
    assert.equal(decodePathSegment("%FF"), "%FF");
    assert.equal(decodePathSegment("%G1"), "%G1");
    assert.equal(decodePathSegment("%E2%82"), "%E2%82");
    assert.equal(decodePathSegment("a%20b"), "a b");
    assert.deepEqual(findAdminAuditAction("DELETE", "/keys/%FF").params, ["%FF"]);
  });

  it("DELETE /keys/%FF 뒤에도 서버가 응답하고 감사 이벤트는 원래 조각을 대상으로 남는다", async () => {
    const status = await rawRequest("DELETE", "/keys/%FF");
    assert.ok(status >= 400);
    const event = await eventFor("admin.key.delete");
    assert.deepEqual(event.target, { type: "api_key", id: "%FF" });
    assert.equal(await rawRequest("DELETE", "/sessions/%E2%82"), 404);
    const again = await fetch(`${base}/stats-not-a-route`, { method: "POST", headers: auth });
    assert.equal(again.status, 404);
  });
});

describe("내보내기 경로", () => {
  it("다른 경로 끝의 /export는 내보내기를 돌리지 않고 404다", async () => {
    queries.length = 0;
    for (const p of ["/x/export?confirm=full", "/memory/export?confirm=full", "/keys/export?confirm=full"]) {
      const res = await fetch(`${base}${p}`, { headers: auth });
      assert.equal(res.status, 404, p);
    }
    assert.equal(queries.filter((q) => /FROM\s+\S*fragments/i.test(q)).length, 0);
  });

  it("다른 경로 끝의 /import POST도 가져오기를 돌리지 않는다", async () => {
    const res = await fetch(`${base}/x/import`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: "{}" });
    assert.equal(res.status, 404);
  });

  it("선언된 /export는 감사 이벤트를 남긴다", async () => {
    await fetch(`${base}/export`, { headers: auth });
    const event = await eventFor("admin.export");
    assert.equal(event.detail.path, "/export");
  });
});

describe("라우트 판정 구조", () => {
  const modules = readdirSync(ADMIN_DIR).filter((f) => f.endsWith(".js"));

  it("관리 모듈은 경로 끝 비교로 라우트를 판정하지 않는다", () => {
    for (const file of modules) {
      const src = readFileSync(path.join(ADMIN_DIR, file), "utf8");
      assert.doesNotMatch(src, /pathname\.endsWith\(/, file);
    }
  });

  it("첨부 파일을 내려 주는 GET 처리기가 있는 모듈은 GET 감사 행위를 선언한다", () => {
    for (const file of modules) {
      const src = readFileSync(path.join(ADMIN_DIR, file), "utf8");
      if (!/Content-Disposition/.test(src)) continue;
      const name     = file.replace(/\.js$/, "");
      const declared = ADMIN_AUDIT_ACTIONS.filter((a) => a.module === name && a.method === "GET");
      assert.ok(declared.length > 0, `${name}에 GET 감사 선언이 없다`);
      for (const a of declared) assert.ok(src.includes(`\${ADMIN_BASE}${a.path}\``), `${name}이 ${a.path}를 정확히 판정하지 않는다`);
    }
  });
});
