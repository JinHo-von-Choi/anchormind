import { describe, it } from "node:test";
import assert         from "node:assert/strict";

import { mergeRRF } from "../../lib/memory/read/RankFusion.js";
import { selectWithinBudget } from "../../lib/memory/read/BudgetSelector.js";

describe("검색 순위 증거 보존", () => {
  it("레이어 순서와 무관하게 의미·어휘 점수를 함께 보존한다", () => {
    const semantic = { name: "semantic", results: [{ id: "a", content: "A", similarity: 0.95 }], weightFactor: 1 };
    const lexical  = { name: "lexical", results: [{ id: "a", content: "A", _lexicalScore: 0.8 }], weightFactor: 1 };
    for (const layers of [[semantic, lexical], [lexical, semantic]]) {
      const [result] = mergeRRF(layers);
      assert.equal(result.similarity, 0.95);
      assert.equal(result._lexicalScore, 0.8);
      assert.deepEqual(result._rankEvidence.channels, ["lexical", "semantic"]);
    }
  });

  it("긴급 롤백 옵션은 기존 마지막 값 우선 병합을 유지한다", () => {
    const [result] = mergeRRF([
      { name: "semantic", results: [{ id: "a", content: "A", similarity: 0.95 }] },
      { name: "legacy", results: [{ id: "a", content: "A", _lexicalScore: 0.8 }] }
    ], 60, { preserveEvidence: false });
    assert.equal(result.similarity, 0.95);
    assert.equal(result._lexicalScore, undefined);
    assert.equal(result._rankEvidence, undefined);
  });

  it("순위 계층과 예산 효용을 분리해 점수를 음수로 만들지 않는다", () => {
    const pool = [
      { id: "primary", content: "p", estimated_tokens: 6 },
      { id: "lex-high", content: "l", estimated_tokens: 4 },
      { id: "lex-low", content: "s", estimated_tokens: 4 }
    ];
    const scores = new Map([["primary", 0.1], ["lex-high", 0.95], ["lex-low", 0.4]]);
    const result = selectWithinBudget(pool, {
      budget: 10,
      scoreOf: f => scores.get(f.id),
      tierOf: f => f.id.startsWith("lex-") ? 1 : 0
    });
    assert.deepEqual([...result.selectedIds].sort(), ["lex-high", "primary"]);
    assert.ok(result.score > 0);
  });
});
