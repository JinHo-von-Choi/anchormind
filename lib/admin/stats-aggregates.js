/**
 * 관리 /stats의 DB 집계와 짧은 재사용
 *
 * 작성자: 최진호
 * 작성일: 2026-11-04
 *
 * 관리 콘솔은 열려 있는 동안 30초마다 /stats를 부른다. 이 응답의 DB 집계(파편 상태 수, 상위 topic, 오늘 호출 수,
 * 활성 키 수, 검색 관측, 경로별 성능, DB 크기)는 파편 표 전체를 세므로 한 번에 1초 가까이 걸린다(운영 측정 약
 * 0.8초). 콘솔이 여러 개 열려 있으면 그만큼 늘어난다. 같은 판정 범위의 집계는 MEMENTO_ADMIN_STATS_CACHE_MS
 * (기본 60000, 0이면 끔) 동안 재사용하고, 동시에 들어온 요청은 진행 중인 집계 하나를 기다린다.
 */

import { getSearchObservability, getPathPerformance } from "../memory/signals/SearchEventAnalyzer.js";
import { countFragmentHealth } from "./FragmentHealth.js";
import { scopedQuery, WORKSPACE_COLUMN } from "./ScopeFilter.js";
import { SCHEMA } from "../memory/schema.js";
import { envInt } from "../config.js";
import { queryScoped, ROW_SUBJECT } from "../tools/row-scope.js";

/** 범위별 { at, promise } */
const entries = new Map();

/**
 * 재사용 시간(ms). 호출 시점의 환경 변수를 읽는다.
 *
 * @returns {number}
 */
export function statsCacheMs() {
  return envInt("MEMENTO_ADMIN_STATS_CACHE_MS", 60_000, { min: 0, max: 3_600_000, fallback: true });
}

/**
 * DB 집계를 새로 계산한다. 추가 소스(검색 관측, 경로 성능, DB 크기)는 하나가 실패해도 나머지를 쓴다.
 *
 * @param {import("pg").Pool} pool
 * @param {object} scope 관리 판정 범위
 */
async function compute(pool, scope) {
  const extrasP = Promise.allSettled([
    getSearchObservability(7),
    getPathPerformance(7),
    queryScoped(pool, "SELECT pg_database_size(current_database()) AS bytes", undefined, ROW_SUBJECT.ADMIN)
  ]);
  const [health, callR, keyR, topicR] = await Promise.all([
    countFragmentHealth(pool, scope),
    queryScoped(pool, `SELECT COALESCE(SUM(call_count),0) AS total, COALESCE(SUM(tool_call_count),0) AS tool_calls
                  FROM ${SCHEMA}.api_key_usage
                 WHERE usage_date = CURRENT_DATE`, undefined, ROW_SUBJECT.ADMIN),
    queryScoped(pool, `SELECT COUNT(*) AS total FROM ${SCHEMA}.api_keys WHERE status='active'`, undefined, ROW_SUBJECT.ADMIN),
    queryScoped(pool, ...scopedQuery(WORKSPACE_COLUMN, scope, (ws) => `SELECT topic, COUNT(*)::int AS count
                  FROM ${SCHEMA}.fragments
                 WHERE valid_to IS NULL AND ${ws}
                 GROUP BY topic ORDER BY count DESC LIMIT 5`), ROW_SUBJECT.ADMIN)
  ]);
  const [obsResult, ppResult, dbSizeResult] = await extrasP;
  return {
    health,
    topTopics      : topicR.rows,
    apiCallsToday  : parseInt(callR.rows[0].total),
    toolCallsToday : parseInt(callR.rows[0].tool_calls),
    activeKeys     : parseInt(keyR.rows[0].total),
    observability  : obsResult.status === "fulfilled" ? obsResult.value : null,
    pathPerformance: ppResult.status === "fulfilled" ? ppResult.value : null,
    dbSizeBytes    : dbSizeResult.status === "fulfilled" ? parseInt(dbSizeResult.value.rows[0]?.bytes ?? 0) : 0
  };
}

/**
 * 판정 범위의 DB 집계. 재사용 시간 안이면 앞선 결과(또는 진행 중인 계산)를 돌려준다. 실패한 계산은 남기지 않는다.
 *
 * @param {import("pg").Pool} pool
 * @param {object} scope
 * @param {number} [now]
 * @returns {Promise<object>}
 */
export function loadStatsAggregates(pool, scope, now = Date.now()) {
  const ttl = statsCacheMs();
  if (ttl === 0) return compute(pool, scope);
  const key = JSON.stringify(scope ?? null);
  const hit = entries.get(key);
  if (hit && now - hit.at < ttl) return hit.promise;
  const promise = compute(pool, scope);
  entries.set(key, { at: now, promise });
  promise.catch(() => { if (entries.get(key)?.promise === promise) entries.delete(key); });
  return promise;
}

/** 시험용: 재사용 중인 집계를 비운다. */
export function resetStatsAggregates() {
  entries.clear();
}
