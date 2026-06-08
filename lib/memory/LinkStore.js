/**
 * LinkStore — 파편 링크 관리 (fragment_links 테이블 CRUD + RCA 체인)
 *
 * 작성자: 최진호
 * 작성일: 2026-03-12
 */

import { queryWithAgentVector, getPrimaryPool } from "../tools/db.js";
import { buildSearchPath }                       from "../config.js";
import { MEMORY_CONFIG }        from "../../config/memory.js";
import { keyScopeClause }       from "./keyScope.js";

const SCHEMA = "agent_memory";

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
    const client    = await getPrimaryPool().connect();
    try {
      await client.query(`SET search_path TO ${SCHEMA}, nerdvana, public`);
      await client.query("BEGIN");
      // security: agentId sanitized via /[^a-zA-Z0-9_-]/g — SET LOCAL does not support parameter binding
      await client.query(`SET LOCAL app.current_agent_id = '${safeAgent}'`);
      await client.query("SET LOCAL hnsw.ef_search = 80");
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtext($1::text)), pg_advisory_xact_lock(hashtext($2::text))`,
        [lockFirst, lockSecond]
      );
      await client.query(
        `INSERT INTO ${SCHEMA}.fragment_links (from_id, to_id, relation_type, weight)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT (from_id, to_id) DO UPDATE
                 SET relation_type = EXCLUDED.relation_type,
                     weight        = GREATEST(${SCHEMA}.fragment_links.weight, EXCLUDED.weight)`,
        [fromId, toId, relationType, weight]
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }

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

    const client = await pool.connect();
    try {
      await client.query(buildSearchPath(SCHEMA));
      await client.query("BEGIN");
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
              weight        = GREATEST(${SCHEMA}.fragment_links.weight, EXCLUDED.weight),
              accessed_at   = NOW()
        RETURNING id`;

      const result = await client.query(insertSql, params);
      await client.query("COMMIT");

      const insertedIds = result.rows.map(r => r.id);

      /**
       * 양방향 linked_to 배열 갱신 (배치).
       * 단일 UPDATE ... WHERE id = ANY(...) 로 묶어 N+1 방지.
       */
      const allFromIds = pairs.map(p => p.fromId);
      const allToIds   = pairs.map(p => p.toId);

      await queryWithAgentVector(agentId,
        `UPDATE ${SCHEMA}.fragments f
         SET linked_to = (
           SELECT array_agg(DISTINCT elem)
           FROM (
             SELECT unnest(f.linked_to) AS elem
             UNION
             SELECT unnest($2::text[]) AS elem
           ) sub
         )
         WHERE f.id = ANY($1::text[])`,
        [allFromIds, allToIds],
        "write"
      ).catch(() => {});

      await queryWithAgentVector(agentId,
        `UPDATE ${SCHEMA}.fragments f
         SET linked_to = (
           SELECT array_agg(DISTINCT elem)
           FROM (
             SELECT unnest(f.linked_to) AS elem
             UNION
             SELECT unnest($2::text[]) AS elem
           ) sub
         )
         WHERE f.id = ANY($1::text[])`,
        [allToIds, allFromIds],
        "write"
      ).catch(() => {});

      return insertedIds;

    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * fragment_links 테이블에서 1-hop 연결 파편 조회
   *
   * @param {string[]}    fromIds
   * @param {string|null} relationType
   * @param {string}      agentId
   * @param {number|null} keyId  - API 키 격리 필터 (null=master, 전체 조회)
   * @returns {Promise<object[]>}
   */
  async getLinkedFragments(fromIds, relationType = null, agentId = "default", keyId = null) {
    if (fromIds.length === 0) return [];

    const ALLOWED_RELATION_TYPES = new Set([
      "related", "caused_by", "resolved_by", "part_of", "contradicts", "superseded_by", "co_retrieved", "temporal"
    ]);
    const safeRelationType = relationType && ALLOWED_RELATION_TYPES.has(relationType)
      ? relationType
      : null;

    let result;
    if (safeRelationType) {
      const params    = [fromIds, safeRelationType];
      let keyFilter   = "";
      if (keyId != null) {
        params.push(Array.isArray(keyId) ? keyId : [keyId]);
        keyFilter = `AND f.key_id = ANY($${params.length})`;
      }
      result = await queryWithAgentVector(agentId,
        `SELECT DISTINCT ON (id)
                         id, content, topic, keywords, type,
                         importance, linked_to, access_count,
                         created_at, verified_at, relation_type,
                         link_weight, relation_order
         FROM (
           SELECT f.id, f.content, f.topic, f.keywords, f.type,
                  f.importance, f.linked_to, f.access_count,
                  f.created_at, f.verified_at, l.relation_type,
                  COALESCE(l.weight, 1) AS link_weight,
                  CASE l.relation_type
                    WHEN 'resolved_by' THEN 1
                    WHEN 'caused_by'   THEN 2
                    ELSE 3
                  END AS relation_order
           FROM ${SCHEMA}.fragment_links l
           JOIN ${SCHEMA}.fragments f ON l.to_id = f.id
           WHERE l.from_id = ANY($1)
             AND l.relation_type = $2
             ${keyFilter}
           UNION ALL
           SELECT f.id, f.content, f.topic, f.keywords, f.type,
                  f.importance, f.linked_to, f.access_count,
                  f.created_at, f.verified_at, l.relation_type,
                  COALESCE(l.weight, 1) AS link_weight,
                  CASE l.relation_type
                    WHEN 'resolved_by' THEN 1
                    WHEN 'caused_by'   THEN 2
                    ELSE 3
                  END AS relation_order
           FROM ${SCHEMA}.fragment_links l
           JOIN ${SCHEMA}.fragments f ON l.from_id = f.id
           WHERE l.to_id = ANY($1)
             AND l.relation_type = $2
             ${keyFilter}
         ) sub
         ORDER BY id, link_weight DESC, relation_order, importance DESC
         LIMIT ${MEMORY_CONFIG.linkedFragmentLimit}`,
        params
      );
    } else {
      const params    = [fromIds];
      let keyFilter   = "";
      if (keyId != null) {
        params.push(Array.isArray(keyId) ? keyId : [keyId]);
        keyFilter = `AND f.key_id = ANY($${params.length})`;
      }
      result = await queryWithAgentVector(agentId,
        `SELECT DISTINCT ON (id)
                         id, content, topic, keywords, type,
                         importance, linked_to, access_count,
                         created_at, verified_at, relation_type,
                         link_weight, relation_order
         FROM (
           SELECT f.id, f.content, f.topic, f.keywords, f.type,
                  f.importance, f.linked_to, f.access_count,
                  f.created_at, f.verified_at, l.relation_type,
                  COALESCE(l.weight, 1) AS link_weight,
                  CASE l.relation_type
                    WHEN 'resolved_by' THEN 1
                    WHEN 'caused_by'   THEN 2
                    ELSE 3
                  END AS relation_order
           FROM ${SCHEMA}.fragment_links l
           JOIN ${SCHEMA}.fragments f ON l.to_id = f.id
           WHERE l.from_id = ANY($1)
             AND l.relation_type IN ('caused_by', 'resolved_by', 'related', 'co_retrieved')
             ${keyFilter}
           UNION ALL
           SELECT f.id, f.content, f.topic, f.keywords, f.type,
                  f.importance, f.linked_to, f.access_count,
                  f.created_at, f.verified_at, l.relation_type,
                  COALESCE(l.weight, 1) AS link_weight,
                  CASE l.relation_type
                    WHEN 'resolved_by' THEN 1
                    WHEN 'caused_by'   THEN 2
                    ELSE 3
                  END AS relation_order
           FROM ${SCHEMA}.fragment_links l
           JOIN ${SCHEMA}.fragments f ON l.from_id = f.id
           WHERE l.to_id = ANY($1)
             AND l.relation_type IN ('caused_by', 'resolved_by', 'related', 'co_retrieved')
             ${keyFilter}
         ) sub
         ORDER BY id, link_weight DESC, relation_order, importance DESC
         LIMIT ${MEMORY_CONFIG.linkedFragmentLimit}`,
        params
      );
    }

    return result.rows;
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
    let keyFilter   = "";
    if (keyId != null) {
      params.push(keyId);
      keyFilter = `AND key_id IS NOT DISTINCT FROM $${params.length}`;
    }
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
    let keyFilter   = "";
    if (keyId != null) {
      params.push(keyId);
      keyFilter = `AND f.key_id IS NOT DISTINCT FROM $${params.length}`;
    }
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
   * RCA 체인 조회 (caused_by, resolved_by 1-hop)
   *
   * @param {string} startId
   * @param {string} agentId
   * @returns {Promise<object[]>}
   */
  async getRCAChain(startId, agentId = "default", keyId = null, groupKeyIds = []) {
    const params = [startId];
    const scope  = { keyId, groupKeyIds };
    const seedKeyFilter = keyScopeClause(params, "f.key_id",  scope);
    const keyFilter     = keyScopeClause(params, "f2.key_id", scope);

    const result = await queryWithAgentVector(agentId,
      `WITH rca AS (
         SELECT f.id, f.content, f.type, f.importance, f.topic,
                NULL::text AS relation_type, 0 AS depth
         FROM ${SCHEMA}.fragments f
         WHERE f.id = $1
           AND f.valid_to IS NULL
           ${seedKeyFilter}

         UNION ALL

         SELECT f2.id, f2.content, f2.type, f2.importance, f2.topic,
                l.relation_type, 1 AS depth
         FROM ${SCHEMA}.fragment_links l
         JOIN ${SCHEMA}.fragments f2 ON l.to_id = f2.id
         WHERE l.from_id = $1
           AND l.relation_type IN ('caused_by', 'resolved_by')
           AND f2.valid_to IS NULL
           ${keyFilter}
       )
       SELECT * FROM rca ORDER BY depth ASC, importance DESC`,
      params
    );

    return result.rows;
  }
}
