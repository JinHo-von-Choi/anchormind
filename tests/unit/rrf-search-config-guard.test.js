/**
 * P1 회귀 방지: rrfSearch.candidateMinImportance 정책값이 명시적으로 존재해야 한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-07-16
 */
import { test } from "node:test";
import assert   from "node:assert/strict";
import { MEMORY_CONFIG } from "../../config/memory.js";

test("rrfSearch.candidateMinImportance는 유한 숫자로 정의되어야 한다", () => {
  const v = MEMORY_CONFIG.rrfSearch.candidateMinImportance;
  assert.equal(typeof v, "number");
  assert.ok(Number.isFinite(v));
  assert.ok(v > 0 && v < 1);
});
