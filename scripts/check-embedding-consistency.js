/**
 * check-embedding-consistency.js — 임베딩 차원 일관성 startup 검증
 *
 * 작성자: 최진호
 * 작성일: 2026-04-18
 * 수정일: 2026-04-29 (v3.2.0: morpheme_indexed=false Consistency Gate 카운트 추가)
 *
 * 목적: EMBEDDING_DIMENSIONS 설정값과 DB의 실제 벡터 차원이 일치하는지 확인한다.
 *       불일치 시 server.js 기동 전에 명확한 가이드를 출력하고 false를 반환한다.
 * 호출 조건: server.js 기동 시 자동 호출. setup.sh의 검증 단계에서도 직접 호출 가능.
 * 빈도: 서버 기동마다 자동 실행
 * 의존: DATABASE_URL, EMBEDDING_DIMENSIONS, EMBEDDING_PROVIDER
 * 관련 문서: docs/INSTALL.md#기동-후-검증-체크리스트, docs/operations/maintenance.md
 */

import { getPrimaryPool }                                     from "../lib/tools/db.js";
import { EMBEDDING_DIMENSIONS, EMBEDDING_PROVIDER, EMBEDDING_MODEL } from "../lib/config.js";
import { getSchedulerRegistry } from "../lib/scheduler-registry.js";
import { resolveEmbeddingColumnSpec, embeddingColumnMismatch, fetchEmbeddingColumn }
  from "../lib/memory/embedding/column-spec.js";

const TABLES           = ["fragments", "morpheme_dict", "fragment_synthetic_query"];
const SCHEMA_FOR_CHECK = "agent_memory";

export async function checkEmbeddingConsistency() {
  const pool      = getPrimaryPool();
  const mismatches = [];
  const spec       = resolveEmbeddingColumnSpec(EMBEDDING_DIMENSIONS);

  for (const table of TABLES) {
    /** 1차: 선언 차원 검사 (pg_attribute.atttypmod). 데이터가 전량 NULL이어도
     *  컬럼 선언과 설정의 불일치를 잡는다 — 행 표본 검사만으로는 이 상태에서
     *  서버가 기동해 임베딩 쓰기가 전부 실패하며 NULL을 양산한다. */
    try {
      const current  = await fetchEmbeddingColumn(pool, SCHEMA_FOR_CHECK, table);
      const mismatch = current ? embeddingColumnMismatch(current, spec) : null;
      if (mismatch) {
        mismatches.push({
          table,
          dbDim    : current.declaredDim ?? `${current.udtName}(무차원)`,
          configDim: EMBEDDING_DIMENSIONS
        });
        continue;
      }
    } catch {
      /** 테이블 미존재 → 데이터 표본 검사로 진행 */
    }

    /** 2차: 실데이터 표본 검사 (선언은 맞지만 이질 데이터가 남은 경우) */
    try {
      const { rows } = await pool.query(`
        SELECT vector_dims(embedding) AS dim
        FROM agent_memory.${table}
        WHERE embedding IS NOT NULL
        LIMIT 1
      `);
      if (rows.length > 0 && rows[0].dim !== EMBEDDING_DIMENSIONS) {
        mismatches.push({ table, dbDim: rows[0].dim, configDim: EMBEDDING_DIMENSIONS });
      }
    } catch {
      /** 테이블 미존재 또는 halfvec 타입 → vector_dims 에러는 무시 */
    }
  }

  if (mismatches.length > 0) {
    console.error("\n[embedding-consistency] 차원 불일치 발견:");
    for (const m of mismatches) {
      console.error(`  - ${m.table}: DB=${m.dbDim}d, config=${m.configDim}d`);
    }
    console.error(`\nconfig: provider=${EMBEDDING_PROVIDER}, model=${EMBEDDING_MODEL}, dims=${EMBEDDING_DIMENSIONS}`);
    console.error("\n해결 방법:");
    console.error("  1. 이전 provider로 복구");
    console.error("  2. EMBEDDING_DIMENSIONS=N npm run migrate-007 실행 + node scripts/backfill-embeddings.js");
    console.error("\n데이터 혼합 방지를 위해 기동을 중단합니다.\n");
    return false;
  }

  try {
    const { rows } = await pool.query(`
      SELECT count(*)::int AS cnt
      FROM agent_memory.fragments
      WHERE morpheme_indexed = false
    `);
    if (rows.length > 0 && rows[0].cnt > 0) {
      console.warn(`[embedding-consistency] morpheme_indexed=false 파편 ${rows[0].cnt}개 (형태소 미인덱싱)`);
      const reg  = getSchedulerRegistry();
      const snap = reg.getAll?.() || {};
      const job  = snap.morphemeBackfill;
      if (job && job.lastSuccess) {
        console.warn(`[embedding-consistency] MorphemeBackfill 최근 성공: ${job.lastSuccess} (processed=${job.lastSummary?.processed ?? "?"})`);
      } else {
        console.warn("[embedding-consistency] MorphemeBackfill 미실행/기록 없음 — 서버 스케줄러 가동 여부를 확인하세요 (5분 주기, batch 500).");
      }
    }
  } catch {
    /** migration-035 미적용 환경에서는 컬럼 미존재 → 무시 */
  }

  return true;
}
