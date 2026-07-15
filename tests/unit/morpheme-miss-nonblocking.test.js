/**
 * morpheme 사전 미스 경로 비블로킹 회귀 고정
 *
 * 작성자: 최진호
 * 작성일: 2026-07-16
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const POST = readFileSync(
  fileURLToPath(new URL("../../lib/memory/write/RememberPostProcessor.js", import.meta.url)),
  "utf8"
);
const SEARCH = readFileSync(
  fileURLToPath(new URL("../../lib/memory/read/FragmentSearch.js", import.meta.url)),
  "utf8"
);

describe("morpheme miss path is non-blocking", () => {
  it("morpheme 등록은 fire-and-forget(_morphemePromises)로 유지된다", () => {
    assert.match(POST, /_morphemePromises\.add\(/);
    assert.doesNotMatch(POST, /await this\.morphemeIndex\.getOrRegisterEmbeddings/);
  });

  it("morpheme 보강 검색 실패는 빈 배열로 격리된다", () => {
    const block = SEARCH.slice(SEARCH.indexOf("morphemeProbe"), SEARCH.indexOf("const [results, morphemeResults]"));
    assert.match(block, /catch\s*\(morphErr\)/);
    assert.match(block, /return \[\]/);
  });
});
