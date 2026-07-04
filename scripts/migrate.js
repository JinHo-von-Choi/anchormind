#!/usr/bin/env node
/**
 * migrate.js — 경량 DB 마이그레이션 러너
 *
 * 작성자: 최진호
 * 수정일: 2026-04-20 (v2.12.0 문서 현행화 반영)
 *
 * 목적: lib/memory/migration-NNN-*.sql 파일을 번호 순으로 자동 탐지하여 실행한다.
 *       agent_memory.schema_migrations 테이블에 적용 이력을 기록하며 미적용 파일만 순서대로 실행한다.
 * 호출 조건: 서버 업그레이드 또는 신규 설치 후 DB 스키마 적용 시
 * 빈도: 버전 업그레이드 시 1회
 * 의존: DATABASE_URL 환경변수 (또는 POSTGRES_* 개별 항목), PostgreSQL, pgvector
 * 관련 문서: docs/INSTALL.md#업그레이드-기존-설치, docs/operations/maintenance.md
 *
 * 트랜잭션 제약:
 *   각 migration 파일은 BEGIN/COMMIT 래퍼로 감싸 원자적으로 실행된다.
 *   따라서 migration-034-v2.16.0-bundle처럼 CREATE UNIQUE INDEX를 포함하는 파일은 트랜잭션 내에서 실행되며,
 *   CREATE INDEX CONCURRENTLY는 사용할 수 없다.
 *   수백만 건 이상의 대규모 테이블에서 잠금 최소화가 필요하다면,
 *   npm run migrate 실행 전에 해당 인덱스를 CONCURRENTLY 옵션으로 수동 실행한다.
 *   IF NOT EXISTS 가드로 인해 수동 적용 후 자동 실행 시 SKIP된다.
 *   상세 가이드: docs/INSTALL.md "migration-034-v2.16.0-bundle CONCURRENTLY 옵션" 섹션 참조.
 */
import fs   from "node:fs";
import path from "node:path";
import pg   from "pg";
import dotenv from "dotenv";

dotenv.config();

if (!process.env.DATABASE_URL) {
  const h  = process.env.POSTGRES_HOST     || "localhost";
  const p  = process.env.POSTGRES_PORT     || "5432";
  const d  = process.env.POSTGRES_DB       || "memento";
  const u  = process.env.POSTGRES_USER     || "postgres";
  const pw = process.env.POSTGRES_PASSWORD || "";
  process.env.DATABASE_URL = `postgresql://${u}:${encodeURIComponent(pw)}@${h}:${p}/${d}`;
}

const DB_URL        = process.env.DATABASE_URL;
const MIGRATION_DIR = path.join(import.meta.dirname, "../lib/memory/migrations");

if (!DB_URL) {
  console.error("DATABASE_URL environment variable is required");
  process.exit(1);
}

async function migrate() {
  const pool   = new pg.Pool({ connectionString: DB_URL });
  const client  = await pool.connect();

  const MIGRATE_LOCK_ID = 73657;
  await client.query(`SELECT pg_advisory_lock(${MIGRATE_LOCK_ID})`);
  console.log("Migration lock acquired");

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS agent_memory.schema_migrations (
        filename   TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // pgvector 스키마 자동 감지
    let pgvectorSchema = process.env.PGVECTOR_SCHEMA || "";
    if (!pgvectorSchema) {
      try {
        const extResult = await client.query(
          `SELECT n.nspname FROM pg_extension e
           JOIN pg_namespace n ON e.extnamespace = n.oid
           WHERE e.extname = 'vector'`
        );
        if (extResult.rows.length > 0 && extResult.rows[0].nspname !== "public") {
          pgvectorSchema = extResult.rows[0].nspname;
        }
      } catch { /* pgvector not installed */ }
    }

    // embedding 컬럼 타입에 따른 ops 클래스 결정
    let opsClass = "vector_cosine_ops";
    try {
      const colResult = await client.query(
        `SELECT udt_name
         FROM information_schema.columns
         WHERE table_schema = 'agent_memory'
           AND table_name   = 'fragments'
           AND column_name  = 'embedding'`
      );
      if (colResult.rows.length > 0 && colResult.rows[0].udt_name === "halfvec") {
        opsClass = "halfvec_cosine_ops";
      }
    } catch { /* fragments 테이블 미존재 시 기본값 유지 */ }
    console.log(`Embedding ops class: ${opsClass}`);

    const searchPathParts = ["agent_memory"];
    if (pgvectorSchema) searchPathParts.push(pgvectorSchema);
    searchPathParts.push("public");
    const searchPathSQL = `SET search_path TO ${searchPathParts.join(", ")}`;
    console.log(`search_path: ${searchPathParts.join(", ")}${pgvectorSchema ? ` (pgvector in ${pgvectorSchema})` : ""}`);

    const { rows } = await client.query(
      "SELECT filename FROM agent_memory.schema_migrations ORDER BY filename"
    );
    const applied = new Set(rows.map(r => r.filename));

    const files = fs.readdirSync(MIGRATION_DIR)
      .filter(f => f.startsWith("migration-") && f.endsWith(".sql"))
      .sort();

    const pending = files.filter(f => !applied.has(f));

    if (pending.length === 0) {
      console.log("All migrations already applied.");
      return;
    }

    console.log(`${pending.length} pending migration(s):`);

    for (const file of pending) {
      console.log(`  Applying ${file}...`);
      let sql = fs.readFileSync(path.join(MIGRATION_DIR, file), "utf-8");
      /** opclass placeholder 치환 — 환경에 따라 vector_cosine_ops를 다른 opclass(예: halfvec_cosine_ops)로
       *  변경한다. 마이그레이션 파일은 vector_cosine_ops를 placeholder로 그대로 두고, migrate.js가
       *  적용 시점에 치환한다. */
      sql = sql.replaceAll("vector_cosine_ops", opsClass);
      /** body-only 규약(docs/migration-conventions.md) 이후로는 마이그레이션 파일이 인라인 BEGIN/COMMIT이나
       *  INSERT INTO agent_memory.schema_migrations를 포함하지 않는다. 기존 파일도 일괄 normalize 완료.
       *  신규 파일은 scripts/lint-migrations.js가 PR 시점에 차단한다. */

      await client.query("BEGIN");
      await client.query(searchPathSQL);
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO agent_memory.schema_migrations (filename) VALUES ($1)",
          [file]
        );
        await client.query("COMMIT");
        console.log(`  done.`);
      } catch (err) {
        await client.query("ROLLBACK");
        console.error(`  FAILED: ${err.message}`);
        throw err;
      }
    }

    console.log(`${pending.length} migration(s) applied successfully.`);
  } finally {
    await client.query(`SELECT pg_advisory_unlock(${MIGRATE_LOCK_ID})`);
    console.log("Migration lock released");
    client.release();
    await pool.end();
  }
}

migrate().catch(err => {
  console.error("Migration failed:", err.message);
  process.exit(1);
});
