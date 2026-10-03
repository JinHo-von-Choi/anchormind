/**
 * 파편 행 잠금 문장
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 파편 행을 여러 개 갱신하거나 지우는 경로는 queryWithAgentVector 의 lock 옵션으로 대상 행을
 * id 오름차순으로 먼저 잠그고, 같은 트랜잭션의 다음 문장에서 잠근 행($1)만 쓴다. 이 모듈은 그
 * 잠금 문장과 잠근 행을 지우는 문장을 만든다.
 *
 * 잠금과 쓰기를 한 문장(잠금 CTE + UPDATE ... FROM)으로 합치지 않는 이유: 그 문장의 갱신 단계는
 * 문장 시작 시점의 스냅숏이 보는 행 버전을 대상으로 한다. 잠금 단계가 갱신 체인을 따라가 최신
 * 버전을 잠갔더라도 갱신 단계는 이전 버전을 다시 건드리고, 그 버전의 xmax가 살아 있는 키 공유
 * 잠금을 담은 multixact이면 이전 버전의 튜플 잠금을 기다린다. 그 튜플 잠금을 쥔 다른 트랜잭션이
 * 이 트랜잭션이 잠근 최신 버전을 기다리면 id 순서와 무관하게 교착이 된다. 쓰기를 다음 문장으로
 * 나누면 그 문장의 스냅숏은 이미 잠근 최신 버전을 보므로 쓰기 단계는 어떤 잠금도 기다리지 않는다.
 */

import { SCHEMA } from "../schema.js";

/** 앞선 잠금 문장이 잠근 행($1)을 지우는 문장. 필요하면 RETURNING 을 덧붙인다. */
export const DELETE_LOCKED_SQL = `DELETE FROM ${SCHEMA}.fragments WHERE id = ANY($1::text[])`;

/** 행 잠금 강도. 비키 열 갱신은 NO KEY UPDATE, 삭제는 UPDATE. */
export const LOCK_FOR_WRITE  = "FOR NO KEY UPDATE";
export const LOCK_FOR_DELETE = "FOR UPDATE";

/**
 * 조건에 맞는 파편 행을 id 오름차순으로 잠그는 lock 옵션 값을 만든다.
 *
 * @param {string} operation lock-retry 의 operation 이름
 * @param {string} where     fragments 의 별칭 없는 컬럼 조건. params 의 자리표시자를 쓴다
 * @param {Array}  [params]
 * @param {string} [strength=LOCK_FOR_WRITE]
 * @returns {{operation: string, sql: string, params: Array}}
 */
export function fragmentRowLock(operation, where, params = [], strength = LOCK_FOR_WRITE) {
  return {
    operation,
    sql: `SELECT id FROM ${SCHEMA}.fragments WHERE ${where} ORDER BY id ${strength}`,
    params
  };
}
