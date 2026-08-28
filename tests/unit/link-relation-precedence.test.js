/**
 * 링크 관계 강등 방지 단위 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-08-28
 *
 * ProactiveRecall과 SessionLinker는 같은 파편 쌍에 related·co_retrieved·temporal을
 * 반복 생성한다. 사용자가 명시한 caused_by·resolved_by가 이 자동 링크에 덮이면
 * 인과 정보가 소실되므로 우선순위 판정으로 강등을 차단한다.
 */

import { test, describe } from "node:test";
import assert             from "node:assert/strict";

import { isRelationDowngrade } from "../../lib/memory/link/LinkStore.js";

describe("isRelationDowngrade", () => {
  test("인과 관계를 자동 생성 관계로 덮는 것은 강등이다", () => {
    assert.equal(isRelationDowngrade("resolved_by", "related"), true);
    assert.equal(isRelationDowngrade("caused_by", "co_retrieved"), true);
    assert.equal(isRelationDowngrade("contradicts", "temporal"), true);
  });

  test("자동 생성 관계를 인과 관계로 올리는 것은 강등이 아니다", () => {
    assert.equal(isRelationDowngrade("related", "resolved_by"), false);
    assert.equal(isRelationDowngrade("co_retrieved", "caused_by"), false);
    assert.equal(isRelationDowngrade("temporal", "part_of"), false);
  });

  test("같은 우선순위끼리는 강등이 아니다", () => {
    assert.equal(isRelationDowngrade("related", "temporal"), false);
    assert.equal(isRelationDowngrade("caused_by", "resolved_by"), false);
  });

  test("part_of는 자동 생성 관계보다 우선하고 인과보다는 낮다", () => {
    assert.equal(isRelationDowngrade("part_of", "related"), true);
    assert.equal(isRelationDowngrade("part_of", "caused_by"), false);
    assert.equal(isRelationDowngrade("caused_by", "part_of"), true);
  });

  test("알 수 없는 관계는 최하위로 취급한다", () => {
    assert.equal(isRelationDowngrade("resolved_by", "unknown_relation"), true);
    assert.equal(isRelationDowngrade("unknown_relation", "related"), false);
  });
});
