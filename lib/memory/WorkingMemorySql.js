/**
 * WorkingMemorySql - 작업 기억 행 식별과 조회 제외 조건
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * Redis가 준비되지 않았을 때 쓰는 작업 기억 행(source=wm-fallback)을 가리키는 값과, 기억을
 * 보여 주거나 세는 질의가 그 행을 빼는 SQL 조건을 한곳에 둔다. 행은 valid_to가 채워져 기본
 * 조회에서 빠지지만, 닫힌 파편을 포함하는 조회와 valid_to를 보지 않는 집계는 이 조건을 붙인다.
 * 가져오는 것은 스키마 이름뿐이라 DB 모듈을 쓰는 곳에서 부담 없이 가져온다.
 */

import { SCHEMA } from "./schema.js";
import { keyScopeScalar } from "./keyScope.js";

/** 작업 기억 행의 source 값 */
export const WM_FALLBACK_SOURCE = "wm-fallback";

/**
 * 작업 기억 행이 아닌 행만 고르는 조건.
 *
 * @param {string} [alias] - 표 별칭. 비우면 열 이름만 쓴다
 * @returns {string}
 */
export function notWorkingMemoryRow(alias = "") {
  return `${alias ? `${alias}.` : ""}source IS DISTINCT FROM '${WM_FALLBACK_SOURCE}'`;
}

/** 별칭 없는 조건. 문자열 결합에 바로 쓴다 */
export const NOT_WM_ROW = notWorkingMemoryRow();

/**
 * 닫힌 파편의 포함 여부에 따른 유효성 조건. 포함하지 않으면 valid_to IS NULL, 포함하면
 * 작업 기억 행만 뺀다.
 *
 * @param {boolean} include - 닫힌 파편을 포함할지
 * @param {string}  [alias]
 * @returns {string}
 */
export function liveOrClosedCondition(include, alias = "") {
  return include ? notWorkingMemoryRow(alias) : `${alias ? `${alias}.` : ""}valid_to IS NULL`;
}

/**
 * 한 API 키의 작업 기억 행을 모두 지운다. 키 삭제가 키 행을 지우기 전에 부른다. 키가 없으면
 * 아무것도 지우지 않는다.
 *
 * @param {{query: Function}} db - pool 또는 트랜잭션 client
 * @param {string}            keyId
 * @returns {Promise<number>} 지운 행 수
 */
export async function deleteWorkingMemoryRowsOfKey(db, keyId) {
  if (keyId == null) return 0;
  const params = [WM_FALLBACK_SOURCE];
  const result = await db.query(
    `DELETE FROM ${SCHEMA}.fragments
      WHERE source = $1
        AND valid_to IS NOT NULL${keyScopeScalar(params, "key_id", keyId)}`,
    params
  );
  return result.rowCount;
}
