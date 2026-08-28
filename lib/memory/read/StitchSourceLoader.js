/**
 * StitchSourceLoader - 시간·인과 스티칭 전용 소스 조회
 *
 * 작성자: 최진호
 * 작성일: 2026-08-28
 *
 * 범용 링크 로더(LinkedFragmentLoader)는 관계 종류를 가리지 않고 weight 상위 3건만
 * 돌려주므로, ProactiveRecall이 대량 생성하는 related·co_retrieved가 인과 링크를
 * 밀어낸다. 스티칭은 인과 관계가 핵심이므로 관계 종류를 지정해 따로 조회한다.
 *
 * 세션 인접 파편도 source 문자열 대신 session_id 컬럼으로 직접 조회한다.
 * source는 저장 시 절삭될 수 있어 세션 단위 조회의 기준으로 쓸 수 없다.
 */

import { getPrimaryPool } from "../../tools/db.js";
import { keyScopeClause } from "../keyScope.js";

const SCHEMA = "agent_memory";

/** 스티칭에서 인과로 취급하는 관계 종류 */
const CAUSAL_RELATIONS = ["caused_by", "resolved_by", "contradicts", "part_of"];

/**
 * 주어진 파편들의 인과 링크를 양방향으로 조회한다.
 *
 * @param {string[]} fragmentIds
 * @param {{keyId?: string|null, groupKeyIds?: string[]}} [scope]
 * @param {number} [perFragment] 파편당 최대 건수
 * @returns {Promise<Map<string, Array<{id: string, relation_type: string, content: string}>>>}
 */
export async function fetchCausalLinks(fragmentIds, scope = {}, perFragment = 3) {
  if (!fragmentIds || fragmentIds.length === 0) return new Map();

  const pool   = getPrimaryPool();
  if (!pool) return new Map();

  const params = [fragmentIds, CAUSAL_RELATIONS];
  const keyClause = keyScopeClause(params, "f.key_id", {
    keyId      : scope.keyId ?? null,
    groupKeyIds: scope.groupKeyIds,
  });

  /**
   * from_id 기준과 to_id 기준을 합쳐 방향과 무관하게 상대 파편을 얻는다.
   * 역방향은 관계 이름을 그대로 두되 방향 정보를 direction으로 남긴다.
   */
  const { rows } = await pool.query(
    `SELECT anchor_id, other_id, relation_type, direction, content
       FROM (
         SELECT fl.from_id AS anchor_id, fl.to_id AS other_id, fl.relation_type,
                'out'::text AS direction, f.content, fl.weight
           FROM ${SCHEMA}.fragment_links fl
           JOIN ${SCHEMA}.fragments f ON f.id = fl.to_id
          WHERE fl.from_id = ANY($1::text[])
            AND fl.relation_type = ANY($2::text[])
            AND f.valid_to IS NULL${keyClause}
         UNION ALL
         SELECT fl.to_id AS anchor_id, fl.from_id AS other_id, fl.relation_type,
                'in'::text AS direction, f.content, fl.weight
           FROM ${SCHEMA}.fragment_links fl
           JOIN ${SCHEMA}.fragments f ON f.id = fl.from_id
          WHERE fl.to_id = ANY($1::text[])
            AND fl.relation_type = ANY($2::text[])
            AND f.valid_to IS NULL${keyClause}
       ) t
      ORDER BY weight DESC`,
    params
  );

  const result = new Map();
  for (const row of rows) {
    const list = result.get(row.anchor_id) ?? [];
    if (list.length >= perFragment) continue;
    if (list.some(item => item.id === row.other_id)) continue;
    list.push({
      id           : row.other_id,
      relation_type: row.relation_type,
      direction    : row.direction,
      content      : row.content,
    });
    result.set(row.anchor_id, list);
  }
  return result;
}

/**
 * 같은 세션에서 지정 시간창 안에 저장된 이웃 파편을 조회한다.
 *
 * @param {Array<{id: string, session_id: string|null, created_at: string}>} fragments
 * @param {{keyId?: string|null, groupKeyIds?: string[]}} [scope]
 * @param {number} [windowMinutes]
 * @param {number} [perFragment]
 * @returns {Promise<Map<string, Array<{id: string, content: string, type: string, created_at: string}>>>}
 */
export async function fetchSessionNeighbors(fragments, scope = {}, windowMinutes = 30, perFragment = 6) {
  const targets = (fragments || []).filter(f => f && f.session_id && f.created_at);
  if (targets.length === 0) return new Map();

  const pool = getPrimaryPool();
  if (!pool) return new Map();

  const sessionIds = [...new Set(targets.map(f => f.session_id))];
  const params     = [sessionIds];
  const keyClause  = keyScopeClause(params, "f.key_id", {
    keyId      : scope.keyId ?? null,
    groupKeyIds: scope.groupKeyIds,
  });

  const { rows } = await pool.query(
    `SELECT f.id, f.content, f.type, f.created_at, f.session_id
       FROM ${SCHEMA}.fragments f
      WHERE f.session_id = ANY($1::text[])
        AND f.valid_to IS NULL${keyClause}
      ORDER BY f.created_at ASC`,
    params
  );

  const bySession = new Map();
  for (const row of rows) {
    const list = bySession.get(row.session_id) ?? [];
    list.push(row);
    bySession.set(row.session_id, list);
  }

  const windowMs = windowMinutes * 60 * 1000;
  const result   = new Map();

  for (const target of targets) {
    const anchorTime = new Date(target.created_at).getTime();
    const neighbors  = (bySession.get(target.session_id) ?? [])
      .filter(n => n.id !== target.id)
      .filter(n => Math.abs(new Date(n.created_at).getTime() - anchorTime) <= windowMs)
      .slice(0, perFragment)
      .map(n => ({ id: n.id, content: n.content, type: n.type, created_at: n.created_at }));

    if (neighbors.length > 0) result.set(target.id, neighbors);
  }

  return result;
}
