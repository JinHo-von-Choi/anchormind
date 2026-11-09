/**
 * LinkStore — 파편 링크 관리 (fragment_links 테이블 CRUD + RCA 체인)
 *
 * 작성자: 최진호
 * 작성일: 2026-03-12
 * 수정일: 2026-10-31 (배치도 관계 강등 방지를 적용한다)
 * 수정일: 2026-11-04 (링크 쓰기가 파편 행의 linked_to를 갱신하지 않는다. 링크는 fragment_links에만 있고,
 *                    linked_to는 저장할 때 선언한 링크 대상(linkedTo)만 담는다)
 */

import { queryWithAgentVector, getPrimaryPool, withTransaction } from "../../tools/db.js";
import { buildSearchPath }                       from "../../config.js";
import { MEMORY_CONFIG }        from "../../../config/memory.js";
import { reviewVisibilityParts } from "../read/ReviewVisibility.js";
import { keyScopeClause, keyScopeGroup, keyScopeNullable }       from "../keyScope.js";
import { SCHEMA } from "../schema.js";
import {
  CYCLE_RELATIONS, EXPANSION_DEFAULT_RELATIONS, SYSTEM_FACT_RELATIONS, UNLINK_DELETE_REASON, activeLinkCondition, deletedRowCondition,
  relationOrderSql, revivableRowCondition, reviveAssignments, safeRelationType
} from "./LinkVisibility.js";
import { normalizeIsAnchor } from "../read/SearchScope.js";
import { workspaceCondition } from "../read/WorkspaceScope.js";
import { agentScopeCondition, resolveAgentScope } from "../read/AgentScope.js";
import { liveOrClosedCondition } from "../WorkingMemorySql.js";
import { fragmentFieldConditions, timeRangeConditions, andClauses } from "../read/FragmentFieldFilter.js";
import { linkWritesTotal, linkWriteDuration } from "../background-metrics.js";

/**
 * recall 검색과 같은 파편 조건을 연결 파편 SQL 조건으로 만든다.
 * 조건을 SQL에 두어야 연결 파편 수 제한이 조건을 통과한 파편에만 적용된다.
 *
 * @param {Array}  params  바인딩 파라미터(push)
 * @param {Object} filters { type, topic, caseId, resolutionStatus, phase, affect, minImportance }
 * @returns {string} 앞에 공백과 AND가 붙은 조건 문자열(조건이 없으면 "")
 */
export function linkedFieldFilter(params, filters = {}) {
  return fragmentFieldConditions(params, filters).map(c => `\n             AND ${c}`).join("");
}

/**
 * 관계 종류 우선순위. 값이 클수록 구체적인 관계이며 덮어쓰기 대상이 아니다.
 *
 * ProactiveRecall과 SessionLinker가 자동 생성하는 related·co_retrieved·temporal은
 * 같은 파편 쌍에 대해 반복 생성된다. 우선순위 없이 갱신하면 사용자가 명시한
 * caused_by·resolved_by가 자동 링크에 덮여 인과 정보가 소실된다.
 *
 * contradicts와 superseded_by는 파편 상태와 짝을 이루는 시스템 사실이라 일반 관계로 덮이지 않는다.
 * 모순이 해소되면 contradicts가 superseded_by로 바뀌므로 superseded_by를 가장 높게 둔다.
 */
const RELATION_PRECEDENCE = {
  co_retrieved : 1,
  temporal     : 1,
  related      : 1,
  part_of      : 2,
  caused_by    : 3,
  resolved_by  : 3,
  contradicts  : 4,
  superseded_by: 5,
};

/**
 * 기존 관계보다 우선순위가 낮은 갱신인지 판정한다.
 *
 * @param {string} existing
 * @param {string} incoming
 * @returns {boolean}
 */
export function isRelationDowngrade(existing, incoming) {
  const before = RELATION_PRECEDENCE[existing] ?? 1;
  const after  = RELATION_PRECEDENCE[incoming] ?? 1;
  return after < before;
}

/**
 * 활성 관계가 existing인 쌍에 incoming을 쓰면 저장될 관계를 돌려준다.
 *
 * @param {string|null} existing - 활성 관계. 활성 행이 없으면 null
 * @param {string}      incoming
 * @returns {string}
 */
export function resolveStoredRelation(existing, incoming) {
  return existing && isRelationDowngrade(existing, incoming) ? existing : incoming;
}

/** 링크 쓰기 지표의 producer 라벨 값. 목록 밖 값은 other로 센다. */
const LINK_PRODUCERS = new Set(["temporal", "graph_linker", "auto_link", "proactive", "linked_to", "session", "other"]);

/**
 * 같은 (from_id, to_id) 쌍을 하나로 합친다. 다중 행 upsert는 한 문장에서 같은 행을 두 번 갱신할 수 없다.
 * 관계는 우선순위가 높은 쪽, weight는 큰 쪽을 남긴다.
 *
 * @param {Array<{fromId: string, toId: string, relationType?: string, weight?: number}>} pairs
 * @returns {Array<{fromId: string, toId: string, relationType: string, weight: number}>}
 */
function mergeLinkPairs(pairs) {
  const merged = new Map();
  for (const { fromId, toId, relationType, weight } of pairs) {
    const row = { fromId, toId, relationType: relationType ?? "related", weight: Number(weight ?? 1) };
    const key = `${fromId}\u0000${toId}`;
    const was = merged.get(key);
    if (!was) { merged.set(key, row); continue; }
    if (isRelationDowngrade(row.relationType, was.relationType)) was.relationType = row.relationType;
    was.weight = Math.max(was.weight, row.weight);
  }
  /** (from, to) 순으로 정렬해 같은 쌍을 쓰는 동시 upsert가 행 잠금을 같은 순서로 잡게 한다(교착 방지). */
  return [...merged.values()].sort((a, b) =>
    (a.fromId < b.fromId ? -1 : a.fromId > b.fromId ? 1 : (a.toId < b.toId ? -1 : a.toId > b.toId ? 1 : 0)));
}

export class LinkStore {
  /**
   * fragment_links에 링크 하나를 만든다. 파편 행은 갱신하지 않는다.
   *
   * @param {string} fromId
   * @param {string} toId
   * @param {string} relationType
   * @param {string} agentId
   * @param {number} [weight=1]
   * @param {{producer?: string, reviveUnlinked?: boolean}} [opts]
   *   producer: 링크 쓰기 지표에 남길 경로 이름. reviveUnlinked: unlink로 지운 행도 되살린다(공개 link 도구 전용)
   * @returns {Promise<string|null>} 저장된 관계. unlink로 지운 행이라 쓰지 않았으면 null
   */
  async createLink(fromId, toId, relationType = "related", agentId = "default", weight = 1, { producer = "other", reviveUnlinked = false } = {}) {
    const rows = await this.#writeLinks([{ fromId, toId, relationType, weight }], agentId, { producer, reviveUnlinked });
    return rows[0]?.relation_type ?? null;
  }

  /**
   * 가져온 링크 한 건을 호출자의 트랜잭션 client로 기록한다. 같은 (from_id, to_id)의 활성 행과
   * unlink로 지운 행은 건드리지 않고 created=false를 돌려준다. 그 밖의 지운 행은 가져온 값으로 되살린다.
   *
   * @param {import("pg").PoolClient} client
   * @param {Object} link - {from_id, to_id, relation_type, created_at, weight, confidence, decay_rate, quarantine_state}
   * @returns {Promise<{created: boolean}>}
   */
  async restoreLink(client, link) {
    const inserted = await client.query(
      `INSERT INTO ${SCHEMA}.fragment_links
              (from_id, to_id, relation_type, created_at, weight, confidence, decay_rate, quarantine_state)
       VALUES ($1, $2, $3, COALESCE($4::timestamptz, NOW()), COALESCE($5, 1.0), COALESCE($6, 1.0), COALESCE($7, 0.005), $8)
       ON CONFLICT (from_id, to_id) DO UPDATE
         SET relation_type    = EXCLUDED.relation_type,
             created_at       = EXCLUDED.created_at,
             weight           = EXCLUDED.weight,
             confidence       = EXCLUDED.confidence,
             decay_rate       = EXCLUDED.decay_rate,
             quarantine_state = EXCLUDED.quarantine_state${reviveAssignments()}
         WHERE ${deletedRowCondition(`${SCHEMA}.fragment_links`)}
           AND ${revivableRowCondition(`${SCHEMA}.fragment_links`)}`,
      [
        link.from_id,
        link.to_id,
        link.relation_type ?? "related",
        link.created_at ?? null,
        link.weight ?? null,
        link.confidence ?? null,
        link.decay_rate ?? null,
        link.quarantine_state ?? null
      ]
    );
    return { created: inserted.rowCount > 0 };
  }

  /**
   * 링크 여러 개를 한 트랜잭션에서 만든다. 관계 강등 방지, weight 규칙은 createLink와 같다.
   * 실패하면 전체를 되돌리고 오류를 던진다. 호출자는 필요하면 단건 createLink로 대신한다.
   *
   * @param {Array<{fromId: string, toId: string, relationType?: string, weight?: number}>} pairs
   * @param {string} agentId
   * @param {{producer?: string, lockTimeoutMs?: number}} [opts]
   * @returns {Promise<string[]>} 삽입·갱신된 fragment_links 행 id
   */
  async createLinks(pairs, agentId = "default", { producer = "session", lockTimeoutMs = 5000 } = {}) {
    if (!pairs || pairs.length === 0) return [];
    const rows = await this.#writeLinks(pairs, agentId, { producer, lockTimeoutMs });
    return rows.map(r => r.id);
  }

  /**
   * 링크 쓰기 본체. (from, to) 순으로 정렬한 다중 행 upsert 한 문장이다. 파편 행을 잠그거나 갱신하지 않으므로
   * 같은 파편에 링크를 거는 쓰기끼리 기다리지 않는다. 같은 쌍을 동시에 쓰면 ON CONFLICT가 한 행으로 합친다.
   *
   * @param {Array<{fromId: string, toId: string, relationType?: string, weight?: number}>} pairs
   * @param {string} agentId
   * @param {{producer: string, lockTimeoutMs?: number}} opts
   * @returns {Promise<string[]>}
   */
  async #writeLinks(pairs, agentId, { producer: rawProducer, lockTimeoutMs = 0, reviveUnlinked = false }) {
    const producer = LINK_PRODUCERS.has(rawProducer) ? rawProducer : "other";
    const rows = mergeLinkPairs(pairs);
    const pool = getPrimaryPool();
    if (rows.length === 0 || !pool) return [];

    const safeAgent = String(agentId || "default").replace(/[^a-zA-Z0-9_-]/g, "");
    const fromIds   = rows.map(r => r.fromId);
    const toIds     = rows.map(r => r.toId);
    const end       = linkWriteDuration.startTimer({ producer });

    try {
      const written = await withTransaction(pool, async (client) => {
        await client.query(buildSearchPath(SCHEMA));
        if (lockTimeoutMs > 0) await client.query(`SET LOCAL lock_timeout = ${Math.floor(lockTimeoutMs)}`);
        // security: agentId sanitized via /[^a-zA-Z0-9_-]/g — SET LOCAL does not support parameter binding
        await client.query(`SET LOCAL app.current_agent_id = '${safeAgent}'`);
        /**
         * 관계 강등 방지: 기존 관계가 더 구체적이면 relation_type을 보존한다. weight는 큰 값을 유지한다.
         * unlink로 지운 행은 공개 link 호출이나 시스템 사실 관계일 때만 되살린다.
         */
        const upserted = await client.query(
          `INSERT INTO ${SCHEMA}.fragment_links (from_id, to_id, relation_type, weight)
           SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::float8[])
           ON CONFLICT (from_id, to_id) DO UPDATE
             SET relation_type = CASE
                   WHEN ${deletedRowCondition(`${SCHEMA}.fragment_links`)} THEN EXCLUDED.relation_type
                   WHEN COALESCE(($5::jsonb ->> EXCLUDED.relation_type)::int, 1)
                      < COALESCE(($5::jsonb ->> ${SCHEMA}.fragment_links.relation_type)::int, 1)
                   THEN ${SCHEMA}.fragment_links.relation_type
                   ELSE EXCLUDED.relation_type
                 END,
                 weight        = CASE
                   WHEN ${deletedRowCondition(`${SCHEMA}.fragment_links`)} THEN EXCLUDED.weight
                   ELSE GREATEST(${SCHEMA}.fragment_links.weight, EXCLUDED.weight)
                 END${reviveAssignments()}
             WHERE ${revivableRowCondition(`${SCHEMA}.fragment_links`)}
                OR $6::boolean
                OR EXCLUDED.relation_type = ANY($7::text[])
           RETURNING id, from_id, to_id, relation_type`,
          [fromIds, toIds, rows.map(r => r.relationType), rows.map(r => r.weight), JSON.stringify(RELATION_PRECEDENCE),
            reviveUnlinked === true, [...SYSTEM_FACT_RELATIONS]]
        );

        return upserted.rows;
      });
      const applied = new Set(written.map(r => `${r.from_id}\u0000${r.to_id}`));
      for (const r of rows) {
        if (applied.has(`${r.fromId}\u0000${r.toId}`)) linkWritesTotal.inc({ producer, relation: r.relationType });
      }
      return written;
    } finally {
      end();
    }
  }

  /**
   * fragment_links 테이블에서 1-hop 연결 파편 조회
   *
   * @param {string[]}    fromIds
   * @param {string|null} relationType
   * @param {string}      agentId
   * @param {string|string[]|null} keyId  - API 키 격리 필터 (null=master, 전체 조회)
   * @param {Object|null} opts
   * @param {string|null} opts.workspace
   * @param {boolean}     opts.includePeerAgents
   * @param {boolean|null|undefined} opts.isAnchor
   * @param {boolean}     opts.includeSuperseded
   * @param {Object}      [opts.filters]  - 검색과 같은 파편 조건(type, topic, caseId, resolutionStatus, phase, affect, minImportance)
   * @returns {Promise<object[]>}
   */
  async getLinkedFragments(
    fromIds,
    relationType = null,
    agentId = "default",
    keyId = null,
    opts = {}
  ) {
    if (fromIds.length === 0) return [];

    const allowedRelationType = safeRelationType(relationType);
    const normalizedOpts = opts ?? {};
    const {
      workspace = null,
      allWorkspaces = false,
      includePeerAgents = false,
      includeSuperseded = false
    } = normalizedOpts;
    const effectiveAgentId = agentId || "default";

    const { sql, params } = this._buildLinkedFragmentsSql({
      fromIds,
      safeRelationType: allowedRelationType,
      keyId,
      viewerKeyId: normalizedOpts.viewerKeyId,
      agentId: effectiveAgentId,
      workspace,
      allWorkspaces,
      includePeerAgents,
      includeSuperseded,
      isAnchor: normalizeIsAnchor(normalizedOpts.isAnchor),
      filters : normalizedOpts.filters ?? {},
      timeRange : normalizedOpts.timeRange ?? null,
      excludeIds: normalizedOpts.excludeIds ?? []
    });
    const result = await queryWithAgentVector(effectiveAgentId, sql, params);

    return result.rows;
  }

  /**
   * getLinkedFragments 전용 SQL + 파라미터 빌더.
   *
   * @param {object}      opts
   * @param {string[]|null} opts.fromIds          - $1 에 바인딩될 ID 배열
   * @param {string|null} opts.safeRelationType   - 검증된 relation_type 값, null이면 기본 4종 IN 필터
   * @param {string|string[]|null} opts.keyId     - API 키 격리 필터
   * @param {string}      opts.agentId
   * @param {string|null} opts.workspace
   * @param {boolean}     opts.allWorkspaces
   * @param {boolean}     opts.includePeerAgents
   * @param {boolean|undefined} opts.isAnchor
   * @param {boolean}     opts.includeSuperseded
   * @param {string|null} [opts.viewerKeyId]      - 검토 대기 파편 가시성의 보는 주체(ReviewVisibility)
   * @param {Object}      [opts.filters]          - 검색과 같은 파편 조건
   * @param {Object|null} [opts.timeRange]        - 검색과 같은 기간 조건(정규화된 {from, to, basis})
   * @param {string[]}    [opts.excludeIds]       - 이미 결과 후보에 있어 연결 파편으로 더하지 않을 id
   * @returns {{ sql: string, params: any[] }}
   */
  _buildLinkedFragmentsSql({
    fromIds,
    safeRelationType,
    keyId,
    viewerKeyId,
    agentId = "default",
    workspace = null,
    allWorkspaces = false,
    includePeerAgents = false,
    includeSuperseded = false,
    isAnchor,
    filters = {},
    timeRange = null,
    excludeIds = []
  }) {
    const params        = [fromIds, safeRelationType ? [safeRelationType] : [...EXPANSION_DEFAULT_RELATIONS]];
    const relationWhere = "AND l.relation_type = ANY($2::text[])";

    const keyFilter = keyId == null
      ? ""
      : keyScopeGroup(params, "f.key_id", Array.isArray(keyId) ? keyId : [keyId]).trimStart();

    /** 검색·미리보기와 같은 에이전트 조건. peer 조회도 귀속 불명(NULL) 파편은 넣지 않는다. */
    params.push(agentId);
    const agentFilter = `AND ${agentScopeCondition(`$${params.length}`, { includePeerAgents }, "f.agent_id")}`;

    let workspaceFilter = "";
    const workspaceClause = workspaceCondition(
      params, { workspace, allWorkspaces }, "f.workspace"
    );
    if (workspaceClause) workspaceFilter = `AND ${workspaceClause}`;

    let anchorFilter = "";
    if (isAnchor !== undefined) {
      params.push(isAnchor);
      anchorFilter = `AND f.is_anchor = $${params.length}`;
    }

    /** 파편 조건과 기간을 LIMIT 앞에 건다. 자른 뒤 거르면 맞는 이웃이 빠진다. */
    const fieldFilter = linkedFieldFilter(params, filters) + andClauses(timeRangeConditions(params, timeRange));
    /** 이미 후보에 있는 파편은 중복 제거 뒤 LIMIT 앞에서 한 번만 뺀다. 분기 안으로 밀려 들어가면 플래너가 id 목록을
     *  색인마다 검토해 계획 수립이 느려지므로, 중복 제거 하위 질의에 OFFSET 0을 둬 밀어 넣기를 막는다. */
    const excludeWhere = excludeIds.length > 0 ? `WHERE picked.id <> ALL($${params.push(excludeIds)}::text[])` : "";
    const validFilter = `AND ${liveOrClosedCondition(Boolean(includeSuperseded), "f")}`;
    const review      = reviewVisibilityParts(params, { viewerKeyId, keyId });

    /** 같은 파편이 두 방향으로 잡히면 관계 우선순위와 가중치가 높은 쪽 하나만 남긴 뒤, 전체를 같은 기준으로
     *  정렬하고 자른다. DISTINCT ON의 id 순서로 자르면 강한 연결이 id 사전순 때문에 빠진다. */
    const sql = `SELECT * FROM (
                 SELECT DISTINCT ON (id)
                         id, content, topic, keywords, type,
                         importance, linked_to, access_count,
                         created_at, verified_at, agent_id, workspace, is_anchor, valid_to, event_time, mention_time, relation_type,
                         case_id, resolution_status, phase, affect, linked_from,
                         link_weight, relation_order${review.column}
         FROM (
           SELECT f.id, f.content, f.topic, f.keywords, f.type,
                  f.importance, f.linked_to, f.access_count,
                  f.created_at, f.verified_at, f.agent_id, f.workspace, f.is_anchor, f.valid_to, f.event_time, f.mention_time, l.relation_type${review.select},
                  f.case_id, f.resolution_status, f.phase, f.affect, l.from_id AS linked_from,
                  COALESCE(l.weight, 1) AS link_weight,
                  ${relationOrderSql("l")} AS relation_order
           FROM ${SCHEMA}.fragment_links l
           JOIN ${SCHEMA}.fragments f ON l.to_id = f.id
           WHERE l.from_id = ANY($1)
             ${relationWhere}
             AND ${activeLinkCondition("l")}
             ${keyFilter}
             ${agentFilter}
             ${workspaceFilter}
             ${anchorFilter}${fieldFilter}
             ${validFilter}${review.clause}
           UNION ALL
           SELECT f.id, f.content, f.topic, f.keywords, f.type,
                  f.importance, f.linked_to, f.access_count,
                  f.created_at, f.verified_at, f.agent_id, f.workspace, f.is_anchor, f.valid_to, f.event_time, f.mention_time, l.relation_type${review.select},
                  f.case_id, f.resolution_status, f.phase, f.affect, l.to_id AS linked_from,
                  COALESCE(l.weight, 1) AS link_weight,
                  ${relationOrderSql("l")} AS relation_order
           FROM ${SCHEMA}.fragment_links l
           JOIN ${SCHEMA}.fragments f ON l.from_id = f.id
           WHERE l.to_id = ANY($1)
             ${relationWhere}
             AND ${activeLinkCondition("l")}
             ${keyFilter}
             ${agentFilter}
             ${workspaceFilter}
             ${anchorFilter}${fieldFilter}
             ${validFilter}${review.clause}
         ) sub
         ORDER BY id, relation_order, link_weight DESC, importance DESC
         OFFSET 0
         ) picked
         ${excludeWhere}
         ORDER BY relation_order, link_weight DESC, importance DESC, id
         LIMIT ${MEMORY_CONFIG.linkedFragmentLimit}`;

    return { sql, params };
  }

  /**
   * 재귀 CTE로 startId에서 targetId까지 도달 가능 여부를 판정한다.
   * 활성 링크 중 방향 관계(CYCLE_RELATIONS)만 정방향으로 따라간다. UNION이 방문한 파편을 다시 펼치지 않는다.
   * key_id 격리 필터를 각 홉의 경유 파편에 적용한다.
   *
   * @param {string}      startId  - 탐색 시작 파편
   * @param {string}      targetId - 도달 목표 파편
   * @param {string}      agentId
   * @param {string|null} keyId
   * @returns {Promise<boolean>}
   */
  async isReachable(startId, targetId, agentId = "default", keyId = null) {
    const params    = [startId, targetId, [...CYCLE_RELATIONS]];
    const keyFilter = keyId == null
      ? ""
      : keyScopeNullable(params, "f.key_id", keyId).trimStart();
    const result = await queryWithAgentVector(agentId,
      `WITH RECURSIVE reachable(id) AS (
         SELECT l.to_id
         FROM ${SCHEMA}.fragment_links l
         JOIN ${SCHEMA}.fragments f0 ON f0.id = l.from_id
         WHERE l.from_id = $1
           AND ${activeLinkCondition("l")}
           AND l.relation_type = ANY($3::text[])
           AND f0.valid_to IS NULL
       UNION
         SELECT l.to_id
         FROM reachable r
         JOIN ${SCHEMA}.fragments f ON f.id = r.id
         JOIN ${SCHEMA}.fragment_links l ON l.from_id = r.id
         WHERE r.id != $2
           AND ${activeLinkCondition("l")}
           AND l.relation_type = ANY($3::text[])
           AND f.valid_to IS NULL
           ${keyFilter}
       )
       SELECT EXISTS (SELECT 1 FROM reachable WHERE id = $2) AS found`,
      params
    );
    return result.rows[0]?.found === true;
  }

  /**
   * 두 파편 사이의 활성 관계를 조회한다. 호출자가 양 끝 파편의 권한을 먼저 확인한다.
   *
   * @param {string} fromId
   * @param {string} toId
   * @param {string} agentId
   * @returns {Promise<string|null>} 활성 관계. 활성 행이 없으면 null
   */
  async getActiveRelation(fromId, toId, agentId = "default") {
    const result = await queryWithAgentVector(agentId,
      `SELECT l.relation_type
         FROM ${SCHEMA}.fragment_links l
        WHERE l.from_id = $1 AND l.to_id = $2 AND ${activeLinkCondition("l")}`,
      [fromId, toId]
    );
    return result.rows[0]?.relation_type ?? null;
  }

  /**
   * 일치하는 활성 링크 한 건을 소프트 삭제하고 재통합 이력을 남긴다. 파편 행과 링크의 weight, confidence,
   * quarantine_state는 바꾸지 않는다. 조건과 쓰기가 한 문장이라 그사이 관계가 바뀌면 지우지 않는다.
   *
   * @param {string}      fromId
   * @param {string}      toId
   * @param {string}      relationType
   * @param {string}      agentId
   * @param {{keyId?: string|null, groupKeyIds?: string[]}} [scope]
   * @returns {Promise<boolean>} 지웠으면 true
   */
  async softDeleteLink(fromId, toId, relationType, agentId = "default", { keyId = null, groupKeyIds = [] } = {}) {
    const keyIds = keyId == null ? [] : [...new Set([keyId, ...groupKeyIds])];
    const result = await queryWithAgentVector(agentId,
      `WITH removed AS (
         UPDATE ${SCHEMA}.fragment_links
            SET deleted_at = NOW(), delete_reason = $4
          WHERE from_id = $1 AND to_id = $2 AND relation_type = $3 AND deleted_at IS NULL
          RETURNING id, weight, confidence
       ), history AS (
         INSERT INTO ${SCHEMA}.link_reconsolidations
                (link_id, action, old_weight, new_weight, old_confidence, new_confidence, reason, triggered_by, key_id)
         SELECT id, 'soft_delete', weight, weight, confidence, confidence, $4, 'tool:unlink', $5
           FROM removed
         RETURNING link_id
       )
       SELECT count(*)::int AS removed FROM history`,
      [fromId, toId, relationType, UNLINK_DELETE_REASON, keyId],
      keyIds.length > 0 ? { keyId, keyIds } : {}
    );
    return result.rows[0]?.removed > 0;
  }

  /**
   * 파편들에 걸린 활성 링크 수. 양 끝이 호출자의 키 범위에 있는 링크만 센다.
   *
   * @param {string[]} ids
   * @param {string}   agentId
   * @param {{keyId?: string|null, groupKeyIds?: string[]}} [scope]
   * @returns {Promise<number>}
   */
  async countActiveLinks(ids, agentId = "default", { keyId = null, groupKeyIds = [] } = {}) {
    if (!Array.isArray(ids) || ids.length === 0) return 0;
    const scope  = { keyId, groupKeyIds };
    const params = [ids];
    const fromFilter = keyScopeClause(params, "f.key_id", scope);
    const toFilter   = keyScopeClause(params, "t.key_id", scope);
    const result = await queryWithAgentVector(agentId,
      `SELECT count(*)::int AS links
         FROM ${SCHEMA}.fragment_links l
         JOIN ${SCHEMA}.fragments f ON f.id = l.from_id
         JOIN ${SCHEMA}.fragments t ON t.id = l.to_id
        WHERE (l.from_id = ANY($1::text[]) OR l.to_id = ANY($1::text[]))
          AND ${activeLinkCondition("l")} ${fromFilter} ${toFilter}`,
      params
    );
    return result.rows[0]?.links ?? 0;
  }

  /**
   * RCA 체인 조회 (caused_by, resolved_by 1-hop). 규약 방향(에러 → 해결책)을 따라가고,
   * 이전 방향(절차 → 에러)으로 저장된 resolved_by도 에러에서 시작하면 포함한다.
   *
   * @param {string} startId
   * @param {string} agentId
   * @returns {Promise<object[]>}
   */
  async getRCAChain(startId, agentId = "default", keyId = null, groupKeyIds = [], opts = {}) {
    const agentScope = resolveAgentScope({ ...opts, agentId });
    const params = [startId, agentScope.agentId];
    const scope  = { keyId, groupKeyIds };
    const seedKeyFilter = keyScopeClause(params, "f.key_id",  scope);
    const keyFilter     = keyScopeClause(params, "f2.key_id", scope);
    const seedWorkspaceClause = workspaceCondition(params, opts, "f.workspace");
    const seedWorkspaceFilter = seedWorkspaceClause ? `AND ${seedWorkspaceClause}` : "";
    const targetWorkspaceClause = workspaceCondition(params, opts, "f2.workspace");
    const targetWorkspaceFilter = targetWorkspaceClause ? `AND ${targetWorkspaceClause}` : "";
    /** 다른 키의 검토 대기 파편은 체인의 시작점과 이웃 어디에도 나오지 않는다. */
    const seedReview   = reviewVisibilityParts(params, { viewerKeyId: keyId ?? null }, "f");
    const targetReview = reviewVisibilityParts(params, { viewerKeyId: keyId ?? null }, "f2");

    const result = await queryWithAgentVector(agentScope.agentId,
      `WITH rca AS (
         SELECT f.id, f.content, f.type, f.importance, f.topic,
                NULL::text AS relation_type, 0 AS depth
         FROM ${SCHEMA}.fragments f
         WHERE f.id = $1
           AND f.valid_to IS NULL
           AND ${agentScopeCondition("$2", agentScope, "f.agent_id")}
           ${seedKeyFilter}
           ${seedWorkspaceFilter}${seedReview.clause}

         UNION ALL

         SELECT f2.id, f2.content, f2.type, f2.importance, f2.topic,
                l.relation_type, 1 AS depth
         FROM ${SCHEMA}.fragment_links l
         JOIN ${SCHEMA}.fragments f2 ON l.to_id = f2.id
         WHERE l.from_id = $1
           AND ${activeLinkCondition("l")}
           AND l.relation_type IN ('caused_by', 'resolved_by')
           AND f2.valid_to IS NULL
           AND ${agentScopeCondition("$2", agentScope, "f2.agent_id")}
           ${keyFilter}
           ${targetWorkspaceFilter}${targetReview.clause}

         UNION ALL

         SELECT f2.id, f2.content, f2.type, f2.importance, f2.topic,
                l.relation_type, 1 AS depth
         FROM ${SCHEMA}.fragment_links l
         JOIN ${SCHEMA}.fragments f2 ON l.from_id = f2.id
         WHERE l.to_id = $1
           AND ${activeLinkCondition("l")}
           AND l.relation_type = 'resolved_by'
           AND f2.type = 'procedure'
           AND f2.valid_to IS NULL
           AND ${agentScopeCondition("$2", agentScope, "f2.agent_id")}
           ${keyFilter}
           ${targetWorkspaceFilter}${targetReview.clause}
       )
       SELECT * FROM rca ORDER BY depth ASC, importance DESC`,
      params
    );

    return result.rows;
  }
}
