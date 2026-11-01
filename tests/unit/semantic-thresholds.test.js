/**
 * SemanticThresholds: 순위용 유사도 펴기
 *
 * rankBand [lo, hi]의 코사인을 0~1로 펴고 lo 이하(무관 파편 대역)는 0, hi 이상은 1로 두는지, 순서를 바꾸지 않는지,
 * 구간이 없는 모델은 원값 그대로인지 본다.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { rankingSimilarity, withModelRanking } from "../../lib/memory/read/SemanticThresholds.js";

describe("rankingSimilarity", () => {
  const band = [0.50, 0.85];

  test("구간이 없으면 원값을 돌려준다", () => {
    assert.equal(rankingSimilarity(0.62, null), 0.62);
  });

  test("lo 이하는 0, 구간 안은 0~1, hi 이상은 1이다", () => {
    assert.equal(rankingSimilarity(0.30, band), 0);
    assert.equal(rankingSimilarity(0.50, band), 0);
    assert.ok(Math.abs(rankingSimilarity(0.675, band) - 0.5) < 1e-9);
    assert.equal(rankingSimilarity(0.85, band), 1);
    assert.equal(rankingSimilarity(0.93, band), 1);
  });

  test("순서를 바꾸지 않는다", () => {
    let prev = -Infinity;
    for (let s = 0; s <= 1.0001; s += 0.01) {
      const r = rankingSimilarity(s, band);
      assert.ok(r >= prev, `순서 역전 ${s}`);
      prev = r;
    }
  });
});

describe("withModelRanking", () => {
  const base = {
    ranking       : { importanceWeight: 0.4, recencyWeight: 0.3, semanticWeight: 0.3, recencyHalfLifeDays: 30, exactKeywordBoost: 0.45, lexicalWeightFallback: 0.12, lexicalWeightReranked: 0.08 },
    semanticSearch: { modelCalibration: [{ match: "bge-m3", ranking: { importanceWeight: 0.3, recencyWeight: 0.1, semanticWeight: 0.6 } }] }
  };

  test("맞는 모델이 없으면 원본을 돌려준다", () => {
    assert.equal(withModelRanking(base, "text-embedding-3-small"), base);
  });

  test("가중치를 덮어쓰고 키워드 가산은 semanticWeight 비율만큼, 재정렬 가산은 그대로 둔다", () => {
    const { ranking } = withModelRanking(base, "Xenova/bge-m3#cls");
    assert.deepEqual([ranking.importanceWeight, ranking.recencyWeight, ranking.semanticWeight], [0.3, 0.1, 0.6]);
    assert.ok(Math.abs(ranking.exactKeywordBoost - 0.90) < 1e-9);
    assert.ok(Math.abs(ranking.lexicalWeightFallback - 0.24) < 1e-9);
    assert.equal(ranking.lexicalWeightReranked, 0.08);
    assert.equal(ranking.recencyHalfLifeDays, 30);
    assert.equal(base.ranking.semanticWeight, 0.3);
  });
});
