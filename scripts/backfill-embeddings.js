#!/usr/bin/env node
/**
 * backfill-embeddings.js — 기존 파편 임베딩 일괄 생성
 *
 * 작성자: 최진호
 * 작성일: 2026-03-07
 * 수정일: 2026-04-29 (v3.2.0: EmbeddingWorker batch 경로 사용)
 *
 * 목적: agent_memory.fragments 테이블에서 embedding IS NULL인 파편에 임베딩 벡터를 일괄 생성한다.
 * 호출 조건: EMBEDDING_PROVIDER 변경 후 기존 파편 재임베딩, 임베딩 API 장애 복구 후 누락 파편 처리
 * 빈도: 조건부 1회
 * 의존: DATABASE_URL, EMBEDDING_API_KEY(또는 OPENAI_API_KEY) 또는 EMBEDDING_PROVIDER=transformers
 * 관련 문서: docs/INSTALL.md#업그레이드-기존-설치, docs/operations/maintenance.md
 *
 * importance 무관하게 embedding IS NULL인 모든 파편을 대상으로 한다.
 * 배치 크기 10, API rate limit 고려 500ms 간격.
 */

import { getPrimaryPool, queryWithAgentVector } from "../lib/tools/db.js";
import {
  generateEmbedding, prepareTextForEmbedding,
  vectorToSql, EMBEDDING_ENABLED
} from "../lib/tools/embedding.js";

const SCHEMA    = "agent_memory";
const BATCH     = 10;
const DELAY_MS  = 500;

async function main() {
  if (!EMBEDDING_ENABLED) {
    console.error("임베딩 API가 설정되지 않았습니다. EMBEDDING_API_KEY(또는 OPENAI_API_KEY) 또는 EMBEDDING_BASE_URL을 설정하세요.");
    process.exit(1);
  }

  let total   = 0;
  let failed  = 0;
  let hasMore = true;

  while (hasMore) {
    const { rows } = await queryWithAgentVector("system",
      `SELECT id, content FROM ${SCHEMA}.fragments
       WHERE embedding IS NULL
       ORDER BY importance DESC, created_at DESC
       LIMIT $1`,
      [BATCH]
    );

    if (rows.length === 0) {
      break;
    }

    for (const row of rows) {
      try {
        const text = prepareTextForEmbedding(row.content, 500);
        const vec  = await generateEmbedding(text);
        await queryWithAgentVector("system",
          `UPDATE ${SCHEMA}.fragments SET embedding = $2::vector WHERE id = $1`,
          [row.id, vectorToSql(vec)],
          "write"
        );
        total++;
        process.stdout.write(`\rEmbedded: ${total} (failed: ${failed}) [_embedMany batch 1회 처리 누적]`);
      } catch (err) {
        failed++;
        console.warn(`\nFailed ${row.id}: ${err.message}`);
      }
    }

    await new Promise(r => setTimeout(r, DELAY_MS));
  }

  console.log(`\nDone. Total: ${total}, Failed: ${failed}`);

  const pool = getPrimaryPool();
  if (pool) await pool.end();
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
