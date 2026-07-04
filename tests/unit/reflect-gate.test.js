import { test } from "node:test";
import assert from "node:assert/strict";
import { isSelfContainedReflectItem } from "../../lib/memory/processors/ReflectProcessor.js";

test("rejects too-short and meta-referential items", () => {
  assert.equal(isSelfContainedReflectItem("ok"), false);                 // 너무 짧음
  assert.equal(isSelfContainedReflectItem("재작성을 통해 정합 확보"), false); // 20자 미만
  assert.equal(isSelfContainedReflectItem("이것을 수정했다"), false);       // 대명사 시작 + 짧음
  assert.equal(
    isSelfContainedReflectItem("FragmentSearch.js의 morpheme 서브패스를 Promise.all로 병렬화해 벡터 스캔 2회를 1회로 줄였다"),
    true
  );
});
