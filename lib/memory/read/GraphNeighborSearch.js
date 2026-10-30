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
import { SCHEMA } from "../schema.js";
import { byDescendingScore } from "./DeterministicRanking.js";
import { workspaceCondition } from "./WorkspaceScope.js";
import { resolveAgentScope } from "./AgentScope.js";
import { liveOrClosedCondition } from "../WorkingMemorySql.js";
import { reviewVisibilityParts } from "./ReviewVisibility.js";
import { fragmentFieldConditions, timeRangeConditions, andClauses } from "./FragmentFieldFilter.js";

/**
 * L2 상위 파편 ID에서 1-hop 이웃 파편을 조회한다.
 *
 * @param {string[]}    seedIds  - L2 상위 파편 ID 배열 (최대 5개)
 * @param {number}      maxTotal - 최대 반환 수 (기본 10)
 * @param {string}      agentId  - 에이전트 ID
 * @param {string|null} keyId    - API 키 격리 필터
 * @param {Object}      opts
 * @param {string|null} opts.workspace
 * @param {boolean}     opts.allWorkspaces
 * @param {boolean}     opts.includePeerAgents
 * @param {boolean|undefined} opts.isAnchor
 * @param {boolean}     opts.includeSuperseded
 * @param {string|null} [opts.viewerKeyId] - 검토 대기 파편 가시성의 보는 주체(ReviewVisibility)
 * @param {Object}      [opts.filters]     - recall 파편 조건(type, topic, caseId, resolutionStatus, phase, affect, minImportance)
 * @param {Object|null} [opts.timeRange]   - 정규화된 기간 {from, to, basis}
 * @returns {Promise<Object[]>} 이웃 파편 배열 (id, content, topic, type, importance 등)
 */
export async function fetchGraphNeighbors(
  seedIds,
  maxTotal = 10,
  agentId = "default",
  keyId = null,
  opts = {}
) {
  resolveAgentScope({ ...opts, agentId });
  if (!seedIds || seedIds.length === 0) return [];

  const validIds = seedIds.filter(id => typeof id === "string" && id.length > 0);
  if (validIds.length === 0) return [];

  const pool = getPrimaryPool();
  const {
    workspace = null,
    allWorkspaces = false,
    includePeerAgents = false,
    includeSuperseded = false,
    isAnchor,
    viewerKeyId,
    filters,
    timeRange
  } = opts || {};
  const effectiveAgentId = agentId || "default";

  /** keyId 정규화: 단일 값 또는 배열 모두 문자열 배열로 통일. null이면 마스터(필터 없음). */
  const effectiveKeyId = Array.isArray(keyId)
    ? keyId.map(String).filter(s => s.length > 0)
    : (keyId != null ? [String(keyId)] : null);
  if (effectiveKeyId !== null && effectiveKeyId.length === 0) return [];

  let keyFilter       = "";
  let agentFilter     = "";
  let workspaceFilter = "";
  let anchorFilter    = "";
  const params        = [validIds, validIds, maxTotal];

  if (effectiveKeyId !== null) {
    keyFilter = `AND f.key_id = ANY($4::text[])`;
    params.push(effectiveKeyId);
  }
  if (!includePeerAgents) {
    params.push(effectiveAgentId);
    agentFilter = `AND (f.agent_id = $${params.length} OR f.agent_id = 'default')`;
  }
  const workspaceClause = workspaceCondition(
    params, { workspace, allWorkspaces }, "f.workspace"
  );
  if (workspaceClause) workspaceFilter = `AND ${workspaceClause}`;
  if (isAnchor !== undefined) {
    params.push(isAnchor);
    anchorFilter = `AND f.is_anchor = $${params.length}`;
  }
  const validFilter = `AND ${liveOrClosedCondition(Boolean(includeSuperseded), "f")}`;
  const review      = reviewVisibilityParts(params, { viewerKeyId, keyId });
  /** recall 조건과 기간을 LIMIT 앞에 건다. 점수 상위 이웃을 자른 뒤 거르면 조건에 맞는 이웃이 빠진다. */
  const fieldFilter = andClauses([...fragmentFieldConditions(params, filters), ...timeRangeConditions(params, timeRange)]);
  /** JS 재정렬과 같은 점수(tanh 포화 × 관계 부스트)로 SQL에서 자른다. id 순으로 자르면 강한 이웃이 빠진다. */
  const boosts      = MEMORY_CONFIG.graph?.relationBoosts || {};
  const boostIdx    = params.push(JSON.stringify(boosts));
  const scoreSql    = `tanh(_link_weight * 0.5) * COALESCE(($${boostIdx}::jsonb ->> _relation_type)::float8, 1.0)`;
  /** 파편 조건은 링크마다 기본 키로 한 번 조회하며 건다(OFFSET 0으로 조인 평탄화를 막는다). 조건이 JOIN에 섞이면
   *  플래너가 키 전체 파편을 훑는 해시 조인을 골라 키의 파편 수에 비례해 느려진다. */
  const fragmentFilter = [validFilter, keyFilter, agentFilter, workspaceFilter, `${anchorFilter}${review.clause}${fieldFilter}`]
    .filter(Boolean).join("\n                ");

  /**
   * seedIds를 제외한 이웃 파편만 조회한다.
   * weight DESC로 가장 강한 관계부터 반환.
   * 기본은 valid_to IS NULL 파편만 대상으로 하며 includeSuperseded=true이면 만료 파편도 허용한다.
   */
  const { rows } = await pool.query(
    `SELECT * FROM (
     SELECT DISTINCT ON (id)
            id, content, topic, keywords, type, importance,
            utility_score, access_count, created_at, is_anchor, valid_to, agent_id, workspace,
            mention_time, event_time, event_time_end, event_time_precision,
            case_id, resolution_status, phase, affect,
            _link_weight, _relation_type${review.column},
            ${scoreSql} AS _sql_graph_score
       FROM (
         SELECT f.id, f.content, f.topic, f.keywords, f.type, f.importance,
                f.utility_score, f.access_count, f.created_at, f.is_anchor, f.valid_to,
                f.agent_id, f.workspace,
                f.mention_time, f.event_time, f.event_time_end, f.event_time_precision,
                f.case_id, f.resolution_status, f.phase, f.affect,
                fl.weight AS _link_weight,
                fl.relation_type AS _relation_type${review.select}
           FROM ${SCHEMA}.fragment_links fl
           CROSS JOIN LATERAL (
             SELECT f.* FROM ${SCHEMA}.fragments f
              WHERE f.id = fl.to_id
                ${fragmentFilter}
             OFFSET 0
           ) f
          WHERE fl.from_id = ANY($1)
            AND fl.to_id != ALL($2)
            AND fl.deleted_at IS NULL
         UNION ALL
         SELECT f.id, f.content, f.topic, f.keywords, f.type, f.importance,
                f.utility_score, f.access_count, f.created_at, f.is_anchor, f.valid_to,
                f.agent_id, f.workspace,
                f.mention_time, f.event_time, f.event_time_end, f.event_time_precision,
                f.case_id, f.resolution_status, f.phase, f.affect,
                fl.weight AS _link_weight,
                fl.relation_type AS _relation_type${review.select}
           FROM ${SCHEMA}.fragment_links fl
           CROSS JOIN LATERAL (
             SELECT f.* FROM ${SCHEMA}.fragments f
              WHERE f.id = fl.from_id
                ${fragmentFilter}
             OFFSET 0
           ) f
          WHERE fl.to_id = ANY($1)
            AND fl.from_id != ALL($2)
            AND fl.deleted_at IS NULL
       ) sub
      ORDER BY id, ${scoreSql} DESC, created_at DESC, _relation_type ASC
     ) picked
      ORDER BY _sql_graph_score DESC, id
      LIMIT $3`,
    params
  );

  /** tanh 포화 스코어링 + 관계 유형별 부스트 적용 후 재정렬 */
  for (const row of rows) {
    delete row._sql_graph_score;
    const saturated    = Math.tanh((row._link_weight || 0) * 0.5);
    const boost        = boosts[row._relation_type] ?? 1.0;
    row._graphScore    = saturated * boost;
  }

  return rows.sort(byDescendingScore(row => row._graphScore || 0));
}
