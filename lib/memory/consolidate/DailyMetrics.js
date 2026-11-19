/**
 * DailyMetrics - 경험 신호 일별 집계
 *
 * 작성자: 최진호
 * 작성일: 2026-11-19
 *
 * 정리 주기의 daily_metrics 단계다. 끝난 날(UTC 어제)의 지표를 memory_daily_metrics(migration-083)에 키별로 쓴다.
 * search_events는 30일 뒤 지워지지만 이 표는 남는다. 같은 날을 다시 계산하면 값을 덮어쓴다. 이미 계산한 날은
 * 건너뛴다. key_id가 없는 행(마스터 키)은 빈 문자열로 묶는다.
 *
 *   observed_use_rate     그날 recall이 돌려준 파편 가운데 그날 사용 사건(fragment_use_events)이 생긴 비율
 *   feedback_report_rate  그날 검색 이벤트 가운데 tool_feedback이 그 이벤트를 가리킨 비율
 *   lesson_return_rate    그날 검색 이벤트 가운데 교훈 파편을 하나 이상 돌려준 비율
 *   lesson_helped_rate    그날 보고된 교훈 결과 가운데 helped의 비율(not_applicable 제외)
 *   unused_30d_rate       30일 전 그날 만든 파편 가운데 만든 뒤 30일 안에 사용 사건이 없는 비율
 *
 * 비율마다 분자와 분모를 함께 남긴다. 분모가 0이면 값은 NULL이다.
 */

import { queryWithAgentVector } from "../../tools/db.js";
import { SCHEMA }               from "../schema.js";
import { lessonPredicateSql }   from "../write/LessonSummary.js";

/** 일별 지표 이름 */
export const DAILY_METRICS = Object.freeze({
  OBSERVED_USE_RATE   : "observed_use_rate",
  FEEDBACK_REPORT_RATE: "feedback_report_rate",
  LESSON_RETURN_RATE  : "lesson_return_rate",
  LESSON_HELPED_RATE  : "lesson_helped_rate",
  UNUSED_30D_RATE     : "unused_30d_rate"
});

/** 일별 지표 질의. $1은 집계할 날(date)이다. 행은 (k, num, den)이다. */
const METRIC_SQL = Object.freeze({
  [DAILY_METRICS.OBSERVED_USE_RATE]: `
    WITH returned AS (
      SELECT DISTINCT COALESCE(se.key_id, '') AS k, u.id
        FROM ${SCHEMA}.search_events se, unnest(se.selected_fragment_ids) AS u(id)
       WHERE se.created_at >= $1::date AND se.created_at < $1::date + 1
    ), used AS (
      SELECT DISTINCT fragment_id FROM ${SCHEMA}.fragment_use_events
       WHERE created_at >= $1::date AND created_at < $1::date + 1
    )
    SELECT r.k, count(u.fragment_id)::bigint AS num, count(*)::bigint AS den
      FROM returned r LEFT JOIN used u ON u.fragment_id = r.id
     GROUP BY r.k`,
  [DAILY_METRICS.FEEDBACK_REPORT_RATE]: `
    SELECT COALESCE(se.key_id, '') AS k,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM ${SCHEMA}.tool_feedback tf WHERE tf.search_event_id = se.id))::bigint AS num,
           count(*)::bigint AS den
      FROM ${SCHEMA}.search_events se
     WHERE se.created_at >= $1::date AND se.created_at < $1::date + 1
     GROUP BY 1`,
  [DAILY_METRICS.LESSON_RETURN_RATE]: `
    SELECT COALESCE(se.key_id, '') AS k,
           count(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM unnest(se.selected_fragment_ids) AS u(id)
               JOIN ${SCHEMA}.fragments f ON f.id = u.id
              WHERE ${lessonPredicateSql("f")}))::bigint AS num,
           count(*)::bigint AS den
      FROM ${SCHEMA}.search_events se
     WHERE se.created_at >= $1::date AND se.created_at < $1::date + 1
     GROUP BY 1`,
  [DAILY_METRICS.LESSON_HELPED_RATE]: `
    SELECT COALESCE(key_id, '') AS k,
           count(*) FILTER (WHERE outcome = 'helped')::bigint AS num,
           count(*) FILTER (WHERE outcome IN ('helped', 'failed'))::bigint AS den
      FROM ${SCHEMA}.lesson_outcomes
     WHERE created_at >= $1::date AND created_at < $1::date + 1
     GROUP BY 1`,
  [DAILY_METRICS.UNUSED_30D_RATE]: `
    SELECT COALESCE(f.key_id, '') AS k,
           count(*) FILTER (WHERE NOT EXISTS (
             SELECT 1 FROM ${SCHEMA}.fragment_use_events e
              WHERE e.fragment_id = f.id AND e.created_at < f.created_at + INTERVAL '30 days'))::bigint AS num,
           count(*)::bigint AS den
      FROM ${SCHEMA}.fragments f
     WHERE f.created_at >= $1::date - 30 AND f.created_at < $1::date - 29
     GROUP BY 1`
});

/**
 * 집계 행을 지표 행으로 바꾼다. 분모가 0이면 값은 null이다.
 *
 * @param {string} metric
 * @param {Array<{k: string, num: string|number, den: string|number}>} rows
 * @returns {Array<{k: string, metric: string, value: number|null, num: number, den: number}>}
 */
export function toMetricRows(metric, rows) {
  return rows.map(r => {
    const num = Number(r.num), den = Number(r.den);
    return { k: r.k ?? "", metric, value: den > 0 ? num / den : null, num, den };
  });
}

/**
 * 집계할 날. 지금 UTC 날짜의 전날(YYYY-MM-DD).
 *
 * @param {Date} [now]
 * @returns {string}
 */
export function previousUtcDay(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1)).toISOString().slice(0, 10);
}

/**
 * 하루치 지표를 계산해 쓴다. 이미 쓴 날이면 계산하지 않는다.
 *
 * @param {{day?: string, query?: (sql: string, params: Array, opts?: unknown) => Promise<{rows: Array}>, force?: boolean}} [options]
 * @returns {Promise<number>} 쓴 지표 행 수
 */
export async function computeDailyMetrics({
  day = previousUtcDay(),
  query = (sql, params, opts) => queryWithAgentVector("system", sql, params, opts),
  force = false
} = {}) {
  if (!force) {
    const { rows } = await query(
      `SELECT 1 FROM ${SCHEMA}.memory_daily_metrics WHERE day = $1::date AND metric = $2 LIMIT 1`,
      [day, DAILY_METRICS.OBSERVED_USE_RATE]
    );
    if (rows.length > 0) return 0;
  }

  const out = [];
  for (const [metric, sql] of Object.entries(METRIC_SQL)) {
    const { rows } = await query(sql, [day]);
    out.push(...toMetricRows(metric, rows));
  }
  if (out.length === 0) return 0;

  await query(
    `INSERT INTO ${SCHEMA}.memory_daily_metrics (day, key_id, metric, value, numerator, denominator)
     SELECT $1::date, k, m, v, n, d
       FROM unnest($2::text[], $3::text[], $4::float8[], $5::bigint[], $6::bigint[]) AS t(k, m, v, n, d)
     ON CONFLICT (day, key_id, metric) DO UPDATE
       SET value = EXCLUDED.value, numerator = EXCLUDED.numerator, denominator = EXCLUDED.denominator,
           computed_at = NOW()`,
    [day, out.map(r => r.k), out.map(r => r.metric), out.map(r => r.value), out.map(r => r.num), out.map(r => r.den)],
    "write"
  );
  return out.length;
}
