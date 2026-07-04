/**
 * 시간-의미 복합 랭킹 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-03-07
 *
 * FragmentSearch._computeRankScore 의 anchorTime 기반 지수 감쇠 검증
 */

import { describe, it }   from "node:test";
import assert              from "node:assert/strict";
import { FragmentSearch }  from "../../lib/memory/read/FragmentSearch.js";

const DAY_MS = 86400000;

/** DB/Redis 의존 없이 _computeRankScore만 테스트하기 위한 인스턴스 */
const search = Object.create(FragmentSearch.prototype);

const config = {
  ranking: {
    importanceWeight    : 0.4,
    recencyWeight       : 0.3,
    semanticWeight      : 0.3,
    recencyHalfLifeDays : 30,
    activationThreshold : 0,
  }
};

describe("_computeRankScore — anchorTime 기반 복합 랭킹", () => {

  it("anchorTime이 현재일 때 최근 파편이 더 높은 점수", () => {
    const now = Date.now();

    const recent = {
      importance : 0.5,
      created_at : new Date(now).toISOString(),
    };

    const old = {
      importance : 0.5,
      created_at : new Date(now - 60 * DAY_MS).toISOString(),
    };

    const recentScore = search._computeRankScore(recent, config, now);
    const oldScore    = search._computeRankScore(old,    config, now);

    assert.ok(
      recentScore > oldScore,
      `최근 파편(${recentScore.toFixed(4)})이 60일 전 파편(${oldScore.toFixed(4)})보다 높아야 한다`
    );
  });

  it("anchorTime이 과거일 때 그 시점 근처 파편이 더 높은 점수", () => {
    const now        = Date.now();
    const anchor     = now - 30 * DAY_MS;   // 30일 전

    const nearAnchor = {
      importance : 0.5,
      created_at : new Date(now - 29 * DAY_MS).toISOString(),  // anchor에서 1일 차이
    };

    const farFromAnchor = {
      importance : 0.5,
      created_at : new Date(now).toISOString(),                // anchor에서 30일 차이
    };

    const nearScore = search._computeRankScore(nearAnchor,    config, anchor);
    const farScore  = search._computeRankScore(farFromAnchor, config, anchor);

    assert.ok(
      nearScore > farScore,
      `anchor 근처 파편(${nearScore.toFixed(4)})이 먼 파편(${farScore.toFixed(4)})보다 높아야 한다`
    );
  });

  it("similarity 없는 파편은 semantic 점수 0", () => {
    const now = Date.now();

    const fragment = {
      importance : 0.8,
      created_at : new Date(now).toISOString(),
      // similarity 없음
    };

    const score = search._computeRankScore(fragment, config, now);

    // importance * 0.4 + proximity(0일 차이 = 1.0) * 0.3 + 0 * 0.3 = 0.32 + 0.30 = 0.62
    const expected = 0.8 * 0.4 + 1.0 * 0.3 + 0 * 0.3;

    assert.ok(
      Math.abs(score - expected) < 0.001,
      `점수(${score.toFixed(4)})가 예상값(${expected.toFixed(4)})과 일치해야 한다`
    );
  });

});
