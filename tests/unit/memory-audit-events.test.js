/**
 * 기억 도구와 쓰기 관문의 감사 이벤트 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * MemoryManager와 감사 기록기(audit-outbox.recordAudit)만 대체하고 실제 도구 처리기를 불러, remember,
 * amend, forget, link, 앵커, 관문 거부가 남기는 감사 이벤트의 행위, 대상, 결과와 본문 미포함을 본다.
 */

import { describe, it, mock, beforeEach } from "node:test";
import assert                              from "node:assert/strict";
import crypto                              from "node:crypto";

process.env.DOTENV_CONFIG_PATH      ??= ".env.test";
process.env.MEMENTO_METRICS_DEFAULT ??= "off";
process.env.REDIS_ENABLED           ??= "false";
process.env.CACHE_ENABLED           ??= "false";

const recorded = [];
let   manager  = {};

mock.module("../../lib/logging/audit-outbox.js", {
  exports: { recordAudit: async (event) => { recorded.push(event); return null; }, enqueueAudit: async () => null }
});
const realManager = await import("../../lib/memory/MemoryManager.js");
mock.module("../../lib/memory/MemoryManager.js", {
  namedExports: { ...realManager, MemoryManager: { getInstance: () => manager } }
});

const { tool_remember, tool_amend, tool_forget, tool_link } = await import("../../lib/tools/memory.js");
const { WriteGate, gateBlockAuditEvent, WRITE_ENTRIES }    = await import("../../lib/memory/write/WriteGate.js");
const { SymbolicPolicyViolationError }                     = await import("../../lib/symbolic/errors.js");
const { buildAuditPayload }                                = await import("../../lib/logging/audit-event.js");

const KEY_ID  = "6f1c0f7e-3333-4000-8000-000000000004";
const ACTOR   = Object.freeze({ keyId: KEY_ID, sessionId: "0f8e2d6c-9999-4000-8000-000000000000", clientIp: "203.0.113.9" });
const CONTENT = "배포 키는 매주 월요일에 교체한다";
const sha256  = (t) => crypto.createHash("sha256").update(t, "utf8").digest("hex");
const args    = (extra) => ({ _auditActor: ACTOR, _defaultWorkspace: "team-a", ...extra });
const actions = () => recorded.map(e => e.action);

beforeEach(() => {
  recorded.length = 0;
  manager         = {};
});

describe("remember", () => {
  it("본문 대신 sha256과 길이를 담은 memory.remember를 남기고 payload 규칙을 통과한다", async () => {
    manager.remember = async () => ({ id: "frag-1" });
    await tool_remember(args({ content: CONTENT, topic: "ops", type: "procedure" }));
    assert.deepEqual(actions(), ["memory.remember"]);
    const event = recorded[0];
    assert.equal(event.outcome, "success");
    assert.deepEqual(event.target, { type: "fragment", id: "frag-1" });
    assert.equal(event.workspace, "team-a");
    assert.equal(event.actor, ACTOR);
    assert.equal(event.detail.contentSha256, sha256(CONTENT));
    assert.equal(event.detail.contentLength, [...CONTENT].length);
    const payload = buildAuditPayload(event);
    assert.ok(!JSON.stringify(payload).includes(CONTENT));
  });

  it("앵커로 저장하면 memory.anchor를 함께 남긴다", async () => {
    manager.remember = async () => ({ id: "frag-2" });
    await tool_remember(args({ content: CONTENT, topic: "ops", type: "fact", isAnchor: true }));
    assert.deepEqual(actions(), ["memory.remember", "memory.anchor"]);
    assert.deepEqual(recorded[1].target, { type: "fragment", id: "frag-2" });
  });

  it("dryRun은 남기지 않는다", async () => {
    manager.remember = async () => ({ id: null, dryRun: true });
    await tool_remember(args({ content: CONTENT, topic: "ops", type: "fact", dryRun: true }));
    assert.deepEqual(actions(), []);
  });

  it("실패는 오류 분류만 담은 failure로 남기고 오류 메시지는 담지 않는다", async () => {
    manager.remember = async () => { const e = new Error(`quota exceeded for ${CONTENT}`); e.code = "QUOTA"; throw e; };
    await tool_remember(args({ content: CONTENT, topic: "ops", type: "fact" }));
    assert.equal(recorded[0].outcome, "failure");
    assert.equal(recorded[0].detail.errorCode, "QUOTA");
    assert.ok(!JSON.stringify(recorded[0]).includes("quota exceeded"));
  });
});

describe("amend, forget, link", () => {
  it("amend는 바뀐 필드 이름과 본문 지문을 남기고 앵커 변경은 memory.anchor로 남긴다", async () => {
    manager.amend = async () => ({ updated: true });
    await tool_amend(args({ id: "frag-3", content: CONTENT, importance: 0.9, isAnchor: false }));
    assert.deepEqual(actions(), ["memory.amend", "memory.anchor"]);
    assert.deepEqual(recorded[0].detail.changed, ["content", "importance", "isAnchor"]);
    assert.equal(recorded[0].detail.contentSha256, sha256(CONTENT));
    assert.deepEqual(recorded[1].detail, { isAnchor: false });
  });

  it("갱신하지 못한 amend는 failure이고 앵커 이벤트가 없다", async () => {
    manager.amend = async () => ({ updated: false, error: "Fragment not found" });
    await tool_amend(args({ id: "frag-4", isAnchor: true }));
    assert.deepEqual(actions(), ["memory.amend"]);
    assert.equal(recorded[0].outcome, "failure");
  });

  it("forget은 대상과 삭제 수를, 예외는 failure를 남긴다", async () => {
    manager.forget = async () => ({ deleted: 2 });
    await tool_forget(args({ topic: "old-notes" }));
    assert.deepEqual(recorded[0].target, { type: "topic", id: "old-notes" });
    assert.equal(recorded[0].detail.deleted, 2);

    manager.forget = async () => { throw new Error("db"); };
    await tool_forget(args({ id: "frag-5" }));
    assert.equal(recorded[1].outcome, "failure");
    assert.deepEqual(recorded[1].target, { type: "fragment", id: "frag-5" });
  });

  it("link는 출발 파편을 대상으로, 도착 파편과 관계를 detail로 남긴다", async () => {
    manager.link = async () => ({ linkId: 9 });
    await tool_link(args({ fromId: "frag-6", toId: "frag-7", relationType: "resolved_by" }));
    assert.equal(recorded[0].action, "memory.link");
    assert.deepEqual(recorded[0].target, { type: "fragment", id: "frag-6" });
    assert.deepEqual(recorded[0].detail, { toId: "frag-7", relationType: "resolved_by" });
  });
});

describe("관문 거부", () => {
  it("hard gate 키의 거부를 gate.block(denied)으로 남긴다", async () => {
    const events = [];
    const gate   = new WriteGate({
      getHardGate: async () => true,
      policyRules: { check: () => [{ rule: "missingTopic", severity: "high", detail: "x", ruleVersion: "v1" }] },
      policyGatingEnabled: true,
      auditReject: (e) => events.push(e)
    });
    await assert.rejects(gate.check({
      entry : WRITE_ENTRIES.REMEMBER,
      op    : "create",
      fields: { content: "충분히 긴 본문 내용입니다 테스트", type: "fact", topic: "t" },
      build : (f) => ({ ...f, workspace: "team-b" }),
      ctx   : { keyId: KEY_ID }
    }), SymbolicPolicyViolationError);
    assert.equal(events.length, 1);
    assert.equal(events[0].action, "gate.block");
    assert.equal(events[0].outcome, "denied");
    assert.deepEqual(events[0].actor, { keyId: KEY_ID });
    assert.equal(events[0].workspace, "team-b");
    assert.equal(events[0].detail.rule, "missingTopic");
    assert.doesNotThrow(() => buildAuditPayload(events[0]));
  });

  it("서버 내부 진입점의 거부는 system, 키 없는 사용자 진입점은 master다", () => {
    const base = { op: "create", ctx: { keyId: null }, draft: { type: "fact" } };
    assert.equal(gateBlockAuditEvent({ ...base, entry: WRITE_ENTRIES.AUTO_REFLECT }, "r").actor, "system");
    assert.deepEqual(gateBlockAuditEvent({ ...base, entry: WRITE_ENTRIES.REMEMBER }, "r").actor, { keyId: "master" });
  });
});
