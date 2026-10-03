/**
 * FragmentGC — 파편 만료 삭제, 지수 감쇠, TTL 계층 전환
 *
 * 작성자: 최진호
 * 작성일: 2026-03-12
 * 수정일: 2026-10-03 (여러 행 갱신과 삭제는 대상 행을 id 순으로 먼저 잠근다)
 * 수정일: 2026-10-03 (만료 삭제는 청크 단위로 반복하고 남은 후보 수를 적체 근사 게이지로 기록한다)
 */

import { queryWithAgentVector }                   from "../../tools/db.js";
import { MEMORY_CONFIG }                          from "../../../config/memory.js";
import { SCHEMA }                                 from "../schema.js";
import { minDeltaFromEnv, scoreUpdateBatchSize, updateInIdOrder } from "./idOrderedUpdate.js";
import { DELETE_LOCKED_SQL, LOCK_FOR_DELETE, fragmentRowLock } from "../write/rowLock.js";
import { gcThroughputEnabled, gcMaxDeletePerCycle, gcTimeBudgetMs } from "../../config.js";
import { logWarn }                                from "../../logger.js";
import { deindexRows }                            from "../FragmentIndex.js";
import { deleteExpiredWorkingMemoryRows }         from "../WorkingMemoryRows.js";
import { runGcChunks }                            from "./gcChunks.js";
import { setGcBacklog }                           from "./gc-metrics.js";

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

/**
 * 묶음 감쇠 갱신의 조건, 대입, 매개변수. 최소 변화량이 양수이면 감쇠량이 그 값 이상이거나
 * 마지막 감쇠 후 24시간이 지났거나 감쇠 기록이 없는 행만 고른다(값은 $4, real 비교).
 * 0이면 감쇠 대상 전체를 고른다.
 *
 * @param {number} minDelta 0 이상 1 이하
 * @returns {{ where: string, set: string, params: number[] }}
 */
export function decayUpdateSpec(minDelta) {
  const where = minDelta > 0
    ? `ttl_tier != 'permanent' AND is_anchor = FALSE
         AND (ABS((${decayedImportanceSql("$3::timestamptz")})::real - importance) >= $4::real
              OR last_decay_at IS NULL
              OR last_decay_at < $3::timestamptz - INTERVAL '24 hours')`
    : "ttl_tier != 'permanent' AND is_anchor = FALSE";
  return {
    where,
    set   : `importance = ${decayedImportanceSql("$3::timestamptz", "f")}, last_decay_at = $3::timestamptz`,
    params: minDelta > 0 ? [minDelta] : []
  };
}

/** 만료 삭제 청크의 잠금 대기 상한(ms). 청크마다 트랜잭션 안에서 건다. */
export const GC_CHUNK_LOCK_TIMEOUT_MS = 3000;

/** 적체 근사 게이지가 세는 후보 수의 상한. 이 값에서 세기를 멈춘다. */
export const GC_BACKLOG_COUNT_CAP = 100000;

/**
 * 만료 후보를 고르는 FROM 절과 조건($1부터 $7까지의 매개변수, 대상 행의 별칭은 f).
 * 삭제 청크와 적체 세기가 같은 절을 쓴다.
 * 분할 자식이 남아 있는 원본은 대조군으로 보존한다. split은 원본을 valid_to, importance 하향,
 * cold로 바꾸므로 이 조건이 없으면 utility 분기에서 원본이 물리 삭제된다.
 */
export const GC_CANDIDATE_FROM = `FROM ${SCHEMA}.fragments f
         WHERE f.ttl_tier NOT IN ('permanent')
           AND f.is_anchor = FALSE
           AND f.created_at < NOW() - make_interval(days => $1)
           AND NOT EXISTS (
             SELECT 1 FROM ${SCHEMA}.fragments split_child
             WHERE split_child.source = 'split:' || f.id
           )
           AND (
             (f.utility_score < $2
              AND (f.accessed_at IS NULL OR f.accessed_at < NOW() - make_interval(days => $3))
             )
             OR
             (f.type IN ('fact', 'decision')
              AND f.importance < $4
              AND f.access_count = 0
              AND coalesce(array_length(f.linked_to, 1), 0) = 0
              AND NOT EXISTS (
                SELECT 1 FROM ${SCHEMA}.fragment_links fl
                WHERE fl.from_id = f.id OR fl.to_id = f.id
              )
              AND f.created_at < NOW() - make_interval(days => $5)
             )
             OR
             (f.importance < 0.1
              AND (f.accessed_at IS NULL OR f.accessed_at < NOW() - INTERVAL '90 days')
              AND f.created_at < NOW() - INTERVAL '90 days'
              AND coalesce(array_length(f.linked_to, 1), 0) < 2
             )
             OR
             (f.type = 'error'
              AND f.content LIKE '[해결됨]%'
              AND f.created_at < NOW() - make_interval(days => $6)
              AND f.importance < $7
             )
             OR
             (f.type IS NULL
              AND f.created_at < NOW() - make_interval(days => $1)
              AND f.importance < 0.2
             )
           )`;

/**
 * 만료 후보 조건의 매개변수($1부터 $7까지).
 *
 * @param {Object} [gc] MEMORY_CONFIG.gc
 * @returns {number[]}
 */
export function gcCandidateParams(gc = MEMORY_CONFIG.gc || {}) {
  const fdPolicy = gc.factDecisionPolicy || {};
  const erPolicy = gc.errorResolvedPolicy || {};
  return [
    Number(gc.gracePeriodDays) || 7,
    Number(gc.utilityThreshold) || 0.15,
    Number(gc.inactiveDays) || 60,
    Number(fdPolicy.importanceThreshold) || 0.2,
    Number(fdPolicy.orphanAgeDays) || 30,
    Number(erPolicy.maxAgeDays) || 30,
    Number(erPolicy.maxImportance) || 0.3
  ];
}

/**
 * 한 주기의 삭제 한도. MEMENTO_GC_THROUGHPUT이 off이면 MEMORY_CONFIG.gc.maxDeletePerCycle건을
 * 시간 예산과 잠금 대기 상한 없이 한 번에 지운다.
 *
 * @param {Object} [gc] MEMORY_CONFIG.gc
 * @returns {{cap: number, chunk: number, budgetMs: number, lockTimeoutMs?: number}}
 */
export function gcLimits(gc = MEMORY_CONFIG.gc || {}) {
  if (!gcThroughputEnabled()) {
    const cap = Number(gc.maxDeletePerCycle) || 50;
    return { cap, chunk: cap, budgetMs: Infinity };
  }
  return {
    cap          : gcMaxDeletePerCycle(),
    chunk        : Number(gc.chunkSize) || 100,
    budgetMs     : gcTimeBudgetMs(),
    lockTimeoutMs: GC_CHUNK_LOCK_TIMEOUT_MS
  };
}

export class FragmentGC {
  /**
   * 만료된 파편 정리 (유지보수용 - 'system' 컨텍스트 사용)
   *
   * 보관 시간이 지난 작업 기억 행(source=wm-fallback)을 먼저 지우고, 만료 후보를 청크 단위로
   * 반복해 지운다. 주기당 삭제 상한, 시간 예산, 후보 소진 중 먼저 닿는 것에서 멈춘다. 청크는
   * 대상 행을 id 순으로 잠근 뒤 잠근 행만 지우는 두 문장이며 청크마다 별도 트랜잭션이다.
   * 청크가 실패해도 그때까지 지운 수는 유지하고 다음 주기가 이어간다.
   *
   * @returns {Promise<number>} 삭제된 파편 수(작업 기억 행 제외)
   */
  async deleteExpired() {
    await deleteExpiredWorkingMemoryRows();
    const limits  = gcLimits();
    const params  = gcCandidateParams();
    const outcome = await runGcChunks({
      ...limits,
      deleteChunk: (limit) => this._deleteExpiredChunk(params, limit, limits.lockTimeoutMs)
    });
    if (outcome.stopped === "error") {
      if (outcome.deleted === 0) throw outcome.error;
      logWarn(`[FragmentGC] expired delete stopped after ${outcome.deleted} rows: ${outcome.error.message}`);
    }
    await this._recordBacklog(params);
    return outcome.deleted;
  }

  /**
   * 만료 후보 limit건을 id 순으로 잠그고 지운다.
   *
   * @param {number[]} params 만료 후보 조건의 매개변수
   * @param {number} limit
   * @param {number} [lockTimeoutMs]
   * @returns {Promise<number>} 지운 행 수
   */
  async _deleteExpiredChunk(params, limit, lockTimeoutMs) {
    const lockSql = `WITH gc_candidates AS (
         SELECT f.id ${GC_CANDIDATE_FROM}
         ORDER BY f.utility_score ASC
         LIMIT $8
       )
       SELECT id FROM ${SCHEMA}.fragments WHERE id IN (SELECT id FROM gc_candidates)
        ORDER BY id
          ${LOCK_FOR_DELETE}`;
    const result = await queryWithAgentVector("system",
      `${DELETE_LOCKED_SQL} RETURNING id, keywords, topic, type, key_id`,
      [],
      { lock: { operation: "gc_delete", sql: lockSql, params: [...params, limit], lockTimeoutMs } }
    );
    await deindexRows(result.rows);
    return result.rowCount;
  }

  /**
   * 남은 만료 후보 수를 적체 근사 게이지에 기록한다. 세기가 실패하면 경고만 남기고 게이지는 그대로 둔다.
   *
   * @param {number[]} params 만료 후보 조건의 매개변수
   */
  async _recordBacklog(params) {
    try {
      const { rows: [row] } = await queryWithAgentVector("system",
        `SELECT count(*)::int AS n
           FROM (SELECT 1 ${GC_CANDIDATE_FROM} LIMIT $8) c`,
        [...params, GC_BACKLOG_COUNT_CAP]
      );
      setGcBacklog(row?.n ?? 0);
    } catch (err) {
      logWarn(`[FragmentGC] backlog count failed: ${err.message}`);
    }
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
    await updateInIdOrder({ ...decayUpdateSpec(minDelta), batchSize });
  }

  /**
   * TTL 계층 전환 (유지보수용 - 'system' 컨텍스트 사용)
   */
  async transitionTTL() {
    /** preference → permanent 고정 */
    await queryWithAgentVector("system",
      `UPDATE ${SCHEMA}.fragments SET ttl_tier = 'permanent' WHERE id = ANY($1::text[])`,
      [],
      { lock: fragmentRowLock("tier", "type = 'preference' AND ttl_tier != 'permanent'") }
    );

    /** 허브 → permanent 승격 */
    await queryWithAgentVector("system",
      `UPDATE ${SCHEMA}.fragments SET ttl_tier = 'permanent' WHERE id = ANY($1::text[])`,
      [],
      { lock: fragmentRowLock("tier", `coalesce(array_length(linked_to, 1), 0) >= 5
               AND ttl_tier != 'permanent'`) }
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
      `UPDATE ${SCHEMA}.fragments SET ttl_tier = 'permanent' WHERE id = ANY($1::text[])`,
      [],
      { lock: fragmentRowLock("tier", `importance >= 0.8
         AND ttl_tier != 'permanent'
         AND (
           quality_verified = TRUE
           OR (quality_verified IS NULL AND is_anchor = TRUE)
           OR (quality_verified IS NULL AND importance >= 0.9)
         )
         AND quality_verified IS DISTINCT FROM FALSE`) }
    );

    /** warm → cold */
    await queryWithAgentVector("system",
      `UPDATE ${SCHEMA}.fragments SET ttl_tier = 'cold' WHERE id = ANY($1::text[])`,
      [],
      { lock: fragmentRowLock("tier", `ttl_tier = 'warm'
               AND (importance < 0.3
                    OR (accessed_at IS NULL AND created_at < NOW() - INTERVAL '30 days')
                    OR accessed_at < NOW() - INTERVAL '30 days')`) }
    );

    /** permanent parole: 장기 미접근 + 낮은 importance → cold 강등 */
    await queryWithAgentVector("system",
      `UPDATE ${SCHEMA}.fragments SET ttl_tier = 'cold' WHERE id = ANY($1::text[])`,
      [],
      { lock: fragmentRowLock("tier", `ttl_tier    = 'permanent'
         AND is_anchor   = FALSE
         AND importance  < 0.5
         AND (accessed_at IS NULL OR accessed_at < NOW() - INTERVAL '180 days')`) }
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
       WHERE id = ANY($1::text[])`,
      [],
      { lock: fragmentRowLock("ema_decay", `(accessed_at IS NULL OR accessed_at < NOW() - INTERVAL '60 days')
         AND ema_activation  > 0
         AND is_anchor       = FALSE`) }
    );

    await queryWithAgentVector("system",
      `UPDATE ${SCHEMA}.fragments
       SET ema_activation   = ema_activation * 0.5,
           ema_last_updated = NOW()
       WHERE id = ANY($1::text[])`,
      [],
      { lock: fragmentRowLock("ema_decay", `accessed_at >= NOW() - INTERVAL '60 days'
         AND accessed_at  < NOW() - INTERVAL '30 days'
         AND ema_activation  > 0.01
         AND is_anchor       = FALSE`) }
    );
  }
}
