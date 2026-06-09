/**
 * Unit tests: split-skip metric helper increments the labeled counter.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { recordSplitSkip, splitSkippedTotal } from "../../lib/memory/consolidate/split-metrics.js";

describe("recordSplitSkip", () => {
  it("increments the counter for a given reason", async () => {
    recordSplitSkip("low_yield");
    recordSplitSkip("provider_error");
    const metrics = await splitSkippedTotal.get();
    const lowYield = metrics.values.find(v => v.labels.reason === "low_yield");
    const provErr  = metrics.values.find(v => v.labels.reason === "provider_error");
    assert.ok(lowYield && lowYield.value >= 1);
    assert.ok(provErr && provErr.value >= 1);
  });
});
