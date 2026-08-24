import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const consolidator = readFileSync(new URL("../../lib/memory/consolidate/MemoryConsolidator.js", import.meta.url), "utf8");
const reflector = readFileSync(new URL("../../lib/memory/processors/MemoryReflector.js", import.meta.url), "utf8");
const tool = readFileSync(new URL("../../lib/tools/memory.js", import.meta.url), "utf8");

test("duplicate merge follow-up mutations preserve key and workspace scope", () => {
  const body = consolidator.slice(consolidator.indexOf("async _mergeDuplicates"), consolidator.indexOf("async _transitionWithCount"));
  assert.match(body, /workspace/);
  assert.match(body, /key_id\s*=\s*\$/);
});

test("stats and memory_stats propagate the request scope", () => {
  assert.match(consolidator, /async getStats\(scope\s*=\s*\{\}/);
  assert.match(reflector, /async stats\(scope\s*=\s*\{\}/);
  assert.match(tool, /mgr\.stats\(scope\)/);
});
