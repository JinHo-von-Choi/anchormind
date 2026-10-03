/**
 * 감사 승격 실서버 시험(일회용 DB)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * migration-056의 admin_audit_events에서 생산자(audit-outbox)가 outbox에 남긴 감사 이벤트를 outbox 작업자와
 * 감사 승격 소비자가 단일 해시 체인으로 옮기는 경로를 본다. 트랜잭션 롤백, 두 작업자와 두 풀의 동시 기록에서
 * 체인이 갈라지지 않는지, 같은 이벤트의 재전달 멱등, jsonb 왕복 뒤 검증, 실제 행 변조와 삭제의 검출, 보존 정리가
 * 앞부분만 지우고 마지막 행을 남기는지 확인한다. 실행마다 전용 데이터베이스를 만들어 쓰고 끝나면 지운다.
 */
import { describe, it, after, beforeEach } from "node:test";
import assert                              from "node:assert/strict";
import pg                                  from "pg";

const { prepareLaneDatabase, dropLaneDatabase, directQuery, directClientConfig } = await import("./_harness.js");

/** 앱 모듈이 풀을 만들기 전에 실행 전용 데이터베이스를 준비한다. */
await prepareLaneDatabase();

const { shutdownPool, getPrimaryPool, withTransaction } = await import("../../lib/tools/db.js");
const { recordAudit, enqueueAudit }                    = await import("../../lib/logging/audit-outbox.js");
const { registerAuditConsumer, createAuditHandler, runAuditRetention } = await import("../../lib/logging/audit-consumer.js");
const { AuditStore }                                    = await import("../../lib/logging/AuditStore.js");
const { AUDIT_TOPIC, buildAuditPayload, readAuditPayload } = await import("../../lib/logging/audit-event.js");
const { OutboxStore }                                   = await import("../../lib/outbox/OutboxStore.js");
const { OutboxWorker }                                  = await import("../../lib/outbox/OutboxWorker.js");
const { SchedulerRegistry }                             = await import("../../lib/scheduler-registry.js");

const AUDIT  = "agent_memory.admin_audit_events";
const OUTBOX = "agent_memory.outbox_events";
const KEY_ID = "6f1c0f7e-5555-4000-8000-000000000006";
const SECRET_BODY = "운영 DB 비밀번호는 매 분기 바꾼다";
const pools  = [];

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

async function pendingAudit() {
  const { rows } = await directQuery(
    `SELECT count(*)::int AS n FROM ${OUTBOX} WHERE topic = $1 AND processed_at IS NULL AND dead_at IS NULL`, [AUDIT_TOPIC]);
  return rows[0].n;
}

async function drain(...workers) {
  await Promise.all(workers.map(async (w) => { while (await pendingAudit() > 0) await w._processBatch(); }));
}

async function auditRows() {
  const { rows } = await directQuery(`SELECT seq::int AS seq, source_event, action, outcome, actor_kind, actor_key_id, target_id, detail FROM ${AUDIT} ORDER BY seq`);
  return rows;
}

const event = (i, extra = {}) => ({
  action: "memory.remember",
  actor : { keyId: KEY_ID, sessionId: "abcdef0123", clientIp: "203.0.113.5" },
  target: { type: "fragment", id: `frag-${i}` },
  detail: { contentSha256: "a".repeat(64), contentLength: i, type: "fact", note: `n${i}` },
  ...extra
});

const unregister = registerAuditConsumer();

beforeEach(async () => {
  await directQuery(`TRUNCATE ${AUDIT}`);
  await directQuery(`DELETE FROM ${OUTBOX} WHERE topic = $1`, [AUDIT_TOPIC]);
});

after(async () => {
  try {
    unregister?.();
    await Promise.all(pools.map(p => p.end()));
    await shutdownPool();
  } finally {
    await dropLaneDatabase();
  }
});

describe("outbox를 거친 감사 기록", () => {
  it("독립 기록과 트랜잭션 기록이 작업자를 거쳐 seq 1부터 이어진 체인이 되고 롤백한 이벤트는 남지 않는다", async () => {
    assert.equal(typeof unregister, "function");
    for (let i = 1; i <= 2; i++) assert.ok(await recordAudit(event(i)));
    assert.ok(await recordAudit(event(3, {
      action: "admin.key.policy_update",
      detail: { changed: ["allowed_workspaces"], before: { allowed_workspaces: null }, after: { allowed_workspaces: ["팀-가", "b"] }, ratio: 0.25 }
    })));
    await withTransaction(getPrimaryPool(), (client) => enqueueAudit(client, event(4, { action: "admin.key.revoke", actor: { keyId: "master" } })));
    await assert.rejects(withTransaction(getPrimaryPool(), async (client) => {
      await enqueueAudit(client, event(5, { action: "admin.key.delete" }));
      throw new Error("업무 변경 실패");
    }), /업무 변경 실패/);

    await drain(laneWorker(processPool()));
    const rows = await auditRows();
    assert.deepEqual(rows.map(r => r.seq), [1, 2, 3, 4]);
    assert.equal(rows.filter(r => r.action === "admin.key.delete").length, 0);
    assert.equal(rows[3].actor_kind, "master");
    assert.equal(rows[0].actor_key_id, KEY_ID);
    assert.ok(rows.every(r => /^audit\.record:\d+$/.test(r.source_event)));

    const result = await new AuditStore(getPrimaryPool()).verify();
    assert.equal(result.ok, true);
    assert.equal(result.anchor, "genesis");
    assert.equal(result.checked, 4);
  });

  it("detail에 본문이 들어갈 수 없다(본문 키는 기록되지 않고 지문만 남는다)", async () => {
    assert.equal(await recordAudit(event(1, { detail: { content: SECRET_BODY } })), null);
    await recordAudit(event(2, { detail: { contentSha256: "b".repeat(64), contentLength: [...SECRET_BODY].length } }));
    await drain(laneWorker(processPool()));
    const { rows } = await directQuery(`SELECT detail::text AS d FROM ${AUDIT}`);
    assert.equal(rows.length, 1);
    assert.ok(!rows[0].d.includes(SECRET_BODY));
  });

  it("두 작업자가 별도 풀로 함께 처리해도 체인은 하나로 이어지고 이벤트마다 한 행이다", async () => {
    const n = 120;
    await withTransaction(getPrimaryPool(), async (client) => {
      for (let i = 1; i <= n; i++) await enqueueAudit(client, event(i));
    });
    await drain(laneWorker(processPool(), { batchSize: 7 }), laneWorker(processPool(), { batchSize: 7 }));

    const rows = await auditRows();
    assert.equal(rows.length, n);
    assert.deepEqual(rows.map(r => r.seq), Array.from({ length: n }, (_, i) => i + 1));
    assert.equal(new Set(rows.map(r => r.source_event)).size, n);
    assert.equal((await new AuditStore(getPrimaryPool()).verify({ chunk: 17 })).ok, true);
  });

  it("두 풀의 저장소가 동시에 기록해도 seq와 prev_hash가 갈라지지 않는다", async () => {
    const a = new AuditStore(processPool());
    const b = new AuditStore(processPool());
    const record = (i) => readAuditPayload(buildAuditPayload(event(i)));
    await Promise.all(Array.from({ length: 80 }, (_, i) => (i % 2 ? a : b).append(record(i), `audit.record:p${i}`)));
    const { rows } = await directQuery(`SELECT count(*)::int AS n, count(DISTINCT prev_hash)::int AS prevs, max(seq)::int AS max FROM ${AUDIT}`);
    assert.deepEqual(rows[0], { n: 80, prevs: 80, max: 80 });
    assert.equal((await new AuditStore(getPrimaryPool()).verify()).ok, true);
  });

  it("같은 이벤트를 다시 전달해도 행이 늘지 않는다", async () => {
    const handler = createAuditHandler(new AuditStore(getPrimaryPool()));
    const payload = buildAuditPayload(event(1));
    const first   = await handler({ payload, idempotencyKey: "audit.record:777" });
    const again   = await handler({ payload, idempotencyKey: "audit.record:777" });
    assert.equal(first.duplicate, false);
    assert.deepEqual(again, { seq: first.seq, rowHash: first.rowHash, duplicate: true });
    assert.equal((await auditRows()).length, 1);
  });
});

describe("변조 검출과 보존 정리", () => {
  async function seed(n) {
    const store = new AuditStore(getPrimaryPool());
    for (let i = 1; i <= n; i++) await store.append(readAuditPayload(buildAuditPayload(event(i))), `audit.record:s${i}`);
    return store;
  }

  it("행 값을 직접 바꾸면 그 seq에서 row_hash 불일치로 검출한다", async () => {
    const store = await seed(6);
    await directQuery(`UPDATE ${AUDIT} SET outcome = 'denied' WHERE seq = 4`);
    assert.deepEqual((await store.verify({ chunk: 2 })).broken, { seq: 4, reason: "row_hash_mismatch" });
  });

  it("detail jsonb 값을 바꿔도 검출한다", async () => {
    const store = await seed(3);
    await directQuery(`UPDATE ${AUDIT} SET detail = jsonb_set(detail, '{contentLength}', '999') WHERE seq = 2`);
    assert.deepEqual((await store.verify()).broken, { seq: 2, reason: "row_hash_mismatch" });
  });

  it("가운데 행을 지우면 seq 공백으로 검출한다", async () => {
    const store = await seed(5);
    await directQuery(`DELETE FROM ${AUDIT} WHERE seq = 3`);
    assert.deepEqual((await store.verify()).broken, { seq: 4, reason: "seq_gap" });
  });

  it("보존 정리는 오래된 앞부분만 지우고 남은 체인은 기준점부터 검증된다", async () => {
    const store = await seed(6);
    await directQuery(`UPDATE ${AUDIT} SET recorded_at = recorded_at - interval '500 days' WHERE seq <= 2`);
    assert.equal(await runAuditRetention({ store, retentionDays: 400, chunk: 1 }), 2);
    const result = await store.verify();
    assert.equal(result.ok, true);
    assert.equal(result.anchor, "retained");
    assert.equal(result.firstSeq, 3);
  });

  it("모든 행이 오래되어도 마지막 행은 남기고 다음 기록이 그 뒤에 이어진다", async () => {
    const store = await seed(4);
    await directQuery(`UPDATE ${AUDIT} SET recorded_at = recorded_at - interval '500 days'`);
    assert.equal(await runAuditRetention({ store, retentionDays: 400 }), 3);
    assert.deepEqual((await auditRows()).map(r => r.seq), [4]);
    const next = await store.append(readAuditPayload(buildAuditPayload(event(9))), "audit.record:s9");
    assert.equal(next.seq, 5);
    const result = await store.verify({ fromSeq: 5 });
    assert.equal(result.ok, true);
    assert.equal(result.anchor, "previous_row");
    assert.equal(result.checked, 1);
  });
});
