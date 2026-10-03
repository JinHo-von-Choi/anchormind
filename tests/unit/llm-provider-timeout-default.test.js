/**
 * Unit tests: LLM dispatcher provider timeout defaults.
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
    calls.push(options);
    return { ok: true };
  }
}

mock.module("../../lib/config.js", {
  namedExports: {
    LLM_PRIMARY                     : "primary",
    LLM_FALLBACKS                  : [],
    LLM_PROVIDER_TIMEOUT_MS        : 60_000,
    LLM_PROVIDER_TIMEOUT_CONFIGURED: false,
    LLM_CHAIN_TIMEOUT_MS           : 0,
    LLM_CONCURRENCY_ENABLED        : false,
    LLM_CONCURRENCY_WAIT_MS        : 30_000,
    getConcurrencyLimit            : () => 1,
    egressPolicyEnabled            : () => false,
    egressUnknownKeyMode           : () => "configured",
    EGRESS_LOCAL_HOSTS             : []
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

describe("llmJson provider timeout defaults", () => {
  it("전역 provider timeout이 명시되지 않았고 chain deadline도 없으면 provider 기본값을 보존한다", async () => {
    calls.length = 0;

    const result = await llmJson("test");

    assert.deepEqual(result, { ok: true });
    assert.equal(calls.length, 1);
    assert.equal(Object.hasOwn(calls[0], "timeoutMs"), false);
  });
});
