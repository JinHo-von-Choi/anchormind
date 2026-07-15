/**
 * KeyNameEnricher - 파편에 생성 키의 key_id/key_name을 덧붙이는 후처리기
 *
 * 작성자: 최진호
 * 작성일: 2026-07-15
 *
 * recall/context에서 includeKeyName=true일 때만 호출된다.
 * 입력 파편은 이미 키/그룹 스코프 필터를 통과한 상태이므로
 * 같은 API 키 그룹 범위 밖의 이름이 노출될 경로는 없다.
 */

import { getPrimaryPool } from "../../tools/db.js";
import { logWarn }        from "../../logger.js";

/**
 * fragment id 기준으로 조회 행(id, key_id, key_name)을 파편에 매핑한다.
 * 매칭 행이 없는 파편은 원본 그대로 둔다. 입력을 변형하지 않는다.
 *
 * @param {Object[]} fragments - 파편 배열
 * @param {Array<{id: string, key_id: string|null, key_name: string|null}>} rows
 * @returns {Object[]} key_id/key_name이 덧붙은 새 배열
 */
export function attachKeyNames(fragments, rows) {
  const byId = new Map(rows.map(r => [r.id, r]));
  return fragments.map(f => {
    const row = byId.get(f.id);
    return row
      ? { ...f, key_id: row.key_id ?? null, key_name: row.key_name ?? null }
      : f;
  });
}

/**
 * 파편 id 배열로 fragments ⨝ api_keys를 1회 조회하여 key_id/key_name을 덧붙인다.
 * 조회 실패 시 원본 배열을 그대로 반환한다 (graceful degradation).
 * getPrimaryPool()은 항상 풀을 생성 반환하므로(lib/tools/db.js:63) null 가드는 두지 않는다.
 *
 * @param {Object[]} fragments - id 필드를 가진 파편 배열
 * @returns {Promise<Object[]>}
 */
export async function enrichWithKeyNames(fragments) {
  const ids = fragments.map(f => f?.id).filter(Boolean);
  if (ids.length === 0) return fragments;

  try {
    const pool     = getPrimaryPool();
    const { rows } = await pool.query(
      `SELECT f.id, f.key_id, k.name AS key_name
         FROM agent_memory.fragments f
         LEFT JOIN agent_memory.api_keys k ON k.id = f.key_id
        WHERE f.id = ANY($1)`,
      [ids]
    );
    return attachKeyNames(fragments, rows);
  } catch (err) {
    logWarn(`[KeyNameEnricher] lookup failed: ${err.message}`);
    return fragments;
  }
}
