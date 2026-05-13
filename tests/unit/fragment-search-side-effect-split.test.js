/**
 * FragmentSearch 부작용 모듈 외부화 회귀 가드
 *
 * 작성자: 최진호
 * 작성일: 2026-05-13
 *
 * 검색 이벤트 영속화와 SearchParamAdaptor 학습은 lib/memory/read/SearchSideEffects.js의
 * `commitSearchSideEffects` 함수로 외부화됐다. FragmentSearch는 이 함수를 호출하여
 * 부작용 단계를 위임하며, 인라인 recordSearchEvent/recordOutcome 호출은 0건이어야 한다.
 */

import { describe, it } from "node:test";
import assert            from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path              from "node:path";

const here       = path.dirname(fileURLToPath(import.meta.url));
const searchSrc  = readFileSync(
  path.resolve(here, "../../lib/memory/read/FragmentSearch.js"),
  "utf-8"
);
const sideEffectsPath = path.resolve(here, "../../lib/memory/read/SearchSideEffects.js");

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

describe("FragmentSearch — 부작용 모듈 외부화 회귀 가드", () => {

  it("SearchSideEffects.js 모듈이 존재한다", () => {
    assert.ok(existsSync(sideEffectsPath), "lib/memory/read/SearchSideEffects.js가 존재해야 한다");
  });

  it("SearchSideEffects가 commitSearchSideEffects를 export한다", () => {
    const src = readFileSync(sideEffectsPath, "utf-8");
    assert.match(
      src,
      /export\s+async\s+function\s+commitSearchSideEffects\s*\(/,
      "commitSearchSideEffects 함수 export가 존재해야 한다"
    );
  });

  it("FragmentSearch가 SearchSideEffects.commitSearchSideEffects를 import한다", () => {
    assert.match(
      searchSrc,
      /import\s*\{\s*commitSearchSideEffects\s*\}\s*from\s*['"]\.\/SearchSideEffects\.js['"]/,
      "FragmentSearch는 ./SearchSideEffects.js에서 commitSearchSideEffects를 import해야 한다"
    );
  });

  it("FragmentSearch.search()가 commitSearchSideEffects를 호출한다", () => {
    const count = countCallSites(searchSrc, "commitSearchSideEffects");
    assert.strictEqual(count, 1, `commitSearchSideEffects 호출이 정확히 1회여야 한다 (received ${count})`);
  });

  it("FragmentSearch는 더 이상 _commitSearchSideEffects 메서드를 보유하지 않는다", () => {
    assert.doesNotMatch(
      searchSrc,
      /async\s+_commitSearchSideEffects\s*\(/,
      "_commitSearchSideEffects 메서드는 모듈 외부화 후 잔존하면 안 된다"
    );
  });

  it("FragmentSearch가 recordSearchEvent를 직접 호출하지 않는다", () => {
    const count = countCallSites(searchSrc, "recordSearchEvent");
    assert.strictEqual(count, 0, `FragmentSearch의 recordSearchEvent 호출은 0이어야 한다 (received ${count})`);
  });

  it("FragmentSearch가 SearchParamAdaptor.recordOutcome을 직접 호출하지 않는다", () => {
    const count = countCallSites(searchSrc, "recordOutcome");
    assert.strictEqual(count, 0, `FragmentSearch의 recordOutcome 호출은 0이어야 한다 (received ${count})`);
  });

  it("_searchEventId 반환 계약이 유지된다", () => {
    assert.match(
      searchSrc,
      /_searchEventId\s*:\s*searchEventId/,
      "search() 응답에 _searchEventId가 동기 부착되어야 한다"
    );
  });

});
