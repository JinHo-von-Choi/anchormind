/**
 * 슬롯 보장 절단 검증
 *
 * 작성자: 최진호
 * 작성일: 2026-07-27
 *
 * 이슈 #30: _trimToTokenBudget이 단순 prefix 절단(첫 초과 시 break)만 수행하여
 * budget이 빡빡할 때 점수 우위인 supplement가 exact 히트·다른 supplement를 절단 전 밀어낼 수
 * 있었다. _kwExact/_kwSupplement 슬롯 보장 3-pass 절단으로 방지되는지 검증한다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

import { FragmentSearch } from "../../lib/memory/read/FragmentSearch.js";

describe("슬롯 보장 절단", () => {
  it("점수 우위 일반 파편이 예산을 선점해도 정확 히트와 supplement가 생존한다", () => {
    const search = Object.create(FragmentSearch.prototype);

    /** 순위상 최우선(고득점) 이지만 태그 없는 일반 파편 — 예산 전체를 잠식할 크기 */
    const general = { id: "general", content: "일반", estimated_tokens: 90 };
    /** L3kw supplement — semanticSlotShare(25) 이내 */
    const supplement = { id: "supp", content: "보조", estimated_tokens: 20, _kwSupplement: true };
    /** keywords 정확 일치 — 순위는 가장 낮지만 exactSlotShare(50) 이내 */
    const exact = { id: "exact", content: "정확", estimated_tokens: 40, _kwExact: true };

    const result = search._trimToTokenBudget([general, supplement, exact], 100);
    const ids    = result.map(f => f.id);

    assert.ok(ids.includes("exact"), "정확 히트가 절단에서 생존하지 않음");
    assert.ok(ids.includes("supp"), "supplement가 절단에서 전멸함");
    assert.ok(!ids.includes("general"), "일반 파편이 예산을 선점해 슬롯 보장이 무력화됨");
  });

  it("정확 히트가 exactSlotShare(50%) 상한을 초과 점유하지 못한다", () => {
    const search = Object.create(FragmentSearch.prototype);

    const e1 = { id: "e1", content: "e1", estimated_tokens: 40, _kwExact: true };
    /** 예산 잔여를 소비하는 태그 없는 필러 — pass 3이 e2를 되채우지 못하도록 함 */
    const fillers = Array.from({ length: 6 }, (_, i) => ({
      id: `g${i}`, content: "g", estimated_tokens: 10
    }));
    const e2 = { id: "e2", content: "e2", estimated_tokens: 40, _kwExact: true };

    const result     = search._trimToTokenBudget([e1, ...fillers, e2], 100);
    const exactCost   = result.filter(f => f._kwExact === true)
      .reduce((sum, f) => sum + f.estimated_tokens, 0);

    assert.ok(exactCost <= 50, `정확 히트 점유량(${exactCost})이 exactSlotShare 상한(50)을 초과함`);
    assert.ok(!result.some(f => f.id === "e2"), "e2가 상한을 넘어 선점됨");
  });

  it("태그 없는 일반 경로(text)는 기존 단순 prefix 절단과 바이트 동일하다", () => {
    const search = Object.create(FragmentSearch.prototype);

    const fragments = [
      { id: "t1", content: "t1", estimated_tokens: 40 },
      { id: "t2", content: "t2", estimated_tokens: 40 },
      { id: "t3", content: "t3", estimated_tokens: 40 }
    ];

    /** 기존 알고리즘 재구현: 첫 초과 시 즉시 break하는 prefix 절단 */
    const legacyTrim = (frags, budget) => {
      const out = [];
      let used  = 0;
      for (const f of frags) {
        const c = f.estimated_tokens;
        if (used + c > budget) break;
        used += c;
        out.push(f);
      }
      return out;
    };

    const expected = legacyTrim(fragments, 100);
    const actual   = search._trimToTokenBudget(fragments, 100);

    assert.deepEqual(actual, expected, "태그 부재 경로가 기존 절단과 달라짐");
  });
});
