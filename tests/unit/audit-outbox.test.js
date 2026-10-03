/**
 * 감사 이벤트 생산자와 감사 승격 소비자 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * outbox 기록 함수와 DB 풀을 대체하고, 생산자가 감사 topic으로 본문 없는 payload를 기록하는지,
 * 스위치와 기록 실패를 어떻게 다루는지, 소비자가 payload를 다시 검증해 저장소에 멱등 키와 함께
 * 넘기는지, 읽을 수 없는 payload를 재시도 없이 dead-letter로 보내는지 본다.
 */

import { describe, it, mock, beforeEach, afterEach } from "node:test";
import assert                                        from "node:assert/strict";

process.env.DOTENV_CONFIG_PATH      ??= ".env.test";
process.env.MEMENTO_METRICS_DEFAULT ??= "off";

const enqueued   = [];
let   failNext   = null;
const fakePool   = { name: "primary" };
const fakeClient = { name: "tx-client" };

const realOutbox = await import("../../lib/outbox/Outbox.js");
mock.module("../../lib/outbox/Outbox.js", {
  exports: {
    ...realOutbox,
    enqueueStandalone: async (pool, event) => {
      if (failNext) { const err = failNext; failNext = null; throw err; }
      enqueued.push({ via: "standalone", pool, event });
      return { id: String(enqueued.length) };
    },
    enqueue: async (client, event) => {
      enqueued.push({ via: "tx", client, event });
      return { id: String(enqueued.length) };
    }
  }
});
/** 기록 실패 경고는 출력하지 않고 모아 확인한다 */
const warnings   = [];
const realLogger = await import("../../lib/logger.js");
mock.module("../../lib/logger.js", { exports: { ...realLogger, logWarn: (msg) => { warnings.push(String(msg)); } } });
const realDb = await import("../../lib/tools/db.js");
mock.module("../../lib/tools/db.js", { exports: { ...realDb, getPrimaryPool: () => fakePool } });

const { recordAudit, enqueueAudit }     = await import("../../lib/logging/audit-outbox.js");
const { createAuditHandler, registerAuditConsumer, runAuditRetention } = await import("../../lib/logging/audit-consumer.js");
const { AUDIT_TOPIC, AuditEventError }  = await import("../../lib/logging/audit-event.js");
const { getOutboxHandler, OutboxPermanentError } = await import("../../lib/outbox/OutboxHandlers.js");
const { register }                      = await import("../../lib/metrics.js");

const KEY_ID = "6f1c0f7e-1111-4000-8000-000000000001";

async function counter(name) {
  const metric = (await register.getMetricsAsJSON()).find(m => m.name === name);
  return metric?.values?.[0]?.value ?? 0;
}

beforeEach(() => {
  enqueued.length = 0;
  failNext        = null;
  delete process.env.MEMENTO_AUDIT_DB;
});
afterEach(() => { delete process.env.MEMENTO_AUDIT_DB; });

describe("recordAudit", () => {
  it("감사 topic으로 본문 없는 payload를 독립 트랜잭션에 기록한다", async () => {
    const result = await recordAudit({
      action: "memory.remember",
      actor : { keyId: KEY_ID, sessionId: "abcdef0123456", clientIp: "::1" },
      target: { type: "fragment", id: "frag-9" },
      detail: { contentSha256: "d".repeat(64), contentLength: 40, type: "fact" }
    });
    assert.deepEqual(result, { id: "1" });
    assert.equal(enqueued.length, 1);
    const { via, pool, event } = enqueued[0];
    assert.equal(via, "standalone");
    assert.equal(pool, fakePool);
    assert.equal(event.topic, AUDIT_TOPIC);
    assert.equal(event.aggregateId, "fragment:frag-9");
    assert.equal(event.payload.action, "memory.remember");
    assert.equal(event.payload.actor.kind, "key");
    assert.equal(event.payload.actor.session, "abcdef01");
    assert.deepEqual(event.payload.detail, { contentSha256: "d".repeat(64), contentLength: 40, type: "fact" });
  });

  it("발생 시각은 호출 시점이다", async () => {
    const before = Date.now();
    await recordAudit({ action: "admin.sessions.cleanup", actor: "system" });
    const at = Date.parse(enqueued[0].event.payload.occurredAt);
    assert.ok(at >= before && at <= Date.now());
  });

  it("MEMENTO_AUDIT_DB=off이면 기록하지 않고 null이다", async () => {
    process.env.MEMENTO_AUDIT_DB = "off";
    assert.equal(await recordAudit({ action: "memory.forget", actor: "system" }), null);
    assert.equal(enqueued.length, 0);
  });

  it("기록이 실패해도 거부하지 않고 null을 돌려주며 실패를 센다", async () => {
    const before = await counter("memento_audit_enqueue_failed_total");
    failNext = new Error("db down");
    assert.equal(await recordAudit({ action: "memory.link", actor: "system" }), null);
    assert.equal(await counter("memento_audit_enqueue_failed_total"), before + 1);
    assert.ok(warnings.some((w) => /audit event not recorded \(action=memory\.link\): db down/.test(w)));
  });

  it("규칙을 어긴 이벤트는 기록하지 않고 실패로 센다", async () => {
    const before = await counter("memento_audit_enqueue_failed_total");
    assert.equal(await recordAudit({ action: "memory.remember", detail: { content: "SECRET-BODY-VALUE" } }), null);
    assert.equal(enqueued.length, 0);
    assert.ok(warnings.some((w) => /action=memory\.remember/.test(w)));
    assert.ok(!warnings.some((w) => w.includes("SECRET-BODY-VALUE")));
    assert.equal(await counter("memento_audit_enqueue_failed_total"), before + 1);
  });
});

describe("enqueueAudit", () => {
  it("호출자 트랜잭션 연결로 기록한다", async () => {
    await enqueueAudit(fakeClient, { action: "admin.key.revoke", actor: { keyId: "master" }, target: { type: "api_key", id: KEY_ID } });
    assert.equal(enqueued[0].via, "tx");
    assert.equal(enqueued[0].client, fakeClient);
    assert.equal(enqueued[0].event.payload.actor.kind, "master");
  });

  it("규칙 위반은 호출자에게 던진다", async () => {
    await assert.rejects(enqueueAudit(fakeClient, { action: "Bad" }), AuditEventError);
  });

  it("MEMENTO_AUDIT_DB=off이면 null이다", async () => {
    process.env.MEMENTO_AUDIT_DB = "off";
    assert.equal(await enqueueAudit(fakeClient, { action: "admin.key.revoke" }), null);
    assert.equal(enqueued.length, 0);
  });
});

describe("감사 승격 처리기", () => {
  const payload = () => ({
    v: 1, action: "memory.forget", outcome: "success", occurredAt: "2026-10-03T00:00:00.000Z",
    actor: { kind: "key", keyId: KEY_ID, session: null, ip: null }, target: { type: "fragment", id: "f1" },
    workspace: null, detail: { deleted: 1 }
  });

  it("payload를 검증해 멱등 키와 함께 저장소에 넘긴다", async () => {
    const calls   = [];
    const handler = createAuditHandler({ append: async (record, key) => { calls.push({ record, key }); return { seq: 1, rowHash: "x", duplicate: false }; } });
    await handler({ id: "77", topic: AUDIT_TOPIC, payload: payload(), idempotencyKey: "audit.record:77" });
    assert.equal(calls[0].key, "audit.record:77");
    assert.equal(calls[0].record.actorKeyId, KEY_ID);
    assert.equal(calls[0].record.targetId, "f1");
  });

  it("읽을 수 없는 payload는 재시도 없이 dead-letter로 보낸다", async () => {
    const handler = createAuditHandler({ append: async () => assert.fail("기록하면 안 된다") });
    await assert.rejects(handler({ id: "78", payload: { ...payload(), detail: { body: "x" } }, idempotencyKey: "audit.record:78" }), OutboxPermanentError);
    await assert.rejects(handler({ id: "79", payload: { ...payload(), v: 9 }, idempotencyKey: "audit.record:79" }), OutboxPermanentError);
  });

  it("저장소 오류는 그대로 던져 재시도하게 한다", async () => {
    const handler = createAuditHandler({ append: async () => { throw new Error("lock timeout"); } });
    await assert.rejects(handler({ id: "80", payload: payload(), idempotencyKey: "audit.record:80" }), (e) => !(e instanceof OutboxPermanentError) && /lock timeout/.test(e.message));
  });

  it("스위치가 켜져 있으면 감사 topic에 처리기를 등록하고 꺼져 있으면 등록하지 않는다", () => {
    const unregister = registerAuditConsumer({ store: { append: async () => ({}) } });
    try {
      assert.equal(typeof unregister, "function");
      assert.ok(getOutboxHandler(AUDIT_TOPIC));
    } finally {
      unregister();
    }
    process.env.MEMENTO_AUDIT_DB = "off";
    assert.equal(registerAuditConsumer({ store: { append: async () => ({}) } }), null);
    assert.equal(getOutboxHandler(AUDIT_TOPIC), null);
  });
});

describe("보존 정리", () => {
  it("묶음이 가득 차면 회차 상한까지 이어서 지운다", async () => {
    const sizes = [3, 3, 1];
    const calls = [];
    const store = { cleanup: async (args) => { calls.push(args); return sizes.shift() ?? 0; } };
    assert.equal(await runAuditRetention({ store, chunk: 3, maxPerRun: 100, retentionDays: 400 }), 7);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[0], { retentionDays: 400, limit: 3 });
  });

  it("회차 상한에서 멈춘다", async () => {
    const store = { cleanup: async ({ limit }) => limit };
    assert.equal(await runAuditRetention({ store, chunk: 4, maxPerRun: 10, retentionDays: 1 }), 10);
  });

  it("보존 일수를 생략하면 MEMENTO_AUDIT_RETENTION_DAYS를 쓴다", async () => {
    process.env.MEMENTO_AUDIT_RETENTION_DAYS = "30";
    try {
      const calls = [];
      await runAuditRetention({ store: { cleanup: async (a) => { calls.push(a); return 0; } } });
      assert.equal(calls[0].retentionDays, 30);
    } finally {
      delete process.env.MEMENTO_AUDIT_RETENTION_DAYS;
    }
  });
});
