/**
 * P4 회귀 방지: reflect decision importance가 permanent 승격 임계(0.8) 미만이어야 한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-07-16
 */
import { test } from "node:test";
import assert   from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../../lib/memory/processors/ReflectProcessor.js", import.meta.url), "utf8");

test("ReflectProcessor decision 파편은 importance 0.7로 생성된다", () => {
  /** decisions 블록 내 create 호출의 importance 리터럴 검증 (정적 가드) */
  const decisionBlock = SRC.slice(SRC.indexOf('type       : "decision"'));
  const m = decisionBlock.match(/importance\s*:\s*([0-9.]+)/);
  assert.ok(m, "decision create 블록에서 importance 리터럴을 찾지 못함");
  assert.equal(Number(m[1]), 0.7);
});
