/**
 * llmJson 외부 전송 관문 연결 시험(제공자, 정책 조회, outbox는 대역)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */
import { describe, it, mock, beforeEach } from "node:test";
import assert                             from "node:assert/strict";

const log      = [];
let   enabled  = true;
let   policies = new Map();
let   auditOk  = true;
let   outboxOn = true;
let   unknownKeyMode = "configured";
const warns    = [];

class StubProvider {
  constructor(config) {
    this.config  = typeof config === "string" ? { provider: config } : config;
    this.name    = this.config.provider;
    this.baseUrl = this.config.baseUrl ?? null;
  }
  async isAvailable() { return true; }
  async callJson(prompt, options) {
    log.push({ kind: "call", provider: this.name, prompt, options });
    if (this.config.fail) throw new Error("upstream failed");
    return { picked: this.name };
  }
}

mock.module("../../lib/config.js", {
  namedExports: {
    LLM_PRIMARY                    : "global-primary",
    LLM_FALLBACKS                  : [],
    LLM_PROVIDER_TIMEOUT_MS        : 60_000,
    LLM_PROVIDER_TIMEOUT_CONFIGURED: false,
    LLM_CHAIN_TIMEOUT_MS           : 0,
    LLM_CONCURRENCY_ENABLED        : false,
    LLM_CONCURRENCY_WAIT_MS        : 30_000,
    getConcurrencyLimit            : () => 1,
    egressPolicyEnabled            : () => enabled,
    egressUnknownKeyMode           : () => unknownKeyMode,
    EGRESS_LOCAL_HOSTS             : []
  }
});
mock.module("../../lib/llm/registry.js", {
  namedExports: { createProvider: (cfg) => new StubProvider(cfg) }
});
mock.module("../../lib/logger.js", {
  namedExports: {
    logWarn        : (msg) => { warns.push(String(msg)); },
    REDACT_PATTERNS: [],
    redactString   : (value) => value
  }
});
mock.module("../../lib/admin/ApiKeyStore.js", {
  namedExports: { getEgressPolicy: async (keyId) => policies.get(keyId) ?? null }
});
mock.module("../../lib/tools/db.js", {
  namedExports: { getPrimaryPool: () => ({ pool: true }) }
});
mock.module("../../lib/outbox/Outbox.js", {
  namedExports: {
    enqueueStandalone: async (_pool, event) => {
      if (!auditOk) throw new Error("outbox down");
      if (!outboxOn) return null;
      log.push({ kind: "audit", provider: event.payload.provider, stage: event.payload.stage });
      return { id: "1" };
    }
  }
});

const { llmJson }            = await import("../../lib/llm/index.js");
const { EgressSkippedError } = await import("../../lib/llm/EgressPolicy.js");
const { register }           = await import("../../lib/metrics.js");

async function counter(name, labels) {
  const values = (await register.getSingleMetric(name).get()).values;
  return values.filter(v => Object.entries(labels).every(([k, val]) => v.labels[k] === val))
    .reduce((sum, v) => sum + v.value, 0);
}

const LOCAL    = { provider: "ollama", baseUrl: "http://127.0.0.1:11434" };
const EXTERNAL = { provider: "anthropic", baseUrl: "https://api.anthropic.com" };
const CLI      = { provider: "codex-cli" };

describe("llmJson과 외부 전송 관문", () => {
  beforeEach(() => {
    log.length   = 0;
    warns.length = 0;
    enabled      = true;
    auditOk      = true;
    outboxOn     = true;
    unknownKeyMode = "configured";
    policies     = new Map();
  });

  it("정책이 없는 기존 단계는 구성된 체인의 첫 제공자를 그대로 쓴다", async () => {
    const out = await llmJson("p", { providers: [EXTERNAL, LOCAL], egress: { stage: "split", keyId: "k1" } });
    assert.equal(out.picked, "anthropic");
    assert.deepEqual(log.map(e => e.kind), ["audit", "call"]);
  });

  it("local_only 키는 외부 제공자를 건너뛰고 로컬 제공자를 쓴다", async () => {
    policies.set("k1", { local_only: true });
    const out = await llmJson("p", { providers: [EXTERNAL, CLI, LOCAL], egress: { stage: "split", keyId: "k1" } });
    assert.equal(out.picked, "ollama");
    assert.deepEqual(log.filter(e => e.kind === "call").map(e => e.provider), ["ollama"]);
    assert.equal(log.filter(e => e.kind === "audit").length, 0);
  });

  it("로컬 제공자가 실패해도 외부로 대체하지 않는다", async () => {
    policies.set("k1", { local_only: true });
    await assert.rejects(
      llmJson("p", { providers: [{ ...LOCAL, fail: true }, EXTERNAL], egress: { stage: "split", keyId: "k1" } }),
      /all LLM providers failed/
    );
    assert.deepEqual(log.filter(e => e.kind === "call").map(e => e.provider), ["ollama"]);
  });

  it("남는 제공자가 없으면 아무 제공자도 부르지 않고 단계를 건너뛴다", async () => {
    policies.set("k1", { local_only: true });
    await assert.rejects(
      llmJson("p", { providers: [EXTERNAL, CLI], egress: { stage: "evaluate", keyId: "k1" } }),
      (err) => err instanceof EgressSkippedError && err.stage === "evaluate"
    );
    assert.equal(log.length, 0);
  });

  it("문맥 없는 호출은 로컬만 쓴다", async () => {
    await assert.rejects(llmJson("p", { providers: [EXTERNAL] }), EgressSkippedError);
    assert.equal(log.length, 0);
  });

  it("외부 제공자에게는 가린 프롬프트를 보내고 문맥을 넘기지 않는다", async () => {
    const secret = "ghp_" + "c".repeat(36);
    await llmJson(`값 ${secret}`, { providers: [EXTERNAL], timeoutMs: 7, egress: { stage: "auto_reflect", keyId: "k1" } });
    const call = log.find(e => e.kind === "call");
    assert.ok(!call.prompt.includes(secret));
    assert.equal(call.options.timeoutMs, 7);
    assert.equal(Object.hasOwn(call.options, "egress"), false);
    assert.equal(Object.hasOwn(call.options, "providers"), false);
  });

  it("감사 기록에 실패한 외부 제공자는 건너뛰고 다음 제공자로 간다", async () => {
    auditOk = false;
    const out = await llmJson("p", { providers: [EXTERNAL, LOCAL], egress: { stage: "split", keyId: "k1" } });
    assert.equal(out.picked, "ollama");
    assert.deepEqual(log.filter(e => e.kind === "call").map(e => e.provider), ["ollama"]);
  });

  it("감사 기록 실패는 제공자 실패로 세지 않고 제공자 실패 경고도 남기지 않는다", async () => {
    auditOk = false;
    const before = await counter("memento_llm_provider_calls_total", { provider: "anthropic", outcome: "failure" });
    await llmJson("p", { providers: [EXTERNAL, LOCAL], egress: { stage: "split", keyId: "k1" } });
    assert.equal(await counter("memento_llm_provider_calls_total", { provider: "anthropic", outcome: "failure" }), before);
    assert.equal(warns.filter(w => /anthropic failed, trying next/.test(w)).length, 0);
  });

  it("outbox가 꺼져 감사 행 없이 보낸 건은 sent_unaudited로 센다", async () => {
    outboxOn = false;
    const before = await counter("memento_llm_egress_calls_total", { stage: "split", provider: "anthropic", outcome: "sent_unaudited" });
    const out    = await llmJson("p", { providers: [EXTERNAL], egress: { stage: "split", keyId: "k1" } });
    assert.equal(out.picked, "anthropic");
    assert.equal(await counter("memento_llm_egress_calls_total", { stage: "split", provider: "anthropic", outcome: "sent_unaudited" }), before + 1);
  });

  it("MEMENTO_EGRESS_UNKNOWN_KEY=local_only는 키를 알 수 없는 호출만 로컬로 제한한다", async () => {
    unknownKeyMode = "local_only";
    await assert.rejects(llmJson("p", { providers: [EXTERNAL], egress: { stage: "split" } }), EgressSkippedError);
    const master = await llmJson("p", { providers: [EXTERNAL], egress: { stage: "split", keyId: null } });
    assert.equal(master.picked, "anthropic");
    const keyed  = await llmJson("p", { providers: [EXTERNAL], egress: { stage: "split", keyId: "k1" } });
    assert.equal(keyed.picked, "anthropic");
  });

  it("스위치가 꺼져 있으면 정책과 관계없이 구성된 체인과 원문을 쓴다", async () => {
    enabled = false;
    policies.set("k1", { local_only: true });
    const secret = "ghp_" + "d".repeat(36);
    const out    = await llmJson(secret, { providers: [EXTERNAL], egress: { stage: "split", keyId: "k1" } });
    assert.equal(out.picked, "anthropic");
    assert.equal(log.find(e => e.kind === "call").prompt, secret);
    assert.equal(log.filter(e => e.kind === "audit").length, 0);
  });
});
