import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mergeRRF } from "../../lib/memory/read/RankFusion.js";
import { selectForRecall } from "../../lib/memory/read/BudgetSelector.js";
import { computeRecallScore } from "../../lib/memory/processors/MemoryRecaller.js";

const ranking = {
  importanceWeight: 0.2,
  recencyWeight: 0.2,
  semanticWeight: 0.6,
  recencyHalfLifeDays: 30,
  unrerankedBaseDiscount: 1,
  lexicalWeightFallback: 0
};

describe("검색 증거 → 최종 점수 → 예산 선택", () => {
  it("L2+L3 후보가 병합 순서와 무관하게 의미 증거를 유지한다", () => {
    const now = Date.parse("2026-10-04T00:00:00Z");
    const base = { content: "memory", importance: 0.5, created_at: "2026-10-04T00:00:00Z", workspace: null };
    const l2 = { name: "l2", results: [{ ...base, id: "a", similarity: 0.95 }] };
    const l3 = { name: "l3", results: [{ ...base, id: "a" }, { ...base, id: "b", similarity: 0.65 }] };
    const score = fragment => computeRecallScore(fragment, {
      lexicalQuery: {}, anchorTime: now, config: { ranking }, workspace: null
    });

    for (const layers of [[l2, l3], [l3, l2]]) {
      const merged = mergeRRF(layers);
      const a = merged.find(fragment => fragment.id === "a");
      const b = merged.find(fragment => fragment.id === "b");
      assert.equal(a.similarity, 0.95);
      assert.ok(score(a) > score(b));
    }
  });

  it("lexical-only tier가 양수 효용을 훼손하지 않고 남은 예산만 쓴다", () => {
    const pool = [
      { id: "a", content: "a", estimated_tokens: 40, utility: 0.9 },
      { id: "b", content: "b", estimated_tokens: 40, utility: 0.8 },
      { id: "c", content: "c", estimated_tokens: 80, utility: 1.0, lexicalOnly: true }
    ];
    const selected = selectForRecall(pool, {
      budget: 80,
      utilityOf: fragment => fragment.utility,
      tierOf: fragment => fragment.lexicalOnly ? 1 : 0
    });
    assert.deepEqual([...selected.selectedIds].sort(), ["a", "b"]);
  });
});
