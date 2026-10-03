/**
 * 관리 /stats의 switches 요약 시험
 *
 * 실제 handleAdminApi를 호출하고 DB 풀만 대체한다. switches가 현재 프로세스 환경의 요약을 담고
 * 기존 키가 그대로 있는지 본다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */
import { describe, it, before, after, mock } from "node:test";
import assert                                from "node:assert/strict";
import http                                  from "node:http";
import fs                                    from "node:fs";
import os                                    from "node:os";
import path                                  from "node:path";

const LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "memento-stats-switches-"));
process.env.LOG_DIR                   = LOG_DIR;
process.env.DOTENV_CONFIG_PATH      ??= ".env.test";
process.env.MEMENTO_METRICS_DEFAULT ??= "off";
process.env.REDIS_ENABLED           ??= "false";
process.env.CACHE_ENABLED           ??= "false";

const stubPool = {
  query: async () => ({ rows: [{ total: "0", count: 0, cnt: "0", verified: 0, bytes: "0" }] })
};
const realDb = await import("../../lib/tools/db.js");
mock.module("../../lib/tools/db.js", {
  namedExports: { ...realDb, getPrimaryPool: () => stubPool }
});

const { handleAdminApi } = await import("../../lib/admin/admin-routes.js");
const { ADMIN_BASE }     = await import("../../lib/admin/admin-auth.js");
const { ACCESS_KEY }     = await import("../../lib/config.js");
const { SWITCHES }       = await import("../../config/switches.js");

let server;
let base;
const SAVED = process.env.MEMENTO_WORKSPACE_GATE;

before(async () => {
  server = http.createServer((req, res) => handleAdminApi(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}${ADMIN_BASE}`;
});

after(async () => {
  if (SAVED === undefined) delete process.env.MEMENTO_WORKSPACE_GATE;
  else process.env.MEMENTO_WORKSPACE_GATE = SAVED;
  await new Promise((r) => setTimeout(r, 100));
  fs.rmSync(LOG_DIR, { recursive: true, force: true });
  await new Promise((resolve) => server.close(resolve));
});

const getStats = async () => {
  const res = await fetch(`${base}/stats`, { headers: { authorization: `Bearer ${ACCESS_KEY}` } });
  assert.equal(res.status, 200);
  return res.json();
};

describe("GET /stats switches", () => {
  it("개수와 기본과 다른 스위치 이름을 담는다", async () => {
    delete process.env.MEMENTO_WORKSPACE_GATE;
    const base0 = (await getStats()).switches;
    assert.equal(base0.total, SWITCHES.length);
    assert.equal(base0.on + base0.off + base0.mode, base0.total);
    assert.ok(!base0.nonDefault.includes("MEMENTO_WORKSPACE_GATE"));

    process.env.MEMENTO_WORKSPACE_GATE = "true";
    const next = (await getStats()).switches;
    assert.ok(next.nonDefault.includes("MEMENTO_WORKSPACE_GATE"));
    assert.equal(next.nonDefaultCount, next.nonDefault.length);
    assert.equal(next.on, base0.on + 1);
  });

  it("스위치 값은 응답에 담지 않고 이름과 개수만 담는다", async () => {
    process.env.MEMENTO_WORKSPACE_GATE = "true";
    const { switches } = await getStats();
    assert.deepEqual(Object.keys(switches).sort(), ["invalid", "mode", "nonDefault", "nonDefaultCount", "off", "on", "total"]);
    assert.ok(switches.nonDefault.every((n) => typeof n === "string"));
  });

  it("기존 키가 그대로 있다", async () => {
    const body = await getStats();
    for (const key of ["fragments", "topTopics", "quality", "sessions", "apiCallsToday", "activeKeys", "uptime",
      "nodeVersion", "system", "db", "redis", "queues", "schedulerJobs", "lastConsolidation", "healthFlags"]) {
      assert.ok(key in body, key);
    }
    assert.ok(Array.isArray(body.healthFlags));
  });
});
