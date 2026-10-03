/**
 * 마이그레이션 파일 규약 검사 스크립트.
 *
 * 대상: lib/memory/migrations/migration-*.sql
 * MIGRATION_LINT_FROM 이 지정되면 그 번호 미만 파일은 검사에서 제외한다.
 *
 * 온라인 마이그레이션 규칙(CONCURRENTLY 금지, 대형 표 색인 등록과 IF NOT EXISTS)은
 * MIGRATION_LINT_FROM 과 별개로 번호 NEW_RULES_FROM 이상 파일에만 적용한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-05-13
 * 수정일: 2026-10-03
 */

import fs   from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  LARGE_TABLES, IndexManifestError, loadManifest, manifestNames
} from "./ops/index-manifest.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_DIR = path.resolve(__dirname, "../lib/memory/migrations");

/** 파일명에서 3자리 번호를 추출한다. 일치하지 않으면 null을 반환한다. */
function extractNumber(filename) {
  const m = filename.match(/^migration-(\d{3})-/);
  return m ? parseInt(m[1], 10) : null;
}

/** cutoff 번호를 결정한다. MIGRATION_LINT_FROM 환경변수가 없으면 0(전체 검사). */
function resolveCutoff() {
  const envVal = process.env.MIGRATION_LINT_FROM;
  if (envVal !== undefined) {
    const parsed = parseInt(envVal, 10);
    if (!Number.isNaN(parsed)) return parsed;
  }

  return 0;
}

/**
 * 같은 번호를 쓰는 파일이 둘 이상이면 위반으로 본다.
 *
 * cutoff와 무관하게 전체 파일을 본다. 충돌은 두 파일 사이에서 생기고 그중 하나가
 * cutoff 아래에 있을 수 있으므로 대상을 좁히면 놓친다.
 */
function findDuplicateNumbers(files) {
  const byNumber = new Map();

  for (const file of files) {
    const n = extractNumber(file);
    if (n === null) continue;
    const group = byNumber.get(n);
    if (group) group.push(file);
    else byNumber.set(n, [file]);
  }

  const violations = [];

  for (const [number, group] of [...byNumber].sort((a, b) => a[0] - b[0])) {
    if (group.length < 2) continue;
    violations.push({
      file:    group[0],
      line:    null,
      message: `번호 ${String(number).padStart(3, "0")}을 ${group.length}개 파일이 함께 쓴다 `
             + `(${group.join(", ")}). 머지 시점에 +1 하여 재번호할 것.`,
    });
  }

  return violations;
}

/** 온라인 마이그레이션 규칙을 적용하는 첫 번호. */
export const NEW_RULES_FROM = 50;

const GRANDFATHERED_NAMES = new Set(["migration-034-v2.16.0-bundle.sql"]);
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

/**
 * SQL 주석(-- 줄 주석, 블록 주석)을 공백으로 바꾼다. 줄바꿈은 유지하므로 줄 번호가 같다.
 * 작은따옴표 문자열 안의 주석 표지는 문자열의 일부로 둔다.
 *
 * @param {string} sql
 * @returns {string}
 */
export function stripSqlComments(sql) {
  let out   = "";
  let state = "code";

  for (let i = 0; i < sql.length; i++) {
    const ch   = sql[i];
    const pair = sql.slice(i, i + 2);

    if (state === "line") {
      if (ch === "\n") { state = "code"; out += ch; }
      else out += " ";
    } else if (state === "block") {
      if (pair === "*/") { state = "code"; out += "  "; i++; }
      else out += ch === "\n" ? ch : " ";
    } else if (state === "string") {
      if (ch === "'") state = "code";
      out += ch;
    } else if (pair === "--") { state = "line";  out += "  "; i++; }
    else if (pair === "/*")   { state = "block"; out += "  "; i++; }
    else {
      if (ch === "'") state = "string";
      out += ch;
    }
  }

  return out;
}

const IDENT           = String.raw`(?:"[^"]+"|\w+)(?:\.(?:"[^"]+"|\w+))*`;
const INDEX_STATEMENT = new RegExp(
  String.raw`CREATE\s+(UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(IF\s+NOT\s+EXISTS\s+)?(${IDENT})\s+ON\s+(?:ONLY\s+)?(${IDENT})`,
  "gi"
);

/** 따옴표를 벗기고 스키마 접두를 뗀 마지막 식별자를 소문자로 돌려준다. */
function lastIdentifier(text) {
  return text.replace(/"/g, "").split(".").pop().toLowerCase();
}

/**
 * 주석을 지운 SQL 에서 CREATE INDEX 문을 찾는다.
 *
 * @param {string} sql 주석을 지운 SQL
 * @returns {Array<{name: string, table: string, unique: boolean, ifNotExists: boolean, line: number}>}
 */
export function extractIndexStatements(sql) {
  const found = [];

  for (const m of sql.matchAll(INDEX_STATEMENT)) {
    found.push({
      name:        lastIdentifier(m[3]),
      table:       lastIdentifier(m[4]),
      unique:      m[1] !== undefined,
      ifNotExists: m[2] !== undefined,
      line:        sql.slice(0, m.index).split("\n").length,
    });
  }

  return found;
}

/** 기존 줄 단위 규칙 위반. */
function lintLines(filename, content) {
  const violations = [];
  const lines      = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    for (const rule of RULES) {
      if (rule.test(lines[i])) {
        violations.push({ rule: rule.id, file: filename, line: i + 1, message: rule.message });
      }
    }
  }

  return violations;
}

/** 대형 표 색인 문의 등록과 IF NOT EXISTS 위반. */
function lintLargeIndexes(filename, stripped, registered) {
  const violations = [];

  for (const idx of extractIndexStatements(stripped)) {
    if (!LARGE_TABLES.includes(idx.table)) continue;
    if (!registered.has(idx.name)) {
      violations.push({
        rule:    "large-index-unregistered",
        file:    filename,
        line:    idx.line,
        message: `대형 표 ${idx.table} 의 색인 ${idx.name} 이 scripts/ops/index-manifest.json 에 등록되어 있지 않다. `
               + `등록하고 scripts/ops/online-index.mjs 로 먼저 만들 것.`,
      });
    }
    if (!idx.ifNotExists) {
      violations.push({
        rule:    "large-index-if-not-exists",
        file:    filename,
        line:    idx.line,
        message: `대형 표 ${idx.table} 의 색인 ${idx.name} 문에 IF NOT EXISTS 가 없다. `
               + `운영 절차로 먼저 만든 색인과 같은 이름의 IF NOT EXISTS 문만 둘 것.`,
      });
    }
  }

  return violations;
}

/** 주석을 뺀 본문의 CONCURRENTLY 사용 위반. */
function lintConcurrently(filename, stripped) {
  const violations = [];
  const lines      = stripped.split("\n");

  for (let i = 0; i < lines.length; i++) {
    if (!/\bCONCURRENTLY\b/i.test(lines[i])) continue;
    violations.push({
      rule:    "no-concurrently",
      file:    filename,
      line:    i + 1,
      message: "CONCURRENTLY 는 트랜잭션 안에서 실행할 수 없다. migrate.js 가 파일을 트랜잭션으로 감싸므로 "
             + "scripts/ops/online-index.mjs 로 먼저 만들고 파일에는 같은 이름의 IF NOT EXISTS 문만 둘 것.",
    });
  }

  return violations;
}

/**
 * 파일 내용 하나를 검사한다. 파일명 형식은 검사하지 않는다.
 *
 * @param {string}      filename
 * @param {string}      content
 * @param {Set<string>} registeredIndexes 작업 목록에 등록된 색인 이름
 * @returns {Array<{rule: string, file: string, line: number, message: string}>}
 */
export function lintMigrationContent(filename, content, registeredIndexes) {
  const violations = lintLines(filename, content);
  const number     = extractNumber(filename);

  if (number === null || number < NEW_RULES_FROM) return violations;

  const stripped = stripSqlComments(content);
  violations.push(
    ...lintConcurrently(filename, stripped),
    ...lintLargeIndexes(filename, stripped, registeredIndexes)
  );

  return violations;
}

function lintFile(filepath, registeredIndexes) {
  const filename   = path.basename(filepath);
  const violations = [];

  if (!FILENAME_PATTERN.test(filename) && !GRANDFATHERED_NAMES.has(filename)) {
    violations.push({
      file:    filename,
      line:    null,
      message: `파일명이 migration-NNN-<kebab-slug>.sql 형식을 따르지 않는다.`,
    });
  }

  const content = fs.readFileSync(filepath, "utf-8");
  violations.push(...lintMigrationContent(filename, content, registeredIndexes));

  return violations;
}

/** 작업 목록을 읽어 등록된 색인 이름을 돌려준다. 형식 위반이면 메시지를 내고 종료한다. */
function loadRegisteredIndexes() {
  try {
    return manifestNames(loadManifest());
  } catch (err) {
    if (!(err instanceof IndexManifestError)) throw err;
    process.stderr.write(`FAIL  scripts/ops/index-manifest.json  ${err.message}\n`);
    process.exit(1);
  }
}

function main() {
  const allFiles = fs
    .readdirSync(MIGRATION_DIR)
    .filter(f => f.startsWith("migration-") && f.endsWith(".sql"))
    .sort();

  const cutoff = resolveCutoff();

  const targets = allFiles.filter(f => {
    const n = extractNumber(f);
    return n === null || n >= cutoff;
  });

  const allViolations = findDuplicateNumbers(allFiles);
  const registered    = loadRegisteredIndexes();

  for (const filename of targets) {
    const filepath    = path.join(MIGRATION_DIR, filename);
    const violations  = lintFile(filepath, registered);
    allViolations.push(...violations);
  }

  if (allViolations.length === 0) {
    process.stdout.write(
      targets.length === 0
        ? `OK: cutoff=${cutoff} — 검사 대상 파일 없음 (기존 파일 모두 면제), 번호 중복 없음\n`
        : `OK: ${targets.length}개 파일 검사 완료, 규약 위반 없음\n`
    );
    process.exit(0);
  }

  for (const v of allViolations) {
    const loc = v.line !== null ? `:${v.line}` : "";
    process.stderr.write(`FAIL  ${v.file}${loc}  ${v.message}\n`);
  }

  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
