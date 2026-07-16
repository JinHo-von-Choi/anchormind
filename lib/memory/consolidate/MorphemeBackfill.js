/**
 * MorphemeBackfill — morpheme_indexed=false 파편의 형태소 인덱싱 백필.
 *
 * 작성자: 최진호
 * 작성일: 2026-07-16
 *
 * remember hot-path의 fire-and-forget 형태소 등록이 재시작·타임아웃으로 유실한
 * 파편을 배치로 복구한다. EmbeddingBackfill(5분 주기)과 대칭 구조다.
 * 부분 인덱스 idx_fragments_morpheme_indexed(WHERE morpheme_indexed=false)로
 * 대상 스캔 비용을 최소화한다.
 */
import { getPrimaryPool } from "../../tools/db.js";
import { MorphemeIndex }  from "../embedding/MorphemeIndex.js";
import { logWarn }        from "../../logger.js";

const SCHEMA = "agent_memory";

/**
 * morpheme_indexed=false 파편을 배치로 처리한다.
 *
 * @param {{ pool?: import("pg").Pool, morphemeIndex?: MorphemeIndex, batchSize?: number }} deps
 * @returns {Promise<number>} 처리(UPDATE 성공)된 파편 수
 */
export async function processMorphemeBackfill({ pool, morphemeIndex, batchSize = 500 } = {}) {
  const db  = pool || getPrimaryPool();
  if (!db) return 0;
  const idx = morphemeIndex || new MorphemeIndex();

  const { rows } = await db.query(
    `SELECT id, content
       FROM ${SCHEMA}.fragments
      WHERE morpheme_indexed = false
      ORDER BY created_at DESC
      LIMIT $1`,
    [batchSize]
  );
  if (rows.length === 0) return 0;

  let processed = 0;
  for (const row of rows) {
    try {
      const morphemes = await idx.tokenize(row.content || "");
      await idx.getOrRegisterEmbeddings(morphemes);
      await db.query(
        `UPDATE ${SCHEMA}.fragments SET morpheme_indexed = true WHERE id = $1`,
        [row.id]
      );
      processed++;
    } catch (err) {
      /** 개별 파편 실패는 다음 사이클에서 재시도되므로 삼키지 않고 경고만 남긴다 */
      logWarn(`[MorphemeBackfill] id=${row.id} 처리 실패: ${err.message}`);
    }
  }
  return processed;
}
