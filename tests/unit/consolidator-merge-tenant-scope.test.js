/**
 * _mergeDuplicates 테넌트/워크스페이스 격리 회귀 가드
 *
 * 작성자: 최진호
 * 작성일: 2026-05-13
 *
 * migration-031 이후 content_hash UNIQUE 범위는 (key_id, content_hash) per-key다.
 * 그룹 키를 content_hash 단독으로 잡으면 cross-tenant 병합으로 데이터가 유실된다.
 * 본 테스트는 _mergeDuplicates 소스가 (key_id, workspace, content_hash) 기준으로
 * 그룹화하고, scope 어설션과 key_id 조건부 UPDATE/DELETE를 사용하는지 정적으로 검증한다.
 */

import { describe, it } from "node:test";
import assert            from "node:assert/strict";
import { readFileSync }  from "node:fs";
import { fileURLToPath } from "node:url";
import path              from "node:path";

const here     = path.dirname(fileURLToPath(import.meta.url));
const source   = readFileSync(
  path.resolve(here, "../../lib/memory/consolidate/MemoryConsolidator.js"),
  "utf-8"
);

/** _mergeDuplicates 메서드 본문 추출 */
function extractMergeDuplicates(text) {
  const start = text.indexOf("async _mergeDuplicates");
  assert.ok(start >= 0, "_mergeDuplicates 메서드를 찾을 수 없다");
  const sub = text.slice(start);
  const next = sub.search(/\n {2}async _[A-Za-z]/);
  return next > 0 ? sub.slice(0, next) : sub;
}

describe("_mergeDuplicates — tenant/workspace scope 회귀 가드", () => {

  const body = extractMergeDuplicates(source);

  it("GROUP BY를 (key_id, workspace, content_hash)로 한정한다", () => {
    assert.match(
      body,
      /GROUP\s+BY\s+key_id\s*,\s*workspace\s*,\s*content_hash/i,
      "GROUP BY가 (key_id, workspace, content_hash)로 한정되어야 한다"
    );
  });

  it("master key(key_id IS NULL)는 자동 병합 대상에서 제외한다", () => {
    assert.match(
      body,
      /WHERE\s+key_id\s+IS\s+NOT\s+NULL/i,
      "WHERE key_id IS NOT NULL 절이 있어야 한다"
    );
  });

  it("그룹 동질성 어설션이 존재한다", () => {
    assert.match(
      body,
      /scope[_\s]*mismatch/i,
      "scope mismatch 어설션/로그가 존재해야 한다"
    );
  });

  it("linked_to UPDATE에 key_id 조건이 포함된다", () => {
    const updates = body.match(/UPDATE[\s\S]*?WHERE[\s\S]*?(?=`)/g) || [];
    /** 남은 linked_to 갱신은 다른 파편이 선언한 링크 대상의 교체 하나다 */
    assert.ok(updates.length >= 1, "linked_to 교체 UPDATE가 있어야 한다");
    for (const upd of updates) {
      assert.match(
        upd,
        /key_id\s*=\s*\$/i,
        `UPDATE에 key_id 조건이 있어야 한다: ${upd.slice(0, 80)}…`
      );
    }
  });

  it("중복은 지우지 않고 그룹 동질성 확인 뒤에 닫으며 변경 기록을 남긴다", () => {
    assert.doesNotMatch(body, /store\.delete\s*\(/, "중복 병합은 파편을 지우지 않는다");
    const check = body.search(/scope[_\s]*mismatch/i);
    const close = body.indexOf("closeWithLogSql(");
    assert.ok(check >= 0 && close > check, "닫기는 그룹 동질성 확인 뒤에 한다");
    assert.match(body, /\[\[rid\], currentCycleId\(\), "merge_duplicates", \[keepId\]\]/, "닫은 파편과 승계자를 기록한다");
    assert.match(body, /WHERE\s+key_id\s+IS\s+NOT\s+NULL\s+AND\s+valid_to\s+IS\s+NULL/i, "열린 중복만 고른다");
  });

  it("기존 cross-tenant 병합 SQL이 잔존하지 않는다", () => {
    /** GROUP BY 다음에 즉시 content_hash만 오는 형태가 없어야 한다 */
    const naive = /GROUP\s+BY\s+content_hash\s*\n\s*HAVING/i;
    assert.doesNotMatch(body, naive, "GROUP BY content_hash 단독 패턴은 제거되어야 한다");
  });

});
