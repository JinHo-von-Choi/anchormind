/**
 * LinkedFragmentLoader - recall 결과에 1-hop 링크 파편 조회
 *
 * 작성자: 최진호
 * 작성일: 2026-03-28
 *
 * 모든 결과 파편 ID를 1회 쿼리로 조회하여 from_id별 상위 3개 링크를 반환한다.
 */

import { getPrimaryPool } from "../../tools/db.js";
import { SCHEMA } from "../schema.js";

/**
 * 주어진 파편 ID 배열에 대해 1-hop 연결 파편을 조회한다.
 *
 * @param {string[]} fragmentIds - 조회 대상 파편 ID 배열
 * @returns {Promise<Map<string, Array<{id: string, relation_type: string, preview: string}>>>}
 *          from_id -> [linked fragment] (최대 3개씩)
 */
export async function fetchLinkedFragments(fragmentIds) {
  if (!fragmentIds || fragmentIds.length === 0) return new Map();

  const pool = getPrimaryPool();

  /**
   * LATERAL JOIN으로 from_id별 상위 3개를 효율적으로 가져온다.
   * weight DESC로 가장 강한 관계부터 반환.
   */
  const { rows } = await pool.query(
    `SELECT sub.from_id, sub.to_id, sub.relation_type, sub.preview
       FROM unnest($1::text[]) AS fid(id)
       CROSS JOIN LATERAL (
         SELECT fl.from_id, fl.to_id, fl.relation_type, LEFT(f.content, 60) AS preview
           FROM ${SCHEMA}.fragment_links fl
           JOIN ${SCHEMA}.fragments f ON f.id = fl.to_id
          WHERE fl.from_id = fid.id
            AND f.valid_to IS NULL
          ORDER BY fl.weight DESC
          LIMIT 3
       ) sub`,
    [fragmentIds]
  );

  const result = new Map();
  for (const row of rows) {
    const entry = {
      id           : row.to_id,
      relation_type: row.relation_type,
      preview      : row.preview
    };
    if (result.has(row.from_id)) {
      result.get(row.from_id).push(entry);
    } else {
      result.set(row.from_id, [entry]);
    }
  }

  return result;
}
