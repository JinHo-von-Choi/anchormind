/**
 * 의미 열 쓰기 경계 구조 검사
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * fragments 표의 의미 열(content, topic, keywords, is_anchor, workspace, key_id,
 * context_summary, goal, outcome)을 쓰는 SQL 문자열은 FragmentWriter의 의미 메서드와
 * 사유가 붙은 허용 목록에만 있어야 한다. 행 INSERT는 본문을 쓰므로 모두 의미 쓰기다.
 *
 * lib, scripts, bin의 문자열 상수와 템플릿 문자열을 읽어
 *   1. INSERT INTO fragments
 *   2. UPDATE fragments ... SET <의미 열> =
 *   3. SET 절을 조립하는 모듈(동적 SET)에서 "<의미 열> = "로 시작하는 문자열
 * 을 찾고, 감싼 함수 이름과 함께 대조한다. 내부 메타데이터 갱신(임베딩, 접근 수, TTL,
 * 감쇠, 링크 유지 등)은 의미 열을 쓰지 않으므로 대상이 아니다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

import { listSourceFiles, scanFile } from "./_source-scan.js";

const SEMANTIC_COLUMNS = Object.freeze([
  "content", "topic", "keywords", "is_anchor", "workspace", "key_id", "context_summary", "goal", "outcome"
]);

/** FragmentWriter의 의미 메서드. 관문을 통과한 값만 받는다. */
const SEMANTIC_METHODS = Object.freeze({
  "lib/memory/write/FragmentWriter.js": ["insert", "_prepareInsertRow", "_runInsert", "update", "_diffUpdatableFields", "_runUpdate"]
});

/**
 * SET 절을 문자열로 받아 조립하는 모듈. 이 모듈과 그 도우미를 부르는 파일은 "<열> = "로 시작하는
 * 문자열 조각도 SET 절의 일부로 본다. 새 동적 SET 모듈은 여기에 사유와 함께 등록한다.
 */
const DYNAMIC_SET_MODULES = Object.freeze({
  "lib/memory/write/FragmentWriter.js"        : "amend의 SET 절을 바뀐 필드로 조립한다",
  "lib/memory/consolidate/idOrderedUpdate.js": "id 순 묶음 갱신. SET 절은 호출 파일이 넘기므로 호출 파일의 문자열을 함께 검사한다"
});
const DYNAMIC_SET_HELPERS = Object.freeze(["updateInIdOrder"]);

/**
 * 의미 열을 쓰는 SQL을 둘 수 있는 그 밖의 위치. 키는 "파일::함수", 값은 사유다.
 */
const ALLOWED_SEMANTIC_SQL = Object.freeze({
  "lib/memory/write/BatchRememberProcessor.js::_insertChunk":
    "Phase A에서 항목마다 WriteGate.check를 통과한 파편만 청크 단위 다중 행 INSERT로 기록한다",
  "lib/memory/consolidate/MemoryConsolidator.js::_promoteAnchors":
    "통합 단계의 앵커 자동 승격. 접근 수와 중요도 조건으로 is_anchor만 올린다",
  "scripts/backfill-body-keywords.js::main":
    "운영자가 실행하는 일회성 백필. 저장된 본문에서 추출한 키워드를 다시 채운다",
  "scripts/backfill-split-keywords.js::main":
    "운영자가 실행하는 일회성 백필. 분할 자식의 키워드를 저장된 본문에서 다시 추출한다",
  "scripts/reextract-reflect-keywords.js::main":
    "운영자가 실행하는 일회성 백필. reflect 파편의 키워드를 저장된 본문에서 다시 추출한다",
  "scripts/backfill-reflect-workspace.js::main":
    "운영자가 실행하는 일회성 백필. 같은 세션 파편의 workspace를 reflect 파편에 옮겨 적는다"
});

const TABLE_WRITE   = /\b(INSERT\s+INTO|UPDATE)\s+(?:\$\{\}\.|[A-Za-z_]+\.)?fragments(?![\w])/i;
const SET_CLAUSE    = /\bSET\b([\s\S]*?)(?:\bWHERE\b|\bFROM\b|\bRETURNING\b|$)/i;
const ASSIGNMENT    = /(?:^|,)\s*(?:[a-z_]+\.)?([a-z_]+)\s*=(?!=)/gi;
const LEADING_SET   = /^\s*(?:[a-z_]+\.)?([a-z_]+)\s*=(?!=)/i;

/** UPDATE 문자열의 SET 절에서 대입되는 열 이름. SET 절이 보간이면 dynamic=true. */
function setColumns(text, matchEnd) {
  const set = SET_CLAUSE.exec(text.slice(matchEnd));
  if (!set) return { columns: [], dynamic: false };
  const columns = [...set[1].matchAll(ASSIGNMENT)].map(m => m[1].toLowerCase());
  return { columns, dynamic: /^\s*\$\{\}/.test(set[1]) };
}

/**
 * 파일 하나의 의미 쓰기와 동적 SET 문장을 찾는다.
 *
 * @param {string} file
 * @returns {{ writes: Array<{file: string, fn: string, kind: string, columns: string[], line: number}>, dynamicSet: boolean }}
 */
function scanWrites(file) {
  const { strings, calls } = scanFile(file);
  const writes     = [];
  let   dynamicSet = false;
  const fnOf       = (s) => s.scope.at(-1) ?? "<module>";

  for (const s of strings) {
    const m = TABLE_WRITE.exec(s.text);
    if (!m) continue;
    if (/INSERT/i.test(m[1])) {
      writes.push({ file, fn: fnOf(s), kind: "insert", columns: ["*"], line: s.line });
      continue;
    }
    const { columns, dynamic } = setColumns(s.text, m.index + m[0].length);
    dynamicSet = dynamicSet || dynamic;
    const semantic = columns.filter(c => SEMANTIC_COLUMNS.includes(c));
    if (semantic.length > 0) writes.push({ file, fn: fnOf(s), kind: "update", columns: semantic, line: s.line });
  }

  const buildsSet = file in DYNAMIC_SET_MODULES || calls.some(c => DYNAMIC_SET_HELPERS.includes(c.callee));
  if (buildsSet) {
    for (const s of strings) {
      const lead = LEADING_SET.exec(s.text);
      if (lead && SEMANTIC_COLUMNS.includes(lead[1].toLowerCase()) && !TABLE_WRITE.test(s.text)) {
        writes.push({ file, fn: fnOf(s), kind: "set-fragment", columns: [lead[1].toLowerCase()], line: s.line });
      }
    }
  }
  return { writes, dynamicSet };
}

/** lib, scripts, bin 전체를 스캔한다. */
function collectSemanticWrites() {
  const files      = [...listSourceFiles("lib"), ...listSourceFiles("scripts"), ...listSourceFiles("bin")];
  const writes     = [];
  const dynamicSet = [];
  for (const file of files) {
    const r = scanWrites(file);
    writes.push(...r.writes);
    if (r.dynamicSet) dynamicSet.push(file);
  }
  return { writes, dynamicSet };
}

function isSemanticMethod(w) {
  return (SEMANTIC_METHODS[w.file] ?? []).includes(w.fn);
}

describe("의미 열 쓰기 경계", () => {
  const { writes, dynamicSet } = collectSemanticWrites();

  it("의미 열 쓰기는 FragmentWriter 의미 메서드와 허용 목록에만 있다", () => {
    const offenders = writes
      .filter(w => !isSemanticMethod(w) && !(`${w.file}::${w.fn}` in ALLOWED_SEMANTIC_SQL))
      .map(w => `${w.file}::${w.fn} (${w.kind} ${w.columns.join(",")}, ${w.line}행)`);
    assert.deepEqual(offenders, [], `관문 밖 의미 열 쓰기:\n${offenders.join("\n")}`);
  });

  it("허용 항목마다 사유가 있다", () => {
    for (const [key, reason] of Object.entries(ALLOWED_SEMANTIC_SQL)) {
      assert.match(key, /^[\w./-]+\.m?js::[\w<>$]+$/, `허용 키 형식: ${key}`);
      assert.ok(typeof reason === "string" && reason.trim().length >= 10, `${key}: 사유가 비었거나 너무 짧다`);
    }
  });

  it("더는 의미 열을 쓰지 않는 허용 항목이 남아 있지 않다", () => {
    const used  = new Set(writes.map(w => `${w.file}::${w.fn}`));
    const stale = Object.keys(ALLOWED_SEMANTIC_SQL).filter(k => !used.has(k));
    assert.deepEqual(stale, [], `정리된 항목은 목록에서 지운다: ${stale.join(", ")}`);
  });

  it("검사가 FragmentWriter 의미 메서드의 INSERT와 SET 조립을 실제로 찾는다", () => {
    const found = new Set(writes.filter(isSemanticMethod).map(w => `${w.fn}:${w.kind}`));
    assert.ok(found.has("_prepareInsertRow:insert"), "INSERT 탐지가 동작하지 않는다");
    assert.ok(found.has("_diffUpdatableFields:set-fragment"), "동적 SET 조각 탐지가 동작하지 않는다");
  });

  it("SET 절을 보간으로 받는 모듈은 등록된 것뿐이다", () => {
    const unknown = dynamicSet.filter(f => !(f in DYNAMIC_SET_MODULES));
    assert.deepEqual(unknown, [], `등록되지 않은 동적 SET 모듈: ${unknown.join(", ")}`);
    const stale = Object.keys(DYNAMIC_SET_MODULES).filter(f => !dynamicSet.includes(f));
    assert.deepEqual(stale, [], `동적 SET이 사라진 모듈: ${stale.join(", ")}`);
  });
});
