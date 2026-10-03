/**
 * 작업 기억 행 제외 조건 순수 함수 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

import { NOT_WM_ROW, WM_FALLBACK_SOURCE, notWorkingMemoryRow, liveOrClosedCondition } from "../../lib/memory/WorkingMemorySql.js";

describe("WorkingMemorySql", () => {
  it("별칭이 없으면 열 이름만, 있으면 별칭을 붙인 조건을 만든다", () => {
    assert.equal(NOT_WM_ROW, `source IS DISTINCT FROM '${WM_FALLBACK_SOURCE}'`);
    assert.equal(notWorkingMemoryRow("f"), `f.source IS DISTINCT FROM '${WM_FALLBACK_SOURCE}'`);
  });

  it("닫힌 파편을 포함하지 않으면 valid_to IS NULL이다", () => {
    assert.equal(liveOrClosedCondition(false), "valid_to IS NULL");
    assert.equal(liveOrClosedCondition(false, "f"), "f.valid_to IS NULL");
  });

  it("닫힌 파편을 포함하면 작업 기억 행만 뺀다", () => {
    assert.equal(liveOrClosedCondition(true), NOT_WM_ROW);
    assert.equal(liveOrClosedCondition(true, "f"), notWorkingMemoryRow("f"));
  });
});
