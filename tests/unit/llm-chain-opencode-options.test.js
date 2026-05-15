/**
 * Unit tests: LLM dispatcher keeps OpenCode provider options in chain identity.
 */

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

const attempts = [];

class MockProvider {
  constructor(config) {
    this.config = typeof config === "string" ? { provider: config } : config;
    this.name   = this.config.provider;
  }

  async isAvailable() {
    return this.name !== "unavailable";
  }

  async callJson(_prompt, _options) {
    attempts.push(`${this.config.agent}:${this.config.variant}`);
    if (this.config.variant === "low") {
      throw new Error("low variant failed");
    }
    return { ok: true, variant: this.config.variant };
  }
}

mock.module("../../lib/config.js", {
  namedExports: {
    LLM_PRIMARY             : "unavailable",
    LLM_FALLBACKS          : [
      { provider: "opencode-cli", model: "github-copilot/claude-sonnet-4.5", agent: "general", variant: "low" },
      { provider: "opencode-cli", model: "github-copilot/claude-sonnet-4.5", agent: "general", variant: "high" }
    ],
    LLM_CHAIN_TIMEOUT_MS    : 0,
    LLM_PROVIDER_TIMEOUT_MS : 60_000,
    LLM_PROVIDER_TIMEOUT_CONFIGURED: false,
    LLM_CONCURRENCY_ENABLED : false,
    LLM_CONCURRENCY_WAIT_MS : 30_000,
    getConcurrencyLimit     : () => 1
  }
});

mock.module("../../lib/llm/registry.js", {
  namedExports: {
    createProvider: (config) => new MockProvider(config)
  }
});

mock.module("../../lib/llm/metrics.js", {
  namedExports: {
    llmProviderCallsTotal          : { inc: () => {} },
    llmProviderLatencyMs           : { observe: () => {} },
    llmFallbackTriggeredTotal      : { inc: () => {} },
    llmProviderConcurrencyActive   : { inc: () => {}, dec: () => {} },
    llmProviderConcurrencyWaitMs   : { observe: () => {} },
    llmProvider429Total            : { inc: () => {} }
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

describe("llmJson OpenCode provider option identity", () => {
  it("같은 model이어도 agent/variant가 다르면 fallback 후보를 각각 시도한다", async () => {
    attempts.length = 0;

    const result = await llmJson("test");

    assert.deepEqual(result, { ok: true, variant: "high" });
    assert.deepEqual(attempts, ["general:low", "general:high"]);
  });
});
