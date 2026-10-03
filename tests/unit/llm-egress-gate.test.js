/**
 * 외부 전송 관문 시험(정책 조회, 감사 기록은 주입한 대역)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */
import { describe, it } from "node:test";
import assert           from "node:assert/strict";

const { openEgressGate, EGRESS_AUDIT_TOPIC, EgressAuditError } = await import("../../lib/llm/EgressGate.js");
const { EgressSkippedError, EgressDeniedError }                 = await import("../../lib/llm/EgressPolicy.js");
const { register }                                              = await import("../../lib/metrics.js");

const KEY      = "key-1";
const local    = { name: "ollama", baseUrl: "http://127.0.0.1:11434" };
const external = { name: "anthropic", baseUrl: "https://api.anthropic.com" };
const cli      = { name: "codex-cli" };

/** 주입 대역: 정책 조회와 감사 기록을 기록한다. */
function harness({ policy = null, enabled = true, auditFails = false, loadFails = false } = {}) {
  const loads  = [];
  const events = [];
  const deps   = {
    enabled,
    localHosts: [],
    loadPolicy: async (keyId) => {
      loads.push(keyId);
      if (loadFails) throw new Error("db down");
      return policy;
    },
    audit: async (event) => {
      if (auditFails) throw new Error("outbox down");
      events.push(event);
      return { id: String(events.length) };
    }
  };
  return { deps, loads, events };
}

async function counter(name, labels) {
  const metric = register.getSingleMetric(name);
  const values = (await metric.get()).values;
  return values.filter(v => Object.entries(labels).every(([k, val]) => v.labels[k] === val))
    .reduce((sum, v) => sum + v.value, 0);
}

describe("openEgressGate: 스위치와 정책 조회", () => {
  it("스위치가 꺼져 있으면 정책을 조회하지 않고 체인과 프롬프트를 그대로 둔다", async () => {
    const { deps, loads, events } = harness({ enabled: false, policy: { local_only: true } });
    const gate  = await openEgressGate({ stage: "split", keyId: KEY }, deps);
    const chain = [external, cli];
    assert.equal(gate.filter(chain), chain);
    const sent = await gate.prepare(external, "token sk-ant-abcdefghijklmnop", { timeoutMs: 1 });
    assert.deepEqual(sent, { prompt: "token sk-ant-abcdefghijklmnop", options: { timeoutMs: 1 } });
    assert.equal(loads.length, 0);
    assert.equal(events.length, 0);
  });

  it("키 문맥이 없거나 master이면 조회하지 않는다", async () => {
    const { deps, loads } = harness();
    await openEgressGate({ stage: "split" }, deps);
    await openEgressGate({ stage: "split", keyId: null }, deps);
    assert.equal(loads.length, 0);
  });

  it("키 문맥이 있으면 그 키의 정책을 조회한다", async () => {
    const { deps, loads } = harness({ policy: { local_only: true } });
    const gate = await openEgressGate({ stage: "split", keyId: KEY }, deps);
    assert.deepEqual(loads, [KEY]);
    assert.deepEqual(gate.filter([local, external]), [local]);
  });

  it("정책 조회 실패와 잘못된 저장 값은 단계를 건너뛴다", async () => {
    const failing = harness({ loadFails: true });
    await assert.rejects(openEgressGate({ stage: "split", keyId: KEY }, failing.deps),
      (err) => err instanceof EgressSkippedError && err.reason === "policy_unavailable");
    const invalid = harness({ policy: { local_only: "yes" } });
    await assert.rejects(openEgressGate({ stage: "evaluate", keyId: KEY }, invalid.deps),
      (err) => err instanceof EgressSkippedError && err.reason === "policy_invalid" && err.stage === "evaluate");
  });
});

describe("filter: 체인 거르기", () => {
  it("기존 단계는 정책이 없으면 구성된 체인을 그대로 쓴다", async () => {
    const { deps } = harness();
    const gate     = await openEgressGate({ stage: "contradiction", keyId: KEY }, deps);
    assert.deepEqual(gate.filter([cli, external, local]), [cli, external, local]);
  });

  it("문맥 없는 호출은 로컬만 쓴다", async () => {
    const { deps } = harness();
    const gate     = await openEgressGate(undefined, deps);
    assert.deepEqual(gate.filter([external, local]), [local]);
  });

  it("허용 목록 밖의 외부 제공자를 빼고 순서를 지킨다", async () => {
    const { deps } = harness({ policy: { approved_providers: ["codex-cli"] } });
    const gate     = await openEgressGate({ stage: "auto_reflect", keyId: KEY }, deps);
    assert.deepEqual(gate.filter([external, cli, local]), [cli, local]);
  });

  it("남는 제공자가 없으면 외부로 대체하지 않고 단계를 건너뛰며 지표를 남긴다", async () => {
    const { deps } = harness({ policy: { local_only: true } });
    const gate     = await openEgressGate({ stage: "split", keyId: KEY }, deps);
    const before   = await counter("memento_llm_egress_skipped_total", { stage: "split", reason: "local_only" });
    assert.throws(() => gate.filter([external, cli]),
      (err) => err instanceof EgressSkippedError && err.reason === "local_only");
    assert.equal(await counter("memento_llm_egress_skipped_total", { stage: "split", reason: "local_only" }), before + 1);
  });

  it("빈 체인은 그대로 돌려준다(제공자 없음 오류는 호출기가 낸다)", async () => {
    const { deps } = harness({ policy: { local_only: true } });
    const gate     = await openEgressGate({ stage: "split", keyId: KEY }, deps);
    assert.deepEqual(gate.filter([]), []);
  });

  it("workspace 재정의는 문맥의 workspace 중 하나라도 막으면 막는다", async () => {
    const { deps } = harness({ policy: { workspaces: { closed: { local_only: true } } } });
    const open     = await openEgressGate({ stage: "contradiction", keyId: KEY, workspaces: ["a", "b"] }, deps);
    assert.deepEqual(open.filter([external]), [external]);
    const mixed    = await openEgressGate({ stage: "contradiction", keyId: KEY, workspaces: ["a", "closed"] }, deps);
    assert.throws(() => mixed.filter([external]), EgressSkippedError);
    const single   = await openEgressGate({ stage: "contradiction", keyId: KEY, workspace: "closed" }, deps);
    assert.throws(() => single.filter([external]), EgressSkippedError);
  });
});

describe("prepare: 호출 직전 확인, 마스킹, 감사", () => {
  it("외부 제공자에게는 마스킹한 프롬프트를 보내고 감사 이벤트를 먼저 남긴다", async () => {
    const { deps, events } = harness();
    const gate   = await openEgressGate({ stage: "evaluate", keyId: KEY, workspace: "team" }, deps);
    const secret = "ghp_" + "a".repeat(36);
    const sent   = await gate.prepare(external, `내용: ${secret}`, { timeoutMs: 5, systemPrompt: "sys" });

    assert.ok(!sent.prompt.includes(secret), "비밀 값이 그대로 나가면 안 된다");
    assert.deepEqual(sent.options, { timeoutMs: 5, systemPrompt: "sys" });
    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event.topic, EGRESS_AUDIT_TOPIC);
    assert.equal(event.aggregateId, KEY);
    assert.equal(event.payload.key_id, KEY);
    assert.equal(event.payload.stage, "evaluate");
    assert.equal(event.payload.provider, "anthropic");
    assert.equal(event.payload.provider_class, "external");
    assert.deepEqual(event.payload.workspaces, ["team"]);
    assert.equal(event.payload.bytes, Buffer.byteLength(sent.prompt) + Buffer.byteLength("sys"));
    assert.ok(event.payload.masked_rules >= 1);
    assert.ok(!JSON.stringify(event.payload).includes("내용"), "감사 이벤트에 본문을 담지 않는다");
  });

  it("로컬 제공자에게는 원문을 보내고 감사 이벤트를 남기지 않는다", async () => {
    const { deps, events } = harness();
    const gate   = await openEgressGate({ stage: "evaluate", keyId: KEY }, deps);
    const secret = "ghp_" + "b".repeat(36);
    const sent   = await gate.prepare(local, secret, {});
    assert.equal(sent.prompt, secret);
    assert.equal(events.length, 0);
  });

  it("감사 기록에 실패하면 그 제공자에게 보내지 않는다", async () => {
    const { deps } = harness({ auditFails: true });
    const gate     = await openEgressGate({ stage: "evaluate", keyId: KEY }, deps);
    const before   = await counter("memento_llm_egress_calls_total", { stage: "evaluate", outcome: "audit_failed" });
    await assert.rejects(gate.prepare(external, "p", {}), (err) => err instanceof EgressAuditError);
    assert.equal(await counter("memento_llm_egress_calls_total", { stage: "evaluate", outcome: "audit_failed" }), before + 1);
  });

  it("거부된 제공자에게 보내려 하면 호출 직전 확인이 막는다", async () => {
    const { deps, events } = harness({ policy: { local_only: true } });
    const gate = await openEgressGate({ stage: "split", keyId: KEY }, deps);
    await assert.rejects(gate.prepare(external, "p", {}), (err) => err instanceof EgressDeniedError && err.reason === "local_only");
    assert.equal(events.length, 0);
  });

  it("보낸 건수와 바이트를 단계와 분류별로 센다", async () => {
    const { deps } = harness();
    const gate     = await openEgressGate({ stage: "synthetic_query", keyId: null }, deps);
    const sent0    = await counter("memento_llm_egress_calls_total", { stage: "synthetic_query", provider_class: "external", outcome: "sent" });
    const bytes0   = await counter("memento_llm_egress_bytes_total", { stage: "synthetic_query", provider_class: "external" });
    await gate.prepare(cli, "abc", {});
    assert.equal(await counter("memento_llm_egress_calls_total", { stage: "synthetic_query", provider_class: "external", outcome: "sent" }), sent0 + 1);
    assert.equal(await counter("memento_llm_egress_bytes_total", { stage: "synthetic_query", provider_class: "external" }), bytes0 + 3);
  });

  it("master 키 호출의 감사 이벤트는 key_id가 null이고 문맥 구분을 싣는다", async () => {
    const { deps, events } = harness();
    const master = await openEgressGate({ stage: "split", keyId: null }, deps);
    await master.prepare(cli, "x", {});
    const none   = await openEgressGate({ stage: "split" }, deps);
    await none.prepare(cli, "x", {});
    assert.equal(events[0].aggregateId, null);
    assert.equal(events[0].payload.key_id, null);
    assert.equal(events[0].payload.key_context, "master");
    assert.equal(events[1].payload.key_context, "none");
  });
});
