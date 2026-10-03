/**
 * 본문 어휘 채널 스키마 구조 검사
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * content_tokens 열은 마이그레이션이 열만 더하고, 검색용 GIN 색인은 운영 색인 절차
 * (scripts/ops/online-index.mjs)가 만든다. 다음을 본다.
 *   1. 마이그레이션 053은 nullable tsvector 열 하나만 더하고 색인 문장이 없다.
 *   2. 마이그레이션 lint 규칙을 통과한다.
 *   3. 작업 목록에 content_tokens의 GIN 색인이 작업 항목으로 등록되어 있다.
 *   4. 어느 마이그레이션 파일도 content_tokens 색인을 만들지 않는다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";
import fs               from "node:fs";
import path             from "node:path";

import { stripSqlComments, extractIndexStatements, lintMigrationContent } from "../../scripts/lint-migrations.js";
import { loadManifest, manifestNames }                                      from "../../scripts/ops/index-manifest.mjs";

const ROOT          = path.resolve(import.meta.dirname, "../..");
const MIGRATION_DIR = path.join(ROOT, "lib/memory/migrations");
const FILE          = "migration-053-content-tokens.sql";

function readMigration(name) {
  return fs.readFileSync(path.join(MIGRATION_DIR, name), "utf8");
}

function lexicalIndexEntries() {
  return loadManifest().indexes.filter(entry => /\bcontent_tokens\b/.test(entry.definition ?? ""));
}

describe("마이그레이션 053", () => {
  const body = stripSqlComments(readMigration(FILE));

  it("content_tokens 열을 기본값 없는 nullable tsvector로 더한다", () => {
    assert.match(body, /ALTER\s+TABLE\s+agent_memory\.fragments\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+content_tokens\s+tsvector\s*;/i);
    assert.doesNotMatch(body, /\bDEFAULT\b/i);
    assert.doesNotMatch(body, /\bNOT\s+NULL\b/i);
  });

  it("색인 문장이 없다", () => {
    assert.deepEqual(extractIndexStatements(body), []);
    assert.doesNotMatch(body, /\bCREATE\s+(UNIQUE\s+)?INDEX\b/i);
    assert.doesNotMatch(body, /\bCONCURRENTLY\b/i);
  });

  it("잠금 대기를 제한한다", () => {
    assert.match(body, /SET\s+LOCAL\s+lock_timeout\s*=/i);
    assert.match(readMigration(FILE), /SET\s+LOCAL\s+lock_timeout\s*=\s*'3s'\s*;/i);
  });

  it("마이그레이션 lint 규칙을 통과한다", () => {
    assert.deepEqual(lintMigrationContent(FILE, readMigration(FILE), manifestNames(loadManifest())), []);
  });
});

describe("content_tokens 색인 작업 목록", () => {
  it("GIN 작업 항목 하나가 fragments 표에 등록되어 있다", () => {
    const entries = lexicalIndexEntries();
    assert.equal(entries.length, 1);
    const [entry] = entries;
    assert.equal(entry.table, "fragments");
    assert.notEqual(entry.baseline, true);
    assert.notEqual(entry.unique, true);
    assert.match(entry.definition, /^ON\s+agent_memory\.fragments\s+USING\s+gin\s*\(\s*content_tokens\s*\)$/i);
  });

  it("어느 마이그레이션 파일도 content_tokens 색인을 만들지 않는다", () => {
    const [entry] = lexicalIndexEntries();
    const files   = fs.readdirSync(MIGRATION_DIR).filter(name => /^migration-\d{3}-.*\.sql$/.test(name));
    for (const name of files) {
      const body = stripSqlComments(readMigration(name));
      assert.deepEqual(extractIndexStatements(body).filter(s => s.name === entry.name), [], name);
      assert.doesNotMatch(body, /CREATE\s+(UNIQUE\s+)?INDEX[^;]*\bcontent_tokens\b/i, name);
    }
  });
});
