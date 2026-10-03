/**
 * BudgetSelector 토큰 수 기억: 같은 파편 객체와 같은 본문은 한 번만 센다
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */

import { describe, it, beforeEach, mock } from "node:test";
import assert                             from "node:assert/strict";

const counted = [];

mock.module("../../lib/memory/write/FragmentFactory.js", {
  namedExports: {
    countTokens: (text) => {
      counted.push(text);
      return text.length;
    }
  }
});

const { fragmentTokens, CONTENT_TOKEN_CACHE_LIMIT, selectWithinBudget, trimInSearchOrder, exceedsBudget, selectForRecall } =
  await import("../../lib/memory/read/BudgetSelector.js");

beforeEach(() => { counted.length = 0; });

describe("fragmentTokens 기억", () => {
  it("같은 객체는 한 번만 센다", () => {
    const fragment = { id: "a", content: "object-once" };
    assert.equal(fragmentTokens(fragment), 11);
    assert.equal(fragmentTokens(fragment), 11);
    assert.deepEqual(counted, ["object-once"]);
  });

  it("객체의 본문이 바뀌면 기억을 쓰지 않고 새 본문을 센다", () => {
    const fragment = { id: "m", content: "first-body" };
    assert.equal(fragmentTokens(fragment), 10);
    fragment.content = "second-longer-body";
    assert.equal(fragmentTokens(fragment), 18);
  });

  it("본문이 같은 다른 객체는 다시 세지 않는다", () => {
    assert.equal(fragmentTokens({ id: "b", content: "shared-body" }), 11);
    assert.equal(fragmentTokens({ id: "c", content: "shared-body" }), 11);
    assert.deepEqual(counted, ["shared-body"]);
  });

  it("estimated_tokens가 있으면 세지 않는다", () => {
    assert.equal(fragmentTokens({ id: "d", content: "stored", estimated_tokens: 42 }), 42);
    assert.deepEqual(counted, []);
  });

  it("본문 기억은 상한을 넘으면 가장 오래 쓰지 않은 본문을 버린다", () => {
    const first = "evict-first";
    fragmentTokens({ id: "e0", content: first });
    for (let i = 0; i < CONTENT_TOKEN_CACHE_LIMIT; i++) fragmentTokens({ id: `e${i + 1}`, content: `fill-${i}` });
    counted.length = 0;
    fragmentTokens({ id: "again", content: first });
    assert.deepEqual(counted, [first]);
  });

  it("exceedsBudget은 바이트 상한 합이 예산 이하이면 세지 않고, 넘으면 합이 예산을 넘는 순간까지만 센다", () => {
    const small = Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, content: `ab${i}` }));
    assert.equal(exceedsBudget(small, 100), false);
    assert.deepEqual(counted, []);

    const many = Array.from({ length: 100 }, (_, i) => ({ id: `m${i}`, content: `lazy-${String(i).padStart(4, "0")}` }));
    assert.equal(exceedsBudget(many, 35), true);
    assert.equal(counted.length, 4);
  });

  it("selectForRecall은 예산이 묶이면 절단 경계와 고른 파편만 정확히 센다(후보 200건)", () => {
    const pool = Array.from({ length: 200 }, (_, i) => ({ id: `r${String(i).padStart(3, "0")}`, content: `recall-body-${String(i).padStart(4, "0")}`, score: (i % 13) / 13, _storedTokens: 16 }));
    selectForRecall(pool, { budget: 100, scoreOf: f => f.score });
    assert.ok(counted.length <= 20, `정확히 센 파편 ${counted.length}건`);
  });

  it("검색 순서 절단과 예산 선택을 이어서 해도 후보마다 한 번만 센다", () => {
    const pool = Array.from({ length: 30 }, (_, i) => ({ id: `p${i}`, content: `candidate-${i}-body`, score: 30 - i }));
    const baseline = new Set(trimInSearchOrder(pool, 100).map(f => f.id));
    selectWithinBudget(pool, { budget: 100, scoreOf: f => f.score, baselineIds: baseline });
    trimInSearchOrder(pool, 100);
    assert.equal(counted.length, 30);
    assert.equal(new Set(counted).size, 30);
  });
});
