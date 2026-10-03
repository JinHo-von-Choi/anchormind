/**
 * Unit tests: LLM dispatcher chain deadline with semaphore wait.
 */

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

let now = 1_000;
let providerCallCount = 0;

class MockProvider {
  constructor(config) {
    this.name   = config.provider;
    this.config = config;
  }

  async isAvailable() {
    return true;
  }

  async callJson(_prompt, _options) {
    providerCallCount += 1;
    return { ok: true };
  }
}

const mockSemaphore = {
  acquire: mock.fn(async () => {
    now += 50;
  }),
  release: mock.fn(() => {})
};

mock.module("../../lib/config.js", {
  namedExports: {
    LLM_PRIMARY             : "primary",
    LLM_FALLBACKS          : [],
    LLM_PROVIDER_TIMEOUT_MS : 60_000,
    LLM_PROVIDER_TIMEOUT_CONFIGURED: false,
    LLM_CHAIN_TIMEOUT_MS    : 40,
    LLM_CONCURRENCY_ENABLED : true,
    LLM_CONCURRENCY_WAIT_MS : 30_000,
    getConcurrencyLimit     : () => 1,
    egressPolicyEnabled     : () => false,
    egressUnknownKeyMode    : () => "configured",
    EGRESS_LOCAL_HOSTS      : []
  }
});

mock.module("../../lib/llm/registry.js", {
  namedExports: {
    createProvider: (config) => new MockProvider(config)
  }
});

mock.module("../../lib/llm/util/semaphore.js", {
  namedExports: {
    getSemaphore: () => mockSemaphore
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

describe("llmJson chain deadline with concurrency", () => {
  it("semaphore wait time을 차감한 뒤 provider 호출 전에 deadline 초과를 중단한다", async () => {
    const originalNow = Date.now;
    Date.now = () => now;
    providerCallCount = 0;
    mockSemaphore.acquire.mock.resetCalls();
    mockSemaphore.release.mock.resetCalls();

    try {
      await assert.rejects(
        () => llmJson("test"),
        /chain deadline exceeded after 40ms/
      );

      assert.equal(mockSemaphore.acquire.mock.callCount(), 1);
      assert.equal(mockSemaphore.acquire.mock.calls[0].arguments[0], 40);
      assert.equal(mockSemaphore.release.mock.callCount(), 1);
      assert.equal(providerCallCount, 0);
    } finally {
      Date.now = originalNow;
    }
  });
});
