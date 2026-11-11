import fs   from "node:fs";
import path from "node:path";
import { SCHEMA } from "../schema.js";

const MIGRATION_FILE_RE     = /^migration-\d{3}-.*\.sql$/;
const DEFAULT_MIGRATION_DIR = path.join(import.meta.dirname, "..", "migrations");
const MIGRATIONS_TABLE      = `${SCHEMA}.schema_migrations`;

/** 번호 순으로 정렬된 migration 파일명 목록. 디렉터리가 없으면 빈 배열. */
export function listMigrationFiles(migrationDir = DEFAULT_MIGRATION_DIR) {
  if (!fs.existsSync(migrationDir)) return [];
  return fs.readdirSync(migrationDir)
    .filter(name => MIGRATION_FILE_RE.test(name))
    .sort();
}

/**
 * schema_migrations에 기록되지 않은 migration 파일명을 반환한다.
 * schema_migrations 테이블 자체가 없으면 전체 파일이 미적용이다.
 */
export async function findPendingMigrations(pool, migrationDir = DEFAULT_MIGRATION_DIR) {
  const files = listMigrationFiles(migrationDir);
  if (!pool || files.length === 0) return [];

  const { rows } = await pool.query("SELECT to_regclass($1) AS t", [MIGRATIONS_TABLE]);
  if (!rows[0]?.t) return files;

  const applied = new Set(
    (await pool.query(`SELECT filename FROM ${MIGRATIONS_TABLE}`)).rows.map(row => row.filename)
  );
  return files.filter(name => !applied.has(name));
}

/**
 * 기동 시 미적용 migration을 error 로그로 드러낸다.
 * 검사 자체가 실패해도 기동은 막지 않으며 null을 반환한다.
 */
export async function warnPendingMigrations(pool, { migrationDir = DEFAULT_MIGRATION_DIR, error = console.error } = {}) {
  let pending;
  try {
    pending = await findPendingMigrations(pool, migrationDir);
  } catch (err) {
    error("[Startup] 미적용 migration 검사 실패", { error: err?.message });
    return null;
  }
  if (pending.length > 0) {
    error(
      `[Startup] 미적용 migration ${pending.length}건: ${pending.join(", ")}. ` +
      "이 컬럼을 전제하는 쓰기 경로가 실패하므로 npm run migrate 를 실행하십시오.",
      { pending }
    );
  }
  return pending;
}
