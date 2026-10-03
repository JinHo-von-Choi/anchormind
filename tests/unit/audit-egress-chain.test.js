/**
 * 감사 처리기 연쇄 등록과 외부 전송 감사 topic 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-04
 *
 * outbox 처리기 등록부의 onDuplicate(error, replace, chain)와 해제 순서, 감사 승격 소비자가 audit.llm.egress에
 * "chain"으로 붙어 다른 처리기(파일 기록)와 함께 불리는지, 외부 전송 payload를 본문과 workspace 이름 없이 감사
 * 행 값으로 바꾸는지, 형식이 틀린 payload를 dead-letter로 보내는지 본다.
 */

import { describe, it, afterEach } from "node:test";
import assert                      from "node:assert/strict";

process.env.DOTENV_CONFIG_PATH      ??= ".env.test";
process.env.MEMENTO_METRICS_DEFAULT ??= "off";

const {
  registerOutboxHandler, getOutboxHandler, OutboxHandlerRegistrationError, OutboxPermanentError, _resetOutboxHandlers
} = await import("../../lib/outbox/OutboxHandlers.js");
const {
  registerAuditConsumer, registerAuditTopic, egressAuditEvent, createAuditHandler, AUDIT_EGRESS_TOPIC
} = await import("../../lib/logging/audit-consumer.js");
const { AUDIT_TOPIC } = await import("../../lib/logging/audit-event.js");

const KEY_ID  = "6f1c0f7e-8888-4000-8000-000000000009";
const EGRESS  = (payload) => ({ id: "5", topic: AUDIT_EGRESS_TOPIC, payload, idempotencyKey: `${AUDIT_EGRESS_TOPIC}:5`, createdAt: new Date("2026-10-04T01:00:00.000Z") });
const PAYLOAD = { key_id: KEY_ID, stage: "auto_reflect", provider: "openai", provider_class: "external", bytes: 1234, masked_rules: 2, workspaces: ["팀 비밀 이름", "b"] };

afterEach(() => _resetOutboxHandlers());

describe("같은 topic의 두 번째 등록", () => {
  it("기본은 거부한다", () => {
    registerOutboxHandler("t.one", async () => {});
    assert.throws(() => registerOutboxHandler("t.one", async () => {}), OutboxHandlerRegistrationError);
  });

  it("chain은 앞 처리기가 성공한 뒤 뒤 처리기를 같은 이벤트로 부르고 해제하면 앞 등록이 돌아온다", async () => {
    const calls = [];
    const first = registerOutboxHandler("t.two", async (e) => { calls.push(["a", e.id]); }, { maxAttempts: 5 });
    const second = registerOutboxHandler("t.two", async (e) => { calls.push(["b", e.id]); }, { onDuplicate: "chain", maxAttempts: 3 });
    await getOutboxHandler("t.two").handler({ id: 1 }, {});
    assert.deepEqual(calls, [["a", 1], ["b", 1]]);
    assert.equal(getOutboxHandler("t.two").maxAttempts, 3);
    second();
    calls.length = 0;
    await getOutboxHandler("t.two").handler({ id: 2 }, {});
    assert.deepEqual(calls, [["a", 2]]);
    first();
    assert.equal(getOutboxHandler("t.two"), null);
  });

  it("chain에서 앞 처리기가 실패하면 뒤 처리기를 부르지 않고 실패를 전한다", async () => {
    let called = false;
    registerOutboxHandler("t.three", async () => { throw new Error("file write failed"); });
    registerOutboxHandler("t.three", async () => { called = true; }, { onDuplicate: "chain" });
    await assert.rejects(getOutboxHandler("t.three").handler({ id: 1 }, {}), /file write failed/);
    assert.equal(called, false);
  });

  it("replace는 새 처리기로 바꾸고 해제하면 앞 처리기가 돌아온다", async () => {
    const seen = [];
    registerOutboxHandler("t.four", async () => { seen.push("old"); });
    const undo = registerOutboxHandler("t.four", async () => { seen.push("new"); }, { onDuplicate: "replace" });
    await getOutboxHandler("t.four").handler({}, {});
    undo();
    await getOutboxHandler("t.four").handler({}, {});
    assert.deepEqual(seen, ["new", "old"]);
  });

  it("알 수 없는 onDuplicate는 거부한다", () => {
    assert.throws(() => registerOutboxHandler("t.five", async () => {}, { onDuplicate: "merge" }), OutboxHandlerRegistrationError);
  });
});

describe("외부 전송 감사 topic", () => {
  it("감사 승격 소비자는 audit.record와 audit.llm.egress에 등록하고 해제하면 둘 다 풀린다", () => {
    const unregister = registerAuditConsumer({ store: { append: async () => ({ duplicate: false }) } });
    assert.ok(getOutboxHandler(AUDIT_TOPIC));
    assert.ok(getOutboxHandler(AUDIT_EGRESS_TOPIC));
    unregister();
    assert.equal(getOutboxHandler(AUDIT_TOPIC), null);
    assert.equal(getOutboxHandler(AUDIT_EGRESS_TOPIC), null);
  });

  it("먼저 등록된 파일 기록 처리기(chain)와 함께 불리고 체인에는 멱등 키로 기록한다", async () => {
    const order   = [];
    const appends = [];
    registerOutboxHandler(AUDIT_EGRESS_TOPIC, async () => { order.push("file"); }, { onDuplicate: "chain" });
    registerAuditTopic(AUDIT_EGRESS_TOPIC, egressAuditEvent, {
      store: { append: async (record, key) => { order.push("db"); appends.push({ record, key }); return { duplicate: false }; } }
    });
    await getOutboxHandler(AUDIT_EGRESS_TOPIC).handler(EGRESS(PAYLOAD), {});
    assert.deepEqual(order, ["file", "db"]);
    const { record, key } = appends[0];
    assert.equal(key, `${AUDIT_EGRESS_TOPIC}:5`);
    assert.equal(record.action, "llm.egress");
    assert.equal(record.actorKeyId, KEY_ID);
    assert.deepEqual([record.targetType, record.targetId], ["llm_provider", "openai"]);
    assert.equal(record.occurredAt, "2026-10-04T01:00:00.000Z");
    assert.deepEqual(record.detail, { stage: "auto_reflect", providerClass: "external", bytes: 1234, maskedRules: 2, workspaceCount: 2 });
    assert.ok(!JSON.stringify(record).includes("팀 비밀 이름"));
  });

  it("키가 없으면 마스터 문맥은 master, 그 밖은 system이다", () => {
    assert.deepEqual(egressAuditEvent(EGRESS({ ...PAYLOAD, key_id: null, key_context: "master" })).actor, { keyId: "master" });
    assert.equal(egressAuditEvent(EGRESS({ ...PAYLOAD, key_id: null })).actor, "system");
  });

  it("형식이 틀린 외부 전송 payload는 재시도 없이 dead-letter로 보낸다", async () => {
    const handler = createAuditHandler({ append: async () => assert.fail("기록하면 안 된다") }, { toAuditEvent: egressAuditEvent });
    await assert.rejects(handler(EGRESS({ stage: "x" })), OutboxPermanentError);
  });
});
