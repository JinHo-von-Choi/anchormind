/**
 * FragmentFieldFilter - recall 파편 조건의 SQL 조각
 *
 * 작성자: 최진호
 * 작성일: 2026-10-31
 *
 * recall의 파편 조건(type, topic, caseId, resolutionStatus, phase, affect, minImportance)과 기간(timeRange)을
 * SQL 조건으로 만든다. 그래프 이웃, 연결 확장, 벡터·구간·역질의 검색처럼 LIMIT으로 후보를 자르는 경로는
 * 이 조건을 LIMIT 앞에 걸어야 한다. 자른 뒤 JS(SearchScope)에서 거르면 조건에 맞지 않는 상위 후보가 자리를
 * 차지해 맞는 파편이 빠진다. 값이 비어 있는 조건은 만들지 않는다.
 */

import { timeRangeColumnSql } from "../WorldTime.js";

/**
 * 파편 조건 배열. 바인딩 값은 params에 더한다.
 *
 * @param {Array}  params
 * @param {{type?: string, topic?: string, caseId?: string, resolutionStatus?: string, phase?: string,
 *   affect?: string|string[], minImportance?: number}} [filters]
 * @param {string} [alias="f"] fragments 별칭
 * @returns {string[]}
 */
export function fragmentFieldConditions(params, filters = {}, alias = "f") {
  const clauses = [];
  const equal = (column, value) => {
    if (value === undefined || value === null || value === "") return;
    clauses.push(`${alias}.${column} = $${params.push(value)}`);
  };
  equal("type",              filters.type);
  equal("topic",             filters.topic);
  equal("case_id",           filters.caseId);
  equal("resolution_status", filters.resolutionStatus);
  equal("phase",             filters.phase);
  if (Array.isArray(filters.affect) && filters.affect.length > 0) {
    clauses.push(`${alias}.affect = ANY($${params.push(filters.affect)})`);
  } else {
    equal("affect", typeof filters.affect === "string" ? filters.affect : undefined);
  }
  if (typeof filters.minImportance === "number") {
    clauses.push(`${alias}.importance >= $${params.push(filters.minImportance)}`);
  }
  return clauses;
}

/**
 * 기간 [from, to) 조건 배열. basis=event면 세계 시각, 그 밖은 created_at을 본다.
 *
 * @param {Array} params
 * @param {{from?: Date|string|null, to?: Date|string|null, basis?: string}|null} timeRange
 * @param {string} [alias="f"]
 * @returns {string[]}
 */
export function timeRangeConditions(params, timeRange, alias = "f") {
  if (!timeRange) return [];
  const column  = timeRangeColumnSql(timeRange.basis, alias);
  const clauses = [];
  if (timeRange.from) clauses.push(`${column} >= $${params.push(timeRange.from)}`);
  if (timeRange.to)   clauses.push(`${column} < $${params.push(timeRange.to)}`);
  return clauses;
}

/**
 * 조건 배열을 WHERE 뒤에 이어 붙일 " AND ..." 문자열로 바꾼다.
 *
 * @param {string[]} clauses
 * @returns {string}
 */
export function andClauses(clauses) {
  return clauses.map(c => ` AND ${c}`).join("");
}

/**
 * 정규화된 검색 질의에서 SQL로 넘길 파편 조건을 뽑는다. minImportance는 호출자가 숫자로 준 경우만 넣는다.
 *
 * @param {Object} sq
 * @returns {{type?: string, topic?: string, caseId?: string, resolutionStatus?: string, phase?: string,
 *   affect?: string|string[], minImportance?: number}}
 */
export function searchFieldFilters(sq) {
  return {
    type            : sq.type ?? undefined,
    topic           : sq.topic ?? undefined,
    caseId          : sq.caseId ?? undefined,
    resolutionStatus: sq.resolutionStatus ?? undefined,
    phase           : sq.phase ?? undefined,
    affect          : sq.affect ?? undefined,
    ...(typeof sq.minImportance === "number" ? { minImportance: sq.minImportance } : {})
  };
}
