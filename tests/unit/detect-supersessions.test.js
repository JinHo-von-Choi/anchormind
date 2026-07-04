import { test, describe } from "node:test";
import assert from "node:assert/strict";

describe("_detectSupersessions", () => {
  test("MemoryConsolidator에 _detectSupersessions 메서드가 존재한다", async () => {
    const { MemoryConsolidator } = await import("../../lib/memory/consolidate/MemoryConsolidator.js");
    const mc = new MemoryConsolidator();
    assert.strictEqual(typeof mc._detectSupersessions, "function");
  });

  test("MemoryConsolidator에 _askGeminiSupersession 메서드가 존재한다", async () => {
    const { MemoryConsolidator } = await import("../../lib/memory/consolidate/MemoryConsolidator.js");
    const mc = new MemoryConsolidator();
    assert.strictEqual(typeof mc._askGeminiSupersession, "function");
  });
});
