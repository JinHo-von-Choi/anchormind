#!/usr/bin/env node
/**
 * 구간(세그먼트) 임베딩 백필 도구.
 *
 * 기본은 읽기 전용 dry-run이다: 대상 파편 수와 만들어질 구간 수(예상)를 보여준다.
 * --apply는 현재 해시/분할 버전의 구간이 없는 대상 파편을 최신순으로 워커 로직으로 생성한다.
 *
 * 사용: node scripts/backfill-fragment-segments.js [--apply] [--limit=N] [--since-hours=H]
 *   --limit        이번 실행에서 처리할 최대 파편 수 (기본 200, 1~100000)
 *   --since-hours  이 시간 안에 생성된 파편만 (기본: 전체)
 *
 * 대량 백필 전에 HNSW 인덱스(idx_fseg_embedding_hnsw)를 지우고 끝난 뒤 다시 만들면 삽입이 빠르다.
 * 임베딩 설정(EMBEDDING_*)은 서버와 같아야 한다.
 */

import { getPrimaryPool, shutdownPool } from "../lib/tools/db.js";
import { MEMORY_CONFIG }                from "../config/memory.js";
import { SCHEMA }                       from "../lib/memory/schema.js";
import { SegmentEmbeddingWorker }       from "../lib/memory/embedding/SegmentEmbeddingWorker.js";
import { splitIntoSegments, segmentVersion } from "../lib/memory/embedding/segmenter.js";

function readInt(argv, name, def, min, max) {
  const arg = argv.find(v => v.startsWith(`--${name}=`));
  const value = arg ? Number(arg.slice(name.length + 3)) : def;
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`--${name}은 ${min}~${max} 정수여야 한다`);
  return value;
}

async function targets(pool, cfg, version, sinceHours, limit) {
  const params = [cfg.minChars, version];
  let   since  = "";
  if (sinceHours != null) { params.push(sinceHours); since = ` AND f.created_at > NOW() - make_interval(hours => $${params.length})`; }
  params.push(limit);
  const { rows } = await pool.query(
    `SELECT f.id, f.content
       FROM ${SCHEMA}.fragments f
      WHERE f.valid_to IS NULL AND f.embedding IS NOT NULL
        AND char_length(f.content) > $1${since}
        AND NOT EXISTS (
          SELECT 1 FROM ${SCHEMA}.fragment_segment s
           WHERE s.fragment_id = f.id AND s.source_content_hash = f.content_hash
             AND s.seg_version = $2 AND s.embedding IS NOT NULL)
      ORDER BY f.created_at DESC
      LIMIT $${params.length}`,
    params);
  return rows;
}

async function main() {
  const argv       = process.argv.slice(2);
  const apply      = argv.includes("--apply");
  const limit      = readInt(argv, "limit", 200, 1, 100000);
  const sinceArg   = argv.find(v => v.startsWith("--since-hours="));
  const sinceHours = sinceArg ? readInt(argv, "since-hours", 0, 1, 1000000) : null;
  const cfg        = MEMORY_CONFIG.segmentEmbedding;
  const version    = segmentVersion(cfg);
  const pool       = getPrimaryPool();

  const rows = await targets(pool, cfg, version, sinceHours, limit);
  const expected = rows.reduce((n, r) => n + splitIntoSegments(r.content, cfg).length, 0);
  console.log(`분할 버전 ${version}, 최소 길이 ${cfg.minChars}`);
  console.log(`구간이 없는 대상 파편(이번 조회 상한 ${limit}): ${rows.length}개, 예상 구간 ${expected}개`);

  if (!apply) {
    console.log("dry-run입니다. 실제로 만들려면 --apply를 붙이십시오.");
    await shutdownPool();
    return;
  }

  const worker = new SegmentEmbeddingWorker({ cfg: { ...cfg, maxSegmentsPerMinute: Number.MAX_SAFE_INTEGER } });
  let done = 0;
  for (const r of rows) {
    if (await worker.processFragment(r.id)) done++;
    if ((done + worker.stats.failed) % 25 === 0) console.log(`  진행 ${done}/${rows.length} 실패 ${worker.stats.failed}`);
  }
  console.log(`완료: ${done}개 파편, 구간 ${worker.stats.segments}개, 폐기(본문 변경) ${worker.stats.stale}, 실패 ${worker.stats.failed}`);
  await shutdownPool();
}

main().catch(async err => {
  console.error(err.message);
  await shutdownPool().catch(closeErr => console.error(`풀 종료 실패: ${closeErr.message}`));
  process.exit(1);
});
