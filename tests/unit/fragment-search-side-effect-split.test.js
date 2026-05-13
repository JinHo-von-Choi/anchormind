/**
 * FragmentSearch 부작용 분리 회귀 가드
 *
 * 작성자: 최진호
 * 작성일: 2026-05-13
 *
 * search()는 검색 파이프라인 결과를 만든 뒤 _commitSearchSideEffects로 부작용
 * (search event 영속화, SearchParamAdaptor 학습)을 일괄 처리한다.
 * 인라인으로 recordSearchEvent를 직접 호출하던 회귀를 정적으로 차단한다.
 */

import { describe, it } from "node:test";
import assert            from "node:assert/strict";
import { readFileSync }  from "node:fs";
import { fileURLToPath } from "node:url";
import path              from "node:path";

const here   = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(
  path.resolve(here, "../../lib/memory/read/FragmentSearch.js"),
  "utf-8"
);

/**
 * 실제 호출 사이트(이름 뒤에 `(`가 붙는 라인)만 카운트한다.
 * import 라인과 주석은 제외하여 노이즈를 차단한다.
 */
function countCallSites(text, name) {
  const re    = new RegExp(`\\b${name}\\s*\\(`);
  const lines = text.split("\n");
  let count = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("import")) continue;
    if (trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*")) continue;
    if (re.test(line)) count++;
  }
  return count;
}

describe("FragmentSearch — 부작용 분리 회귀 가드", () => {

  it("_commitSearchSideEffects 메서드가 정의되어 있다", () => {
    assert.match(
      source,
      /async\s+_commitSearchSideEffects\s*\(/,
      "_commitSearchSideEffects 메서드 정의가 존재해야 한다"
    );
  });

  it("search() 본문이 _commitSearchSideEffects를 호출한다", () => {
    assert.match(
      source,
      /this\._commitSearchSideEffects\s*\(/,
      "search 메서드는 _commitSearchSideEffects를 호출해야 한다"
    );
  });

  it("recordSearchEvent 호출은 단 한 곳(_commitSearchSideEffects 내부)에서만 일어난다", () => {
    const total = countCallSites(source, "recordSearchEvent");
    assert.strictEqual(
      total,
      1,
      `recordSearchEvent 호출이 정확히 1회여야 한다 (received ${total})`
    );
  });

  it("SearchParamAdaptor.recordOutcome 호출은 단 한 곳(_commitSearchSideEffects 내부)에서만 일어난다", () => {
    const total = countCallSites(source, "recordOutcome");
    assert.strictEqual(
      total,
      1,
      `recordOutcome 호출이 정확히 1회여야 한다 (received ${total})`
    );
  });

  it("_searchEventId 반환 계약이 유지된다", () => {
    assert.match(
      source,
      /_searchEventId\s*:\s*searchEventId/,
      "search() 응답에 _searchEventId가 동기 부착되어야 한다"
    );
  });

});
