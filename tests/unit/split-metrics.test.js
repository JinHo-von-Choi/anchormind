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

  it("tracks the child-level subject/modality reasons separately", async () => {
    recordSplitSkip("subject_loss");
    recordSplitSkip("modality_drift");
    recordSplitSkip("modality_drift");
    const metrics  = await splitSkippedTotal.get();
    const subject  = metrics.values.find(v => v.labels.reason === "subject_loss");
    const modality = metrics.values.find(v => v.labels.reason === "modality_drift");
    assert.ok(subject && subject.value >= 1);
    assert.ok(modality && modality.value >= 2, "자식 단위 라벨은 한 부모에서 여러 번 누적된다");
  });
});
