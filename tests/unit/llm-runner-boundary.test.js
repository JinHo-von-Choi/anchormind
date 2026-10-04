/** LLM CLI 호환 진입점과 raw runner의 export 계약. */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

const CASES = [
  ["agy",      ["_rawIsAgyCLIAvailable", "buildAgyArgs", "runAgyCLI"]],
  ["codex",    ["_rawIsCodexCLIAvailable", "runCodexCLI"]],
  ["copilot",  ["_rawIsCopilotCLIAvailable", "extractJsonBlock", "runCopilotCLI"]],
  ["gemini",   ["_rawIsGeminiCLIAvailable", "runGeminiCLI"]],
  ["opencode", ["_getOpenCodeRunFlagSupport", "_rawIsOpenCodeCLIAvailable", "runOpenCodeCLI"]],
  ["qwen",     ["_rawIsQwenCLIAvailable", "runQwenCLI"]]
];

describe("LLM CLI runner 경계", () => {
  for (const [name, exports] of CASES) {
    it(`${name}: 기존 진입점은 raw runner 함수를 그대로 다시 내보낸다`, async () => {
      const [compat, runner] = await Promise.all([
        import(`../../lib/${name}.js`),
        import(`../../lib/llm/runners/${name}.js`)
      ]);
      for (const exported of exports) assert.equal(compat[exported], runner[exported], exported);
    });
  }
});
