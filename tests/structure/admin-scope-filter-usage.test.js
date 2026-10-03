/**
 * 관리 SQL 모듈의 ScopeFilter 사용 구조 검사
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * lib/admin 모듈의 SQL 문자열 가운데 기억 표(fragments와 그 파생 표, 검색과 피드백 기록)를 읽는 것은 문자열 안이나
 * 바로 앞에서 ScopeFilter의 술어 생성기(scopePredicate, scopedQuery)를 부른다. 그런 모듈은 ScopeFilter를 가져오고,
 * workspace 범위 조건을 손으로 쓰지 않는다. 판정 범위가 없으면 술어가 FALSE라서 질의 결과가 비는 쪽으로 닫힌다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";
import { readdirSync }  from "node:fs";
import path             from "node:path";

import { ROOT, scanFile } from "./_source-scan.js";

/** 관리 판정 범위를 걸어야 하는 표 */
const SCOPED_TABLES = Object.freeze([
  "fragments", "fragment_links", "fragment_versions", "case_events", "case_event_edges", "fragment_claims",
  "fragment_evidence", "fragment_synthetic_query", "tool_feedback", "search_events", "idempotency_records",
  "memory_review_decisions"
]);

/** 술어 생성기 */
const PREDICATE_CALLS = new Set(["scopePredicate", "scopedQuery"]);

/**
 * 검사에서 빼는 관리 모듈과 사유.
 * ApiKeyStore.js는 키 저장소다. 파편 질의는 키 삭제 보호와 키별 파편 수 집계이며 key_id로 한정되고,
 * 호출하는 관리 라우트(key.manage, 전역 범위)는 판정 범위가 전체일 때만 열린다.
 */
const EXEMPT = new Set(["ApiKeyStore.js", "ScopeFilter.js"]);

const TABLE_PATTERN = new RegExp(`\\$\\{\\}\\.(${SCOPED_TABLES.join("|")})\\b`);

const adminFiles = readdirSync(path.join(ROOT, "lib", "admin")).filter((f) => f.endsWith(".js") && !EXEMPT.has(f));

/** 모듈의 기억 표 SQL 문자열과 술어 생성기 호출 */
function scan(file) {
  const result  = scanFile(`lib/admin/${file}`);
  const sql     = result.strings.filter((s) => TABLE_PATTERN.test(s.text));
  const calls   = result.calls.filter((c) => PREDICATE_CALLS.has(c.callee));
  const imports = result.importSpecs.filter((s) => s.source === "./ScopeFilter.js").map((s) => s.imported);
  return { sql, calls, imports };
}

describe("관리 SQL 모듈의 ScopeFilter 사용", () => {
  const users = adminFiles.filter((f) => scan(f).sql.length > 0);

  it("기억 표를 읽는 관리 모듈이 있다", () => {
    assert.ok(users.length >= 4, `대상 모듈 ${users.length}개`);
  });

  for (const file of users) {
    it(`${file}: 기억 표 SQL마다 술어 생성기를 그 문자열 안이나 바로 앞에서 부른다`, () => {
      const { sql, calls, imports } = scan(file);
      assert.ok(imports.some((name) => PREDICATE_CALLS.has(name)), `${file}가 ScopeFilter를 가져오지 않는다`);
      for (const s of sql) {
        const end = s.line + (s.text.match(/\n/g) ?? []).length;
        const hit = calls.some((c) => c.line >= s.line - 1 && c.line <= end);
        assert.ok(hit, `${file}:${s.line} ${s.text.slice(0, 60).replace(/\s+/g, " ")}`);
      }
    });
  }

  it("관리 모듈은 workspace 범위 조건을 손으로 쓰지 않는다", () => {
    for (const file of adminFiles) {
      for (const s of scanFile(`lib/admin/${file}`).strings) {
        assert.doesNotMatch(s.text, /workspace\s*=\s*ANY\s*\(/i, `${file}:${s.line}`);
      }
    }
  });
});
