/**
 * 통합과 GC 의 폐기·삭제 경로 정합성 검사
 *
 * 작성자: 최진호
 * 작성일: 2026-09-30
 *
 * 폐기·삭제 경로가 RETURNING 행을 역인덱스와 핫 캐시에서 걷어내는지,
 * 압축 그룹이 key_id·workspace 경계를 넘지 않는지, semantic_dedup 병합이
 * 한 트랜잭션으로 묶이는지를 소스 구조와 deindexRows 동작으로 고정한다.
 */

import { describe, it, mock } from "node:test";
import assert                 from "node:assert/strict";
import { readFileSync }       from "node:fs";
import path                   from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

describe("통합과 GC 삭제 경로", () => {
  it("폐기와 삭제를 하는 모듈은 deindexRows 를 쓴다", () => {
    for (const rel of [
      "lib/memory/consolidate/ConsolidatorGC.js",
      "lib/memory/consolidate/MemoryConsolidator.js",
      "lib/memory/consolidate/FragmentGC.js",
      "lib/memory/write/ConflictResolver.js",
      "lib/memory/link/GraphLinker.js"
    ]) {
      assert.match(read(rel), /deindexRows/, rel);
    }
  });

  it("압축 후보 질의는 key_id 와 workspace 를 함께 조회하고 이웃 검색에도 같은 범위를 건다", () => {
    const src = read("lib/memory/consolidate/ConsolidatorGC.js");
    assert.match(src, /SELECT id, topic, importance, access_count, embedding, key_id, workspace/);
    assert.match(src, /workspace IS NOT DISTINCT FROM \$5/);
    assert.match(src, /keyScopeNullable\(knnParams, "key_id", frag\.key_id \?\? null\)/);
    assert.match(src, /JSON\.stringify\(\[row\.topic, row\.key_id \?\? null, row\.workspace \?\? null\]\)/);
  });

  it("압축 링크는 CHECK 제약이 허용하는 superseded_by 로 제거 대상에서 승계자 방향으로 쓴다", () => {
    const src = read("lib/memory/consolidate/ConsolidatorGC.js");
    assert.doesNotMatch(src, /'supersedes'/);
    assert.match(src, /VALUES \(\$1, \$2, 'superseded_by', 1\)[\s\S]{0,200}\[old\.id, keeper\.id\]/);
  });

  it("semantic_dedup 병합은 단일 트랜잭션이며 순회 파편이 닫히면 루프를 끝낸다", () => {
    const src = read("lib/memory/consolidate/MemoryConsolidator.js");
    assert.match(src, /withTransaction\(getPrimaryPool\(\)/);
    assert.match(src, /if \(oldId === frag\.id\) break;/);
  });

  it("semantic_dedup 은 두 행이 모두 살아 있을 때만 병합하고, 병합이 성립한 뒤에만 집계한다", () => {
    const src   = read("lib/memory/consolidate/MemoryConsolidator.js");
    const body  = src.slice(src.indexOf("async _semanticDedup()"), src.indexOf("async _compressOldFragments") > 0
      ? src.indexOf("async _compressOldFragments")
      : undefined);
    assert.match(body, /valid_to IS NULL[\s\S]{0,80}FOR NO KEY UPDATE/);
    const skipAt  = body.indexOf("if (!merged) continue;");
    const addAt   = body.indexOf("processed.add(oldId);");
    const countAt = body.indexOf("mergedCount++;");
    assert.ok(skipAt > 0, "병합 불성립 시 건너뛰는 분기가 있어야 한다");
    assert.ok(skipAt < addAt && skipAt < countAt, "집계는 병합 성립 판정 뒤에 와야 한다");
  });
});

describe("deindexRows", () => {
  it("RETURNING 행마다 deindex 를 id, keywords, topic, type, key_id 순으로 부른다", async () => {
    const { getFragmentIndex, deindexRows } = await import("../../lib/memory/FragmentIndex.js");
    const index    = getFragmentIndex();
    const original = index.deindex;
    const spy      = mock.fn(async () => {});
    index.deindex  = spy;
    try {
      await deindexRows([
        { id: "a", keywords: ["k1"], topic: "t", type: "fact", key_id: "K" },
        { id: "b", keywords: [],     topic: "u", type: "error" }
      ]);
      assert.equal(spy.mock.callCount(), 2);
      assert.deepEqual(spy.mock.calls[0].arguments, ["a", ["k1"], "t", "fact", "K"]);
      assert.deepEqual(spy.mock.calls[1].arguments, ["b", [], "u", "error", null]);
    } finally {
      index.deindex = original;
    }
  });

  it("빈 입력과 배열이 아닌 입력은 아무것도 부르지 않는다", async () => {
    const { getFragmentIndex, deindexRows } = await import("../../lib/memory/FragmentIndex.js");
    const index    = getFragmentIndex();
    const original = index.deindex;
    const spy      = mock.fn(async () => {});
    index.deindex  = spy;
    try {
      await deindexRows([]);
      await deindexRows(undefined);
      await deindexRows(null);
      assert.equal(spy.mock.callCount(), 0);
    } finally {
      index.deindex = original;
    }
  });

  it("한 행의 deindex 가 실패해도 나머지 행은 처리하고 호출자에게 예외를 넘기지 않는다", async () => {
    const { getFragmentIndex, deindexRows } = await import("../../lib/memory/FragmentIndex.js");
    const index    = getFragmentIndex();
    const original = index.deindex;
    const spy      = mock.fn(async (id) => { if (id === "bad") throw new Error("boom"); });
    index.deindex  = spy;
    try {
      await deindexRows([{ id: "bad" }, { id: "ok" }]);
      assert.equal(spy.mock.callCount(), 2);
    } finally {
      index.deindex = original;
    }
  });
});
