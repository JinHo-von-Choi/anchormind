/**
 * 작업 기억 행 제외 조건 구조 검사
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 기억을 보여 주거나 세는 질의가 작업 기억 행을 빼는 공용 조건(WorkingMemorySql)을 쓰는지 본다.
 * 목록의 파일은 그 모듈을 가져와 쓰고, 닫힌 파편을 포함하는 조회를 인자 하나로 갈라
 * valid_to 조건을 통째로 빼는 옛 형태(삼항식으로 빈 문자열을 고르는 형태)가 남아 있지 않다.
 * 실제 질의의 동작은 tests/db-concurrency/working-memory-exclusion.test.js가 확인한다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";
import { readFileSync } from "node:fs";

import { ROOT } from "./_source-scan.js";

/** 공용 조건을 써야 하는 파일 */
const USERS = Object.freeze([
  "lib/memory/read/FragmentReader.js",
  "lib/memory/read/LinkedFragmentLoader.js",
  "lib/memory/read/GraphNeighborSearch.js",
  "lib/memory/read/SyntheticQuerySearch.js",
  "lib/memory/read/StitchSourceLoader.js",
  "lib/memory/read/CaseRecall.js",
  "lib/memory/link/LinkStore.js",
  "lib/memory/embedding/EmbeddingWorker.js",
  "lib/memory/consolidate/MorphemeBackfill.js",
  "lib/admin/admin-memory.js",
  "lib/admin/admin-routes.js",
  "lib/admin/admin-keys.js",
  "lib/admin/ApiKeyStore.js",
  "lib/cli/stats.js",
  "lib/cli/inspect.js",
  "lib/scheduler.js",
  "scripts/check-embedding-consistency.js",
  "scripts/backfill-embeddings.js"
]);

const read = (file) => readFileSync(`${ROOT}/${file}`, "utf8");

describe("작업 기억 행 제외 조건", () => {
  for (const file of USERS) {
    it(`${file}는 공용 조건 모듈을 가져와 쓴다`, () => {
      const src = read(file);
      assert.match(src, /from\s+"[^"]*WorkingMemorySql\.js"/, "가져오기가 없다");
      assert.match(src, /NOT_WM_ROW|notWorkingMemoryRow|liveOrClosedCondition/, "조건을 쓰지 않는다");
    });
  }

  it("닫힌 파편 포함 여부로 valid_to 조건을 통째로 빼는 형태가 읽기 모듈에 남아 있지 않다", () => {
    const offenders = USERS.filter(file => /includeSuperseded[^\n]*\?\s*""\s*:\s*[`"][^`"]*valid_to IS NULL/.test(read(file)));
    assert.deepEqual(offenders, []);
  });

  it("임베딩 백필 스크립트는 닫힌 행과 작업 기억 행을 건너뛰는 조건을 질의에 둔다", () => {
    const src = read("scripts/backfill-embeddings.js");
    const query = /SELECT id, content FROM[\s\S]*?LIMIT \$1/.exec(src)?.[0] ?? "";
    assert.match(query, /valid_to IS NULL/);
    assert.match(query, /\$\{NOT_WM_ROW\}/);
  });

  it("임베딩 대기 조회와 형태소 백필은 공용 조건을 질의에 둔다", () => {
    const embed = /processOrphanFragments[\s\S]*?LIMIT \$1/.exec(read("lib/memory/embedding/EmbeddingWorker.js"))?.[0] ?? "";
    assert.match(embed, /\$\{NOT_WM_ROW\}/);
    const morph = /WHERE morpheme_indexed = false[\s\S]*?LIMIT \$1/.exec(read("lib/memory/consolidate/MorphemeBackfill.js"))?.[0] ?? "";
    assert.match(morph, /\$\{NOT_WM_ROW\}/);
  });
});
