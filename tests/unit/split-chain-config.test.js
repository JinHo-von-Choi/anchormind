/**
 * Unit tests: split-stage LLM chain config resolution.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveSplitChainConfig } from "../../lib/config.js";

describe("resolveSplitChainConfig", () => {
  it("returns null when no split env is set", () => {
    assert.equal(resolveSplitChainConfig({}), null);
  });

  it("returns primary-only chain when only MEMENTO_SPLIT_LLM_PRIMARY is set", () => {
    assert.deepEqual(
      resolveSplitChainConfig({ MEMENTO_SPLIT_LLM_PRIMARY: "xai" }),
      [{ provider: "xai" }]
    );
  });

  it("merges primary in front of fallbacks", () => {
    const env = {
      MEMENTO_SPLIT_LLM_PRIMARY  : "opencode-cli",
      MEMENTO_SPLIT_LLM_FALLBACKS: '[{"provider":"gemini-cli"}]'
    };
    assert.deepEqual(resolveSplitChainConfig(env), [
      { provider: "opencode-cli" },
      { provider: "gemini-cli" }
    ]);
  });

  it("returns null on malformed fallbacks JSON without throwing", () => {
    assert.equal(resolveSplitChainConfig({ MEMENTO_SPLIT_LLM_FALLBACKS: "{bad" }), null);
  });
});
