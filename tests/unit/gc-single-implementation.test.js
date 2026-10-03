/**
 * 만료 GC 단일 구현 구조 검사
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 만료 후보를 고르는 SQL과 삭제 청크 반복은 FragmentGC 한 곳에만 있고, FragmentStore와 정리 단계는
 * 그 구현을 부른다.
 */

import { describe, it }                        from "node:test";
import assert                                  from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path                                    from "node:path";

const LIB = path.resolve(import.meta.dirname, "../../lib");

function collect(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) collect(p, acc);
    else if (name.endsWith(".js")) acc.push(p);
  }
  return acc;
}

const FILES = collect(LIB).map(p => ({ rel: path.relative(LIB, p).split(path.sep).join("/"), src: readFileSync(p, "utf8") }));
const filesWith = (re) => FILES.filter(f => re.test(f.src)).map(f => f.rel);
const read = (rel) => FILES.find(f => f.rel === rel).src;

describe("만료 GC 단일 구현", () => {
  it("만료 후보 CTE는 FragmentGC에만 있다", () => {
    assert.deepEqual(filesWith(/gc_candidates/), ["memory/consolidate/FragmentGC.js"]);
  });

  it("파편 만료 삭제 본문을 가진 메서드는 FragmentGC에만 있다(FragmentStore는 위임만 한다)", () => {
    const delegating = new Set(["memory/write/FragmentStore.js", "memory/CaseEventStore.js"]);
    const defining   = FILES
      .filter(f => /^\s*(async\s+)?deleteExpired\s*\(\s*\)\s*\{/m.test(f.src) && !delegating.has(f.rel))
      .map(f => f.rel);
    assert.deepEqual(defining, ["memory/consolidate/FragmentGC.js"]);
  });

  it("FragmentWriter는 만료 삭제와 작업 기억 행 만료 정리를 직접 하지 않는다", () => {
    const src = read("memory/write/FragmentWriter.js");
    assert.doesNotMatch(src, /deleteExpired/);
    assert.doesNotMatch(src, /gc_delete/);
  });

  it("FragmentStore.deleteExpired는 FragmentGC에 위임한다", () => {
    assert.match(read("memory/write/FragmentStore.js"), /deleteExpired\(\)\s*\{\s*return this\.gc\.deleteExpired\(\);\s*\}/);
  });

  it("정리 단계는 FragmentStore.deleteExpired를 부르고 FragmentGC가 작업 기억 행 정리를 포함한다", () => {
    assert.match(read("memory/consolidate/MemoryConsolidator.js"), /this\.store\.deleteExpired\(\)/);
    assert.match(read("memory/consolidate/FragmentGC.js"), /await deleteExpiredWorkingMemoryRows\(\)/);
  });
});
