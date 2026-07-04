/**
 * remember content 수신 상한 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-07-04
 */
import { test } from "node:test";
import assert   from "node:assert";
import { validateContentInput } from "../../lib/memory/contentGuard.js";

test("4000자 이하는 통과", () => {
  assert.doesNotThrow(() => validateContentInput("a".repeat(4000)));
});

test("4000자 초과는 InvalidParams 성격의 에러", () => {
  assert.throws(() => validateContentInput("a".repeat(4001)), /content.*4000/);
});
