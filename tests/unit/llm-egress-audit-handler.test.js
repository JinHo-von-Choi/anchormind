/**
 * 외부 전송 감사 이벤트 기본 처리기 시험(감사 파일 기록은 대역)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */
import { describe, it, beforeEach } from "node:test";
import assert                       from "node:assert/strict";

const {
  createEgressAuditHandler,
  registerEgressAuditHandler,
  EGRESS_AUDIT_OPERATION
}                                         = await import("../../lib/llm/egress-audit-handler.js");
const { EGRESS_AUDIT_TOPIC }              = await import("../../lib/llm/EgressGate.js");
const { getOutboxHandler, registerOutboxHandler, _resetOutboxHandlers, OutboxPermanentError } =
  await import("../../lib/outbox/OutboxHandlers.js");

function event(id, payload = {}) {
  return {
    id,
    topic         : EGRESS_AUDIT_TOPIC,
    idempotencyKey: `${EGRESS_AUDIT_TOPIC}:${id}`,
    payload       : {
      key_id: "k1", key_context: "key", stage: "split", provider: "codex-cli", provider_class: "external",
      workspaces: ["team", "ops"], bytes: 120, masked_rules: 1, ...payload
    }
  };
}

describe("createEgressAuditHandler", () => {
  it("이벤트마다 감사 줄 한 개를 본문 없이 남긴다", async () => {
    const lines   = [];
    const handler = createEgressAuditHandler({ write: async (op, fields) => { lines.push({ op, fields }); } });
    await handler(event("1"));
    assert.equal(lines.length, 1);
    const [{ op, fields }] = lines;
    assert.equal(op, EGRESS_AUDIT_OPERATION);
    assert.equal(fields.type, "split");
    assert.equal(fields.actor.keyId, "k1");
    assert.match(fields.details, /event=audit\.llm\.egress:1/);
    assert.match(fields.details, /provider=codex-cli/);
    assert.match(fields.details, /bytes=120/);
    assert.match(fields.details, /workspaces=2/);
    assert.doesNotMatch(fields.details, /team|ops/);
  });

  it("master와 키 문맥 없는 호출은 행위자를 master, none으로 적는다", async () => {
    const lines   = [];
    const handler = createEgressAuditHandler({ write: async (_op, fields) => { lines.push(fields); } });
    await handler(event("2", { key_id: null, key_context: "master" }));
    await handler(event("3", { key_id: null, key_context: "none" }));
    assert.deepEqual(lines.map(f => f.actor.keyId), ["master", "none"]);
  });

  it("같은 이벤트가 다시 전달되면 줄을 다시 쓰지 않는다", async () => {
    let count = 0;
    const handler = createEgressAuditHandler({ write: async () => { count++; } });
    await handler(event("4"));
    await handler(event("4"));
    assert.equal(count, 1);
  });

  it("기록 실패는 던져 재시도되게 하고, 다음 전달에서 다시 쓴다", async () => {
    let fail  = true;
    let count = 0;
    const handler = createEgressAuditHandler({ write: async () => { if (fail) throw new Error("disk full"); count++; } });
    await assert.rejects(handler(event("5")), /disk full/);
    fail = false;
    await handler(event("5"));
    assert.equal(count, 1);
  });

  it("payload 형식이 맞지 않으면 재시도 없는 오류다", async () => {
    const handler = createEgressAuditHandler({ write: async () => {} });
    await assert.rejects(handler({ id: "6", idempotencyKey: "x:6", payload: null }), OutboxPermanentError);
    await assert.rejects(handler({ id: "7", idempotencyKey: "x:7", payload: { stage: 3 } }), OutboxPermanentError);
  });
});

describe("registerEgressAuditHandler", () => {
  beforeEach(() => _resetOutboxHandlers());

  it("topic에 처리기를 등록하고 여러 번 불러도 한 번만 등록한다", () => {
    const off1 = registerEgressAuditHandler();
    const off2 = registerEgressAuditHandler();
    assert.equal(typeof getOutboxHandler(EGRESS_AUDIT_TOPIC).handler, "function");
    assert.equal(off1, off2);
    off1();
    assert.equal(getOutboxHandler(EGRESS_AUDIT_TOPIC), null);
  });

  it("다른 소비자가 먼저 등록했어도 묶어서 둘 다 부른다", async () => {
    const seen = [];
    registerOutboxHandler(EGRESS_AUDIT_TOPIC, async (e) => { seen.push(`db:${e.id}`); });
    const off = registerEgressAuditHandler({ write: async () => { seen.push("file"); } });
    await getOutboxHandler(EGRESS_AUDIT_TOPIC).handler(event("9"), {});
    assert.deepEqual(seen, ["db:9", "file"]);
    off();
  });
});
