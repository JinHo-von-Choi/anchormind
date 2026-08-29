#!/usr/bin/env node
/**
 * post-migrate-flexible-embedding-dims.js — embedding 컬럼 차원 동시 조정
 *
 * 작성자: 최진호
 * 작성일: 2026-03-08
 * 수정일: 2026-08-12 ((타입, 차원) 쌍 판정·dry-run·테이블별 트랜잭션 도입)
 *
 * 목적: EMBEDDING_DIMENSIONS 환경변수에 따라 fragments + morpheme_dict 테이블의
 *       embedding 컬럼 타입을 동시에 조정한다.
 *       - ≤2000차원: vector(N)  + HNSW 인덱스
 *       - >2000차원: halfvec(N) + HNSW 인덱스 (pgvector ≥0.7.0 필요)
 * 호출 조건: EMBEDDING_DIMENSIONS 변경 또는 EMBEDDING_PROVIDER 전환 시
 * 빈도: 조건부 1회
 * 의존: DATABASE_URL, EMBEDDING_DIMENSIONS
 * 관련 문서: docs/INSTALL.md#업그레이드-기존-설치, docs/operations/maintenance.md
 *
 * 사용:
 *   node scripts/post-migrate-flexible-embedding-dims.js --dry-run   # 판정만 출력
 *   node scripts/post-migrate-flexible-embedding-dims.js             # 실제 변환
 *
 * 주의:
 * - 컬럼 타입 변경 시 해당 테이블의 기존 임베딩이 전량 NULL로 초기화된다.
 * - fragments는 서버 스케줄러(processOrphanFragments, 5분 주기·배치 500)가 자동
 *   재임베딩을 시작하므로 변환 직후부터 임베딩 API 비용이 발생한다. 비용 통제가
 *   필요하면 변환 전 서버를 내리거나 스케줄러를 비활성화하라.
 * - morpheme_dict는 자동 재임베딩 경로가 없다. 변환 후 반드시
 *   node scripts/backfill-morpheme-dict.js 를 별도 실행하라.
 * - halfvec 목표는 실행 경로의 ::vector 캐스트와 호환 검증이 완료되지 않았다.
 *   halfvec 전환 시 스크립트가 경고를 출력하며, 전환 전 별도 검증이 필요하다.
 */

import { getPrimaryPool }       from "../lib/tools/db.js";
import { EMBEDDING_DIMENSIONS } from "../lib/config.js";
import { resolveEmbeddingColumnSpec, embeddingColumnMismatch, fetchEmbeddingColumn }
  from "../lib/memory/embedding/column-spec.js";

const SCHEMA  = "agent_memory";
const DRY_RUN = process.argv.includes("--dry-run");

/** fragments + morpheme_dict 둘 다 갱신. ef_construction은 기본 스키마(128)와 정합 유지. */
const TABLES = [
  { table: "fragments",                 indexName: "idx_frag_embedding",          whereClause: "WHERE embedding IS NOT NULL" },
  { table: "morpheme_dict",             indexName: "idx_morpheme_dict_embedding", whereClause: ""                            },
  { table: "fragment_synthetic_query",  indexName: "idx_fsq_embedding_hnsw",      whereClause: "WHERE embedding IS NOT NULL" }
];
const HNSW_M = 16;
const HNSW_EF_CONSTRUCTION = 128;

async function migrateTable(pool, { table, indexName, whereClause }, spec) {
  const current  = await fetchEmbeddingColumn(pool, SCHEMA, table);
  const mismatch = embeddingColumnMismatch(current, spec);

  const currentDesc = current
    ? `${current.udtName}(${current.declaredDim ?? "무차원"})`
    : "컬럼 없음";
  console.log(`migration-007: ${table} — 현재 ${currentDesc}, 목표 ${spec.colType}`);

  if (!current) {
    console.log(`migration-007: ${table} — embedding 컬럼 없음, 스킵`);
    return { table, action: "skip" };
  }
  if (!mismatch) {
    console.log(`migration-007: ${table} — 이미 ${spec.colType}, 스킵`);
    return { table, action: "skip" };
  }

  if (DRY_RUN) {
    console.log(`migration-007: ${table} — [dry-run] 변환 필요 (${mismatch.reason}: ${mismatch.detail})`);
    return { table, action: "would-convert", mismatch };
  }

  /**
   * DROP INDEX → ALTER COLUMN → CREATE INDEX를 한 트랜잭션으로 묶는다.
   * 중간 실패 시 롤백되어 "임베딩 전량 NULL + 인덱스 없음" 중간 상태가 남지 않는다.
   */
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    console.log(`migration-007: ${table} — 변환 중: ${mismatch.detail} (임베딩 데이터 NULL 초기화)`);
    await client.query(`DROP INDEX IF EXISTS ${SCHEMA}.${indexName}`);
    await client.query(
      `ALTER TABLE ${SCHEMA}.${table}
       ALTER COLUMN embedding TYPE ${spec.colType} USING NULL`
    );
    const whereExpr = whereClause ? `\n       ${whereClause}` : "";
    await client.query(
      `CREATE INDEX ${indexName}
       ON ${SCHEMA}.${table}
       USING hnsw (embedding ${spec.opsType})
       WITH (m = ${HNSW_M}, ef_construction = ${HNSW_EF_CONSTRUCTION})${whereExpr}`
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw new Error(`${table} 변환 실패(롤백됨): ${err.message}`, { cause: err });
  } finally {
    client.release();
  }

  console.log(`migration-007: ${table} → ${spec.colType} 완료`);
  return { table, action: "converted" };
}

/** 변환 후 상태 검증: NULL 수와 인덱스 유효성 출력 */
async function verifyTable(pool, { table, indexName }) {
  const { rows: [nulls] } = await pool.query(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE embedding IS NULL)::int AS null_rows
     FROM ${SCHEMA}.${table}`
  );
  const { rows: idx } = await pool.query(
    `SELECT i.indisvalid FROM pg_index i
     JOIN pg_class c ON c.oid = i.indexrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = $2`,
    [SCHEMA, indexName]
  );
  const idxState = idx.length === 0 ? "없음" : (idx[0].indisvalid ? "유효" : "무효(invalid)");
  console.log(`검증: ${table} — 행 ${nulls.total}, embedding NULL ${nulls.null_rows}, 인덱스 ${idxState}`);
}

async function main() {
  const dims = EMBEDDING_DIMENSIONS;
  const spec = resolveEmbeddingColumnSpec(dims);

  console.log(`EMBEDDING_DIMENSIONS = ${dims}`);
  console.log(`목표 컬럼 타입 → ${spec.colType}${DRY_RUN ? " [dry-run]" : ""}`);
  if (spec.useHalfvec) {
    console.warn(
      "경고: halfvec 전환은 실행 경로(쓰기·백필·형태소 등록·시맨틱 쿼리)의 ::vector 캐스트와 " +
      "호환 검증이 완료되지 않았다. 전환 전 별도 검증 없이는 검색이 깨질 수 있다."
    );
  }

  const pool = getPrimaryPool();

  try {
    const results = [];
    for (const tableSpec of TABLES) {
      results.push(await migrateTable(pool, tableSpec, spec));
    }

    if (DRY_RUN) {
      console.log("\ndry-run 종료. 변경은 적용되지 않았다.");
      return;
    }

    const converted = results.filter(r => r.action === "converted");
    if (converted.length > 0) {
      console.log("");
      for (const tableSpec of TABLES) {
        await verifyTable(pool, tableSpec);
      }
      console.log("\n마이그레이션 완료.");
      console.log("- fragments: 서버 스케줄러가 5분 주기로 자동 재임베딩한다 (비용 발생 인지).");
      console.log("- morpheme_dict: node scripts/backfill-morpheme-dict.js 를 별도 실행하라.");
    } else {
      console.log("\n변경 사항 없음.");
    }
  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error(`마이그레이션 중단: ${err.message}`);
  process.exit(1);
});
