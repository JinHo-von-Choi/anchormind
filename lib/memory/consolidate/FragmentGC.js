/**
 * FragmentGC — 파편 만료 삭제, 지수 감쇠, TTL 계층 전환
 *
 * 작성자: 최진호
 * 작성일: 2026-03-12
 */

import { queryWithAgentVector }                   from "../../tools/db.js";
import { MEMORY_CONFIG }                          from "../../../config/memory.js";
import { SCHEMA }                                 from "../schema.js";
import { minDeltaFromEnv, scoreUpdateBatchSize, updateInIdOrder } from "./idOrderedUpdate.js";

/**
 * 감쇠 후 importance SQL 식.
 *
 * @param {string} nowRef - 기준 시각 SQL 표현(예: "NOW()", "$3::timestamptz")
 * @param {string} [alias] - 컬럼 별칭. 비우면 별칭 없이 쓴다.
 * @returns {string}
 */
export function decayedImportanceSql(nowRef, alias = "") {
  const c = alias ? `${alias}.` : "";
  return `GREATEST(0.05,
    ${c}importance * POWER(2,
      -EXTRACT(EPOCH FROM (${nowRef} - COALESCE(${c}last_decay_at, ${c}accessed_at, ${c}created_at, ${nowRef})))
      / (CASE ${c}type
           WHEN 'procedure'  THEN 2592000
           WHEN 'fact'       THEN 5184000
           WHEN 'decision'   THEN 7776000
           WHEN 'error'      THEN 3888000
           WHEN 'preference' THEN 10368000
           WHEN 'relation'   THEN 7776000
           ELSE 5184000
         END
         * LEAST(2.0, GREATEST(1.0, 1.0 + COALESCE(${c}ema_activation, 0) * 0.5))
        )
    ))`;
}

export class FragmentGC {
  /**
   * 만료된 파편 정리 (유지보수용 - 'system' 컨텍스트 사용)
   *
   * @returns {Promise<number>} 삭제된 행 수
   */
  async deleteExpired() {
    const gc               = MEMORY_CONFIG.gc || {};
    const utilityThreshold = Number(gc.utilityThreshold) || 0.15;
    const gracePeriodDays  = Number(gc.gracePeriodDays) || 7;
    const inactiveDays     = Number(gc.inactiveDays) || 60;
    const maxDelete        = Number(gc.maxDeletePerCycle) || 50;
    const fdPolicy         = gc.factDecisionPolicy || {};
    const fdImportance     = Number(fdPolicy.importanceThreshold) || 0.2;
    const fdOrphanDays     = Number(fdPolicy.orphanAgeDays) || 30;
    const erPolicy         = gc.errorResolvedPolicy || {};
    const erMaxDays        = Number(erPolicy.maxAgeDays) || 30;
    const erMaxImportance  = Number(erPolicy.maxImportance) || 0.3;

    const scPolicy            = gc.splitChildPolicy || {};
    const scMaxImportance     = Number(scPolicy.maxImportance) || 0.3;
    const scOrphanDays        = Number(scPolicy.orphanAgeDays) || 30;
    const scTombstonedGrace   = Number(scPolicy.tombstonedGraceDays) || 7;

    const result = await queryWithAgentVector("system",
      `WITH gc_candidates AS (
         SELECT child.id FROM ${SCHEMA}.fragments child
         WHERE ttl_tier NOT IN ('permanent')
           AND is_anchor = FALSE
           AND created_at < NOW() - make_interval(days => $1)
           AND (
             (utility_score < $2
              AND (accessed_at IS NULL OR accessed_at < NOW() - make_interval(days => $3))
             )
             OR
             (type IN ('fact', 'decision')
              AND importance < $4
              AND access_count = 0
              AND coalesce(array_length(linked_to, 1), 0) = 0
              AND NOT EXISTS (
                SELECT 1 FROM ${SCHEMA}.fragment_links fl
                WHERE fl.from_id = child.id OR fl.to_id = child.id
              )
              AND created_at < NOW() - make_interval(days => $5)
             )
             OR
             (importance < 0.1
              AND (accessed_at IS NULL OR accessed_at < NOW() - INTERVAL '90 days')
              AND created_at < NOW() - INTERVAL '90 days'
              AND coalesce(array_length(linked_to, 1), 0) < 2
             )
             OR
             (type = 'error'
              AND content LIKE '[해결됨]%'
              AND created_at < NOW() - make_interval(days => $6)
              AND importance < $7
             )
             OR
             (type IS NULL
              AND created_at < NOW() - make_interval(days => $1)
              AND importance < 0.2
             )
             OR
             (source LIKE 'split:%'
              AND importance < $9
              AND access_count = 0
              AND (accessed_at IS NULL OR accessed_at < NOW() - make_interval(days => $10))
              AND created_at < NOW() - make_interval(days => $10)
             )
             OR
             (source LIKE 'split:%'
              AND created_at < NOW() - make_interval(days => $11)
              AND NOT EXISTS (
                SELECT 1 FROM ${SCHEMA}.fragments parent
                WHERE parent.id = split_part(child.source, ':', 2)
                  AND parent.valid_to IS NULL
              )
             )
           )
         ORDER BY utility_score ASC
         LIMIT $8
       )
       DELETE FROM ${SCHEMA}.fragments WHERE id IN (SELECT id FROM gc_candidates)`,
      [gracePeriodDays, utilityThreshold, inactiveDays, fdImportance, fdOrphanDays, erMaxDays, erMaxImportance, maxDelete, scMaxImportance, scOrphanDays, scTombstonedGrace],
      "write"
    );

    return result.rowCount;
  }

  /**
   * 지수 감쇠 배치 적용 (유지보수용 - 'system' 컨텍스트 사용)
   *
   * PostgreSQL POWER() 단일 SQL로 전체 파편을 O(1) 쿼리 처리.
   * type별 halfLife(초)는 CASE WHEN으로 SQL 내부에서 분기하여
   * JS 루프 없이 DB 엔진이 직접 벡터 연산 수행.
   *
   * 멱등성 보장: last_decay_at 기준 증분(delta)만 반영.
   * 몇 번 호출해도 "마지막 감쇠 이후 경과 시간"만 적용되며,
   * last_decay_at이 없으면 COALESCE(accessed_at, created_at, NOW()) 기준.
   *
   * halfLife 매핑 (초):
   *   procedure  → 30일  = 2,592,000s
   *   fact       → 60일  = 5,184,000s
   *   decision   → 90일  = 7,776,000s
   *   error      → 45일  = 3,888,000s
   *   preference → 120일 = 10,368,000s
   *   relation   → 90일  = 7,776,000s
   *   default    → 60일  = 5,184,000s
   *
   * MEMENTO_SCORE_UPDATE_BATCH가 0보다 크면 id 오름차순 묶음으로 나눠 갱신한다.
   * 0이면 단일 문장으로 갱신한다.
   */
  async decayImportance() {
    const batchSize = scoreUpdateBatchSize();
    if (batchSize === 0) {
      await queryWithAgentVector("system",
        `UPDATE ${SCHEMA}.fragments
            SET importance    = ${decayedImportanceSql("NOW()")},
                last_decay_at = NOW()
          WHERE ttl_tier != 'permanent'
            AND is_anchor = FALSE`,
        [],
        "write"
      );
      return;
    }
    /**
     * 최소 변화량이 있으면 감쇠량이 그보다 작은 행은 건너뛴다. 건너뛴 행은 last_decay_at이
     * 그대로라 다음 실행이 누적 경과 시간을 한 번에 적용한다. 마지막 감쇠 후 24시간이
     * 지난 행은 변화량과 무관하게 갱신해 누적 지연을 하루로 제한한다.
     */
    const minDelta = minDeltaFromEnv("MEMENTO_DECAY_MIN_DELTA");
    const where    = minDelta > 0
      ? `ttl_tier != 'permanent' AND is_anchor = FALSE
         AND (ABS((${decayedImportanceSql("$3::timestamptz")})::real - importance) >= $4::real
              OR last_decay_at IS NULL
              OR last_decay_at < $3::timestamptz - INTERVAL '24 hours')`
      : "ttl_tier != 'permanent' AND is_anchor = FALSE";
    await updateInIdOrder({
      where,
      set   : `importance = ${decayedImportanceSql("$3::timestamptz", "f")}, last_decay_at = $3::timestamptz`,
      params: minDelta > 0 ? [minDelta] : [],
      batchSize
    });
  }

  /**
   * TTL 계층 전환 (유지보수용 - 'system' 컨텍스트 사용)
   */
  async transitionTTL() {
    /** preference → permanent 고정 */
    await queryWithAgentVector("system",
      `UPDATE ${SCHEMA}.fragments SET ttl_tier = 'permanent'
             WHERE type = 'preference' AND ttl_tier != 'permanent'`,
      [],
      "write"
    );

    /** 허브 → permanent 승격 */
    await queryWithAgentVector("system",
      `UPDATE ${SCHEMA}.fragments SET ttl_tier = 'permanent'
             WHERE coalesce(array_length(linked_to, 1), 0) >= 5
               AND ttl_tier != 'permanent'`,
      [],
      "write"
    );

    /**
     * importance >= 0.8 → permanent (Circuit Breaker 패턴)
     *
     * - quality_verified=TRUE: 정상 경로
     * - quality_verified IS NULL AND is_anchor=TRUE: 앵커 폴백
     * - quality_verified IS NULL AND importance>=0.9: 오프라인 폴백
     * - quality_verified=FALSE: 항상 차단
     */
    await queryWithAgentVector("system",
      `UPDATE ${SCHEMA}.fragments SET ttl_tier = 'permanent'
       WHERE importance >= 0.8
         AND ttl_tier != 'permanent'
         AND (
           quality_verified = TRUE
           OR (quality_verified IS NULL AND is_anchor = TRUE)
           OR (quality_verified IS NULL AND importance >= 0.9)
         )
         AND quality_verified IS DISTINCT FROM FALSE`,
      [],
      "write"
    );

    /** warm → cold */
    await queryWithAgentVector("system",
      `UPDATE ${SCHEMA}.fragments SET ttl_tier = 'cold'
             WHERE ttl_tier = 'warm'
               AND (importance < 0.3
                    OR (accessed_at IS NULL AND created_at < NOW() - INTERVAL '30 days')
                    OR accessed_at < NOW() - INTERVAL '30 days')`,
      [],
      "write"
    );

    /** permanent parole: 장기 미접근 + 낮은 importance → cold 강등 */
    await queryWithAgentVector("system",
      `UPDATE ${SCHEMA}.fragments SET ttl_tier = 'cold'
       WHERE ttl_tier    = 'permanent'
         AND is_anchor   = FALSE
         AND importance  < 0.5
         AND (accessed_at IS NULL OR accessed_at < NOW() - INTERVAL '180 days')`,
      [],
      "write"
    );
  }

  /**
   * 장기 미접근 파편의 EMA 활성화 감쇠
   *
   * - 60일 이상 미접근: ema_activation = 0 (리셋)
   * - 30~60일 미접근: ema_activation × 0.5 (절반)
   *
   * is_anchor 파편은 면제.
   */
  async decayEmaActivation() {
    await queryWithAgentVector("system",
      `UPDATE ${SCHEMA}.fragments
       SET ema_activation   = 0.0,
           ema_last_updated = NOW()
       WHERE (accessed_at IS NULL OR accessed_at < NOW() - INTERVAL '60 days')
         AND ema_activation  > 0
         AND is_anchor       = FALSE`,
      [],
      "write"
    );

    await queryWithAgentVector("system",
      `UPDATE ${SCHEMA}.fragments
       SET ema_activation   = ema_activation * 0.5,
           ema_last_updated = NOW()
       WHERE accessed_at >= NOW() - INTERVAL '60 days'
         AND accessed_at  < NOW() - INTERVAL '30 days'
         AND ema_activation  > 0.01
         AND is_anchor       = FALSE`,
      [],
      "write"
    );
  }
}
