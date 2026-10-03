/**
 * BudgetSelector 순수 함수 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

import {
  selectWithinBudget, trimInSearchOrder, pairSimilarity, keywordOverlap, sectionOf, fragmentTokens,
  selectForRecall, verifyExactBudget, estimateTokens, partitionCandidates, attachStoredTokens,
  SELECTION_POOL_MAX, RANK_CANDIDATE_LIMIT
} from "../../lib/memory/read/BudgetSelector.js";
import { createRng } from "../../lib/memory/signals/PairedBootstrap.js";
import { countTokens } from "../../lib/memory/write/FragmentFactory.js";

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

describe("추정값 선택과 정확한 확인", () => {
  it("estimateTokens는 저장값, 없으면 본문 길이 / 4(올림)를 쓴다", () => {
    assert.equal(estimateTokens({ id: "s", content: "abcdefghi", _storedTokens: 7 }), 7);
    assert.equal(estimateTokens({ id: "c", content: "abcdefghi" }), 3);
    assert.equal(estimateTokens({ id: "z", content: "abcdefghi", _storedTokens: 0 }), 3);
    assert.equal(estimateTokens({ id: "e", content: "abcdefghi", estimated_tokens: 11, _storedTokens: 7 }), 11);
  });

  it("estimateTokens는 요청의 exactCounts만 보고 프로세스 전체의 토큰 기억은 읽지 않는다", () => {
    const content = "estimate purity check body with several words";
    fragmentTokens({ id: "warm", content });
    const fresh = { id: "fresh", content, _storedTokens: 2 };
    assert.equal(estimateTokens(fresh), 2);
    assert.equal(estimateTokens(fresh, new Map([[fresh, 9]])), 9);
    assert.equal(estimateTokens({ id: "plain", content }), Math.ceil(content.length / 4));
  });

  it("저장값이 실제보다 작아 고른 집합이 예산을 넘으면 이득이 가장 작은 파편부터 뺀다", () => {
    const pool = [
      { id: "a", score: 1.0, estimated_tokens: 40 },
      { id: "b", score: 0.9, estimated_tokens: 40 },
      { id: "c", score: 0.2, estimated_tokens: 40 }
    ];
    /** 추정값 20씩이면 셋 다 들어가지만 정확히는 120 */
    const tokensOf = () => 20;
    const sel      = selectWithinBudget(pool, { budget: 100, scoreOf, tokensOf });
    assert.equal(sel.selectedIds.size, 3);
    const verified = verifyExactBudget(pool.filter(f => sel.selectedIds.has(f.id)), { budget: 100, scoreOf });
    assert.deepEqual(verified.kept.map(f => f.id), ["a", "b"]);
    assert.deepEqual(verified.dropped.map(f => f.id), ["c"]);
    assert.equal(verified.tokens, 80);
  });

  it("뺄 순서의 동점은 점수, 그다음 id가 큰 쪽이 먼저다", () => {
    const pool = [
      { id: "a", score: 0.5, estimated_tokens: 50 },
      { id: "b", score: 0.5, estimated_tokens: 50 },
      { id: "c", score: 0.5, estimated_tokens: 50 }
    ];
    assert.deepEqual(verifyExactBudget(pool, { budget: 100, scoreOf }).kept.map(f => f.id), ["a", "b"]);
    assert.deepEqual(verifyExactBudget([...pool].reverse(), { budget: 100, scoreOf }).kept.map(f => f.id).sort(), ["a", "b"]);
  });

  it("성질: 저장값이 +-30% 틀려도 정확한 토큰 합은 예산 이하이고, 선택 단계는 같은 추정값의 절단 이상이다(시드 300개)", () => {
    let dropped = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const rng  = createRng(seed);
      const n    = 1 + Math.floor(rng() * 60);
      const pool = Array.from({ length: n }, (_, i) => {
        const exact  = 1 + Math.floor(rng() * 40);
        const stored = Math.max(1, Math.round(countTokens(`${seed}-${i} ${"budget token ".repeat(exact)}`) * (0.7 + rng() * 0.6)));
        const extra  = {};
        if (rng() < 0.5) extra.similarity = rng();
        if (rng() < 0.7) extra.keywords = [`k${Math.floor(rng() * 5)}`];
        if (rng() < 0.2) extra._kwExact = true;
        return { id: `f${i}`, score: rng(), content: `${seed}-${i} ${"budget token ".repeat(exact)}`, _storedTokens: stored, ...extra };
      });
      /** countTokens를 직접 써서 선택 전에 정확한 수가 기억되지 않게 한다 */
      const exactOf  = (f) => countTokens(f.content);
      const total    = pool.reduce((sum, f) => sum + exactOf(f), 0);
      const budget   = 1 + Math.floor(rng() * total);
      const baseline = new Set(trimInSearchOrder(pool, budget, undefined, estimateTokens).map(f => f.id));

      const stage = selectWithinBudget(pool, { budget, scoreOf, baselineIds: baseline, tokensOf: estimateTokens });
      const base  = pool.filter(f => baseline.has(f.id)).reduce((sum, f) => sum + f.score, 0);
      assert.ok(totalOf(pool, stage.selectedIds) >= base - 1e-9, `seed ${seed}: 선택 단계 ${totalOf(pool, stage.selectedIds)} < ${base}`);

      const result = selectForRecall(pool, { budget, scoreOf, baselineIds: baseline });
      const exactSum = pool.filter(f => result.selectedIds.has(f.id)).reduce((sum, f) => sum + exactOf(f), 0);
      assert.ok(exactSum <= budget, `seed ${seed}: 정확한 합 ${exactSum} > ${budget}`);
      dropped += result.dropped;
    }
    assert.ok(dropped > 0, "정확한 확인에서 뺀 파편이 하나도 없다");
  });

  it("정확한 합이 예산 이하이면 추정값과 무관하게 전부 고른다", () => {
    const pool = [
      { id: "a", score: 0.1, estimated_tokens: 30, _storedTokens: 500 },
      { id: "b", score: 0.2, estimated_tokens: 30, _storedTokens: 500 }
    ];
    const result = selectForRecall(pool, { budget: 60, scoreOf });
    assert.equal(result.strategy, "all");
    assert.deepEqual(idsOf(result), ["a", "b"]);
  });

  it("후보가 poolLimit를 넘으면 기준 집합만 쓰고 해를 만들지 않는다(후보 1000건)", () => {
    let scoreCalls = 0;
    const counted  = (f) => { scoreCalls++; return f.score; };
    const pool     = Array.from({ length: 1000 }, (_, i) => ({ id: `p${String(i).padStart(4, "0")}`, score: 1 - i / 1000, estimated_tokens: 10 }));
    const baseline = new Set(pool.slice(0, 500).map(f => f.id));
    const result   = selectForRecall(pool, { budget: 5000, scoreOf: counted, baselineIds: baseline, poolLimit: 210 });
    assert.equal(result.strategy, "baseline-only");
    assert.equal(result.selectedIds.size, 500);
    assert.ok(scoreCalls <= 500, `점수 계산 ${scoreCalls}회`);
  });

  it("selectWithinBudget은 SELECTION_POOL_MAX를 넘는 후보에 해를 만들지 않는다", () => {
    let scoreCalls = 0;
    const pool   = Array.from({ length: SELECTION_POOL_MAX + 1 }, (_, i) => ({ id: `q${i}`, score: 1, estimated_tokens: 1 }));
    const result = selectWithinBudget(pool, { budget: 10, scoreOf: () => { scoreCalls++; return 1; }, baselineIds: new Set(["q0", "q1"]) });
    assert.equal(result.strategy, "baseline-only");
    assert.deepEqual(idsOf(result), ["q0", "q1"]);
    assert.equal(scoreCalls, 0);
  });

  it("partitionCandidates: 모두 예산 안이면 상한 없이 전부, 묶이면 상한까지와 상한 밖 기준 파편", () => {
    const ordered = Array.from({ length: RANK_CANDIDATE_LIMIT + 30 }, (_, i) => ({ id: `o${String(i).padStart(4, "0")}`, estimated_tokens: 1 }));
    const all = partitionCandidates(ordered, { budget: 1000 });
    assert.equal(all.candidates.length, RANK_CANDIDATE_LIMIT + 30);
    assert.equal(all.baselineIds.size, RANK_CANDIDATE_LIMIT + 30);

    const binding = partitionCandidates(ordered, { budget: 220 });
    assert.equal(binding.baselineIds.size, 220);
    assert.equal(binding.candidates.length, 220);
    const tight = partitionCandidates(ordered, { budget: 50 });
    assert.equal(tight.candidates.length, RANK_CANDIDATE_LIMIT);
  });

  it("attachStoredTokens는 정확한 수를 아는 파편은 묻지 않고, loader가 없으면 아무것도 하지 않는다", async () => {
    const asked = [];
    const frags = [{ id: "known", estimated_tokens: 5 }, { id: "u1", content: "unique-body-u1" }, { id: "u2", content: "unique-body-u2" }];
    await attachStoredTokens(frags, async (ids) => { asked.push(...ids); return new Map([["u1", 9]]); });
    assert.deepEqual(asked, ["u1", "u2"]);
    assert.equal(frags[1]._storedTokens, 9);
    assert.equal(frags[2]._storedTokens, undefined);
    await attachStoredTokens(frags, null);
  });
});
