/**
 * 본문 어휘 채널 호출 경계 구조 검사
 *
 * 작성자: 최진호
 * 작성일: 2026-10-04
 *
 * 어휘 채널은 recall 진입점이 켠 검색(lexicalChannel: true)에서만 돈다. 저장 경로의 내부 검색(충돌 탐지,
 * 자동 링크 등)은 본문 전체를 질의로 쓰므로 채널을 켜면 저장마다 무거운 전문 검색이 붙는다. lib 소스를
 * 읽어 두 가지를 본다.
 *   1. lexicalChannel을 다루는 파일은 플래그를 켜는 recall 진입점과 읽는 LexicalSearch뿐이다.
 *   2. FragmentSearch의 검색 함수(search, searchCandidates)를 부르는 파일은 사유가 붙은 목록에 있다.
 *      새 호출 위치는 플래그를 켤지 판단하고 여기에 등록한다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";
import fs               from "node:fs";
import path             from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const LIB  = path.join(ROOT, "lib");

/** lexicalChannel을 다루는 파일과 역할 */
const FLAG_FILES = Object.freeze({
  "lib/memory/processors/MemoryRecaller.js": "recall 진입점. buildRecallSearchQuery가 플래그를 켠다",
  "lib/memory/read/LexicalSearch.js"       : "플래그가 켜진 검색만 어휘 질의를 실행한다"
});

/** FragmentSearch 검색 함수를 부르는 파일과 사유 */
const SEARCH_CALLERS = Object.freeze({
  "lib/memory/processors/MemoryRecaller.js": "recall 진입점(플래그를 켠다)",
  "lib/memory/write/ConflictResolver.js"   : "remember의 충돌 탐지. 본문을 질의로 쓰므로 플래그를 두지 않는다",
  "lib/memory/write/RememberPostProcessor.js": "remember 뒤 자동 링크. keywords 검색이며 플래그를 두지 않는다"
});

const SEARCH_CALL = /\.search\.(search|searchCandidates)\s*\(/;

function listJs(dir, acc = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) listJs(p, acc);
    else if (name.endsWith(".js")) acc.push(p);
  }
  return acc;
}

const sources = listJs(LIB).map(file => ({
  rel : path.relative(ROOT, file).split(path.sep).join("/"),
  text: fs.readFileSync(file, "utf8")
}));

describe("본문 어휘 채널 호출 경계", () => {
  it("lexicalChannel을 다루는 파일은 recall 진입점과 LexicalSearch뿐이다", () => {
    const found = sources.filter(s => /\blexicalChannel\b/.test(s.text)).map(s => s.rel).sort();
    assert.deepEqual(found, Object.keys(FLAG_FILES).sort());
  });

  it("recall 진입점은 검색 질의를 만드는 함수 안에서 플래그를 켠다", () => {
    const text  = sources.find(s => s.rel === "lib/memory/processors/MemoryRecaller.js").text;
    const start = text.indexOf("function buildRecallSearchQuery(");
    const end   = text.indexOf("\n}", start);
    assert.ok(start >= 0);
    assert.match(text.slice(start, end), /lexicalChannel\s*:\s*true/);
    assert.equal((text.match(/\blexicalChannel\b/g) ?? []).length, 1);
  });

  it("FragmentSearch 검색 함수를 부르는 파일은 사유가 붙은 목록과 같다", () => {
    const found = sources.filter(s => SEARCH_CALL.test(s.text)).map(s => s.rel).sort();
    assert.deepEqual(found, Object.keys(SEARCH_CALLERS).sort());
  });
});
