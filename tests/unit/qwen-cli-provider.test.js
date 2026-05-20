/**
 * Unit tests: QwenCliProvider
 *
 * 실제 qwen 바이너리 호출 0건 — lib/qwen.js를 mock.module로 차단한다.
 */

import { after, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { teardownTestResources } from "../_lifecycle.js";

const mockRunQwenCLI   = mock.fn();
const mockRawIsQwenCli = mock.fn();

mock.module("../../lib/qwen.js", {
  namedExports: {
    runQwenCLI            : (...args) => mockRunQwenCLI(...args),
    _rawIsQwenCLIAvailable: (...args) => mockRawIsQwenCli(...args)
  }
});

const { QwenCliProvider } = await import("../../lib/llm/providers/QwenCliProvider.js");
const { createProvider, listProviderNames } = await import("../../lib/llm/registry.js");

after(async () => { await teardownTestResources(); });

describe("QwenCliProvider", () => {
  beforeEach(() => {
    mockRunQwenCLI.mock.resetCalls();
    mockRawIsQwenCli.mock.resetCalls();
  });

  it("isAvailable: raw helper 결과를 그대로 반환한다", async () => {
    mockRawIsQwenCli.mock.mockImplementationOnce(async () => true);
    const provider = new QwenCliProvider();
    assert.equal(await provider.isAvailable(), true);
  });

  it("callText: JSON 전용 provider이므로 use callJson 에러를 던진다", async () => {
    const provider = new QwenCliProvider();

    await assert.rejects(
      () => provider.callText("hello"),
      /use callJson/
    );
  });

  it("callJson: systemPrompt + JSON-only 가이드 + prompt를 helper로 전달한다", async () => {
    mockRunQwenCLI.mock.mockImplementationOnce(async (stdinContent, prompt, options) => {
      assert.equal(stdinContent, "");
      assert.ok(prompt.includes("system rules"));
      assert.ok(prompt.includes("Return one valid JSON value only."));
      assert.ok(prompt.includes("user payload"));
      assert.equal(options.model, "qwen-max");
      assert.equal(options.timeoutMs, 3456);
      return "{\"ok\":true,\"source\":\"qwen-cli\"}";
    });

    const provider = new QwenCliProvider({ model: "default-model" });
    const result = await provider.callJson("user payload", {
      systemPrompt: "system rules",
      model       : "qwen-max",
      timeoutMs   : 3456
    });

    assert.deepEqual(result, { ok: true, source: "qwen-cli" });
  });

  it("callJson: options.model이 없으면 provider config.model을 사용한다", async () => {
    mockRunQwenCLI.mock.mockImplementationOnce(async (_stdinContent, _prompt, options) => {
      assert.equal(options.model, "qwen-max");
      return "{\"ok\":true}";
    });

    const provider = new QwenCliProvider({ model: "qwen-max" });
    const result = await provider.callJson("user payload");

    assert.deepEqual(result, { ok: true });
  });

  it("callJson: options.timeoutMs이 없으면 provider config.timeoutMs를 사용한다", async () => {
    mockRunQwenCLI.mock.mockImplementationOnce(async (_stdinContent, _prompt, options) => {
      assert.equal(options.timeoutMs, 2222);
      return "{\"ok\":true}";
    });

    const provider = new QwenCliProvider({ timeoutMs: 2222 });
    const result = await provider.callJson("user payload");

    assert.deepEqual(result, { ok: true });
  });

  it("callJson: fenced JSON 출력도 파싱한다", async () => {
    mockRunQwenCLI.mock.mockImplementationOnce(async () => "```json\n{\"ok\":true}\n```");

    const provider = new QwenCliProvider();
    const result = await provider.callJson("user payload");

    assert.deepEqual(result, { ok: true });
  });

  it("callJson: JSON 문자열 내부의 triple backticks를 보존한다", async () => {
    mockRunQwenCLI.mock.mockImplementationOnce(async () => "```json\n{\"snippet\":\"```ts\\nconst ok = true;\\n```\"}\n```");

    const provider = new QwenCliProvider();
    const result = await provider.callJson("user payload");

    assert.deepEqual(result, { snippet: "```ts\nconst ok = true;\n```" });
  });

  it("callJson: circuit breaker open 상태면 helper 호출 없이 에러를 던진다", async () => {
    const provider = new QwenCliProvider();
    provider.isCircuitOpen = async () => true;

    await assert.rejects(
      () => provider.callJson("user payload"),
      /circuit breaker open/
    );

    assert.equal(mockRunQwenCLI.mock.callCount(), 0);
  });
});

describe("qwen-cli registry wiring", () => {
  it("listProviderNames: qwen-cli를 노출한다", () => {
    assert.ok(listProviderNames().includes("qwen-cli"));
  });

  it("createProvider: qwen-cli config로 provider 인스턴스를 생성한다", () => {
    const provider = createProvider({
      provider : "qwen-cli",
      model    : "qwen-max",
      timeoutMs: 2222
    });

    assert.equal(provider?.name, "qwen-cli");
    assert.equal(provider?.config?.model, "qwen-max");
    assert.equal(provider?.config?.timeoutMs, 2222);
  });
});
