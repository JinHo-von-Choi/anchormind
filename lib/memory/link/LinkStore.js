/**
 * LinkStore — 파편 링크 관리 (fragment_links 테이블 CRUD + RCA 체인)
 *
 * 작성자: 최진호
 * 작성일: 2026-03-12
 * 수정일: 2026-10-03 (linked_to 일괄 갱신은 잠금 문장을 앞세운 트랜잭션으로 실행)
 */

import { queryWithAgentVector, getPrimaryPool, withTransaction } from "../../tools/db.js";
import { buildSearchPath }                       from "../../config.js";
import { MEMORY_CONFIG }        from "../../../config/memory.js";
import { reviewVisibilityParts } from "../read/ReviewVisibility.js";
import { keyScopeClause, keyScopeGroup, keyScopeNullable }       from "../keyScope.js";
import { SCHEMA } from "../schema.js";
import {
  EXPANSION_DEFAULT_RELATIONS, activeLinkCondition, deletedRowCondition, relationOrderSql, reviveAssignments, safeRelationType
} from "./LinkVisibility.js";
import { normalizeIsAnchor } from "../read/SearchScope.js";
import { workspaceCondition } from "../read/WorkspaceScope.js";
import { agentScopeCondition, resolveAgentScope } from "../read/AgentScope.js";
import { logWarn } from "../../logger.js";
import { liveOrClosedCondition } from "../WorkingMemorySql.js";
import { fragmentFieldConditions, timeRangeConditions, andClauses } from "../read/FragmentFieldFilter.js";
import { fragmentRowLock } from "../write/rowLock.js";

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
 */
const RELATION_PRECEDENCE = {
  co_retrieved : 1,
  temporal     : 1,
  related      : 1,
  part_of      : 2,
  contradicts  : 3,
  superseded_by: 3,
  caused_by    : 3,
  resolved_by  : 3,
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

export class LinkStore {
  /**
   * fragment_links에 링크를 생성하고 양방향 linked_to 배열을 갱신한다.
   *
   * @param {string} fromId
   * @param {string} toId
   * @param {string} relationType
   * @param {string} agentId
   */
  async createLink(fromId, toId, relationType = "related", agentId = "default", weight = 1) {
    /**
     * 데드락 방지: sorted 순서로 pg_advisory_xact_lock 획득 후 INSERT.
     * advisory lock과 INSERT는 동일 트랜잭션 안에서 순차 실행해야 하므로
     * raw pool client를 사용해 하나의 트랜잭션으로 묶는다.
     * from_id/to_id 방향은 원래 호출 파라미터 그대로 유지한다.
     */
    const [lockFirst, lockSecond] = fromId < toId ? [fromId, toId] : [toId, fromId];
    const safeAgent = String(agentId || "default").replace(/[^a-zA-Z0-9_-]/g, "");

    await withTransaction(getPrimaryPool(), async (client) => {
      await client.query(buildSearchPath(SCHEMA));
      // security: agentId sanitized via /[^a-zA-Z0-9_-]/g — SET LOCAL does not support parameter binding
      await client.query(`SET LOCAL app.current_agent_id = '${safeAgent}'`);
      await client.query("SET LOCAL hnsw.ef_search = 80");
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtext($1::text)), pg_advisory_xact_lock(hashtext($2::text))`,
        [lockFirst, lockSecond]
      );
      /**
       * 관계 강등 방지: 기존 관계가 더 구체적이면 relation_type을 보존한다.
       * weight는 항상 큰 값을 유지한다.
       */
      await client.query(
        `INSERT INTO ${SCHEMA}.fragment_links (from_id, to_id, relation_type, weight)
               VALUES ($1, $2, $3, $4)
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
                     END${reviveAssignments()}`,
        [fromId, toId, relationType, weight, JSON.stringify(RELATION_PRECEDENCE)]
      );
    });

    /** 양방향 linked_to 갱신 */
    await queryWithAgentVector(agentId,
      `UPDATE ${SCHEMA}.fragments
             SET linked_to = array_append(
                 CASE WHEN NOT ($2 = ANY(linked_to)) THEN linked_to ELSE linked_to END, $2
             )
             WHERE id = $1 AND NOT ($2 = ANY(linked_to))`,
      [fromId, toId],
      "write"
    );
    await queryWithAgentVector(agentId,
      `UPDATE ${SCHEMA}.fragments
             SET linked_to = array_append(
                 CASE WHEN NOT ($1 = ANY(linked_to)) THEN linked_to ELSE linked_to END, $1
             )
             WHERE id = $2 AND NOT ($1 = ANY(linked_to))`,
      [fromId, toId],
      "write"
    );
  }

  /**
   * 가져온 링크 한 건을 호출자의 트랜잭션 client로 기록한다. 같은 (from_id, to_id) 행이 이미
   * 있으면 건드리지 않고 created=false를 돌려준다. 새로 만들었으면 양쪽 파편의 linked_to에
   * 상대 id를 더한다.
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
       ON CONFLICT (from_id, to_id) DO NOTHING`,
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
    if (inserted.rowCount === 0) return { created: false };

    /** 양 끝 행을 id 순으로 잠근 뒤 각자의 linked_to에 상대 id를 더한다. */
    await client.query(
      `WITH locked AS (
         SELECT id FROM ${SCHEMA}.fragments
          WHERE id = ANY($1::text[])
          ORDER BY id
            FOR NO KEY UPDATE
       )
       UPDATE ${SCHEMA}.fragments f
          SET linked_to = array_append(COALESCE(f.linked_to, '{}'), CASE WHEN f.id = $2 THEN $3 ELSE $2 END)
         FROM locked
        WHERE f.id = locked.id
          AND NOT (CASE WHEN f.id = $2 THEN $3 ELSE $2 END = ANY(COALESCE(f.linked_to, '{}')))`,
      [[link.from_id, link.to_id], link.from_id, link.to_id]
    );
    return { created: true };
  }

  /**
   * fragment_links 다중 행 배치 INSERT (Phase 5 SessionLinker 최적화)
   *
   * 단일 트랜잭션에서 advisory lock 일괄 획득 → multi-row INSERT ON CONFLICT를
   * 수행한다. 데드락 방지를 위해 pairs는 sortedKey(min,max) 사전식 오름차순으로
   * 전달되어야 한다 (호출자 책임 — SessionLinker.autoLinkSessionFragments가 보장).
   *
   * 부분 실패는 전체 롤백 후 에러를 throw한다. 호출자는 필요 시 단건 createLink
   * fallback을 수행할 수 있다.
   *
   * @param {Array<{fromId: string, toId: string, relationType: string}>} pairs
   * @param {string} agentId
   * @returns {Promise<string[]>} 삽입/갱신된 fragment_links row id 배열
   */
  async createLinks(pairs, agentId = "default") {
    if (!pairs || pairs.length === 0) return [];

    const safeAgent = String(agentId || "default").replace(/[^a-zA-Z0-9_-]/g, "");
    const pool      = getPrimaryPool();
    if (!pool) return [];

    const result = await withTransaction(pool, async (client) => {
      await client.query(buildSearchPath(SCHEMA));
      await client.query(`SET LOCAL lock_timeout = '5s'`);
      await client.query(`SET LOCAL app.current_agent_id = '${safeAgent}'`);

      /**
       * advisory lock 일괄 획득: sortedKey 순서로 순회.
       * pairs는 이미 sortedKey 사전식 정렬 상태로 전달되므로
       * 순서 재정렬 없이 그대로 traverse.
       * pg_advisory_xact_lock(int, int): 트랜잭션 종료 시 자동 해제.
       */
      for (const { fromId, toId } of pairs) {
        const minId = fromId < toId ? fromId : toId;
        const maxId = fromId < toId ? toId   : fromId;
        await client.query(
          `SELECT pg_advisory_xact_lock(hashtext($1::text)::int, hashtext($2::text)::int)`,
          [minId, maxId]
        );
      }

      /**
       * multi-row INSERT 빌드.
       * VALUES ($1,$2,$3,$4), ($5,$6,$7,$8), ...
       */
      const valueClauses = [];
      const params       = [];
      let   idx          = 1;
      for (const { fromId, toId, relationType } of pairs) {
        valueClauses.push(`($${idx}, $${idx + 1}, $${idx + 2}, 1.0)`);
        params.push(fromId, toId, relationType ?? "related");
        idx += 3;
      }

      const insertSql = `
        INSERT INTO ${SCHEMA}.fragment_links (from_id, to_id, relation_type, weight)
        VALUES ${valueClauses.join(", ")}
        ON CONFLICT (from_id, to_id) DO UPDATE
          SET relation_type = EXCLUDED.relation_type,
              weight        = CASE
                WHEN ${deletedRowCondition(`${SCHEMA}.fragment_links`)} THEN EXCLUDED.weight
                ELSE GREATEST(${SCHEMA}.fragment_links.weight, EXCLUDED.weight)
              END${reviveAssignments()}
        RETURNING id`;

      // iron-laws: ignore[IL-501] SQL 식별자는 코드 상수이고 입력값은 $n 자리표시자로 바인딩한다
      return client.query(insertSql, params);
    });

    const insertedIds = result.rows.map(r => r.id);

    /**
     * 양방향 linked_to 배열 갱신 (배치).
     * 정방향·역방향 쌍을 하나의 방향 목록으로 펼쳐 한 문장으로 갱신한다.
     * 각 파편은 자신이 속한 쌍의 상대 id만 받으며, 대상 행은 앞선 잠금 문장에서
     * id 순으로 잠가($1) 다른 쓰기 경로와 잠금 순서를 맞춘다.
     */
    const srcIds = [...pairs.map(p => p.fromId), ...pairs.map(p => p.toId)];
    const dstIds = [...pairs.map(p => p.toId),   ...pairs.map(p => p.fromId)];

    await queryWithAgentVector(agentId,
      `UPDATE ${SCHEMA}.fragments f
       SET linked_to = (
         SELECT array_agg(DISTINCT elem)
         FROM (
           SELECT unnest(f.linked_to) AS elem
           UNION
           SELECT p.dst AS elem
           FROM unnest($2::text[], $3::text[]) AS p(src, dst)
           WHERE p.src = f.id
         ) sub
       )
       WHERE f.id = ANY($1::text[])`,
      [srcIds, dstIds],
      { lock: fragmentRowLock("link_sync", "id = ANY($1::text[])", [srcIds]) }
    ).catch((err) => {
      logWarn(`[LinkStore] createLinks linked_to update failed: ${err.message}`);
    });

    return insertedIds;
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
   * 연결된 파편 ID 조회 (1-hop, key_id 격리 필터 포함)
   *
   * @param {string}      fragmentId
   * @param {string}      agentId
   * @param {string|null} keyId  - null: master(전체), string: 해당 API 키 소유만
   * @returns {Promise<string[]>}
   */
  async getLinkedIds(fragmentId, agentId = "default", keyId = null) {
    const params    = [fragmentId];
    const keyFilter = keyId == null
      ? ""
      : keyScopeNullable(params, "key_id", keyId).trimStart();
    const result = await queryWithAgentVector(agentId,
      `SELECT linked_to FROM ${SCHEMA}.fragments
       WHERE id = $1
         AND valid_to IS NULL
         ${keyFilter}`,
      params
    );

    return result.rows[0]?.linked_to || [];
  }

  /**
   * 재귀 CTE로 startId에서 targetId까지 도달 가능 여부를 판정한다.
   * linked_to 배열(정방향)만 추적하며 최대 20홉 제한.
   * key_id 격리 필터를 각 홉 JOIN 조건에 적용한다.
   *
   * @param {string}      startId  - 탐색 시작 파편
   * @param {string}      targetId - 도달 목표 파편
   * @param {string}      agentId
   * @param {string|null} keyId
   * @returns {Promise<boolean>}
   */
  async isReachable(startId, targetId, agentId = "default", keyId = null) {
    const params    = [startId, targetId];
    const keyFilter = keyId == null
      ? ""
      : keyScopeNullable(params, "f.key_id", keyId).trimStart();
    const result = await queryWithAgentVector(agentId,
      `WITH RECURSIVE reachable AS (
         SELECT unnest(f0.linked_to) AS id, 1 AS depth
         FROM ${SCHEMA}.fragments f0
         WHERE f0.id = $1
           AND f0.valid_to IS NULL
       UNION
         SELECT unnest(f.linked_to), r.depth + 1
         FROM reachable r
         JOIN ${SCHEMA}.fragments f ON f.id = r.id
         WHERE r.depth < 20
           AND r.id != $2
           AND f.valid_to IS NULL
           ${keyFilter}
       )
       SELECT EXISTS (SELECT 1 FROM reachable WHERE id = $2) AS found`,
      params
    );
    return result.rows[0]?.found === true;
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
