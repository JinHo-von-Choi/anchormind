/**
 * SearchParamAdaptor -- key_id x query_type x hour 별 검색 파라미터 온라인 학습
 *
 * 작성자: 최진호
 * 작성일: 2026-04-07
 *
 * 적응 규칙 (DB-level 원자적 계산):
 *   avg_result_count < 1  -> min_similarity -= 0.01 (더 관대하게)
 *   avg_result_count > 8  -> min_similarity += 0.01 (더 엄격하게)
 *   1 <= avg <= 8         -> 변경 없음 (적정 범위)
 *   sample_count < MIN_SAMPLE(50) -> 기본값 사용 (학습 미적용)
 *   범위 제한: [0.10, 0.60]
 *
 * 동시성 안전: recordOutcome은 SELECT 없이 단일 UPSERT로 원자적 처리.
 */

import { getPrimaryPool } from "../tools/db.js";
import { MEMORY_CONFIG }  from "../../config/memory.js";
import { logWarn }        from "../logger.js";
import { normalizeKeyId } from "./keyId.js";

const SCHEMA      = "agent_memory";
const MIN_SAMPLE  = 50;
const CLAMP_MIN   = 0.10;
const CLAMP_MAX   = 0.60;
const DEFAULT_SIM = MEMORY_CONFIG.semanticSearch?.minSimilarity ?? 0.35;

const _normalizeKeyId = (keyId) => normalizeKeyId(keyId, { mode: 'search' });

export class SearchParamAdaptor {
  /**
   * 주어진 컨텍스트에 맞는 minSimilarity를 반환한다.
   * sample_count < MIN_SAMPLE이면 항상 DEFAULT_SIM을 반환한다.
   */
  async getMinSimilarity(keyId, queryType, hour) {
    /** 옵트인 ENV: MEMENTO_RECALL_MIN_SIM_FLOOR가 설정되면 adaptor 학습값과 무관하게 하한을 강제한다. */
    const floorRaw  = Number(process.env.MEMENTO_RECALL_MIN_SIM_FLOOR);
    const applyFloor = (v) => Number.isFinite(floorRaw) ? Math.max(floorRaw, v) : v;

    try {
      const pool = getPrimaryPool();
      if (!pool) return applyFloor(DEFAULT_SIM);

      const { rows } = await pool.query(
        `SELECT min_similarity, sample_count
           FROM ${SCHEMA}.search_param_thresholds
          WHERE key_id = $1
            AND query_type = $2
            AND hour_bucket IN ($3, -1)
          ORDER BY hour_bucket DESC
          LIMIT 1`,
        [_normalizeKeyId(keyId), queryType, hour]
      );

      if (rows.length === 0 || rows[0].sample_count < MIN_SAMPLE) {
        return applyFloor(DEFAULT_SIM);
      }

      return applyFloor(rows[0].min_similarity);

    } catch (err) {
      logWarn(`[SearchParamAdaptor] getMinSimilarity failed: ${err.message}`);
      return applyFloor(DEFAULT_SIM);
    }
  }

  /**
   * 검색 결과 건수를 기록하고 min_similarity를 원자적으로 갱신한다.
   * fire-and-forget -- SELECT 없이 단일 UPSERT로 원자적 처리.
   */
  async recordOutcome(keyId, queryType, hour, resultCount) {
    try {
      const pool = getPrimaryPool();
      if (!pool) return;

      const spt = `${SCHEMA}.search_param_thresholds`;

      await pool.query(
        `INSERT INTO ${spt}
                (key_id, query_type, hour_bucket, min_similarity, sample_count, total_result_count)
         VALUES ($1, $2, $3, $4, 1, $5)
         ON CONFLICT (key_id, query_type, hour_bucket) DO UPDATE SET
           sample_count       = ${spt}.sample_count + 1,
           total_result_count = ${spt}.total_result_count + EXCLUDED.total_result_count,
           min_similarity     = CASE
             WHEN ${spt}.sample_count + 1 >= ${MIN_SAMPLE} THEN
               CASE
                 WHEN (${spt}.total_result_count + EXCLUDED.total_result_count)::float
                      / (${spt}.sample_count + 1) < 1.0
                   THEN GREATEST(${CLAMP_MIN}, ${spt}.min_similarity - 0.01)
                 WHEN (${spt}.total_result_count + EXCLUDED.total_result_count)::float
                      / (${spt}.sample_count + 1) > 8.0
                   THEN LEAST(${CLAMP_MAX}, ${spt}.min_similarity + 0.01)
                 ELSE ${spt}.min_similarity
               END
             ELSE ${spt}.min_similarity
           END,
           updated_at = NOW()`,
        [_normalizeKeyId(keyId), queryType, hour, DEFAULT_SIM, resultCount]
      );

    } catch (err) {
      logWarn(`[SearchParamAdaptor] recordOutcome failed: ${err.message}`);
    }
  }
}

/** 싱글톤 (서버 수명 동안 공유) */
let _instance = null;
export function getSearchParamAdaptor() {
  if (!_instance) _instance = new SearchParamAdaptor();
  return _instance;
}

/** 테스트 전용: 싱글톤 초기화 */
export function _resetForTesting() {
  _instance = null;
}
