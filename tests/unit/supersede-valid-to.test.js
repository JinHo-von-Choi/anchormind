// tests/unit/supersede-valid-to.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";

describe("superseded_by valid_to 연동", () => {
  test("MemoryConsolidator._resolveContradiction이 valid_to를 갱신한다", async () => {
    const { MemoryConsolidator } = await import("../../lib/memory/consolidate/MemoryConsolidator.js");
    const mc = new MemoryConsolidator();
    const src = mc._resolveContradiction.toString();
    assert.ok(src.includes("valid_to"), "_resolveContradiction에 valid_to 갱신 필수");
  });

  test("GraphLinker.linkFragment이 superseded_by 시 valid_to를 갱신한다", async () => {
    const { GraphLinker } = await import("../../lib/memory/link/GraphLinker.js");
    const gl = new GraphLinker();
    const src = gl.linkFragment.toString();
    assert.ok(src.includes("valid_to"), "linkFragment에 valid_to 갱신 필수");
  });
});
