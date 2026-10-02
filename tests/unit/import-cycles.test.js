/**
 * import 순환 래칫
 *
 * 정적 순환은 없어야 하고, 동적 import를 포함한 순환은 아래 두 개를 넘지 않는다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */
import { describe, it } from "node:test";
import assert           from "node:assert/strict";

import { buildImportGraph, findCycles } from "../../scripts/import-cycles.js";

const ALLOWED_DYNAMIC_CYCLES = [
  ["lib/agy.js", "lib/codex.js", "lib/copilot.js", "lib/gemini.js", "lib/llm/index.js",
   "lib/llm/providers/AgyCliProvider.js", "lib/llm/providers/CodexCliProvider.js",
   "lib/llm/providers/CopilotCliProvider.js", "lib/llm/providers/GeminiCliProvider.js",
   "lib/llm/providers/OpenCodeCliProvider.js", "lib/llm/providers/QwenCliProvider.js",
   "lib/llm/registry.js", "lib/opencode.js", "lib/qwen.js"].join(" | "),
  ["lib/memory/MemoryManager.js", "lib/memory/consolidate/MemoryConsolidator.js",
   "lib/memory/link/ContradictionDetector.js"].join(" | ")
];

describe("import 순환", () => {
  const { edges, nonLiteral } = buildImportGraph();

  it("리터럴이 아닌 동적 import가 없다", () => {
    assert.deepEqual(nonLiteral, []);
  });

  it("정적 순환이 없다", () => {
    assert.deepEqual(findCycles(edges, { includeDynamic: false }).map(c => c.join(" | ")), []);
  });

  it("동적 포함 순환은 허용 목록 안에 있다", () => {
    const cycles = findCycles(edges, { includeDynamic: true }).map(c => c.join(" | "));
    assert.deepEqual(cycles.filter(c => !ALLOWED_DYNAMIC_CYCLES.includes(c)), []);
  });
});
