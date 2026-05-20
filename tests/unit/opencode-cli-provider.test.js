/**
 * Unit tests: OpenCodeCliProvider
 *
 * No real opencode invocation. lib/opencode.js is mocked at module level.
 */

import { after, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { teardownTestResources } from "../_lifecycle.js";

const mockRunOpenCodeCLI   = mock.fn();
const mockRawIsOpenCodeCli = mock.fn();

mock.module("../../lib/opencode.js", {
  namedExports: {
    runOpenCodeCLI            : (...args) => mockRunOpenCodeCLI(...args),
    _rawIsOpenCodeCLIAvailable: (...args) => mockRawIsOpenCodeCli(...args)
  }
});

const { OpenCodeCliProvider } = await import("../../lib/llm/providers/OpenCodeCliProvider.js");
const { createProvider, listProviderNames } = await import("../../lib/llm/registry.js");
const { getConcurrencyLimit } = await import("../../lib/config.js");

after(async () => { await teardownTestResources(); });

describe("OpenCodeCliProvider", () => {
  beforeEach(() => {
    mockRunOpenCodeCLI.mock.resetCalls();
    mockRawIsOpenCodeCli.mock.resetCalls();
  });

  it("isAvailable: raw helper 결과를 그대로 반환한다", async () => {
    mockRawIsOpenCodeCli.mock.mockImplementationOnce(async () => true);
    const provider = new OpenCodeCliProvider();
    assert.equal(await provider.isAvailable(), true);
  });

  it("callText: JSON 전용 provider이므로 use callJson 에러를 던진다", async () => {
    const provider = new OpenCodeCliProvider();

    await assert.rejects(
      () => provider.callText("hello"),
      /use callJson/
    );
  });

  it("callJson: systemPrompt + JSON-only 가이드 + prompt를 helper로 전달한다", async () => {
    mockRunOpenCodeCLI.mock.mockImplementationOnce(async (prompt, options) => {
      assert.ok(prompt.includes("system rules"));
      assert.ok(prompt.includes("Return one valid JSON value only."));
      assert.ok(prompt.includes("user payload"));
      assert.equal(options.model, "github-copilot/claude-sonnet-4.5");
      assert.equal(options.agent, "general");
      assert.equal(options.variant, "low");
      assert.equal(options.timeoutMs, 3456);
      return "{\"ok\":true,\"source\":\"opencode-cli\"}";
    });

    const provider = new OpenCodeCliProvider({
      model  : "default-model",
      agent  : "default-agent",
      variant: "default-variant"
    });
    const result = await provider.callJson("user payload", {
      systemPrompt: "system rules",
      model       : "github-copilot/claude-sonnet-4.5",
      agent       : "general",
      variant     : "low",
      timeoutMs   : 3456
    });

    assert.deepEqual(result, { ok: true, source: "opencode-cli" });
  });

  it("callJson: options.timeoutMs와 config.timeoutMs가 없으면 60000ms를 사용한다", async () => {
    mockRunOpenCodeCLI.mock.mockImplementationOnce(async (_prompt, options) => {
      assert.equal(options.timeoutMs, 60_000);
      return "{\"ok\":true}";
    });

    const provider = new OpenCodeCliProvider();
    const result = await provider.callJson("user payload");

    assert.deepEqual(result, { ok: true });
  });

  it("callJson: fenced JSON 출력도 파싱한다", async () => {
    mockRunOpenCodeCLI.mock.mockImplementationOnce(async () => "```json\n{\"ok\":true}\n```");

    const provider = new OpenCodeCliProvider();
    const result = await provider.callJson("user payload");

    assert.deepEqual(result, { ok: true });
  });

  it("callJson: circuit breaker open 상태면 helper 호출 없이 에러를 던진다", async () => {
    const provider = new OpenCodeCliProvider();
    provider.isCircuitOpen = async () => true;

    await assert.rejects(
      () => provider.callJson("user payload"),
      /circuit breaker open/
    );

    assert.equal(mockRunOpenCodeCLI.mock.callCount(), 0);
  });
});

describe("opencode-cli registry wiring", () => {
  it("listProviderNames: opencode-cli를 노출한다", () => {
    assert.ok(listProviderNames().includes("opencode-cli"));
  });

  it("createProvider: opencode-cli config로 provider 인스턴스를 생성한다", () => {
    const provider = createProvider({
      provider : "opencode-cli",
      model    : "github-copilot/claude-sonnet-4.5",
      timeoutMs: 2222,
      agent    : "general",
      variant  : "low"
    });

    assert.equal(provider?.name, "opencode-cli");
    assert.equal(provider?.config?.model, "github-copilot/claude-sonnet-4.5");
    assert.equal(provider?.config?.timeoutMs, 2222);
    assert.equal(provider?.config?.agent, "general");
    assert.equal(provider?.config?.variant, "low");
  });

  it("getConcurrencyLimit: opencode-cli 기본 동시성은 다른 로컬 CLI처럼 1이다", () => {
    assert.equal(getConcurrencyLimit("opencode-cli||", "opencode-cli"), 1);
  });
});
