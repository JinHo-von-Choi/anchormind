/**
 * 마이그레이션 lint 규칙 시험 (온라인 마이그레이션 규칙)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */
import { describe, it } from "node:test";
import assert           from "node:assert/strict";
import fs               from "node:fs";
import path             from "node:path";
import { execFileSync } from "node:child_process";
import {
  NEW_RULES_FROM,
  stripSqlComments,
  extractIndexStatements,
  lintMigrationContent
} from "../../scripts/lint-migrations.js";
import { loadManifest, manifestTables, LARGE_TABLES } from "../../scripts/ops/index-manifest.mjs";

const ROOT          = path.resolve(import.meta.dirname, "../..");
const MIGRATION_DIR = path.join(ROOT, "lib/memory/migrations");
const KNOWN         = new Map([["idx_known_fragments", "fragments"], ["idx_known_links", "fragment_links"]]);

function ruleIds(filename, sql, names = KNOWN) {
  return lintMigrationContent(filename, sql, names).map(v => v.rule);
}

describe("CONCURRENTLY 금지", () => {
  const cases = [
    ["CREATE INDEX CONCURRENTLY",       "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_small ON agent_memory.api_keys (id);"],
    ["CREATE UNIQUE INDEX CONCURRENTLY","CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_small ON agent_memory.api_keys (id);"],
    ["DROP INDEX CONCURRENTLY",         "DROP INDEX CONCURRENTLY IF EXISTS agent_memory.idx_old;"],
    ["REINDEX CONCURRENTLY",            "REINDEX INDEX CONCURRENTLY agent_memory.idx_old;"],
    ["소문자",                           "create index concurrently if not exists idx_small on agent_memory.api_keys (id);"],
    ["여러 줄",                          "CREATE INDEX\n  CONCURRENTLY IF NOT EXISTS idx_small\n  ON agent_memory.api_keys (id);"]
  ];
  for (const [name, sql] of cases) {
    it(`${name}를 위반으로 본다`, () => {
      assert.ok(ruleIds("migration-050-x.sql", sql).includes("no-concurrently"));
    });
  }

  it("주석에 적힌 단어는 위반이 아니다", () => {
    const sql = "-- CREATE INDEX CONCURRENTLY 는 운영 절차에서 만든다\n/* DROP INDEX CONCURRENTLY */\nALTER TABLE agent_memory.api_keys ADD COLUMN IF NOT EXISTS note text;";
    assert.deepEqual(ruleIds("migration-050-x.sql", sql), []);
  });

  it("위반 줄 번호를 알려 준다", () => {
    const sql = "SELECT 1;\n\nDROP INDEX CONCURRENTLY IF EXISTS agent_memory.idx_old;";
    const [v] = lintMigrationContent("migration-050-x.sql", sql, KNOWN);
    assert.equal(v.line, 3);
  });
});

describe("대형 표 색인 등록과 IF NOT EXISTS", () => {
  const cases = [
    ["등록된 fragments 색인",              "CREATE INDEX IF NOT EXISTS idx_known_fragments ON agent_memory.fragments (workspace);", []],
    ["등록된 UNIQUE 색인",                 "CREATE UNIQUE INDEX IF NOT EXISTS idx_known_fragments ON agent_memory.fragments (content_hash);", []],
    ["등록되지 않은 fragments 색인",       "CREATE INDEX IF NOT EXISTS idx_new_one ON agent_memory.fragments (workspace);", ["large-index-unregistered"]],
    ["등록되지 않은 fragment_links 색인",  "CREATE INDEX IF NOT EXISTS idx_new_two ON agent_memory.fragment_links (weight);", ["large-index-unregistered"]],
    ["등록되지 않은 case_events 색인",     "CREATE INDEX IF NOT EXISTS idx_new_three ON agent_memory.case_events (case_id);", ["large-index-unregistered"]],
    ["등록되지 않은 search_events 색인",   "CREATE INDEX IF NOT EXISTS idx_new_four ON agent_memory.search_events (created_at);", ["large-index-unregistered"]],
    ["스키마 없는 표 이름",                "CREATE INDEX IF NOT EXISTS idx_new_five ON fragments (workspace);", ["large-index-unregistered"]],
    ["따옴표 식별자",                      'CREATE INDEX IF NOT EXISTS "idx_new_six" ON "agent_memory"."fragments" (workspace);', ["large-index-unregistered"]],
    ["ON ONLY",                            "CREATE INDEX IF NOT EXISTS idx_new_seven ON ONLY agent_memory.fragments (workspace);", ["large-index-unregistered"]],
    ["여러 줄 문장",                       "CREATE INDEX IF NOT EXISTS\n  idx_new_eight\n  ON agent_memory.fragments\n  USING gin (keywords);", ["large-index-unregistered"]],
    ["소문자 문장",                        "create index if not exists idx_new_nine on agent_memory.fragments (workspace);", ["large-index-unregistered"]],
    ["이름 없는 fragments 색인",           "CREATE INDEX ON agent_memory.fragments (workspace);", ["large-index-unregistered", "large-index-if-not-exists"]],
    ["이름 없는 UNIQUE 색인, 스키마 없음", "CREATE UNIQUE INDEX ON fragments (content_hash);", ["large-index-unregistered", "large-index-if-not-exists"]],
    ["이름 없는 색인, 따옴표 식별자",      'CREATE INDEX ON "agent_memory"."fragment_links" (weight);', ["large-index-unregistered", "large-index-if-not-exists"]],
    ["이름 없는 색인, ON ONLY",            "CREATE INDEX ON ONLY agent_memory.fragments (workspace);", ["large-index-unregistered", "large-index-if-not-exists"]],
    ["이름 없는 색인, IF NOT EXISTS",      "CREATE INDEX IF NOT EXISTS ON agent_memory.case_events (case_id);", ["large-index-unregistered"]],
    ["이름 없는 색인, 여러 줄",            "CREATE UNIQUE INDEX\n  ON agent_memory.search_events\n  (created_at);", ["large-index-unregistered", "large-index-if-not-exists"]],
    ["이름 없는 작은 표 색인은 대상이 아니다", "CREATE INDEX ON agent_memory.api_keys (id);", []],
    ["등록된 이름을 다른 대형 표에 씀",    "CREATE INDEX IF NOT EXISTS idx_known_fragments ON agent_memory.fragment_links (weight);", ["large-index-table-mismatch"]],
    ["등록된 이름을 다른 대형 표에 씀, 스키마 없음", "CREATE INDEX IF NOT EXISTS idx_known_links ON fragments (workspace);", ["large-index-table-mismatch"]],
    ["등록된 이름을 작은 표에 쓰면 대상이 아니다", "CREATE INDEX IF NOT EXISTS idx_known_links ON agent_memory.api_keys (id);", []],
    ["IF NOT EXISTS 누락, 등록됨",         "CREATE INDEX idx_known_links ON agent_memory.fragment_links (weight);", ["large-index-if-not-exists"]],
    ["IF NOT EXISTS 누락, 미등록",         "CREATE INDEX idx_new_ten ON agent_memory.fragments (workspace);", ["large-index-unregistered", "large-index-if-not-exists"]],
    ["작은 표 색인은 대상이 아니다",       "CREATE INDEX idx_small ON agent_memory.api_keys (id);", []],
    ["스키마 접두 표와 이름이 다른 표",    "CREATE INDEX IF NOT EXISTS idx_x ON agent_memory.fragment_versions (fragment_id);", []],
    ["DROP INDEX는 등록 대상이 아니다",    "DROP INDEX IF EXISTS agent_memory.idx_known_fragments;", []]
  ];
  for (const [name, sql, expected] of cases) {
    it(`${name}`, () => {
      assert.deepEqual(ruleIds("migration-050-x.sql", sql), expected);
    });
  }

  it("본문 맨 위의 SET LOCAL lock_timeout 은 위반이 아니다", () => {
    const sql = "SET LOCAL lock_timeout = '3s';\nALTER TABLE agent_memory.fragments ADD COLUMN IF NOT EXISTS example_col integer;\nALTER TABLE agent_memory.fragments ADD CONSTRAINT chk_example CHECK (example_col >= 0) NOT VALID;";
    assert.deepEqual(ruleIds("migration-050-x.sql", sql), []);
  });

  it("대형 표 목록은 네 표다", () => {
    assert.deepEqual([...LARGE_TABLES], ["fragments", "fragment_links", "case_events", "search_events"]);
  });
});

describe("적용 번호", () => {
  const sql = "CREATE INDEX CONCURRENTLY idx_new_one ON agent_memory.fragments (workspace);";

  it("새 규칙은 번호 050부터 적용한다", () => {
    assert.equal(NEW_RULES_FROM, 50);
    assert.deepEqual(ruleIds("migration-049-x.sql", sql), []);
    assert.deepEqual(ruleIds("migration-050-x.sql", sql).sort(),
      ["large-index-if-not-exists", "large-index-unregistered", "no-concurrently"]);
    assert.ok(ruleIds("migration-120-x.sql", sql).includes("no-concurrently"));
  });

  it("번호가 없는 파일명에는 새 규칙을 적용하지 않는다", () => {
    assert.deepEqual(ruleIds("notes.sql", sql), []);
  });

  it("기존 규칙은 번호와 무관하게 동작한다", () => {
    const ids = ruleIds("migration-010-x.sql", "BEGIN;\nSELECT 1;\nCOMMIT;");
    assert.deepEqual(ids, ["no-begin", "no-commit"]);
  });
});

describe("extractIndexStatements 이름 없는 문", () => {
  it("이름이 없으면 name 이 null 이고 표를 읽는다", () => {
    const found = extractIndexStatements("CREATE INDEX ON ONLY agent_memory.fragments (x);\nCREATE INDEX ON only_t (y);");
    assert.deepEqual(found.map(f => [f.name, f.table]), [[null, "fragments"], [null, "only_t"]]);
  });
});

describe("stripSqlComments", () => {
  it("줄 수를 유지하며 주석만 지운다", () => {
    const out = stripSqlComments("a -- x\nb /* y\nz */ c\n'--keep' d");
    assert.equal(out.split("\n").length, 4);
    assert.ok(!out.includes("x") && !out.includes("y"));
    assert.ok(out.includes("'--keep'"));
  });
});

describe("extractIndexStatements", () => {
  it("색인 이름, 표, UNIQUE, IF NOT EXISTS, 줄 번호를 읽는다", () => {
    const [a, b] = extractIndexStatements("SELECT 1;\nCREATE UNIQUE INDEX IF NOT EXISTS idx_a\n  ON agent_memory.fragments (x);\nCREATE INDEX idx_b ON case_events (y);");
    assert.deepEqual(a, { name: "idx_a", table: "fragments",   unique: true,  ifNotExists: true,  line: 2 });
    assert.deepEqual(b, { name: "idx_b", table: "case_events", unique: false, ifNotExists: false, line: 4 });
  });
});

describe("작업 목록과 현재 마이그레이션", () => {
  it("050 미만 마이그레이션이 만든 대형 표 색인은 모두 등록되어 있다", () => {
    const names = manifestTables(loadManifest());
    const missing = [];
    for (const file of fs.readdirSync(MIGRATION_DIR).filter(f => /^migration-\d{3}-/.test(f))) {
      const content = stripSqlComments(fs.readFileSync(path.join(MIGRATION_DIR, file), "utf8"));
      for (const idx of extractIndexStatements(content)) {
        if (LARGE_TABLES.includes(idx.table) && !names.has(idx.name)) missing.push(`${file}:${idx.name}`);
      }
    }
    assert.deepEqual(missing, []);
  });

  it("lint 스크립트는 현재 트리에서 통과한다", () => {
    const out = execFileSync(process.execPath, [path.join(ROOT, "scripts/lint-migrations.js")], {
      cwd: ROOT, env: { PATH: process.env.PATH }, encoding: "utf8"
    });
    assert.match(out, /^OK/);
  });
});

describe("온라인 마이그레이션 문서", () => {
  const docPath = path.join(ROOT, "docs/operations/online-migration.md");
  const doc     = fs.readFileSync(docPath, "utf8");

  it("본문이 가리키는 저장소 경로가 모두 존재한다", () => {
    const refs = [...doc.matchAll(/`((?:scripts|lib|tests|docs)\/[A-Za-z0-9_./-]+)`/g)].map(m => m[1]);
    assert.ok(refs.length > 0);
    const missing = refs.filter(ref => !fs.existsSync(path.join(ROOT, ref)));
    assert.deepEqual(missing, []);
  });

  it("마이그레이션 규약 문서가 이 문서를 연결한다", () => {
    const conventions = fs.readFileSync(path.join(ROOT, "docs/migration-conventions.md"), "utf8");
    assert.match(conventions, /\]\(operations\/online-migration\.md\)/);
  });

  it("백필 표 두 개의 이름을 문서가 모두 다룬다", () => {
    assert.ok(doc.includes("agent_memory.backfill_watermarks"));
    assert.ok(doc.includes("agent_memory.backfill_failures"));
  });
});
