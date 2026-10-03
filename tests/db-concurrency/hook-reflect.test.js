/**
 * 훅 회고 실서버 시험(일회용 DB)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 훅 처리기가 Stop, SessionEnd 요청을 outbox_events에 기록하고, 두 작업자(별도 풀 두 개로 두 서버 프로세스를
 * 흉내 낸다)가 hook.reflect 소비자로 그 행을 처리할 때 같은 키, 세션, 이벤트는 reflect가 한 번만 일어나는지
 * 본다. 회고는 실제 MemoryManager.reflect로 수행하고 결과 episode 파편 수를 센다. outbox 행에 비밀 원문이
 * 남지 않는지도 본다. 실행마다 전용 데이터베이스를 만들어 쓰고 끝나면 지운다.
 */
import crypto                  from "node:crypto";
import http                    from "node:http";
import { describe, it, after, before } from "node:test";
import assert                  from "node:assert/strict";
import pg                      from "pg";

const { prepareLaneDatabase, dropLaneDatabase, directQuery, directClientConfig } = await import("./_harness.js");

/** 앱 모듈이 풀을 만들기 전에 실행 전용 데이터베이스를 준비한다. */
await prepareLaneDatabase();

const { shutdownPool }                       = await import("../../lib/tools/db.js");
const { OutboxStore }                        = await import("../../lib/outbox/OutboxStore.js");
const { OutboxWorker }                       = await import("../../lib/outbox/OutboxWorker.js");
const { SchedulerRegistry }                  = await import("../../lib/scheduler-registry.js");
const { createHookHandler }                  = await import("../../lib/handlers/hook-handler.js");
const { registerHookReflectConsumer }        = await import("../../lib/hooks/hook-reflect-consumer.js");
const { HOOK_REFLECT_TOPIC }                 = await import("../../lib/hooks/hook-contract.js");
const { DualRateLimiter }                    = await import("../../lib/rate-limiter.js");
const { MemoryManager }                      = await import("../../lib/memory/MemoryManager.js");
const { WRITE_ENTRIES }                      = await import("../../lib/memory/write/WriteGate.js");

const TABLE  = "agent_memory.outbox_events";
const SECRET = `ghp_${"Z9y8X7w6V5".repeat(4)}`;
const pools  = [];

/** 서버 프로세스 하나에 해당하는 독립 풀 */
function processPool() {
  const pool = new pg.Pool({ ...directClientConfig(), max: 4 });
  pools.push(pool);
  return pool;
}

/** 정리와 통계를 멀리 미루고 재시도 간격을 줄인 작업자 */
function laneWorker(pool) {
  const worker = new OutboxWorker({
    store            : new OutboxStore(pool),
    schedulerRegistry: new SchedulerRegistry(),
    settings         : { cleanupIntervalMs: 1e12, statsIntervalMs: 1e12, backoffBaseMs: 20, backoffMaxMs: 40 }
  });
  worker.running = true;
  return worker;
}

let server;
let baseUrl;
let unregister;
let reflectCalls = 0;

before(async () => {
  /** 실제 reflect를 부르되 호출 수를 센다. 같은 서사는 content_hash로 접히므로 파편 수만으로는 중복 호출을 가릴 수 없다. */
  unregister = registerHookReflectConsumer({
    reflect: async (params) => {
      reflectCalls++;
      return MemoryManager.getInstance().reflect(params, { writeEntry: WRITE_ENTRIES.REFLECT });
    }
  });
  const handler = createHookHandler({
    authenticate     : async () => ({ valid: true, keyId: null, groupKeyIds: null, permissions: null, isMaster: true }),
    allowedWorkspaces: async () => null
  });
  const limiter = new DualRateLimiter({ windowMs: 60_000, perIp: 1000, perKey: 1000 });
  server = http.createServer((req, res) => {
    handler(req, res, { rateLimiter: limiter, pathname: new URL(req.url, "http://localhost").pathname });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  try {
    unregister?.();
    await new Promise((resolve) => server.close(resolve));
    await Promise.all(pools.map(p => p.end()));
    await shutdownPool();
  } finally {
    await dropLaneDatabase();
  }
});

/** 훅 요청 하나 */
async function postHook(client, event, body) {
  const res = await fetch(`${baseUrl}/hooks/${client}/${event}`, {
    method : "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer lane" },
    body   : JSON.stringify(body)
  });
  return res.status;
}

/** 대기 행이 없을 때까지 두 작업자를 동시에 돌린다. */
async function drain(workers, rounds = 50) {
  for (let i = 0; i < rounds; i++) {
    await Promise.all(workers.map(w => w._processBatch()));
    const { rows } = await directQuery(
      `SELECT count(*)::int AS n FROM ${TABLE} WHERE topic = $1 AND processed_at IS NULL AND dead_at IS NULL`, [HOOK_REFLECT_TOPIC]);
    if (rows[0].n === 0) return;
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  throw new Error("hook.reflect 대기 행이 남았다");
}

/** 세션의 episode 파편 수 */
async function episodeCount(client, sessionId) {
  const { rows } = await directQuery(
    `SELECT count(*)::int AS n FROM agent_memory.fragments
      WHERE type = 'episode' AND topic = 'session_reflect' AND source = $1`, [`session:${client}:${sessionId}`]);
  return rows[0].n;
}

describe("훅 회고 기록과 소비", () => {
  it("같은 세션과 이벤트를 두 번 보내면 행은 둘이고 두 작업자가 처리해도 reflect는 한 번이다", async () => {
    const sid     = `lane-${crypto.randomBytes(4).toString("hex")}`;
    const excerpt = `[user]\n토큰 ${SECRET} 로 배포해 줘\n\n[assistant]\n배포 파이프라인의 캐시 경로를 고치고 재배포를 마쳤다`;
    assert.equal(await postHook("codex", "SessionEnd", { session_id: sid, excerpt }), 202);
    assert.equal(await postHook("codex", "SessionEnd", { session_id: sid, excerpt }), 202);

    const { rows } = await directQuery(`SELECT aggregate_id, payload::text AS body FROM ${TABLE} WHERE topic = $1 AND payload->>'sessionId' = $2`,
      [HOOK_REFLECT_TOPIC, sid]);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].aggregate_id, rows[1].aggregate_id);
    for (const row of rows) assert.ok(!row.body.includes(SECRET), "outbox 행에 비밀 원문이 있다");

    const callsBefore = reflectCalls;
    await drain([laneWorker(processPool()), laneWorker(processPool())]);
    assert.equal(reflectCalls - callsBefore, 1);
    assert.equal(await episodeCount("codex", sid), 1);

    const claims = await directQuery(
      `SELECT response->>'state' AS state FROM agent_memory.idempotency_records WHERE tool = 'hook_reflect' AND idempotency_key = $1`,
      [rows[0].aggregate_id]);
    assert.deepEqual(claims.rows.map(r => r.state), ["done"]);
  });

  it("이벤트가 다르면 각각 reflect한다", async () => {
    const sid = `lane-${crypto.randomBytes(4).toString("hex")}`;
    assert.equal(await postHook("claude-code", "Stop", { session_id: sid, excerpt: "[assistant]\n색인 이름 판정을 정의 기준으로 바꿨다" }), 202);
    assert.equal(await postHook("claude-code", "SessionEnd", { session_id: sid, excerpt: "[assistant]\n세션을 마치며 시험 전체를 통과시켰다" }), 202);
    const callsBefore = reflectCalls;
    await drain([laneWorker(processPool())]);
    assert.equal(reflectCalls - callsBefore, 2);
    assert.equal(await episodeCount("claude-code", sid), 2);
  });
});
