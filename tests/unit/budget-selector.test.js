/**
 * BudgetSelector 순수 함수 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

import {
  selectWithinBudget, trimInSearchOrder, pairSimilarity, keywordOverlap, sectionOf, fragmentTokens
} from "../../lib/memory/read/BudgetSelector.js";
import { createRng } from "../../lib/memory/signals/PairedBootstrap.js";

/** 점수를 필드로 들고 있는 시험용 파편 */
const frag     = (id, score, tokens, extra = {}) => ({ id, score, estimated_tokens: tokens, content: id, ...extra });
const scoreOf  = (f) => f.score;
const idsOf    = (selection) => [...selection.selectedIds].sort();
const totalOf  = (pool, ids) => pool.filter(f => ids.has(f.id)).reduce((sum, f) => sum + f.score, 0);
const tokensOf = (pool, ids) => pool.filter(f => ids.has(f.id)).reduce((sum, f) => sum + fragmentTokens(f), 0);

describe("selectWithinBudget", () => {
  it("토큰 합이 예산 이하이면 전부 고른다", () => {
    const pool      = [frag("a", 0.1, 30), frag("b", 0.9, 30), frag("c", 0.5, 40)];
    const selection = selectWithinBudget(pool, { budget: 100, scoreOf });
    assert.equal(selection.strategy, "all");
    assert.deepEqual(idsOf(selection), ["a", "b", "c"]);
    assert.equal(selection.tokens, 100);
  });

  it("검색 순서는 낮고 최종 점수는 높은 후보가 예산 안에 남는다", () => {
    /** 검색 순서 a, b, z. 검색 순서 절단은 a, b를 고르고 z에서 멈춘다 */
    const pool     = [frag("a", 0.30, 40), frag("b", 0.25, 40), frag("z", 0.95, 40)];
    const baseline = trimInSearchOrder(pool, 100);
    assert.deepEqual(baseline.map(f => f.id), ["a", "b"]);

    const selection = selectWithinBudget(pool, { budget: 100, scoreOf, baselineIds: new Set(baseline.map(f => f.id)) });
    assert.ok(selection.selectedIds.has("z"));
    assert.ok(selection.tokens <= 100);
    assert.ok(selection.score > 0.30 + 0.25);
  });

  it("탐욕해의 점수 합이 기준해보다 작으면 기준해를 고른다", () => {
    /** 탐욕해는 구획 단계에서 최고 점수 c(60토큰)를 먼저 고르고 a, b가 들어갈 자리가 없다 */
    const pool      = [frag("a", 0.6, 50), frag("b", 0.6, 50), frag("c", 0.65, 60)];
    const selection = selectWithinBudget(pool, { budget: 100, scoreOf, baselineIds: new Set(["a", "b"]) });
    assert.equal(selection.strategy, "baseline");
    assert.deepEqual(idsOf(selection), ["a", "b"]);
  });

  it("MMR: 임베딩 유사도가 없는 파편은 keywords가 같아도 서로 다른 것으로 본다", () => {
    const kw   = ["budget", "recall"];
    const pool = [
      frag("p", 1.00, 10, { similarity: 0.9, keywords: kw }),
      frag("q", 0.95, 10, { similarity: 0.8, keywords: kw }),
      frag("r", 0.90, 10, { keywords: kw })
    ];
    const selection = selectWithinBudget(pool, { budget: 20, scoreOf });
    assert.deepEqual(idsOf(selection), ["p", "r"]);
  });

  it("MMR: 두 파편 모두 임베딩 유사도가 있고 keywords가 겹치면 중복 후보가 밀린다", () => {
    const kw   = ["budget", "recall"];
    const pool = [
      frag("p", 1.00, 10, { similarity: 0.9, keywords: kw }),
      frag("q", 0.95, 10, { similarity: 0.8, keywords: kw }),
      frag("s", 0.90, 10, { similarity: 0.7, keywords: ["other"] })
    ];
    const selection = selectWithinBudget(pool, { budget: 20, scoreOf });
    assert.deepEqual(idsOf(selection), ["p", "s"]);
  });

  it("MMR: keywords가 없는 파편은 겹침 0으로 본다", () => {
    const pool = [
      frag("p", 1.00, 10, { similarity: 0.9, keywords: ["k"] }),
      frag("q", 0.95, 10, { similarity: 0.8 }),
      frag("s", 0.90, 10, { similarity: 0.7, keywords: [] })
    ];
    const selection = selectWithinBudget(pool, { budget: 20, scoreOf });
    assert.deepEqual(idsOf(selection), ["p", "q"]);
  });

  it("구획 단계: 점수가 낮은 구획도 남은 예산에 들어가면 한 건을 받는다", () => {
    const pool = [
      frag("s1", 1.0, 50),
      frag("s2", 0.9, 50),
      frag("e", 0.1, 10, { _kwExact: true }),
      frag("l", 0.05, 10, { _source: "linked" })
    ];
    const selection = selectWithinBudget(pool, { budget: 100, scoreOf });
    assert.ok(selection.selectedIds.has("e"));
    assert.ok(selection.selectedIds.has("l"));
    assert.ok(selection.selectedIds.has("s1"));
    assert.ok(selection.tokens <= 100);
  });

  it("구획 단계는 구획 안에서 남은 예산에 들어가는 최고 점수 항목을 고른다", () => {
    const pool = [
      frag("s", 1.0, 30),
      frag("e-big", 0.9, 60, { _kwExact: true }),
      frag("e-small", 0.2, 20, { _kwExact: true })
    ];
    const selection = selectWithinBudget(pool, { budget: 50, scoreOf });
    assert.deepEqual(idsOf(selection), ["e-small", "s"]);
  });

  it("동점은 id 오름차순으로 정하고 입력 순서와 무관하다", () => {
    const pool = [frag("b", 0.5, 10), frag("a", 0.5, 10), frag("c", 0.5, 10)];
    const forward  = selectWithinBudget(pool, { budget: 20, scoreOf });
    const backward = selectWithinBudget([...pool].reverse(), { budget: 20, scoreOf });
    assert.deepEqual(idsOf(forward), ["a", "b"]);
    assert.deepEqual(idsOf(backward), ["a", "b"]);
  });

  it("유한하지 않은 점수는 0으로 본다", () => {
    const pool = [frag("nan", Number.NaN, 10), frag("ok", 0.1, 10)];
    const selection = selectWithinBudget(pool, { budget: 10, scoreOf });
    assert.deepEqual(idsOf(selection), ["ok"]);
    assert.equal(selection.score, 0.1);
  });

  it("예산을 넘는 기준 집합은 시작 집합으로 쓰지 않는다", () => {
    const pool = [frag("a", 0.5, 60), frag("b", 0.4, 60)];
    const selection = selectWithinBudget(pool, { budget: 100, scoreOf, baselineIds: new Set(["a", "b"]) });
    assert.equal(selection.strategy, "greedy");
    assert.ok(selection.tokens <= 100);
  });

  it("성질: 고른 집합의 점수 합은 검색 순서 절단 이상이고 토큰 합은 예산 이하다(시드 2000개)", () => {
    let strict = 0;
    for (let seed = 1; seed <= 2000; seed++) {
      const rng  = createRng(seed);
      const n    = 1 + Math.floor(rng() * 60);
      const pool = Array.from({ length: n }, (_, i) => {
        const extra = {};
        if (rng() < 0.5) extra.similarity = rng();
        if (rng() < 0.7) extra.keywords = [`k${Math.floor(rng() * 5)}`, `k${Math.floor(rng() * 5)}`];
        const roll = rng();
        if (roll < 0.15) extra._kwExact = true;
        else if (roll < 0.25) extra._kwSupplement = true;
        else if (roll < 0.35) extra._source = "linked";
        return frag(`f${i}`, rng(), 1 + Math.floor(rng() * 100), extra);
      });
      const total    = pool.reduce((sum, f) => sum + f.estimated_tokens, 0);
      const budget   = 1 + Math.floor(rng() * total);
      const baseline = new Set(trimInSearchOrder(pool.filter(f => f._source !== "linked"), budget).map(f => f.id));

      const selection = selectWithinBudget(pool, { budget, scoreOf, baselineIds: baseline });
      const chosen    = totalOf(pool, selection.selectedIds);
      const base      = totalOf(pool, baseline);
      assert.ok(chosen >= base - 1e-9, `seed ${seed}: ${chosen} < ${base}`);
      assert.ok(tokensOf(pool, selection.selectedIds) <= budget, `seed ${seed}: 예산 초과`);
      assert.equal(selection.tokens, tokensOf(pool, selection.selectedIds));
      if (chosen > base + 1e-9) strict++;
    }
    assert.ok(strict > 500, `점수 합이 커진 시드가 적다: ${strict}`);
  });

  it("구획 단계는 점수 0인 항목에 예산을 쓰지 않는다", () => {
    const pool = [
      frag("s1", 1.0, 50),
      frag("s2", 0.9, 50),
      frag("z", 0, 40, { _source: "linked" })
    ];
    const selection = selectWithinBudget(pool, { budget: 100, scoreOf });
    assert.deepEqual(idsOf(selection), ["s1", "s2"]);
  });

  it("입력 순서를 바꿔도 같은 선택을 낸다(점수 합 동률, 시드 3000개)", () => {
    const levels = [0.1, 0.2, 0.3, 0.6, 0.7];
    for (let seed = 1; seed <= 3000; seed++) {
      const rng  = createRng(seed);
      const n    = 2 + Math.floor(rng() * 10);
      const pool = Array.from({ length: n }, (_, i) => frag(`f${i}`, levels[Math.floor(rng() * levels.length)], 1 + Math.floor(rng() * 3)));
      const budget   = 1 + Math.floor(rng() * pool.reduce((sum, f) => sum + f.estimated_tokens, 0));
      const baseline = new Set(trimInSearchOrder(pool, budget).map(f => f.id));
      const forward  = selectWithinBudget(pool, { budget, scoreOf, baselineIds: baseline });
      const backward = selectWithinBudget([...pool].reverse(), { budget, scoreOf, baselineIds: baseline });
      assert.deepEqual(idsOf(backward), idsOf(forward), `seed ${seed}`);
      assert.equal(backward.score, forward.score, `seed ${seed}`);
    }
  });

  it("같은 입력은 같은 선택을 낸다", () => {
    const rng  = createRng(7);
    const pool = Array.from({ length: 50 }, (_, i) => frag(`f${i}`, rng(), 1 + Math.floor(rng() * 50), {
      similarity: rng(), keywords: [`k${i % 4}`]
    }));
    const first  = selectWithinBudget(pool, { budget: 300, scoreOf });
    const second = selectWithinBudget([...pool].reverse(), { budget: 300, scoreOf });
    assert.deepEqual(idsOf(first), idsOf(second));
  });
});

describe("유사도와 구획", () => {
  it("pairSimilarity는 한쪽이라도 similarity가 없으면 0이다", () => {
    const a = { similarity: 0.9, keywords: ["x", "y"] };
    const b = { keywords: ["x", "y"] };
    assert.equal(pairSimilarity(a, b), 0);
    assert.equal(pairSimilarity(b, a), 0);
  });

  it("pairSimilarity는 둘 다 similarity가 있으면 keywords 겹침 비율이다", () => {
    const a = { similarity: 0.9, keywords: ["x", "y"] };
    const b = { similarity: 0.5, keywords: ["y", "z", "w"] };
    assert.equal(pairSimilarity(a, b), 1 / 3);
    assert.equal(keywordOverlap(a, { keywords: [] }), 0);
    assert.equal(keywordOverlap({}, b), 0);
  });

  it("sectionOf는 정확 일치, 보조, 연결, 검색 순으로 구획을 정한다", () => {
    assert.equal(sectionOf({ _kwExact: true, _source: "linked" }), "exact");
    assert.equal(sectionOf({ _kwSupplement: true }), "supplement");
    assert.equal(sectionOf({ _source: "linked" }), "linked");
    assert.equal(sectionOf({}), "search");
  });

  it("fragmentTokens는 estimated_tokens가 없으면 본문을 센다", () => {
    assert.equal(fragmentTokens({ estimated_tokens: 12, content: "x" }), 12);
    assert.ok(fragmentTokens({ content: "budget selection" }) > 0);
    assert.equal(fragmentTokens({}), 0);
  });
});
