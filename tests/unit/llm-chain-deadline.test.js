/**
 * Unit tests: LLM dispatcher chain deadline.
 */

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

const calls = [];

class MockProvider {
  constructor(config) {
    this.name   = config.provider;
    this.config = config;
  }

  async isAvailable() {
    return true;
  }

  async callJson(_prompt, options) {
    calls.push({ name: this.name, timeoutMs: options.timeoutMs });
    if (this.name === "primary") {
      await new Promise(resolve => setTimeout(resolve, 50));
      throw new Error("primary failed");
    }
    return { ok: true, provider: this.name };
  }
}

mock.module("../../lib/config.js", {
  namedExports: {
    LLM_PRIMARY         : "primary",
    LLM_FALLBACKS      : [
      { provider: "primary", timeoutMs: 70 },
      { provider: "fallback", timeoutMs: 70 }
    ],
    LLM_PROVIDER_TIMEOUT_MS : 60_000,
    LLM_PROVIDER_TIMEOUT_CONFIGURED: false,
    LLM_CHAIN_TIMEOUT_MS    : 80,
    LLM_CONCURRENCY_ENABLED : false,
    LLM_CONCURRENCY_WAIT_MS : 30_000,
    getConcurrencyLimit     : () => 1,
    egressPolicyEnabled     : () => false,
    EGRESS_LOCAL_HOSTS      : []
  }
});

mock.module("../../lib/llm/registry.js", {
  namedExports: {
    createProvider: (config) => new MockProvider(config)
  }
});

mock.module("../../lib/logger.js", {
  namedExports: {
    logWarn        : () => {},
    REDACT_PATTERNS: [],
    redactString   : (value) => value
  }
});

const { llmJson } = await import("../../lib/llm/index.js");

describe("llmJson chain deadline", () => {
  it("fallback provider timeout을 남은 chain deadline 이하로 줄인다", async () => {
    calls.length = 0;

    const result = await llmJson("test");

    assert.deepEqual(result, { ok: true, provider: "fallback" });
    assert.equal(calls[0].name, "primary");
    assert.equal(calls[0].timeoutMs, 70);
    assert.equal(calls[1].name, "fallback");
    assert.ok(calls[1].timeoutMs > 0);
    assert.ok(calls[1].timeoutMs < 70);
    assert.ok(calls[1].timeoutMs <= 80);
  });
});
