/**
 * 마이그레이션 파일 규약 검사 스크립트.
 *
 * 대상: lib/memory/migrations/migration-*.sql
 * cutoff 미만(기존) 파일은 검사에서 제외한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-05-13
 */

import fs   from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_DIR = path.resolve(__dirname, "../lib/memory/migrations");

/** 파일명에서 3자리 번호를 추출한다. 일치하지 않으면 null을 반환한다. */
function extractNumber(filename) {
  const m = filename.match(/^migration-(\d{3})-/);
  return m ? parseInt(m[1], 10) : null;
}

/** cutoff 번호를 결정한다. MIGRATION_LINT_FROM 환경변수가 없으면 현존 파일 최대값 + 1. */
function resolveCutoff(files) {
  const envVal = process.env.MIGRATION_LINT_FROM;
  if (envVal !== undefined) {
    const parsed = parseInt(envVal, 10);
    if (!Number.isNaN(parsed)) return parsed;
  }

  const numbers = files
    .map(f => extractNumber(f))
    .filter(n => n !== null);

  return numbers.length > 0 ? Math.max(...numbers) + 1 : 0;
}

const FILENAME_PATTERN = /^migration-\d{3}-[a-z0-9]+(?:-[a-z0-9]+)*\.sql$/;

const RULES = [
  {
    id:      "no-begin",
    message: "본문에 BEGIN 구문이 존재한다. migrate.js가 외부 트랜잭션을 관리하므로 제거할 것.",
    test:    line => /^\s*BEGIN\s*;?\s*$/i.test(line),
  },
  {
    id:      "no-commit",
    message: "본문에 COMMIT 구문이 존재한다. migrate.js가 외부 트랜잭션을 관리하므로 제거할 것.",
    test:    line => /^\s*COMMIT\s*;?\s*$/i.test(line),
  },
  {
    id:      "no-schema-migrations-insert",
    message: "INSERT INTO agent_memory.schema_migrations 가 존재한다. migrate.js가 자동 처리하므로 제거할 것.",
    test:    line => /INSERT\s+INTO\s+agent_memory\.schema_migrations/i.test(line),
  },
];

function lintFile(filepath) {
  const filename  = path.basename(filepath);
  const violations = [];

  if (!FILENAME_PATTERN.test(filename)) {
    violations.push({
      file:    filename,
      line:    null,
      message: `파일명이 migration-NNN-<kebab-slug>.sql 형식을 따르지 않는다.`,
    });
  }

  const content = fs.readFileSync(filepath, "utf-8");
  const lines   = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    for (const rule of RULES) {
      if (rule.test(lines[i])) {
        violations.push({
          file:    filename,
          line:    i + 1,
          message: rule.message,
        });
      }
    }
  }

  return violations;
}

function main() {
  const allFiles = fs
    .readdirSync(MIGRATION_DIR)
    .filter(f => f.startsWith("migration-") && f.endsWith(".sql"))
    .sort();

  const cutoff = resolveCutoff(allFiles);

  const targets = allFiles.filter(f => {
    const n = extractNumber(f);
    return n !== null && n >= cutoff;
  });

  if (targets.length === 0) {
    process.stdout.write(
      `OK: cutoff=${cutoff} — 검사 대상 파일 없음 (기존 파일 모두 면제)\n`
    );
    process.exit(0);
  }

  const allViolations = [];

  for (const filename of targets) {
    const filepath    = path.join(MIGRATION_DIR, filename);
    const violations  = lintFile(filepath);
    allViolations.push(...violations);
  }

  if (allViolations.length === 0) {
    process.stdout.write(`OK: ${targets.length}개 파일 검사 완료, 규약 위반 없음\n`);
    process.exit(0);
  }

  for (const v of allViolations) {
    const loc = v.line !== null ? `:${v.line}` : "";
    process.stderr.write(`FAIL  ${v.file}${loc}  ${v.message}\n`);
  }

  process.exit(1);
}

main();
