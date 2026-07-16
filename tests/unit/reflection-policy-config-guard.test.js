/**
 * P4 회귀 방지: reflectionPolicy.maxImportance가 reflect 하한(0.4대)을 포괄해야 한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-07-16
 */
import { test } from "node:test";
import assert   from "node:assert/strict";
import { MEMORY_CONFIG } from "../../config/memory.js";

test("reflectionPolicy.maxImportance는 0.55다", () => {
  assert.equal(MEMORY_CONFIG.reflectionPolicy.maxImportance, 0.55);
});
