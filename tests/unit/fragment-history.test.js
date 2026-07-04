import { test, describe } from "node:test";
import assert from "node:assert/strict";

describe("fragment history", () => {
  test("FragmentStore.getHistory가 함수이다", async () => {
    const { FragmentStore } = await import("../../lib/memory/write/FragmentStore.js");
    const store = new FragmentStore();
    assert.strictEqual(typeof store.getHistory, "function");
  });

  test("MemoryManager.fragmentHistory가 함수이다", async () => {
    const { MemoryManager } = await import("../../lib/memory/MemoryManager.js");
    const mm = new MemoryManager();
    assert.strictEqual(typeof mm.fragmentHistory, "function");
  });
});
