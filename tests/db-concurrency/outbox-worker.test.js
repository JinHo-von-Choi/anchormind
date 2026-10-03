/**
 * outbox 실서버 시험(일회용 DB)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * migration-054가 만든 표에서 기록의 트랜잭션 원자성, 두 작업자의 동시 점유(별도 풀 두 개로 두 서버
 * 프로세스를 흉내 낸다)에서 이벤트마다 정확히 한 번 처리, 점유 뒤 죽은 작업자의 행이 임대 만료 뒤
 * 다른 작업자에게 넘어가는지, 재시도와 dead-letter, 반납, 보존 정리의 묶음 상한을 본다. 실행마다 전용
 * 데이터베이스를 만들어 쓰고 끝나면 지운다.
 */
import crypto                  from "node:crypto";
import { describe, it, after } from "node:test";
import assert                  from "node:assert/strict";
import pg                      from "pg";

const { prepareLaneDatabase, dropLaneDatabase, directQuery, directClientConfig } = await import("./_harness.js");

/** 앱 모듈이 풀을 만들기 전에 실행 전용 데이터베이스를 준비한다. */
await prepareLaneDatabase();

const { shutdownPool, getPrimaryPool, withTransaction } = await import("../../lib/tools/db.js");
const { enqueue, OutboxTransactionRequiredError }       = await import("../../lib/outbox/Outbox.js");
const { OutboxStore }                                   = await import("../../lib/outbox/OutboxStore.js");
const { OutboxWorker }                                  = await import("../../lib/outbox/OutboxWorker.js");
const { registerOutboxHandler, listOutboxTopics }       = await import("../../lib/outbox/OutboxHandlers.js");
const { SchedulerRegistry }                             = await import("../../lib/scheduler-registry.js");

const TABLE = "agent_memory.outbox_events";
const pools = [];

/** 서버 프로세스 하나에 해당하는 독립 풀 */
function processPool() {
  const pool = new pg.Pool({ ...directClientConfig(), max: 4 });
  pools.push(pool);
  return pool;
}

/** 정리와 통계를 멀리 미룬 작업자 */
function laneWorker(pool, settings = {}) {
  const worker = new OutboxWorker({
    store            : new OutboxStore(pool),
    schedulerRegistry: new SchedulerRegistry(),
    settings         : { cleanupIntervalMs: 1e12, statsIntervalMs: 1e12, ...settings }
  });
  worker.running = true;
  return worker;
}

async function enqueueMany(topic, count) {
  return withTransaction(getPrimaryPool(), async (client) => {
    const ids = [];
    for (let i = 0; i < count; i++) ids.push((await enqueue(client, { topic, aggregateId: `agg-${i % 5}`, payload: { n: i } })).id);
    return ids;
  });
}

async function pendingCount(topic) {
  const { rows } = await directQuery(
    `SELECT count(*)::int AS n FROM ${TABLE} WHERE topic = $1 AND processed_at IS NULL AND dead_at IS NULL`, [topic]);
  return rows[0].n;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const topicFor = (name) => `lane.${name}_${crypto.randomBytes(3).toString("hex")}`;

after(async () => {
  try {
    await Promise.all(pools.map(p => p.end()));
    await shutdownPool();
  } finally {
    await dropLaneDatabase();
  }
});

describe("지연과 전달 시간", () => {
  it("지연은 전달 예정 시각이 지난 대기 행만 보고 그 예정 시각부터 잰다", async () => {
    const topic = topicFor("lag");
    const store = new OutboxStore(processPool());
    try {
      await directQuery(
        `INSERT INTO ${TABLE} (topic, created_at, available_at) VALUES ($1, now() - interval '1 hour', now() + interval '7 days')`, [topic]);
      assert.deepEqual(await store.stats({ topic }), { pending: 1, dead: 0, lagSeconds: 0 });

      await directQuery(
        `INSERT INTO ${TABLE} (topic, created_at, available_at) VALUES ($1, now() - interval '30 seconds', now() - interval '30 seconds')`, [topic]);
      const lag = (await store.stats({ topic })).lagSeconds;
      assert.ok(lag >= 29 && lag < 60, `lag=${lag}`);
    } finally {
      await directQuery(`DELETE FROM ${TABLE} WHERE topic = $1`, [topic]);
    }
  });

  it("전달 시간은 생성 시각이 아니라 점유 전 전달 예정 시각부터 잰다", async () => {
    const topic = topicFor("delivery");
    await directQuery(
      `INSERT INTO ${TABLE} (topic, created_at, available_at) VALUES ($1, now() - interval '1 hour', now() - interval '2 seconds')`, [topic]);
    const store   = new OutboxStore(processPool());
    const token   = crypto.randomUUID();
    const [event] = await store.claim({ topics: [topic], limit: 1, leaseMs: 60_000, token });
    const result  = await store.complete(event.id, token, event.dueAt);
    assert.equal(result.applied, true);
    assert.ok(result.deliverySeconds >= 2 && result.deliverySeconds < 60, `deliverySeconds=${result.deliverySeconds}`);
  });
});

describe("outbox 기록", () => {
  it("커밋하면 남고 롤백하면 사라진다", async () => {
    const topic = topicFor("atomic");
    await enqueueMany(topic, 2);
    await assert.rejects(withTransaction(getPrimaryPool(), async (client) => {
      await enqueue(client, { topic, payload: { n: 99 } });
      throw new Error("업무 변경 실패");
    }), /업무 변경 실패/);
    const { rows } = await directQuery(`SELECT payload FROM ${TABLE} WHERE topic = $1 ORDER BY id`, [topic]);
    assert.deepEqual(rows.map(r => r.payload.n), [0, 1]);
  });

  it("BEGIN 없이 빌린 연결의 자동 커밋 기록은 거부하고 행을 남기지 않는다", async () => {
    const topic  = topicFor("autocommit");
    const client = await getPrimaryPool().connect();
    try {
      await assert.rejects(enqueue(client, { topic }), OutboxTransactionRequiredError);
    } finally {
      client.release();
    }
    assert.equal(await pendingCount(topic), 0);
  });

  it("delayMs가 지나기 전에는 점유하지 않는다", async () => {
    const topic = topicFor("delay");
    await withTransaction(getPrimaryPool(), (client) => enqueue(client, { topic, delayMs: 60_000 }));
    const store = new OutboxStore(processPool());
    assert.deepEqual(await store.claim({ topics: [topic], limit: 10, leaseMs: 1000, token: crypto.randomUUID() }), []);
  });

  it("표의 CHECK가 topic 형식을 막는다", async () => {
    await assert.rejects(directQuery(`INSERT INTO ${TABLE} (topic) VALUES ('Bad Topic')`), /outbox_events_topic_check/);
  });
});

describe("두 작업자의 동시 처리", () => {
  it("별도 풀의 두 작업자가 함께 돌아도 이벤트마다 정확히 한 번 처리한다", async () => {
    const topic      = topicFor("concurrent");
    const ids        = await enqueueMany(topic, 240);
    const deliveries = new Map();
    const byWorker   = { a: 0, b: 0 };
    const unregister = registerOutboxHandler(topic, async (event) => {
      deliveries.set(event.id, (deliveries.get(event.id) ?? 0) + 1);
      await sleep(crypto.randomInt(3));
    });

    try {
      const run = async (name, worker) => {
        while (await pendingCount(topic) > 0) byWorker[name] += await worker._processBatch();
      };
      await Promise.all([
        run("a", laneWorker(processPool(), { batchSize: 7 })),
        run("b", laneWorker(processPool(), { batchSize: 7 }))
      ]);
    } finally {
      unregister();
    }

    assert.equal(deliveries.size, ids.length);
    assert.deepEqual([...deliveries.values()].filter(n => n !== 1), []);
    assert.ok(byWorker.a > 0 && byWorker.b > 0, `작업자별 처리 수 a=${byWorker.a} b=${byWorker.b}`);
    const { rows } = await directQuery(
      `SELECT count(*)::int AS done, max(attempts)::int AS max_attempts, count(claim_token)::int AS claimed
         FROM ${TABLE} WHERE topic = $1 AND processed_at IS NOT NULL`, [topic]);
    assert.deepEqual(rows[0], { done: ids.length, max_attempts: 1, claimed: 0 });
  });
});

describe("임대 만료와 재점유", () => {
  it("점유한 작업자가 죽으면 임대가 끝난 뒤 다른 작업자가 처리하고 늦은 완료는 반영되지 않는다", async () => {
    const topic   = topicFor("lease");
    const [id]    = await enqueueMany(topic, 1);
    const crashed = new OutboxStore(processPool());
    const tokenA  = crypto.randomUUID();
    const claimed = await crashed.claim({ topics: [topic], limit: 10, leaseMs: 1500, token: tokenA });
    assert.deepEqual(claimed.map(e => [e.id, e.attempts]), [[id, 1]]);

    const seen       = [];
    const unregister = registerOutboxHandler(topic, async (event) => { seen.push([event.id, event.attempts]); });
    try {
      const workerB = laneWorker(processPool(), { leaseMs: 60_000 });
      assert.equal(await workerB._processBatch(), 0);
      await sleep(1700);
      assert.equal(await workerB._processBatch(), 1);
    } finally {
      unregister();
    }

    assert.deepEqual(seen, [[id, 2]]);
    assert.deepEqual(await crashed.complete(id, tokenA), { applied: false, deliverySeconds: null });
    const { rows } = await directQuery(`SELECT attempts, processed_at IS NOT NULL AS done FROM ${TABLE} WHERE id = $1`, [id]);
    assert.deepEqual(rows[0], { attempts: 2, done: true });
  });

  it("반납한 점유는 attempts를 되돌리고 곧바로 다시 점유할 수 있다", async () => {
    const topic  = topicFor("release");
    const [id]   = await enqueueMany(topic, 1);
    const store  = new OutboxStore(processPool());
    const token  = crypto.randomUUID();
    await store.claim({ topics: [topic], limit: 1, leaseMs: 60_000, token });
    assert.equal(await store.release([id], token), 1);
    const again = await store.claim({ topics: [topic], limit: 1, leaseMs: 60_000, token: crypto.randomUUID() });
    assert.deepEqual(again.map(e => [e.id, e.attempts]), [[id, 1]]);
  });
});

describe("재시도와 dead-letter", () => {
  it("실패는 재시도 간격 뒤 다시 점유되고 상한에서 dead-letter로 남아 더는 점유되지 않는다", async () => {
    const topic      = topicFor("dead");
    const [id]       = await enqueueMany(topic, 1);
    const unregister = registerOutboxHandler(topic, async () => { throw new Error("handler down"); }, { maxAttempts: 2 });
    try {
      const worker = laneWorker(processPool(), { backoffBaseMs: 200, backoffMaxMs: 200 });
      assert.equal(await worker._processBatch(), 1);
      assert.equal(await worker._processBatch(), 0);
      await sleep(250);
      assert.equal(await worker._processBatch(), 1);
      await sleep(250);
      assert.equal(await worker._processBatch(), 0);
    } finally {
      unregister();
    }
    const { rows } = await directQuery(
      `SELECT attempts, dead_at IS NOT NULL AS dead, processed_at, last_error, claim_token FROM ${TABLE} WHERE id = $1`, [id]);
    assert.deepEqual(rows[0], { attempts: 2, dead: true, processed_at: null, last_error: "Error: handler down", claim_token: null });

    const stats = await new OutboxStore(getPrimaryPool()).stats();
    assert.ok(stats.dead >= 1);
  });
});

describe("보존 정리", () => {
  it("보존 기간이 지난 완료 행만 묶음 상한까지 지운다", async () => {
    const topic = topicFor("cleanup");
    await directQuery(
      `INSERT INTO ${TABLE} (topic, processed_at)
       SELECT $1, now() - interval '10 days' FROM generate_series(1, 12)`, [topic]);
    await directQuery(`INSERT INTO ${TABLE} (topic, processed_at) VALUES ($1, now() - interval '1 day')`, [topic]);
    await directQuery(`INSERT INTO ${TABLE} (topic, dead_at) VALUES ($1, now() - interval '30 days')`, [topic]);
    await directQuery(`INSERT INTO ${TABLE} (topic) VALUES ($1)`, [topic]);

    const store = new OutboxStore(processPool());
    assert.equal(await store.cleanup({ retentionDays: 7, limit: 5 }), 5);
    assert.equal(await store.cleanup({ retentionDays: 7, limit: 5 }), 5);
    assert.equal(await store.cleanup({ retentionDays: 7, limit: 5 }), 2);
    assert.equal(await store.cleanup({ retentionDays: 7, limit: 5 }), 0);

    const { rows } = await directQuery(
      `SELECT count(*) FILTER (WHERE processed_at IS NOT NULL)::int AS recent,
              count(*) FILTER (WHERE dead_at IS NOT NULL)::int AS dead,
              count(*) FILTER (WHERE processed_at IS NULL AND dead_at IS NULL)::int AS pending
         FROM ${TABLE} WHERE topic = $1`, [topic]);
    assert.deepEqual(rows[0], { recent: 1, dead: 1, pending: 1 });
  });
});

describe("처리기 없는 topic", () => {
  it("처리기 없는 topic의 오래된 미점유 대기 행만 묶음 단위로 no_handler dead-letter가 된다", async () => {
    const orphan  = topicFor("orphan");
    const handled = topicFor("handled");
    try {
      await directQuery(
        `INSERT INTO ${TABLE} (topic, available_at) SELECT $1, now() - interval '8 days' FROM generate_series(1, 3)`, [orphan]);
      await directQuery(`INSERT INTO ${TABLE} (topic, available_at) VALUES ($1, now() - interval '1 day')`, [orphan]);
      await directQuery(`INSERT INTO ${TABLE} (topic, available_at, attempts) VALUES ($1, now() - interval '8 days', 1)`, [orphan]);
      await directQuery(`INSERT INTO ${TABLE} (topic, available_at) VALUES ($1, now() - interval '8 days')`, [handled]);

      const store = new OutboxStore(processPool());
      assert.equal(await store.deadLetterUnhandled({ topics: [handled], olderThanDays: 7, limit: 2 }), 2);
      assert.equal(await store.deadLetterUnhandled({ topics: [handled], olderThanDays: 7, limit: 2 }), 1);
      assert.equal(await store.deadLetterUnhandled({ topics: [handled], olderThanDays: 7, limit: 2 }), 0);

      const { rows } = await directQuery(
        `SELECT topic, count(*) FILTER (WHERE dead_at IS NOT NULL AND last_error = 'no_handler')::int AS dead,
                count(*) FILTER (WHERE dead_at IS NULL)::int AS pending
           FROM ${TABLE} WHERE topic = ANY($1::text[]) GROUP BY topic ORDER BY topic`, [[orphan, handled]]);
      const byTopic = Object.fromEntries(rows.map(r => [r.topic, { dead: r.dead, pending: r.pending }]));
      assert.deepEqual(byTopic[orphan], { dead: 3, pending: 2 });
      assert.deepEqual(byTopic[handled], { dead: 0, pending: 1 });
    } finally {
      await directQuery(`DELETE FROM ${TABLE} WHERE topic = ANY($1::text[])`, [[orphan, handled]]);
    }
  });

  it("처리기가 하나도 등록되지 않은 작업자는 오래된 대기 행을 dead-letter로 옮기지 않는다", async () => {
    const elsewhere = topicFor("elsewhere");
    try {
      await directQuery(`INSERT INTO ${TABLE} (topic, available_at) VALUES ($1, now() - interval '30 days')`, [elsewhere]);
      assert.deepEqual(listOutboxTopics(), []);
      const worker = laneWorker(processPool(), { cleanupIntervalMs: 1 });
      assert.equal(await worker._processBatch(), 0);
      assert.equal(worker.snapshot().totals.unhandled, 0);
      const { rows } = await directQuery(`SELECT dead_at FROM ${TABLE} WHERE topic = $1`, [elsewhere]);
      assert.deepEqual(rows, [{ dead_at: null }]);
    } finally {
      await directQuery(`DELETE FROM ${TABLE} WHERE topic = $1`, [elsewhere]);
    }
  });
});
