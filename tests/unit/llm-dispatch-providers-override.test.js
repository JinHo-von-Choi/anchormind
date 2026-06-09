/**
 * Unit tests: llmJson honors options.providers as a per-call chain override.
 */
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

const attempts = [];

class MockProvider {
  constructor(config) {
    this.config = typeof config === "string" ? { provider: config } : config;
    this.name   = this.config.provider;
  }
  async isAvailable() { return true; }
  async callJson(_p, _o) { attempts.push(this.name); return { picked: this.name }; }
}

mock.module("../../lib/config.js", {
  namedExports: {
    LLM_PRIMARY                     : "global-primary",
    LLM_FALLBACKS                  : [],
    LLM_PROVIDER_TIMEOUT_MS        : 60_000,
    LLM_PROVIDER_TIMEOUT_CONFIGURED: false,
    LLM_CHAIN_TIMEOUT_MS           : 0,
    LLM_CONCURRENCY_ENABLED        : false,
    LLM_CONCURRENCY_WAIT_MS        : 30_000,
    getConcurrencyLimit            : () => 1
  }
});
mock.module("../../lib/llm/registry.js", {
  namedExports: { createProvider: (cfg) => new MockProvider(cfg) }
});
mock.module("../../lib/llm/metrics.js", {
  namedExports: {
    llmProviderCallsTotal        : { inc: () => {} },
    llmProviderLatencyMs         : { observe: () => {} },
    llmFallbackTriggeredTotal    : { inc: () => {} },
    llmProviderConcurrencyActive : { inc: () => {}, dec: () => {} },
    llmProviderConcurrencyWaitMs : { observe: () => {} },
    llmProvider429Total          : { inc: () => {} }
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

describe("llmJson options.providers override", () => {
  it("uses the provided provider set instead of the global chain", async () => {
    attempts.length = 0;
    const result = await llmJson("p", { providers: [{ provider: "split-only" }] });
    assert.equal(result.picked, "split-only");
    assert.deepEqual(attempts, ["split-only"]);
  });

  it("falls back to the global chain when providers is absent", async () => {
    attempts.length = 0;
    const result = await llmJson("p", {});
    assert.equal(result.picked, "global-primary");
    assert.deepEqual(attempts, ["global-primary"]);
  });
});
