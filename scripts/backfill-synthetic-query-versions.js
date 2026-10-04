#!/usr/bin/env node
/**
 * 합성 역질의 원본 버전 백필·정리 도구.
 *
 * 기본은 읽기 전용 dry-run이다. --apply는 현재 버전 행이 없는 대상만 워커로 생성하고,
 * --delete-stale까지 함께 줬을 때만 NULL 또는 현재 hash와 다른 파생 행을 삭제한다.
 */

import { getPrimaryPool, shutdownPool } from "../lib/tools/db.js";
import { MEMORY_CONFIG }                from "../config/memory.js";
import { SCHEMA }                       from "../lib/memory/schema.js";

function readLimit(argv) {
  const arg = argv.find(value => value.startsWith("--limit="));
  const value = Number(arg?.slice("--limit=".length) ?? MEMORY_CONFIG.syntheticQuery.backfillBatch ?? 20);
  if (!Number.isInteger(value) || value < 1 || value > 10000) throw new Error("--limit은 1~10000 정수여야 한다");
  return value;
}

async function status(pool) {
  const cfg = MEMORY_CONFIG.syntheticQuery;
  const types = Array.isArray(cfg.types) && cfg.types.length > 0 ? cfg.types : null;
  const params = [cfg.minImportance ?? 0.8];
  const typeClause = types ? " AND f.type = ANY($2::text[])" : "";
  if (types) params.push(types);
  const { rows: [row] } = await pool.query(
    `SELECT COUNT(DISTINCT f.id) FILTER (WHERE q.fragment_id IS NOT NULL)::int AS current_fragments,
            COUNT(DISTINCT f.id) FILTER (WHERE q.fragment_id IS NULL)::int AS missing_fragments
       FROM ${SCHEMA}.fragments f
       LEFT JOIN ${SCHEMA}.fragment_synthetic_query q
         ON q.fragment_id = f.id AND q.source_content_hash = f.content_hash
      WHERE f.valid_to IS NULL AND f.embedding IS NOT NULL
        AND f.importance >= $1${typeClause}`,
    params
  );
  const { rows: [stale] } = await pool.query(
    `SELECT COUNT(*)::int AS stale_rows
       FROM ${SCHEMA}.fragment_synthetic_query q
       LEFT JOIN ${SCHEMA}.fragments f ON f.id = q.fragment_id
      WHERE q.source_content_hash IS NULL
         OR f.id IS NULL
         OR q.source_content_hash IS DISTINCT FROM f.content_hash`
  );
  return { ...row, ...stale };
}

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const deleteStale = argv.includes("--delete-stale");
  if (deleteStale && !apply) throw new Error("--delete-stale은 --apply와 함께 써야 한다");
  const limit = readLimit(argv);
  const pool = getPrimaryPool();
  const before = await status(pool);
  let processed = 0;
  let generated = 0;
  let deleted = 0;

  if (apply) {
    const { SyntheticQueryWorker } = await import("../lib/memory/embedding/SyntheticQueryWorker.js");
    const worker = new SyntheticQueryWorker();
    const generatedBefore = worker.stats.generated;
    processed = await worker.backfill(limit);
    generated = worker.stats.generated - generatedBefore;
    if (deleteStale) {
      const result = await pool.query(
        `DELETE FROM ${SCHEMA}.fragment_synthetic_query q
          WHERE q.source_content_hash IS NULL
             OR NOT EXISTS (
               SELECT 1 FROM ${SCHEMA}.fragments f
                WHERE f.id = q.fragment_id
                  AND f.content_hash = q.source_content_hash
             )`
      );
      deleted = result.rowCount ?? 0;
    }
  }

  const after = apply ? await status(pool) : before;
  process.stdout.write(JSON.stringify({ mode: apply ? "apply" : "dry-run", limit, before, processed, generated, deleted, after }, null, 2) + "\n");
}

main()
  .catch(err => {
    process.stderr.write(`synthetic query version backfill failed: ${err.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => shutdownPool().catch(err => process.stderr.write(`database shutdown failed: ${err.message}\n`)));
