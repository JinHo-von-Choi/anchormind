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

let servers = [];
let unregister;
let reflectCalls = 0;

/** 서버 프로세스 하나를 흉내 낸 처리기(프로세스마다 최근 키 목록과 요청 한도기가 따로 있다) */
async function startHookServer() {
  const handler = createHookHandler({
    authenticate     : async () => ({ valid: true, keyId: null, groupKeyIds: null, permissions: null, isMaster: true }),
    allowedWorkspaces: async () => null
  });
  const server = http.createServer((req, res) => {
    handler(req, res, { pathname: new URL(req.url, "http://localhost").pathname });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

let baseUrls;

before(async () => {
  /** 실제 reflect를 부르되 호출 수를 센다. 같은 서사는 content_hash로 접히므로 파편 수만으로는 중복 호출을 가릴 수 없다. */
  unregister = registerHookReflectConsumer({
    reflect: async (params) => {
      reflectCalls++;
      return MemoryManager.getInstance().reflect(params, { writeEntry: WRITE_ENTRIES.REFLECT });
    }
  });
  baseUrls = [await startHookServer(), await startHookServer(), await startHookServer()];
});

after(async () => {
  try {
    unregister?.();
    await Promise.all(servers.map(server => new Promise((resolve) => server.close(resolve))));
    await Promise.all(pools.map(p => p.end()));
    await shutdownPool();
  } finally {
    await dropLaneDatabase();
  }
});

/** 훅 요청 하나. instance는 요청을 받을 서버 번호다. */
async function postHook(client, event, body, instance = 0) {
  const res = await fetch(`${baseUrls[instance]}/hooks/${client}/${event}`, {
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
  it("두 프로세스가 같은 세션과 이벤트를 접수하면 행은 둘이고 두 작업자가 처리해도 reflect는 한 번이며, 그 뒤 접수는 기록하지 않는다", async () => {
    const sid     = `lane-${crypto.randomBytes(4).toString("hex")}`;
    const excerpt = `[user]\n토큰 ${SECRET} 로 배포해 줘\n\n[assistant]\n토큰 ${SECRET} 로 배포 파이프라인의 캐시 경로를 고치고 재배포를 마쳤다`;
    const statuses = await Promise.all([
      postHook("codex", "SessionEnd", { session_id: sid, excerpt }, 0),
      postHook("codex", "SessionEnd", { session_id: sid, excerpt }, 1)
    ]);
    assert.deepEqual(statuses, [202, 202]);
    assert.equal(await postHook("codex", "SessionEnd", { session_id: sid, excerpt }, 0), 202, "같은 프로세스의 재전송은 기록 없이 202");

    const { rows } = await directQuery(`SELECT aggregate_id, payload::text AS body FROM ${TABLE} WHERE topic = $1 AND payload->>'sessionId' = $2`,
      [HOOK_REFLECT_TOPIC, sid]);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].aggregate_id, rows[1].aggregate_id);
    for (const row of rows) {
      assert.ok(!row.body.includes(SECRET), "outbox 행에 비밀 원문이 있다");
      assert.ok(!row.body.includes("[user]"), "outbox 행에 발췌 전체가 있다");
    }

    const callsBefore = reflectCalls;
    await drain([laneWorker(processPool()), laneWorker(processPool())]);
    assert.equal(reflectCalls - callsBefore, 1);
    assert.equal(await episodeCount("codex", sid), 1);

    const claims = await directQuery(
      `SELECT response->>'state' AS state FROM agent_memory.idempotency_records WHERE tool = 'hook_reflect' AND idempotency_key = $1`,
      [rows[0].aggregate_id]);
    assert.deepEqual(claims.rows.map(r => r.state), ["done"]);

    assert.equal(await postHook("codex", "SessionEnd", { session_id: sid, excerpt }, 2), 202);
    const after = await directQuery(`SELECT count(*)::int AS n FROM ${TABLE} WHERE topic = $1 AND payload->>'sessionId' = $2`,
      [HOOK_REFLECT_TOPIC, sid]);
    assert.equal(after.rows[0].n, 2, "회고가 끝난 세션과 이벤트를 다시 기록했다");
  });

  it("접수 확인 질의는 키별 대기 회고 이벤트를 상한에서 멈춰 세고 다른 키의 행은 세지 않는다", async () => {
    await directQuery(`
      INSERT INTO ${TABLE} (topic, aggregate_id, payload, available_at)
      SELECT $1, 'hook:cap-' || g, jsonb_build_object('keyId', 'cap-key'), now() + interval '1 day'
        FROM generate_series(1, 500) AS g`, [HOOK_REFLECT_TOPIC]);
    try {
      const { hookAdmissionState } = await import("../../lib/hooks/hook-store.js");
      const { getPrimaryPool }     = await import("../../lib/tools/db.js");
      const state = await hookAdmissionState(getPrimaryPool(), { keyId: "cap-key", idempotencyKey: "hook:none", limit: 500 });
      assert.deepEqual(state, { seen: false, pending: 500 });
      const other = await hookAdmissionState(getPrimaryPool(), { keyId: null, idempotencyKey: "hook:none", limit: 500 });
      assert.ok(other.pending < 500);
    } finally {
      await directQuery(`DELETE FROM ${TABLE} WHERE aggregate_id LIKE 'hook:cap-%'`);
    }
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
