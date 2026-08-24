/**
 * GraphNeighborSearch - L2.5 그래프 증강 검색용 1-hop 이웃 조회
 *
 * 작성자: 최진호
 * 작성일: 2026-03-28
 *
 * L2 키워드 검색 상위 파편의 1-hop 이웃을 조회하여
 * RRF 파이프라인에 L2.5 레이어로 투입한다.
 */

import { getPrimaryPool }  from "../../tools/db.js";
import { MEMORY_CONFIG }   from "../../../config/memory.js";
import { exactScopeClause } from "../keyScope.js";

const SCHEMA = "agent_memory";

/**
 * L2 상위 파편 ID에서 1-hop 이웃 파편을 조회한다.
 *
 * @param {string[]}    seedIds  - L2 상위 파편 ID 배열 (최대 5개)
 * @param {number}      maxTotal - 최대 반환 수 (기본 10)
 * @param {string}      agentId  - 에이전트 ID
 * @param {string|null} keyId    - API 키 격리 필터
 * @param {Object}      opts
 * @param {string|null} opts.workspace
 * @param {boolean}     opts.includePeerAgents
 * @param {boolean}     opts.strictScope - 파일럿 API 키의 정확한 key/workspace tuple
 * @returns {Promise<Object[]>} 이웃 파편 배열 (id, content, topic, type, importance 등)
 */
export async function fetchGraphNeighbors(
  seedIds,
  maxTotal = 10,
  agentId = "default",
  keyId = null,
  opts = {}
) {
  if (!seedIds || seedIds.length === 0) return [];

  const validIds = seedIds.filter(id => typeof id === "string" && id.length > 0);
  if (validIds.length === 0) return [];

  const pool = getPrimaryPool();
  const {
    workspace = null,
    includePeerAgents = false,
    strictScope = false
  } = opts || {};
  const effectiveAgentId = agentId || "default";

  /** 파일럿 strict 호출은 배열/부분 범위를 넓은 조회로 해석하지 않는다. */
  if (strictScope && (Array.isArray(keyId) || keyId == null || workspace == null)) return [];

  if (strictScope) {
    const params = [validIds, validIds, maxTotal];
    const targetScope = exactScopeClause(params, "target", { keyId, workspace });
    const sourceScope = exactScopeClause(params, "source", { keyId, workspace });
    let agentFilter = "";
    if (!includePeerAgents) {
      params.push(effectiveAgentId);
      agentFilter = `AND (target.agent_id = $${params.length} OR target.agent_id = 'default')`;
    }

    const { rows } = await pool.query(
      `SELECT DISTINCT ON (id)
              id, content, topic, keywords, type, importance,
              utility_score, access_count, created_at, is_anchor, valid_to, agent_id, workspace,
              key_id, _link_weight, _relation_type
         FROM (
           SELECT target.id, target.content, target.topic, target.keywords, target.type, target.importance,
                  target.utility_score, target.access_count, target.created_at, target.is_anchor, target.valid_to,
                  target.agent_id, target.workspace, target.key_id,
                  fl.weight AS _link_weight,
                  fl.relation_type AS _relation_type
             FROM ${SCHEMA}.fragment_links fl
             JOIN ${SCHEMA}.fragments source ON source.id = fl.from_id
             JOIN ${SCHEMA}.fragments target ON target.id = fl.to_id
            WHERE fl.from_id = ANY($1)
              AND fl.to_id != ALL($2)
              AND fl.deleted_at IS NULL
              AND target.valid_to IS NULL
              ${targetScope}
              ${sourceScope}
              ${agentFilter}
           UNION ALL
           SELECT target.id, target.content, target.topic, target.keywords, target.type, target.importance,
                  target.utility_score, target.access_count, target.created_at, target.is_anchor, target.valid_to,
                  target.agent_id, target.workspace, target.key_id,
                  fl.weight AS _link_weight,
                  fl.relation_type AS _relation_type
             FROM ${SCHEMA}.fragment_links fl
             JOIN ${SCHEMA}.fragments source ON source.id = fl.to_id
             JOIN ${SCHEMA}.fragments target ON target.id = fl.from_id
            WHERE fl.to_id = ANY($1)
              AND fl.from_id != ALL($2)
              AND fl.deleted_at IS NULL
              AND target.valid_to IS NULL
              ${targetScope}
              ${sourceScope}
              ${agentFilter}
         ) sub
        ORDER BY id, _link_weight DESC
        LIMIT $3`,
      params
    );

    /** SQL 방어 이후에도 반환 행의 두 축을 다시 확인한다. */
    const scopedRows = rows.filter(row => row.key_id === keyId && row.workspace === workspace);
    const boosts = MEMORY_CONFIG.graph?.relationBoosts || {};
    for (const row of scopedRows) {
      row._graphScore = Math.tanh((row._link_weight || 0) * 0.5)
        * (boosts[row._relation_type] ?? 1.0);
    }
    return scopedRows.sort((a, b) => (b._graphScore || 0) - (a._graphScore || 0));
  }

  /** keyId 정규화: 단일 값 또는 배열 모두 문자열 배열로 통일. null이면 마스터(필터 없음). */
  const effectiveKeyId = Array.isArray(keyId)
    ? keyId.map(String).filter(s => s.length > 0)
    : (keyId != null ? [String(keyId)] : null);
  if (effectiveKeyId !== null && effectiveKeyId.length === 0) return [];

  let keyFilter       = "";
  let agentFilter     = "";
  let workspaceFilter = "";
  const params        = [validIds, validIds, maxTotal];

  if (effectiveKeyId !== null) {
    keyFilter = `AND f.key_id = ANY($4::text[])`;
    params.push(effectiveKeyId);
  }
  if (!includePeerAgents) {
    params.push(effectiveAgentId);
    agentFilter = `AND (f.agent_id = $${params.length} OR f.agent_id = 'default')`;
  }
  if (workspace !== null) {
    params.push(workspace);
    workspaceFilter = `AND (f.workspace = $${params.length} OR f.workspace IS NULL)`;
  }

  /**
   * seedIds를 제외한 이웃 파편만 조회한다.
   * weight DESC로 가장 강한 관계부터 반환.
   * valid_to IS NULL 필터로 유효한 파편만 대상으로 한다.
   */
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (id)
            id, content, topic, keywords, type, importance,
            utility_score, access_count, created_at, is_anchor, valid_to, agent_id, workspace,
            _link_weight, _relation_type
       FROM (
         SELECT f.id, f.content, f.topic, f.keywords, f.type, f.importance,
                f.utility_score, f.access_count, f.created_at, f.is_anchor, f.valid_to,
                f.agent_id, f.workspace,
                fl.weight AS _link_weight,
                fl.relation_type AS _relation_type
           FROM ${SCHEMA}.fragment_links fl
           JOIN ${SCHEMA}.fragments f ON f.id = fl.to_id
          WHERE fl.from_id = ANY($1)
            AND fl.to_id != ALL($2)
            AND fl.deleted_at IS NULL
            AND f.valid_to IS NULL
            ${keyFilter}
            ${agentFilter}
            ${workspaceFilter}
         UNION ALL
         SELECT f.id, f.content, f.topic, f.keywords, f.type, f.importance,
                f.utility_score, f.access_count, f.created_at, f.is_anchor, f.valid_to,
                f.agent_id, f.workspace,
                fl.weight AS _link_weight,
                fl.relation_type AS _relation_type
           FROM ${SCHEMA}.fragment_links fl
           JOIN ${SCHEMA}.fragments f ON f.id = fl.from_id
          WHERE fl.to_id = ANY($1)
            AND fl.from_id != ALL($2)
            AND fl.deleted_at IS NULL
            AND f.valid_to IS NULL
            ${keyFilter}
            ${agentFilter}
            ${workspaceFilter}
       ) sub
      ORDER BY id, _link_weight DESC
      LIMIT $3`,
    params
  );

  /** tanh 포화 스코어링 + 관계 유형별 부스트 적용 후 재정렬 */
  const boosts = MEMORY_CONFIG.graph?.relationBoosts || {};
  for (const row of rows) {
    const saturated    = Math.tanh((row._link_weight || 0) * 0.5);
    const boost        = boosts[row._relation_type] ?? 1.0;
    row._graphScore    = saturated * boost;
  }

  return rows.sort((a, b) => (b._graphScore || 0) - (a._graphScore || 0));
}
