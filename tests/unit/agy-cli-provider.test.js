/**
 * Unit tests: AgyCliProvider
 *
 * No real agy invocation. The CLI wrapper is mocked at module level.
 */

import { after, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { teardownTestResources } from "../_lifecycle.js";

const mockRunAgyCLI   = mock.fn();
const mockRawIsAgyCli = mock.fn();

mock.module("../../lib/agy.js", {
  namedExports: {
    runAgyCLI            : (...args) => mockRunAgyCLI(...args),
    _rawIsAgyCLIAvailable: (...args) => mockRawIsAgyCli(...args)
  }
});

const { AgyCliProvider } = await import("../../lib/llm/providers/AgyCliProvider.js");
const { createProvider, listProviderNames } = await import("../../lib/llm/registry.js");
const { getConcurrencyLimit } = await import("../../lib/config.js");

after(async () => { await teardownTestResources(); });

describe("AgyCliProvider", () => {
  beforeEach(() => {
    mockRunAgyCLI.mock.resetCalls();
    mockRawIsAgyCli.mock.resetCalls();
  });

  it("isAvailable: raw helper 결과를 그대로 반환한다", async () => {
    mockRawIsAgyCli.mock.mockImplementationOnce(async () => true);
    const provider = new AgyCliProvider();
    assert.equal(await provider.isAvailable(), true);
  });

  it("callText: JSON 전용 provider이므로 use callJson 에러를 던진다", async () => {
    const provider = new AgyCliProvider();
    await assert.rejects(() => provider.callText("hello"), /use callJson/);
  });

  it("callJson: systemPrompt, model, timeout을 constrained CLI helper로 전달한다", async () => {
    mockRunAgyCLI.mock.mockImplementationOnce(async (stdinContent, prompt, options) => {
      assert.equal(stdinContent, "");
      assert.ok(prompt.includes("system rules"));
      assert.ok(prompt.includes("Return one valid JSON value only."));
      assert.ok(prompt.includes("user payload"));
      assert.equal(options.model, "gemini-3.1-pro");
      assert.equal(options.timeoutMs, 3456);
      return "{\"ok\":true,\"source\":\"agy-cli\"}";
    });

    const provider = new AgyCliProvider({ model: "default-model" });
    const result = await provider.callJson("user payload", {
      systemPrompt: "system rules",
      model       : "gemini-3.1-pro",
      timeoutMs   : 3456
    });

    assert.deepEqual(result, { ok: true, source: "agy-cli" });
  });

  it("callJson: provider config의 model과 timeout을 기본값으로 사용한다", async () => {
    mockRunAgyCLI.mock.mockImplementationOnce(async (_stdinContent, _prompt, options) => {
      assert.equal(options.model, "gemini-3.1-pro");
      assert.equal(options.timeoutMs, 2222);
      return "{\"ok\":true}";
    });

    const provider = new AgyCliProvider({ model: "gemini-3.1-pro", timeoutMs: 2222 });
    assert.deepEqual(await provider.callJson("user payload"), { ok: true });
  });

  it("callJson: circuit breaker open 상태면 helper 호출 없이 에러를 던진다", async () => {
    const provider = new AgyCliProvider();
    provider.isCircuitOpen = async () => true;

    await assert.rejects(() => provider.callJson("user payload"), /circuit breaker open/);
    assert.equal(mockRunAgyCLI.mock.callCount(), 0);
  });
});

describe("agy-cli registry wiring", () => {
  it("listProviderNames: agy-cli를 노출한다", () => {
    assert.ok(listProviderNames().includes("agy-cli"));
  });

  it("createProvider: agy-cli config로 provider 인스턴스를 생성한다", () => {
    const provider = createProvider({
      provider : "agy-cli",
      model    : "gemini-3.1-pro",
      timeoutMs: 2222
    });

    assert.equal(provider?.name, "agy-cli");
    assert.equal(provider?.config?.model, "gemini-3.1-pro");
    assert.equal(provider?.config?.timeoutMs, 2222);
  });

  it("getConcurrencyLimit: agy-cli 기본 동시성은 다른 로컬 CLI처럼 1이다", () => {
    assert.equal(getConcurrencyLimit("agy-cli||", "agy-cli"), 1);
  });
});
