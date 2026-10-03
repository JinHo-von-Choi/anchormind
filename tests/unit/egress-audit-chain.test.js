/**
 * 외부 전송 감사 topic의 처리기 연쇄 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-04
 *
 * audit.llm.egress 이벤트 하나가 파일 감사 처리기와 감사 표 처리기 둘 다에 닿는지, 감사 표 기록이 외부 전송
 * payload의 단계, 제공자, 바이트를 담고 workspace 이름은 담지 않는지 본다.
 */

import { describe, it, afterEach } from "node:test";
import assert                      from "node:assert/strict";

import { getOutboxHandler, _resetOutboxHandlers } from "../../lib/outbox/OutboxHandlers.js";
import { registerEgressAuditHandler }             from "../../lib/llm/egress-audit-handler.js";
import { registerAuditTopic, egressAuditEvent, AUDIT_EGRESS_TOPIC } from "../../lib/logging/audit-consumer.js";
import { EGRESS_AUDIT_TOPIC }                     from "../../lib/llm/EgressGate.js";

const EVENT = Object.freeze({
  idempotencyKey: "audit.llm.egress:1",
  createdAt     : new Date("2026-10-04T00:00:00Z"),
  payload       : {
    key_id: "k-1", key_context: "key", stage: "consolidate", provider: "synthetic-cli", provider_class: "external",
    workspaces: ["private-ws"], bytes: 120, masked_rules: 1
  }
});

afterEach(() => _resetOutboxHandlers());

describe("audit.llm.egress 처리기 연쇄", () => {
  it("감사 표 소비자는 생산자와 같은 topic 상수를 쓴다", () => {
    assert.equal(AUDIT_EGRESS_TOPIC, EGRESS_AUDIT_TOPIC);
  });

  it("파일 감사 처리기와 감사 표 처리기가 같은 이벤트를 한 번씩 받는다", async () => {
    const lines    = [];
    const appended = [];
    const release  = registerEgressAuditHandler({ write: async (operation, fields) => { lines.push({ operation, fields }); } });
    registerAuditTopic(AUDIT_EGRESS_TOPIC, egressAuditEvent, {
      store: { append: async (record, sourceEvent) => { appended.push({ record, sourceEvent }); return { duplicate: false }; } }
    });
    try {
      await getOutboxHandler(EGRESS_AUDIT_TOPIC).handler(EVENT);
    } finally {
      release();
    }

    assert.equal(lines.length, 1);
    assert.equal(appended.length, 1);
    assert.equal(appended[0].sourceEvent, EVENT.idempotencyKey);
    const stored = JSON.stringify(appended[0].record);
    assert.match(stored, /llm\.egress/);
    assert.match(stored, /consolidate/);
    assert.match(stored, /synthetic-cli/);
    assert.doesNotMatch(stored, /private-ws/);
  });
});
