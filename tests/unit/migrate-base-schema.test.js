/**
 * 빈 DB 설치 경로 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-08-29
 *
 * migration-001의 첫 구문이 `ALTER TABLE agent_memory.fragments`라, 기반 스키마가
 * 없는 DB에서 마이그레이션만 돌리면 즉시 실패한다. 문서대로 따라 한 신규
 * 사용자가 첫 명령에서 막히던 지점이다.
 *
 * 러너가 기반 스키마 부재를 스스로 감지해 선적용하는지 고정한다.
 */

import { test, describe } from "node:test";
import assert             from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath }  from "node:url";
import path               from "node:path";

const HERE    = path.dirname(fileURLToPath(import.meta.url));
const ROOT    = path.resolve(HERE, "..", "..");
const RUNNER  = readFileSync(path.join(ROOT, "scripts", "migrate.js"), "utf8");
const SCHEMA  = path.join(ROOT, "lib", "memory", "memory-schema.sql");
const FIRST   = path.join(ROOT, "lib", "memory", "migrations", "migration-001-temporal-schema.sql");

describe("빈 DB 설치", () => {
  test("기반 스키마 파일이 배포물에 있다", () => {
    assert.ok(existsSync(SCHEMA), "memory-schema.sql이 없다");
  });

  test("기반 스키마는 여러 번 적용해도 안전하다", () => {
    const sql = readFileSync(SCHEMA, "utf8");
    assert.match(sql, /CREATE SCHEMA IF NOT EXISTS/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS agent_memory\.fragments/);
  });

  test("첫 마이그레이션은 여전히 기반 스키마를 전제한다", () => {
    /** 이 전제가 사라지면 선적용 단계도 불필요해진다. 함께 확인한다. */
    if (!existsSync(FIRST)) return;
    assert.match(readFileSync(FIRST, "utf8"), /ALTER TABLE agent_memory\.fragments/);
  });

  test("러너가 기반 스키마 부재를 감지한다", () => {
    assert.match(RUNNER, /to_regclass\(\$1\)/);
    assert.match(RUNNER, /agent_memory\.fragments/);
  });

  test("러너가 기반 스키마를 선적용한다", () => {
    assert.match(RUNNER, /applyBaseSchemaIfMissing/);
    assert.match(RUNNER, /memory-schema\.sql/);
  });

  test("선적용이 마이그레이션 이력 표 생성보다 먼저다", () => {
    const apply = RUNNER.indexOf("await applyBaseSchemaIfMissing(client)");
    const table = RUNNER.indexOf("CREATE TABLE IF NOT EXISTS agent_memory.schema_migrations");
    assert.ok(apply >= 0 && table >= 0);
    assert.ok(apply < table, "이력 표를 먼저 만들면 스키마가 없어 실패한다");
  });

  test("선적용은 트랜잭션으로 감싼다", () => {
    const fn = RUNNER.slice(RUNNER.indexOf("async function applyBaseSchemaIfMissing"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    assert.match(body, /BEGIN/);
    assert.match(body, /ROLLBACK/);
  });
});
