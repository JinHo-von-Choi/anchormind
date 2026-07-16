/**
 * P3: extractKeywords 조사 스트리핑 + 코드 식별자 보존 검증.
 *
 * 작성자: 최진호
 * 작성일: 2026-07-16
 */
import { test }          from "node:test";
import assert            from "node:assert/strict";
import { FragmentFactory } from "../../lib/memory/write/FragmentFactory.js";

const factory = new FragmentFactory();

test("한글 조사가 스트리핑된다", () => {
  const kws = factory.extractKeywords("nginx를 포트에서 재시작했고 캐시가 초기화됐다");
  assert.ok(kws.includes("nginx"), `nginx 원형 누락: ${kws.join(",")}`);
  assert.ok(!kws.some(k => k.endsWith("를") || k.endsWith("가") || k.endsWith("에서")),
    `조사 잔존: ${kws.join(",")}`);
});

test("camelCase 식별자 원형이 보존된다", () => {
  const kws = factory.extractKeywords("applyImportanceCutoff 함수가 floor 값을 처리한다");
  assert.ok(kws.includes("applyImportanceCutoff"), `camelCase 원형 누락: ${kws.join(",")}`);
});

test("snake_case 식별자 원형이 보존된다", () => {
  const kws = factory.extractKeywords("morpheme_indexed 플래그를 갱신한다");
  assert.ok(kws.includes("morpheme_indexed"), `snake_case 원형 누락: ${kws.join(",")}`);
});

test("1회 등장 식별자도 빈도 무관하게 포함된다", () => {
  const kws = factory.extractKeywords("설정 설정 설정 캐시 캐시 candidateMinImportance");
  assert.ok(kws.includes("candidateMinImportance"), `단발 식별자 탈락: ${kws.join(",")}`);
});
