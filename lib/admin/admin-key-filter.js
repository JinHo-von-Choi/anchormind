/**
 * 관리 조회의 키 선택 조건 생성기
 *
 * 작성자: 최진호
 * 작성일: 2026-10-31
 *
 * 파편 상세 조회는 group_id, key_id, key_ids 쿼리 인자로 볼 키를 고른다. 본체 파편과 연결 미리보기에
 * 같은 조건을 걸어야 연결 미리보기에 다른 키 소유 파편이 섞이지 않는다.
 */

import { SCHEMA } from "../memory/schema.js";
import { keyScopeClause, keyScopeCondition } from "../memory/keyScope.js";

/**
 * 키 선택 조건 배열을 만든다. group_id가 있으면 key_id보다 우선한다.
 *
 * @param {Array}  params 바인딩 배열 (in-place로 push된다)
 * @param {string} column 비교 대상 컬럼 (예: "f.key_id")
 * @param {{memberKeyIds: string[]|null, keyId: string|null, kidScope: {keyId: string|null, groupKeyIds: string[]|null}}} selector
 * @returns {string[]} AND로 이을 조건 문자열 배열
 */
export function keySelectorConditions(params, column, { memberKeyIds, keyId, kidScope }) {
  const conditions = [];
  if (memberKeyIds) conditions.push(keyScopeCondition(params, column, memberKeyIds));
  else if (keyId) conditions.push(keyScopeCondition(params, column, keyId));
  if (kidScope.keyId) conditions.push(keyScopeClause(params, column, kidScope).replace(/^ AND /, ""));
  return conditions;
}

/**
 * key_ids 콤마 구분 쿼리 파라미터를 스코프 객체로 파싱한다.
 * keyScopeClause / 처리기(_keyId/_groupKeyIds) 양쪽에서 재사용한다.
 * key_ids 미지정(마스터 전체 접근)이면 { keyId: null, groupKeyIds: null }.
 *
 * @param {URL} url
 * @returns {{ keyId: string|null, groupKeyIds: string[]|null }}
 */
export function parseKeyIdsScope(url) {
  const raw = url.searchParams.get("key_ids");
  if (!raw) return { keyId: null, groupKeyIds: null };
  const ids = raw.split(",").map(s => s.trim()).filter(Boolean);
  if (ids.length === 0) return { keyId: null, groupKeyIds: null };
  return { keyId: ids[0], groupKeyIds: ids };
}

/**
 * group_id에 속한 key_id 목록 조회
 * @param {import('pg').Pool} pool
 * @param {string} groupId
 * @returns {Promise<string[]>}
 */
export async function fetchGroupKeyIds(pool, groupId) {
  const { rows } = await pool.query(
    `SELECT key_id FROM ${SCHEMA}.api_key_group_members WHERE group_id = $1`,
    [groupId]
  );
  return rows.map(r => r.key_id);
}
