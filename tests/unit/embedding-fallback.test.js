import { test, describe } from "node:test";
import assert from "node:assert/strict";

describe("embedding fallback path", () => {
  test("EmbeddingWorker.processOrphanFragments가 함수이다", async () => {
    const { EmbeddingWorker } = await import("../../lib/memory/embedding/EmbeddingWorker.js");
    const worker = new EmbeddingWorker();
    assert.strictEqual(typeof worker.processOrphanFragments, "function");
  });
});
