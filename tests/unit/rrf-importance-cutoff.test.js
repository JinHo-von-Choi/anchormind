import { test } from "node:test";
import assert from "node:assert/strict";

/** 순수 함수로 추출된 컷오프 로직 검증 */
import { applyImportanceCutoff } from "../../lib/memory/read/FragmentSearch.js";

test("low-importance non-anchor fragments are cut", () => {
  const frags = [
    { id: "a", importance: 0.05, is_anchor: false },
    { id: "b", importance: 0.80, is_anchor: false },
    { id: "c", importance: 0.02, is_anchor: true },        // anchor는 보존
    { id: "d", is_anchor: false },                          // L1-only(importance undefined)는 보존
  ];
  const out = applyImportanceCutoff(frags, 0.15, undefined);
  assert.deepEqual(out.map(f => f.id), ["b", "c", "d"]);
});

test("explicit minImportance overrides default cutoff", () => {
  const frags = [{ id: "a", importance: 0.20, is_anchor: false }];
  const out = applyImportanceCutoff(frags, 0.15, 0.5);  // 명시 0.5 우선
  assert.deepEqual(out.map(f => f.id), []);
});

test("floor가 undefined면 컷오프를 적용하지 않는다 (P1 회귀 방지)", () => {
  const frags = [
    { id: "a", importance: 0.05, is_anchor: false },
    { id: "b", importance: 0.80, is_anchor: false },
    { id: "c", is_anchor: false },                  // importance undefined
  ];
  // defaultFloor=undefined(=config 미정의 시 과거 상태), explicitMin=undefined
  const out = applyImportanceCutoff(frags, undefined, undefined);
  assert.deepEqual(out.map(f => f.id), ["a", "b", "c"]);
});

test("floor가 null이어도 no-op", () => {
  const frags = [{ id: "a", importance: 0.05, is_anchor: false }];
  const out   = applyImportanceCutoff(frags, null, null);
  assert.deepEqual(out.map(f => f.id), ["a"]);
});
