/**
 * EvaluationMetrics - tool_feedback 기반 Implicit IR 평가
 *
 * 작성자: 최진호
 * 작성일: 2026-03-11
 */

import { getPrimaryPool } from "../../tools/db.js";
import { SCHEMA } from "../schema.js";

/**
 * 피드백 배열에서 Precision@k 계산 (순수 함수)
 * @param {{ relevant: boolean }[]} feedbacks
 * @param {number} k
 * @returns {number|null}
 */
export function computePrecisionAt(feedbacks, k) {
  if (!feedbacks || feedbacks.length === 0) return null;
  const top      = feedbacks.slice(0, k);
  const relevant = top.filter(f => f.relevant === true).length;
  return relevant / top.length;
}

/**
 * 최근 N 세션의 rolling Precision@5 계산
 * @param {number} [windowSessions=100]
 * @returns {Promise<{ precision_at_5: number|null, sample_sessions: number, sufficient_rate: number|null }>}
 */
export async function computeRollingPrecision(windowSessions = 100) {
  const pool = getPrimaryPool();
  if (!pool) return { precision_at_5: null, sample_sessions: 0, sufficient_rate: null };

  try {
    const result = await pool.query(`
      WITH recent_sessions AS (
        SELECT
          session_id,
          count(*)::int                                   AS total,
          count(*) FILTER (WHERE relevant  = true)::int   AS rel_count,
          count(*) FILTER (WHERE sufficient = true)::int  AS suf_count
        FROM ${SCHEMA}.tool_feedback
        WHERE session_id IS NOT NULL
          AND created_at > NOW() - INTERVAL '30 days'
        GROUP BY session_id
        HAVING count(*) >= 1
        ORDER BY MAX(created_at) DESC
        LIMIT $1
      )
      SELECT
        COUNT(*)::int                                AS sample_sessions,
        AVG(
          LEAST(rel_count::float, 5.0) / LEAST(total::float, 5.0)
        )                                           AS avg_precision_at_5,
        AVG(suf_count::float / total::float)        AS avg_sufficient_rate
      FROM recent_sessions
    `, [windowSessions]);

    const row = result.rows[0];
    return {
      precision_at_5 : row.avg_precision_at_5  !== null ? parseFloat(row.avg_precision_at_5)  : null,
      sufficient_rate: row.avg_sufficient_rate  !== null ? parseFloat(row.avg_sufficient_rate) : null,
      sample_sessions: parseInt(row.sample_sessions) || 0
    };
  } catch {
    return { precision_at_5: null, sample_sessions: 0, sufficient_rate: null };
  }
}

/** DB 미가용·쿼리 실패 시 반환하는 중립 형태 */
function emptyTaskSuccess() {
  return {
    success_rate             : null,
    total_sessions           : 0,
    completed_rate           : null,
    outcome_reported_sessions: 0,
    outcome_counts           : {
      completed : 0, partial: 0, blocked: 0,
      abandoned : 0, unknown: 0, unreported: 0
    }
  };
}

/**
 * task_feedback 기반 downstream task 성공률과 outcome 분포
 *
 * `completed_rate`는 outcome을 실제로 보고한 세션만 분모로 삼는다. 미보고를
 * 실패로 뭉뚱그리면 자기보고 편향이 성공률에 그대로 반영되기 때문이다.
 *
 * @param {number} [windowDays=30]
 * @returns {Promise<{ success_rate: number|null, total_sessions: number,
 *   completed_rate: number|null, outcome_reported_sessions: number, outcome_counts: Object }>}
 */
export async function computeTaskSuccessRate(windowDays = 30) {
  const pool = getPrimaryPool();
  if (!pool) return emptyTaskSuccess();

  try {
    const result = await pool.query(
      `SELECT
         count(*)::int                                        AS total_sessions,
         count(*) FILTER (WHERE overall_success = true)::int AS success_count,
         count(*) FILTER (WHERE outcome IS NOT NULL)::int    AS reported_sessions,
         count(*) FILTER (WHERE outcome = 'completed')::int  AS outcome_completed,
         count(*) FILTER (WHERE outcome = 'partial')::int    AS outcome_partial,
         count(*) FILTER (WHERE outcome = 'blocked')::int    AS outcome_blocked,
         count(*) FILTER (WHERE outcome = 'abandoned')::int  AS outcome_abandoned,
         count(*) FILTER (WHERE outcome = 'unknown')::int    AS outcome_unknown
       FROM ${SCHEMA}.task_feedback
       WHERE created_at > NOW() - ($1 || ' days')::INTERVAL`,
      [windowDays]
    );

    const row       = result.rows[0];
    const total     = parseInt(row.total_sessions)    || 0;
    const succ      = parseInt(row.success_count)     || 0;
    const reported  = parseInt(row.reported_sessions) || 0;
    const completed = parseInt(row.outcome_completed) || 0;

    return {
      success_rate             : total > 0 ? succ / total : null,
      total_sessions           : total,
      completed_rate           : reported > 0 ? completed / reported : null,
      outcome_reported_sessions: reported,
      outcome_counts           : {
        completed,
        partial   : parseInt(row.outcome_partial)   || 0,
        blocked   : parseInt(row.outcome_blocked)   || 0,
        abandoned : parseInt(row.outcome_abandoned) || 0,
        unknown   : parseInt(row.outcome_unknown)   || 0,
        unreported: Math.max(0, total - reported)
      }
    };
  } catch {
    return emptyTaskSuccess();
  }
}

/** DB 미가용·쿼리 실패 시 반환하는 중립 형태 */
function emptyIrrelevance() {
  return {
    total_irrelevant: 0,
    reported        : 0,
    counts          : {
      not_stored    : 0, search_miss: 0, scope_leak: 0,
      topic_mismatch: 0, other      : 0, unreported: 0
    }
  };
}

/**
 * relevant=false 피드백의 원인 분포
 *
 * not_stored 우세는 저장 습관 문제, search_miss 우세는 검색 리콜 문제,
 * scope_leak 우세는 스코프 격리 문제를 가리킨다.
 *
 * @param {number} [windowDays=30]
 * @returns {Promise<{ total_irrelevant: number, reported: number, counts: Object }>}
 */
export async function computeIrrelevanceBreakdown(windowDays = 30) {
  const pool = getPrimaryPool();
  if (!pool) return emptyIrrelevance();

  try {
    const result = await pool.query(
      `SELECT
         count(*) FILTER (WHERE relevant = false)::int                      AS total_irrelevant,
         count(*) FILTER (WHERE irrelevance_reason IS NOT NULL)::int        AS reported,
         count(*) FILTER (WHERE irrelevance_reason = 'not_stored')::int     AS not_stored,
         count(*) FILTER (WHERE irrelevance_reason = 'search_miss')::int    AS search_miss,
         count(*) FILTER (WHERE irrelevance_reason = 'scope_leak')::int     AS scope_leak,
         count(*) FILTER (WHERE irrelevance_reason = 'topic_mismatch')::int AS topic_mismatch,
         count(*) FILTER (WHERE irrelevance_reason = 'other')::int          AS other
       FROM ${SCHEMA}.tool_feedback
       WHERE created_at > NOW() - ($1 || ' days')::INTERVAL`,
      [windowDays]
    );

    const row      = result.rows[0];
    const total    = parseInt(row.total_irrelevant) || 0;
    const reported = parseInt(row.reported)         || 0;

    return {
      total_irrelevant: total,
      reported,
      counts          : {
        not_stored    : parseInt(row.not_stored)     || 0,
        search_miss   : parseInt(row.search_miss)    || 0,
        scope_leak    : parseInt(row.scope_leak)     || 0,
        topic_mismatch: parseInt(row.topic_mismatch) || 0,
        other         : parseInt(row.other)          || 0,
        unreported    : Math.max(0, total - reported)
      }
    };
  } catch {
    return emptyIrrelevance();
  }
}
