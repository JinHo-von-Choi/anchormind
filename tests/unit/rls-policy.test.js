/**
 * 행 수준 보안 정책 계약 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-08-29
 *
 * 운영 데이터베이스의 fragments에 RLS가 켜져 있지 않았다. memory-schema.sql에는
 * 선언돼 있었으나 마이그레이션 누적으로 자라난 DB에는 적용된 적이 없었고, 어떤
 * 마이그레이션도 이 표의 RLS를 다루지 않았기 때문이다. 그 결과 키 간 격리가
 * 애플리케이션 질의 필터 한 겹에만 의존했다.
 *
 * 이 시험은 정책이 두 축을 모두 보는지, 그리고 키 범위를 지정하지 않는 기존
 * 호출부의 동작이 유지되는지를 마이그레이션 본문 기준으로 고정한다.
 */

import { test, describe } from "node:test";
import assert             from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath }  from "node:url";
import path               from "node:path";

const HERE      = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(HERE, "..", "..");
const MIGRATION = path.join(ROOT, "lib", "memory", "migrations", "migration-045-fragment-rls.sql");
const DB_HELPER = readFileSync(path.join(ROOT, "lib", "tools", "db.js"), "utf8");

describe("RLS 마이그레이션", () => {
  const sql = existsSync(MIGRATION) ? readFileSync(MIGRATION, "utf8") : "";

  test("마이그레이션 파일이 존재한다", () => {
    assert.ok(sql.length > 0, "migration-045-fragment-rls.sql이 없다");
  });

  test("fragments와 fragment_links에 RLS를 켠다", () => {
    assert.match(sql, /ALTER TABLE agent_memory\.fragments ENABLE ROW LEVEL SECURITY/);
    assert.match(sql, /ALTER TABLE agent_memory\.fragment_links ENABLE ROW LEVEL SECURITY/);
  });

  test("정책이 agent_id와 key_id 두 축을 본다", () => {
    const policy = sql.slice(sql.indexOf("CREATE POLICY fragment_isolation_policy"));
    assert.match(policy, /app\.current_agent_id/);
    assert.match(policy, /app\.current_key_id/);
  });

  test("키 범위 미지정은 종전 동작을 유지한다", () => {
    /** 빈 값을 "키 범위 없음"으로 읽어야 기존 호출부가 깨지지 않는다. */
    assert.match(sql, /COALESCE\(current_setting\('app\.current_key_id', true\), ''\) = ''/);
  });

  test("쓰기 경로에도 같은 조건을 건다", () => {
    assert.match(sql, /WITH CHECK/);
  });

  test("FORCE는 이 단계에서 적용하지 않는다", () => {
    /**
     * 애플리케이션 계정이 표 소유자인 동안 FORCE를 켜면 정책이 즉시 전 질의에
     * 적용된다. 정책 검증과 역할 분리를 마친 뒤 별도 마이그레이션에서 한다.
     */
    /** 주석에는 언급할 수 있다. 실제 DDL 구문만 본다. */
    const ddl = sql.split("\n").filter(l => !l.trim().startsWith("--")).join("\n");
    assert.doesNotMatch(ddl, /ALTER TABLE[^;]*FORCE ROW LEVEL SECURITY/);
  });

  test("되돌리기 절차를 본문에 남긴다", () => {
    assert.match(sql, /DISABLE ROW LEVEL SECURITY/);
    /** 되돌리기는 주석으로만 남기고 실행하지 않는다. */
    const ddl2 = sql.split("\n").filter(l => !l.trim().startsWith("--")).join("\n");
    assert.doesNotMatch(ddl2, /ALTER TABLE[^;]*DISABLE ROW LEVEL SECURITY/);
  });
});

describe("키 세션 변수 배관", () => {
  test("질의 헬퍼가 키 범위를 세션에 알린다", () => {
    assert.match(DB_HELPER, /SET LOCAL app\.current_key_id/);
  });

  test("키 값을 정제해 주입한다", () => {
    const block = DB_HELPER.slice(DB_HELPER.indexOf("const rawKeyId"));
    assert.match(block.slice(0, 400), /replace\(\/\[\^a-zA-Z0-9_-\]\/g, ""\)/);
  });

  test("키를 주지 않으면 빈 값으로 둔다", () => {
    const block = DB_HELPER.slice(DB_HELPER.indexOf("const safeKeyId"));
    assert.match(block.slice(0, 200), /rawKeyId == null \? "" :/);
  });

  test("문자열 opts를 넘기는 기존 호출부에서도 안전하다", () => {
    const block = DB_HELPER.slice(DB_HELPER.indexOf("const rawKeyId"));
    assert.match(block.slice(0, 200), /typeof opts === "object" && opts !== null/);
  });
});
