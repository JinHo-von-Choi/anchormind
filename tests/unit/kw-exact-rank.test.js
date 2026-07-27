/**
 * keywords-only 정확 일치 랭킹 가산 검증
 *
 * 작성자: 최진호
 * 작성일: 2026-07-27
 *
 * 이슈 #30: keywords-only recall에서 정확 키워드 히트가 semantic 보조(supplement)
 * 결과에 순위가 밀리는 구조 결함을 재현하고, _kwExact 태그 + 가산항으로 방지되는지 검증한다.
 * 또한 _deduplicate에서 similarity 우선 교체 시 _kwExact 증거가 유실되지 않는지 검증한다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

import { FragmentSearch } from "../../lib/memory/read/FragmentSearch.js";

const NOW = Date.now();

/**
 * 이슈 #30 시나리오의 정확 히트 파편: 방금 생성, importance 0.7, similarity 없음.
 */
function exactHitFragment(id) {
  return {
    id,
    content    : "정확 히트",
    keywords   : ["alpha", "beta"],
    importance : 0.7,
    created_at : new Date(NOW).toISOString(),
    _kwExact   : true
  };
}

/**
 * L3kw supplement 파편: importance 0.8, 15일 경과, similarity 0.6, ema 부스트.
 * _kwExact 미태깅(정의상 semantic).
 */
function supplementFragment(id) {
  return {
    id,
    content       : "보조 결과",
    keywords      : ["gamma"],
    importance    : 0.8,
    created_at    : new Date(NOW - 15 * 86400000).toISOString(),
    similarity    : 0.6,
    ema_activation: 10
  };
}

describe("keywords-only 정확 일치 랭킹 가산", () => {
  it("_deduplicate 결과에서 정확 히트가 supplement 다수보다 1위로 정렬된다", () => {
    const search = Object.create(FragmentSearch.prototype);

    const fragments = [
      exactHitFragment("exact-hit"),
      supplementFragment("supp-1"),
      supplementFragment("supp-2"),
      supplementFragment("supp-3")
    ];

    const result = search._deduplicate(fragments, 0, NOW);

    assert.equal(result[0].id, "exact-hit", "정확 히트가 1위로 정렬되지 않음");
  });

  it("dedup 병합 시 similarity 높은 사본이 채택돼도 _kwExact 증거가 보존된다", () => {
    const search = Object.create(FragmentSearch.prototype);

    const existing = exactHitFragment("dup-1");
    const l3Copy    = {
      id        : "dup-1",
      content   : "L3 사본",
      keywords  : ["alpha", "beta"],
      importance: 0.7,
      created_at: new Date(NOW).toISOString(),
      similarity: 0.6
    };

    const result = search._deduplicate([existing, l3Copy], 0, NOW);
    const merged  = result.find(f => f.id === "dup-1");

    assert.ok(merged, "병합된 파편 미발견");
    assert.equal(merged.similarity, 0.6, "similarity 높은 L3 사본이 채택되지 않음");
    assert.equal(merged._kwExact, true, "_kwExact 증거가 dedup 병합 중 유실됨");
  });
});
