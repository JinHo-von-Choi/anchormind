/**
 * 관리 SQL 모듈의 ScopeFilter 사용과 전체 범위 가드 구조 검사
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 * 수정일: 2026-10-04
 *
 * lib/admin 모듈마다 _admin-checks.scopeViolations로 본다.
 *   1. 기억 표(fragments와 그 파생 표, 검색과 피드백 기록)를 읽는 SQL 문자열은 그 문자열 안이나 바로 앞에서
 *      술어 생성기(scopePredicate, scopedQuery, linkScopePredicate)를 부른다.
 *   2. scopedQuery 조립 함수는 받은 술어를 질의 문자열에 넣는다.
 *   3. workspace 범위 조건을 손으로 쓰지 않는다.
 *   4. 관리 모듈 밖의 기억 경로(MemoryManager, 검색 집계, 내보내기, 가져오기, 세션 반영 등, 비기억 가져오기
 *      목록 NON_DATA_IMPORTS 밖의 모든 가져오기와 동적 가져오기)를 부르는 함수는 전체 범위 가드
 *      requireFullScope를 부르거나, 모듈 안의 모든 호출자가 가드를 부른다.
 * 마지막 묶음은 실제 소스를 고친 변형에서 위반이 잡히는지 확인한다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path             from "node:path";

import { ROOT } from "./_source-scan.js";
import { scopeViolations } from "./_admin-checks.js";

/**
 * 검사에서 빼는 관리 모듈과 사유.
 * ApiKeyStore.js는 키 저장소다. 파편 질의는 키 삭제 보호와 키별 파편 수 집계이며 key_id로 한정되고,
 * 호출하는 관리 라우트(key.manage, 전역 범위)는 판정 범위가 전체일 때만 열린다. ScopeFilter.js는 술어 생성기 자신이다.
 */
const EXEMPT = new Set(["ApiKeyStore.js", "ScopeFilter.js"]);

const ADMIN_DIR  = path.join(ROOT, "lib", "admin");
const adminFiles = readdirSync(ADMIN_DIR).filter((f) => f.endsWith(".js") && !EXEMPT.has(f));
const sourceOf   = (file) => readFileSync(path.join(ADMIN_DIR, file), "utf8");

describe("관리 모듈의 범위 규칙", () => {
  for (const file of adminFiles) {
    it(`${file}: 위반이 없다`, () => {
      assert.deepEqual(scopeViolations(sourceOf(file)), []);
    });
  }
});

describe("범위 규칙 검사의 변형 소스 시험", () => {
  const memory = sourceOf("admin-memory.js");
  const change = (from, to) => {
    assert.ok(memory.includes(from), `변형 기준 문자열이 없다: ${from.slice(0, 60)}`);
    return memory.replace(from, to);
  };

  it("scopedQuery 조립 함수가 술어를 버리면 잡힌다", () => {
    const out = scopeViolations(change("WHERE ${NOT_WM_ROW} AND ${ws}`)),", "WHERE ${NOT_WM_ROW}`)),"));
    assert.ok(out.some((m) => m.includes("술어 ws를 쓰지 않는다")), out.join("; "));
  });

  it("기억 표 SQL에서 범위 술어를 빼면 잡힌다", () => {
    const out = scopeViolations(change(" AND ${scopePredicate(params, \"workspace\", scope)}`,\n      params\n    );", "`,\n      params\n    );"));
    assert.ok(out.some((m) => m.includes("범위 술어 없는 기억 표 SQL")), out.join("; "));
  });

  it("이력 처리기에서 전체 범위 가드를 빼면 MemoryManager 동적 가져오기가 잡힌다", () => {
    const from = "async function handleFragmentHistory(req, res, url, fragId) {\n  if (!requireFullScope(req, res)) return true;";
    const out  = scopeViolations(change(from, "async function handleFragmentHistory(req, res, url, fragId) {"));
    assert.ok(out.some((m) => m.includes("MemoryManager")), out.join("; "));
  });

  it("가드 없는 처리기에서 모듈 밖 기억 경로를 새로 부르면 잡힌다", () => {
    const from = "async function handleOverview(req, res, _url) {\n  try {";
    const out  = scopeViolations(change(from, `${from}\n    await getSearchMetrics();`));
    assert.ok(out.some((m) => m.includes("getSearchMetrics") && m.includes("handleOverview")), out.join("; "));
  });

  it("손으로 쓴 workspace 범위 조건은 잡힌다", () => {
    const out = scopeViolations(change("WHERE ${NOT_WM_ROW} AND ${ws}`)),", "WHERE ${NOT_WM_ROW} AND ${ws} AND workspace = ANY($1)`)),"));
    assert.ok(out.some((m) => m.includes("손으로 쓴")), out.join("; "));
  });
});
