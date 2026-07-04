/**
 * SearchEventAnalyzer — 검색 이벤트 관측성 분석
 *
 * L1 miss rate, 필터 분포, 경로별 관련성 집계를 제공하는
 * 순수 함수 + DB 집계 쿼리 모듈.
 *
 * 작성자: 최진호
 * 작성일: 2026-03-25
 */

import { getPrimaryPool } from "../../tools/db.js";

/* ─────────────────────────────────────────────────────────────────────────── */
/*  Pure functions                                                              */
/* ─────────────────────────────────────────────────────────────────────────── */

/**
 * L1 캐시 miss rate를 계산한다.
 *
 * @param {Array<{ l1_is_fallback: boolean }>} rows
 * @returns {number|null} 0~1 사이의 miss rate, 빈 배열이면 null
 */
export function computeL1MissRate(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const fallbackCount = rows.filter(r => r.l1_is_fallback === true).length;
  const rate          = fallbackCount / rows.length;

  return parseFloat(rate.toFixed(4));
}

/**
 * filter_keys 배열에 등장하는 각 키의 사용 빈도를 집계한다.
 *
 * @param {Array<{ filter_keys: string[]|null|undefined }>} rows
 * @returns {Object<string, number>} 키별 카운트 맵
 */
export function computeFilterDistribution(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return {};

  /** @type {Object<string, number>} */
  const dist = {};

  for (const row of rows) {
    const keys = row?.filter_keys;
    if (!Array.isArray(keys) || keys.length === 0) continue;

    for (const key of keys) {
      if (key == null || key === "") continue;
      dist[key] = (dist[key] ?? 0) + 1;
    }
  }

  return dist;
}

/* ─────────────────────────────────────────────────────────────────────────── */
/*  DB analytics                                                                */
/* ─────────────────────────────────────────────────────────────────────────── */

/**
 * 지정 기간의 검색 이벤트 관측성 데이터를 집계하여 반환한다.
 *
 * 내부적으로 3개의 병렬 쿼리를 실행한다:
 *  - overview       : 전체 집계 (총 검색 수, avg latency, RRF/L3 비율 등)
 *  - path_relevance : query_type × used_rrf 별 관련성 피드백 집계
 *  - filter_distribution : unnest(filter_keys) 별 사용 빈도
 *
 * @param {number} [windowDays=30] 집계 기간 (일 단위)
 * @returns {Promise<object|null>}
 */
export async function getSearchObservability(windowDays = 30) {
  const pool = getPrimaryPool();
  if (!pool) return null;

  const SQL_OVERVIEW = `
    SELECT
      count(*)::int                                        AS total_searches,
      count(*) FILTER (WHERE l1_is_fallback)::int         AS l1_fallback_count,
      avg(result_count)::real                             AS avg_result_count,
      avg(latency_ms)::real                               AS avg_latency_ms,
      count(*) FILTER (WHERE used_rrf)::int               AS rrf_count,
      count(*) FILTER (WHERE l3_count > 0)::int           AS l3_used_count
    FROM agent_memory.search_events
    WHERE created_at > NOW() - ($1 || ' days')::INTERVAL
  `;

  const SQL_PATH_RELEVANCE = `
    SELECT
      se.query_type, se.used_rrf,
      count(*)::int                                           AS search_count,
      count(tf.id)::int                                       AS feedback_count,
      count(*) FILTER (WHERE tf.relevant = true)::int        AS relevant_count,
      count(*) FILTER (WHERE tf.sufficient = true)::int      AS sufficient_count
    FROM agent_memory.search_events se
    LEFT JOIN agent_memory.tool_feedback tf ON tf.search_event_id = se.id
    WHERE se.created_at > NOW() - ($1 || ' days')::INTERVAL
    GROUP BY se.query_type, se.used_rrf
    ORDER BY search_count DESC
  `;

  const SQL_FILTER_DIST = `
    SELECT
      unnest(filter_keys) AS filter_key,
      count(*)::int       AS usage_count
    FROM agent_memory.search_events
    WHERE created_at > NOW() - ($1 || ' days')::INTERVAL
      AND filter_keys IS NOT NULL
      AND array_length(filter_keys, 1) > 0
    GROUP BY filter_key
    ORDER BY usage_count DESC
  `;

  try {
    const [overview, pathRelevance, filterDist] = await Promise.all([
      pool.query(SQL_OVERVIEW,       [windowDays]),
      pool.query(SQL_PATH_RELEVANCE, [windowDays]),
      pool.query(SQL_FILTER_DIST,    [windowDays]),
    ]);

    const row            = overview.rows[0] ?? {};
    const totalSearches  = row.total_searches   ?? 0;
    const l1FallbackCnt  = row.l1_fallback_count ?? 0;
    const l3UsedCnt      = row.l3_used_count     ?? 0;
    const rrfCnt         = row.rrf_count         ?? 0;

    const l1MissRate   = totalSearches > 0 ? parseFloat((l1FallbackCnt / totalSearches).toFixed(4)) : null;
    const l3UsageRate  = totalSearches > 0 ? parseFloat((l3UsedCnt     / totalSearches).toFixed(4)) : null;
    const rrfUsageRate = totalSearches > 0 ? parseFloat((rrfCnt        / totalSearches).toFixed(4)) : null;

    const avgResultCount  = row.avg_result_count != null ? parseFloat(parseFloat(row.avg_result_count).toFixed(1))  : null;
    const avgLatencyMs    = row.avg_latency_ms   != null ? parseFloat(parseFloat(row.avg_latency_ms).toFixed(1))    : null;

    return {
      window_days       : windowDays,
      total_searches    : totalSearches,
      l1_miss_rate      : l1MissRate,
      l3_usage_rate     : l3UsageRate,
      rrf_usage_rate    : rrfUsageRate,
      avg_result_count  : avgResultCount,
      avg_latency_ms    : avgLatencyMs,
      path_relevance    : pathRelevance.rows,
      filter_distribution: filterDist.rows
    };
  } catch {
    return null;
  }
}

/**
 * 검색 경로별 레이어 레이턴시 성능을 집계하여 반환한다.
 *
 * search_path × used_rrf 조합별로 총 검색 횟수, 평균 전체/레이어별 레이턴시,
 * 평균 결과 수를 집계한다. migration-020 이후 수집된 데이터만 유효하다.
 *
 * @param {number} [days=7] 집계 기간 (일 단위)
 * @returns {Promise<Array<object>|null>}
 */
export async function getPathPerformance(days = 7) {
  const pool = getPrimaryPool();
  if (!pool) return null;

  const SQL = `
    SELECT
      search_path,
      used_rrf,
      COUNT(*)::int                             AS search_count,
      ROUND(AVG(latency_ms)::numeric, 1)        AS avg_latency_ms,
      ROUND(AVG(result_count)::numeric, 1)      AS avg_result_count,
      ROUND(AVG(l1_latency_ms)::numeric, 1)     AS avg_l1_ms,
      ROUND(AVG(l2_latency_ms)::numeric, 1)     AS avg_l2_ms,
      ROUND(AVG(l3_latency_ms)::numeric, 1)     AS avg_l3_ms
    FROM agent_memory.search_events
    WHERE created_at > NOW() - INTERVAL '1 day' * $1
    GROUP BY search_path, used_rrf
    ORDER BY search_count DESC
  `;

  try {
    const { rows } = await pool.query(SQL, [days]);
    return rows;
  } catch {
    return null;
  }
}
