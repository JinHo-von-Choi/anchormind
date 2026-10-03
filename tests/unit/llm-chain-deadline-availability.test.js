/**
 * Unit tests: LLM dispatcher chain deadline includes availability checks.
 */

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

let now = 1_000;
let providerCallCount = 0;
let availabilityMode = "advance-clock";
const availabilityTimeouts = [];

class MockProvider {
  constructor(config) {
    this.name   = config.provider;
    this.config = config;
  }

  async isAvailable(timeoutMs) {
    availabilityTimeouts.push(timeoutMs);
    if (availabilityMode === "hang") {
      return new Promise(() => {});
    }
    now += 50;
    return true;
  }

  async callJson() {
    providerCallCount += 1;
    return { ok: true };
  }
}

mock.module("../../lib/config.js", {
  namedExports: {
    LLM_PRIMARY                     : "primary",
    LLM_FALLBACKS                  : [],
    LLM_PROVIDER_TIMEOUT_MS        : 60_000,
    LLM_PROVIDER_TIMEOUT_CONFIGURED: false,
    LLM_CHAIN_TIMEOUT_MS           : 40,
    LLM_CONCURRENCY_ENABLED        : false,
    LLM_CONCURRENCY_WAIT_MS        : 30_000,
    getConcurrencyLimit            : () => 1,
    egressPolicyEnabled            : () => false,
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

describe("llmJson chain deadline availability budget", () => {
  it("isAvailable 대기 시간이 chain deadline을 초과하면 provider 호출 전에 중단한다", async () => {
    const originalNow = Date.now;
    Date.now = () => now;
    providerCallCount = 0;
    availabilityMode = "advance-clock";
    availabilityTimeouts.length = 0;

    try {
      await assert.rejects(
        () => llmJson("test"),
        /chain deadline exceeded after 40ms/
      );

      assert.equal(providerCallCount, 0);
      assert.equal(availabilityTimeouts[0], 40);
    } finally {
      Date.now = originalNow;
    }
  });

  it("isAvailable promise가 끝나지 않아도 chain deadline에서 중단한다", async () => {
    const originalNow = Date.now;
    Date.now = () => now;
    providerCallCount = 0;
    availabilityMode = "hang";
    availabilityTimeouts.length = 0;

    const started = performance.now();
    try {
      await assert.rejects(
        () => llmJson("test"),
        /chain deadline exceeded after 40ms/
      );

      assert.equal(providerCallCount, 0);
      assert.equal(availabilityTimeouts[0], 40);
      assert.ok(performance.now() - started < 200);
    } finally {
      Date.now = originalNow;
    }
  });
});
