/**
 * Unit tests: CodexCliProvider
 *
 * 실제 codex 바이너리 호출 0건 — lib/codex.js를 mock.module로 차단한다.
 */

import { after, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { teardownTestResources } from "../_lifecycle.js";

const mockRunCodexCLI   = mock.fn();
const mockRawIsCodexCli = mock.fn();

mock.module("../../lib/codex.js", {
  namedExports: {
    runCodexCLI            : (...args) => mockRunCodexCLI(...args),
    _rawIsCodexCLIAvailable: (...args) => mockRawIsCodexCli(...args)
  }
});

const { CodexCliProvider } = await import("../../lib/llm/providers/CodexCliProvider.js");
const { createProvider, listProviderNames } = await import("../../lib/llm/registry.js");

after(async () => { await teardownTestResources(); });

describe("CodexCliProvider", () => {
  beforeEach(() => {
    mockRunCodexCLI.mock.resetCalls();
    mockRawIsCodexCli.mock.resetCalls();
  });

  it("isAvailable: raw helper 결과를 그대로 반환한다", async () => {
    mockRawIsCodexCli.mock.mockImplementationOnce(async () => true);
    const provider = new CodexCliProvider();
    assert.equal(await provider.isAvailable(), true);
  });

  it("callText: JSON 전용 provider이므로 use callJson 에러를 던진다", async () => {
    const provider = new CodexCliProvider();

    await assert.rejects(
      () => provider.callText("hello"),
      /use callJson/
    );
  });

  it("callJson: systemPrompt + JSON-only 가이드 + prompt를 helper로 전달한다", async () => {
    mockRunCodexCLI.mock.mockImplementationOnce(async (stdinContent, prompt, options) => {
      assert.equal(stdinContent, "");
      assert.ok(prompt.includes("system rules"));
      assert.ok(prompt.includes("Return one valid JSON value only."));
      assert.ok(prompt.includes("user payload"));
      assert.equal(options.model, "gpt-5.3-codex-spark");
      assert.equal(options.timeoutMs, 1234);
      return "{\"ok\":true,\"source\":\"codex-cli\"}";
    });

    const provider = new CodexCliProvider({ model: "default-model" });
    const result = await provider.callJson("user payload", {
      systemPrompt: "system rules",
      model       : "gpt-5.3-codex-spark",
      timeoutMs   : 1234
    });

    assert.deepEqual(result, { ok: true, source: "codex-cli" });
  });

  it("callJson: options.model이 없으면 provider config.model을 사용한다", async () => {
    mockRunCodexCLI.mock.mockImplementationOnce(async (_stdinContent, _prompt, options) => {
      assert.equal(options.model, "gpt-5.3-codex-spark");
      return "{\"ok\":true}";
    });

    const provider = new CodexCliProvider({ model: "gpt-5.3-codex-spark" });
    const result = await provider.callJson("user payload");

    assert.deepEqual(result, { ok: true });
  });

  it("callJson: options.timeoutMs이 없으면 provider config.timeoutMs를 사용한다", async () => {
    mockRunCodexCLI.mock.mockImplementationOnce(async (_stdinContent, _prompt, options) => {
      assert.equal(options.timeoutMs, 2222);
      return "{\"ok\":true}";
    });

    const provider = new CodexCliProvider({ timeoutMs: 2222 });
    const result = await provider.callJson("user payload");

    assert.deepEqual(result, { ok: true });
  });

  it("callJson: circuit breaker open 상태면 helper 호출 없이 에러를 던진다", async () => {
    const provider = new CodexCliProvider();
    provider.isCircuitOpen = async () => true;

    await assert.rejects(
      () => provider.callJson("user payload"),
      /circuit breaker open/
    );

    assert.equal(mockRunCodexCLI.mock.callCount(), 0);
  });
});

describe("codex-cli registry wiring", () => {
  it("listProviderNames: codex-cli를 노출한다", () => {
    assert.ok(listProviderNames().includes("codex-cli"));
  });

  it("createProvider: codex-cli config로 provider 인스턴스를 생성한다", () => {
    const provider = createProvider({
      provider : "codex-cli",
      model    : "gpt-5.3-codex-spark",
      timeoutMs: 2222
    });

    assert.equal(provider?.name, "codex-cli");
    assert.equal(provider?.config?.model, "gpt-5.3-codex-spark");
    assert.equal(provider?.config?.timeoutMs, 2222);
  });
});
