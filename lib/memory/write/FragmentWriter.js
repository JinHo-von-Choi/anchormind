/**
 * FragmentWriter - PostgreSQL 파편 쓰기 작업
 *
 * 작성자: 최진호
 * 작성일: 2026-03-15
 * 수정일: 2026-04-03 (Narrative Reconstruction Phase 1: case_id, goal, outcome, phase, resolution_status, assertion_status INSERT 추가)
 * 수정일: 2026-04-18 (migration-034-v2.16.0-bundle: affect 정서 태그 컬럼 추가)
 */

import { getPrimaryPool, queryWithAgentVector } from "../../tools/db.js";
import { buildSearchPath }                       from "../../config.js";
import { MEMORY_CONFIG }                         from "../../../config/memory.js";
import { computeContentHash }                    from "../../tools/embedding.js";
import { logWarn }                               from "../../logger.js";
import { recordTenantIsolationBlocked }          from "../../metrics.js";

const SCHEMA = "agent_memory";

/**
 * 허용되는 정서 태그 값 집합.
 * migration-034-v2.16.0-bundle의 CHECK 제약과 반드시 동기화 유지.
 */
export const VALID_AFFECT_VALUES = new Set([
  "neutral", "frustration", "confidence", "surprise", "doubt", "satisfaction"
]);

/** 허용값 외 입력은 'neutral'로 강제 */
export function sanitizeAffect(affect) {
  if (!affect || !VALID_AFFECT_VALUES.has(affect)) return "neutral";
  return affect;
}

/** 타입별 최대 초기 importance */
const MAX_INITIAL_IMPORTANCE = {
  error    : 0.6,
  procedure: 0.6,
  fact     : 0.7,
  decision : 0.7,
  relation : 0.7,
  preference: 0.9,
  default  : 0.7
};

/**
 * 삽입 시 importance 상한 적용
 *
 * - is_anchor=TRUE: 제한 없음
 * - content 20자 미만: 최대 0.2
 * - 타입별 상한 초과: clamp
 *
 * @param {string}  content
 * @param {string}  type
 * @param {number}  requestedImportance
 * @param {boolean} [isAnchor=false]
 * @returns {number}
 */
export function sanitizeInsertImportance(content, type, requestedImportance, isAnchor = false) {
  if (isAnchor) return requestedImportance;
  const max = MAX_INITIAL_IMPORTANCE[type] ?? MAX_INITIAL_IMPORTANCE.default;
  const imp = Math.min(requestedImportance, max);
  if ((content || "").length < 20) {
    return Math.min(imp, 0.2);
  }
  return imp;
}

export class FragmentWriter {
  constructor() {
    this.schemaInitialized = false;
  }

  /**
   * 스키마 초기화 확인 (최초 1회)
   */
  async ensureSchema() {
    if (this.schemaInitialized) return;

    const pool = getPrimaryPool();
    if (!pool) return;

    try {
      // 스키마 생성은 'default' 컨텍스트에서 수행
      await queryWithAgentVector("default", `CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`, [], "write");
      this.schemaInitialized = true;
    } catch (err) {
      logWarn(`[FragmentWriter] Schema check failed: ${err.message}`);
    }
  }

  /**
   * 파편 저장
   *
   * @param {Object}      fragment           - 저장할 파편 객체
   * @param {Object}      [opts]             - 옵션
   * @param {import('pg').PoolClient} [opts.client] - 외부 트랜잭션 client.
   *   제공 시 해당 client로 쿼리를 실행한다 (BEGIN/COMMIT은 호출자 책임).
   *   미제공 시 내부에서 pool client를 획득하고 자체 트랜잭션을 관리한다.
   * @returns {Promise<string|null>} fragment id
   */
  async insert(fragment, { client: externalClient } = {}) {
    const pool = getPrimaryPool();
    if (!pool) return null;

    await this.ensureSchema();

    const row = this._prepareInsertRow(fragment);
    return this._runInsert(externalClient, row);
  }

  /**
   * INSERT 대상 컬럼값을 정규화하고 SQL/파라미터를 구성한다.
   *
   * @param {Object} fragment - 저장할 파편 객체
   * @returns {{agentId: string, contentHash: string, keyId: (string|null), safeAgent: string,
   *   insertSql: string, insertParams: Array, fragmentId: *}}
   */
  _prepareInsertRow(fragment) {
    const agentId     = fragment.agent_id || "default";
    const contentHash = computeContentHash(fragment.content);
    const keyId       = fragment.key_id ?? null;
    const safeAgent   = String(agentId).replace(/[^a-zA-Z0-9_-]/g, "");

    const embeddingStr = null;

    const estimatedTokens = fragment.estimated_tokens || Math.ceil((fragment.content || "").length / 4);

    const validFrom      = fragment.valid_from || new Date().toISOString();
    const isAnchor       = fragment.is_anchor === true;
    const affect         = sanitizeAffect(fragment.affect);
    const embeddingParam = embeddingStr ? "$28::vector" : "NULL";

    const rawImportance = fragment.importance ?? 0.5;
    const importance    = sanitizeInsertImportance(
      fragment.content,
      fragment.type,
      rawImportance,
      isAnchor
    );

    /**
     * ON CONFLICT inference: partial index 2개에 각각 매핑
     *  - master  (key_id IS NULL):     uq_frag_hash_master   (content_hash) WHERE key_id IS NULL
     *  - DB key  (key_id IS NOT NULL): uq_frag_hash_per_key  (key_id, content_hash) WHERE key_id IS NOT NULL
     */
    const onConflictClause = keyId === null
      ? `ON CONFLICT (content_hash) WHERE key_id IS NULL DO UPDATE SET`
      : `ON CONFLICT (key_id, content_hash) WHERE key_id IS NOT NULL DO UPDATE SET`;

    const insertSql = `INSERT INTO ${SCHEMA}.fragments
                (id, content, topic, keywords, type, importance, content_hash,
                 source, linked_to, agent_id, ttl_tier, estimated_tokens, valid_from, key_id, is_anchor,
                 context_summary, session_id, workspace,
                 case_id, goal, outcome, phase, resolution_status, assertion_status,
                 validation_warnings, affect, idempotency_key,
                 embedding)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::timestamptz,
                     $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25::jsonb, $26, $27, ${embeddingParam})
             ${onConflictClause}
                importance  = GREATEST(${SCHEMA}.fragments.importance, EXCLUDED.importance),
                is_anchor   = ${SCHEMA}.fragments.is_anchor OR EXCLUDED.is_anchor,
                accessed_at = NOW()
             RETURNING id`;

    const insertParams = [
      fragment.id,
      fragment.content,
      fragment.topic,
      fragment.keywords || [],
      fragment.type,
      importance,
      contentHash,
      fragment.source || null,
      fragment.linked_to || [],
      agentId,
      fragment.ttl_tier || "warm",
      estimatedTokens,
      validFrom,
      keyId,
      isAnchor,
      fragment.context_summary || null,
      fragment.session_id || null,
      fragment.workspace || null,
      fragment.case_id || null,
      fragment.goal || null,
      fragment.outcome || null,
      fragment.phase || null,
      fragment.resolution_status || null,
      fragment.assertion_status || "observed",
      (Array.isArray(fragment.validation_warnings) && fragment.validation_warnings.length > 0)
        ? JSON.stringify(fragment.validation_warnings.map(v =>
            typeof v === "object" && v !== null && v.rule ? String(v.rule) : String(v)
          ))
        : null,
      affect,
      fragment.idempotency_key ?? null,
      ...(embeddingStr ? [embeddingStr] : [])
    ];

    return { agentId, contentHash, keyId, safeAgent, insertSql, insertParams, fragmentId: fragment.id };
  }

  /**
   * 중복 검사 후 INSERT SQL을 실행한다.
   *
   * externalClient가 주어지면 이미 열린 트랜잭션 내에서 실행한다 (key_id 격리 적용, 크로스 테넌트 hit 방지).
   *
   * @param {import('pg').PoolClient|undefined} externalClient
   * @param {ReturnType<FragmentWriter['_prepareInsertRow']>} row
   * @returns {Promise<string|null>} fragment id
   */
  async _runInsert(externalClient, row) {
    const { agentId, contentHash, keyId, safeAgent, insertSql, insertParams, fragmentId } = row;

    if (externalClient) {
      const dup = await externalClient.query(
        `SELECT id FROM ${SCHEMA}.fragments
         WHERE content_hash = $1
           AND key_id IS NOT DISTINCT FROM $2`,
        [contentHash, keyId]
      );
      if (dup.rows.length > 0) return dup.rows[0].id;
    } else {
      const dup = await queryWithAgentVector(agentId,
        `SELECT id FROM ${SCHEMA}.fragments
         WHERE content_hash = $1
           AND key_id IS NOT DISTINCT FROM $2`,
        [contentHash, keyId]
      );
      if (dup.rows.length > 0) return dup.rows[0].id;
    }

    if (externalClient) {
      /** SET LOCAL은 BEGIN 이후에만 유효 — 호출자가 BEGIN을 열었음을 전제한다 */
      await externalClient.query(`SET LOCAL app.current_agent_id = '${safeAgent}'`);
      const result = await externalClient.query(insertSql, insertParams);
      return result.rows[0]?.id || fragmentId;
    }

    const result = await queryWithAgentVector(agentId, insertSql, insertParams, "write");
    return result.rows[0]?.id || fragmentId;
  }

  /**
   * 파편의 현재 상태를 이력 테이블에 저장
   */
  async archiveVersion(fragment, agentId = "default") {
    await queryWithAgentVector(agentId,
      `INSERT INTO ${SCHEMA}.fragment_versions
                (fragment_id, content, topic, keywords, type, importance, amended_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        fragment.id,
        fragment.content,
        fragment.topic,
        fragment.keywords,
        fragment.type,
        fragment.importance,
        agentId
      ],
      "write"
    ).catch(err => logWarn(`[FragmentWriter] archiveVersion failed: ${err.message}`));
  }

  /**
   * 파편 수정 (amend) - 트랜잭션 보장
   *
   * 아카이빙 → 콘텐츠 중복 검사 → UPDATE를 단일 트랜잭션으로 실행하여
   * 아카이빙 후 UPDATE 실패 시 롤백을 보장한다.
   *
   * @param {string}      id       - 갱신 대상 파편 ID
   * @param {Object}      updates  - 갱신할 필드 { content, topic, keywords, type, importance, is_anchor }
   * @param {string}      agentId  - 에이전트 ID
   * @param {string|null} keyId    - null: 마스터(전체 수정 가능), string: 소유 파편만 수정
   * @param {Object|null} existing - 미리 조회된 파편 (없으면 내부에서 조회)
   * @returns {Object|null} 갱신된 파편
   */
  async update(id, updates, agentId = "default", keyId = null, existing = null) {
    if (!existing) {
      const lookup = await queryWithAgentVector(agentId,
        `SELECT id, content, topic, keywords, type, importance,
                source, linked_to, agent_id, access_count,
                accessed_at, created_at, ttl_tier, verified_at, is_anchor, key_id
         FROM ${SCHEMA}.fragments WHERE id = $1`,
        [id]
      );
      existing = lookup.rows[0] || null;
      if (!existing) return null;
    }

    /** API 키 소유권 검사 */
    if (keyId && existing.key_id !== keyId) {
      recordTenantIsolationBlocked("amend");
      return null;
    }

    const pool = getPrimaryPool();
    if (!pool) return null;

    const safeAgent = String(agentId || "default").replace(/[^a-zA-Z0-9_-]/g, "");
    const client    = await pool.connect();

    try {
      await client.query(buildSearchPath(SCHEMA));
      await client.query("BEGIN");
      /** SET LOCAL은 파라미터 바인딩 미지원 — safeAgent는 [^a-zA-Z0-9_\-]로 정제됨 */
      await client.query(`SET LOCAL app.current_agent_id = '${safeAgent}'`);

      /** 수정 전 상태 아카이빙 (버전 관리) */
      await client.query(
        `INSERT INTO ${SCHEMA}.fragment_versions
                  (fragment_id, content, topic, keywords, type, importance, amended_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          existing.id,
          existing.content,
          existing.topic,
          existing.keywords,
          existing.type,
          existing.importance,
          agentId
        ]
      );

      const diff = await this._diffUpdatableFields(client, id, existing, updates);
      if (diff.merged) {
        await client.query("ROLLBACK");
        return { merged: true, existingId: diff.existingId };
      }

      if (diff.setClauses.length === 0) {
        await client.query("ROLLBACK");
        return existing;
      }

      const result = await this._runUpdate(client, id, diff);

      await client.query("COMMIT");
      return result;

    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * updates와 existing 파편을 비교하여 UPDATE SET 절 대상과 파라미터를 산출한다.
   *
   * content 변경 시 콘텐츠 해시 중복 검사를 수행하며, 중복이면 병합 신호를 반환한다.
   *
   * @param {import('pg').PoolClient} client
   * @param {string} id
   * @param {Object} existing
   * @param {Object} updates
   * @returns {Promise<{merged: true, existingId: string}|{setClauses: string[], params: Array}>}
   */
  async _diffUpdatableFields(client, id, existing, updates) {
    const setClauses = [];
    const params     = [id];
    let paramIdx     = 2;

    if (updates.content !== undefined) {
      const newHash = computeContentHash(updates.content);

      const dup = await client.query(
        `SELECT id FROM ${SCHEMA}.fragments
         WHERE content_hash = $1
           AND id != $2
           AND key_id IS NOT DISTINCT FROM $3`,
        [newHash, id, existing.key_id ?? null]
      );
      if (dup.rows.length > 0) {
        return { merged: true, existingId: dup.rows[0].id };
      }

      setClauses.push(`content = $${paramIdx}`);
      params.push(updates.content);
      paramIdx++;

      setClauses.push(`content_hash = $${paramIdx}`);
      params.push(newHash);
      paramIdx++;

      setClauses.push("embedding = NULL");
    }

    if (updates.topic !== undefined) {
      setClauses.push(`topic = $${paramIdx}`);
      params.push(updates.topic);
      paramIdx++;
    }

    if (updates.keywords !== undefined) {
      setClauses.push(`keywords = $${paramIdx}`);
      params.push(updates.keywords);
      paramIdx++;
    }

    if (updates.type !== undefined) {
      setClauses.push(`type = $${paramIdx}`);
      params.push(updates.type);
      paramIdx++;
    }

    if (updates.importance !== undefined) {
      setClauses.push(`importance = $${paramIdx}`);
      params.push(updates.importance);
      paramIdx++;
    }

    if (updates.is_anchor !== undefined) {
      setClauses.push(`is_anchor = $${paramIdx}`);
      params.push(updates.is_anchor);
      paramIdx++;
    }

    if (updates.quality_verified !== undefined) {
      setClauses.push(`quality_verified = $${paramIdx}`);
      params.push(updates.quality_verified);
      paramIdx++;
    }

    if (updates.assertion_status !== undefined) {
      setClauses.push(`assertion_status = $${paramIdx}`);
      params.push(updates.assertion_status);
      paramIdx++;
    }

    if (updates.affect !== undefined) {
      setClauses.push(`affect = $${paramIdx}`);
      params.push(sanitizeAffect(updates.affect));
      paramIdx++;
    }

    return { setClauses, params };
  }

  /**
   * SET 절과 파라미터로 UPDATE SQL을 실행한다.
   *
   * @param {import('pg').PoolClient} client
   * @param {string} id
   * @param {{setClauses: string[], params: Array}} fields
   * @returns {Promise<Object|null>} 갱신된 파편
   */
  async _runUpdate(client, id, fields) {
    const { setClauses, params } = fields;
    setClauses.push("verified_at = NOW()");
    setClauses.push("accessed_at = NOW()");

    const result = await client.query(
      `UPDATE ${SCHEMA}.fragments
             SET ${setClauses.join(", ")}
             WHERE id = $1
             RETURNING id, content, topic, keywords, type, importance,
                       source, linked_to, agent_id, access_count,
                       accessed_at, created_at, ttl_tier, verified_at, is_anchor,
                       valid_from, valid_to, assertion_status, quality_verified,
                       case_id, key_id, affect`,
      params
    );

    return result.rows[0] || null;
  }

  /**
   * 파편 삭제
   *
   * @param {string}      id
   * @param {string}      agentId
   * @param {string|null} keyId - null: 마스터(전체 삭제 가능), string: 소유 파편만 삭제
   */
  async delete(id, agentId = "default", keyId = null) {
    /** API 키 소유권 검사: keyId가 있으면 해당 파편의 key_id와 일치해야 함 */
    if (keyId) {
      const ownership = await queryWithAgentVector(agentId,
        `SELECT id FROM ${SCHEMA}.fragments WHERE id = $1 AND key_id = $2`,
        [id, keyId]
      );
      if (ownership.rows.length === 0) return false;
    }

    /** fragment_links 테이블에서 관련 링크 제거 (CASCADE 보충) */
    await queryWithAgentVector(agentId,
      `DELETE FROM ${SCHEMA}.fragment_links
             WHERE from_id = $1 OR to_id = $1`,
      [id],
      "write"
    ).catch(() => {});

    /** linked_to 배열에서 제거 */
    await queryWithAgentVector(agentId,
      `UPDATE ${SCHEMA}.fragments
             SET linked_to = array_remove(linked_to, $1)
             WHERE $1 = ANY(linked_to)`,
      [id],
      "write"
    );

    const result = await queryWithAgentVector(agentId,
      `DELETE FROM ${SCHEMA}.fragments WHERE id = $1`,
      [id],
      "write"
    );

    return result.rowCount > 0;
  }

  /**
   * 파편 다수 일괄 삭제 (N+1 DELETE 방지)
   *
   * 단일 DELETE ... WHERE id = ANY($1) 쿼리로 배열 전체를 처리한다.
   * keyId가 null이면 마스터(전체 삭제), 값이 있으면 소유 파편만 삭제.
   *
   * @param {string[]}    ids
   * @param {string}      agentId
   * @param {string|null} keyId
   * @returns {Promise<number>} 실제 삭제된 행 수
   */
  async deleteMany(ids, agentId = "default", keyId = null) {
    if (!ids || ids.length === 0) return 0;

    /** fragment_links 관련 링크 일괄 제거 */
    await queryWithAgentVector(agentId,
      `DELETE FROM ${SCHEMA}.fragment_links
             WHERE from_id = ANY($1) OR to_id = ANY($1)`,
      [ids],
      "write"
    ).catch(() => {});

    /** linked_to 배열에서 일괄 제거 */
    await queryWithAgentVector(agentId,
      `UPDATE ${SCHEMA}.fragments
             SET linked_to = (
               SELECT COALESCE(array_agg(elem), '{}')
               FROM unnest(linked_to) AS elem
               WHERE elem != ALL($1)
             )
             WHERE linked_to && $1`,
      [ids],
      "write"
    ).catch(() => {});

    let sql    = `DELETE FROM ${SCHEMA}.fragments WHERE id = ANY($1)`;
    const args = [ids];
    if (keyId) {
      sql += ` AND key_id = $2`;
      args.push(keyId);
    }

    const result = await queryWithAgentVector(agentId, sql, args, "write");
    return result.rowCount || 0;
  }

  /**
   * 에이전트의 모든 데이터 삭제 (GDPR 준수)
   */
  async deleteByAgent(agentId) {
    if (!agentId || agentId === "default") {
      throw new Error("Cannot delete 'default' agent data via this method");
    }

    const result = await queryWithAgentVector(agentId,
      `DELETE FROM ${SCHEMA}.fragments WHERE agent_id = $1`,
      [agentId],
      "write"
    );

    return result.rowCount;
  }

  /**
   * 접근 횟수 증가
   *
   * @param {string[]} ids
   * @param {string}   agentId
   * @param {Object}   [opts]
   * @param {boolean}  [opts.noEma=false] - true이면 EMA 컬럼 갱신 생략 (L1 fallback 경로)
   */
  async incrementAccess(ids, agentId = "default", { noEma = false } = {}) {
    if (ids.length === 0) return;

    const alpha = 0.3;

    if (noEma) {
      await queryWithAgentVector(agentId,
        `UPDATE ${SCHEMA}.fragments
               SET access_count = access_count + 1,
                   accessed_at  = NOW()
               WHERE id = ANY($1)`,
        [ids],
        "write"
      ).catch(err => logWarn(`[FragmentWriter] incrementAccess failed: ${err.message}`));
    } else {
      await queryWithAgentVector(agentId,
        `UPDATE ${SCHEMA}.fragments
               SET access_count      = access_count + 1,
                   accessed_at       = NOW(),
                   ema_activation    = $2 * POWER(
                                         GREATEST(
                                           EXTRACT(EPOCH FROM (NOW() - COALESCE(ema_last_updated, created_at - INTERVAL '1 day'))),
                                           1
                                         ), -0.5
                                       ) + (1 - $2) * COALESCE(ema_activation, 0),
                   ema_last_updated  = NOW()
               WHERE id = ANY($1)`,
        [ids, alpha],
        "write"
      ).catch(err => logWarn(`[FragmentWriter] incrementAccess failed: ${err.message}`));
    }
  }

  /**
   * co_retrieved 링크된 파편들의 accessed_at 갱신
   *
   * 직접 검색되지 않아도 co_retrieved 관계로 연결된 파편의
   * accessed_at을 갱신하여 GC 보호를 돕는다.
   * EMA는 갱신하지 않는다 — 직접 접근이 아님.
   *
   * @param {string[]}              retrievedIds - 직접 반환된 파편 ID 배열
   * @param {string}                agentId
   * @param {string|string[]|null}  keyId        - null: 마스터(전체), 단일값/배열: 소유 파편만
   */
  async touchLinked(retrievedIds, agentId, keyId = null) {
    if (!retrievedIds || retrievedIds.length === 0) return;
    const pool = getPrimaryPool();
    if (!pool) return;

    const params    = [retrievedIds];
    let   keyFilter = "";
    if (keyId != null) {
      const keyArr = Array.isArray(keyId) ? keyId : [keyId];
      params.push(keyArr);
      keyFilter = `AND key_id = ANY($${params.length}::text[])`;
    }

    await queryWithAgentVector(agentId,
      `UPDATE ${SCHEMA}.fragments
       SET accessed_at = NOW()
       WHERE id IN (
         SELECT DISTINCT
           CASE WHEN fl.from_id = ANY($1::text[]) THEN fl.to_id
                ELSE fl.from_id
           END
         FROM ${SCHEMA}.fragment_links fl
         WHERE (fl.from_id = ANY($1::text[]) OR fl.to_id = ANY($1::text[]))
           AND fl.relation_type = 'co_retrieved'
       )
       AND id != ALL($1::text[])
       ${keyFilter}`,
      params,
      "write"
    ).catch(() => {});
  }

  /**
   * assertion_status 단일 컬럼 업데이트 (비동기 패치 전용)
   *
   * checkAssertionConsistency 결과를 fire-and-forget으로 반영한다.
   * keyId가 null이면 마스터 컨텍스트(전체 수정), 값이 있으면 소유 파편만 수정.
   *
   * @param {string}      id              - 대상 파편 ID
   * @param {string}      assertionStatus - 'observed' | 'inferred' | 'verified' | 'rejected'
   * @param {number|null} keyId           - API 키 ID (null: 마스터)
   * @returns {Promise<boolean>} 업데이트 성공 여부
   */
  async patchAssertion(id, assertionStatus, keyId = null) {
    const params    = [assertionStatus, id];
    let   keyFilter = "";
    if (keyId != null) {
      params.push(keyId);
      keyFilter = `AND key_id = $${params.length}`;
    }
    const result = await queryWithAgentVector(
      keyId != null ? "default" : "system",
      `UPDATE ${SCHEMA}.fragments
       SET assertion_status = $1
       WHERE id = $2 ${keyFilter}`,
      params,
      "write"
    );
    return (result.rowCount || 0) > 0;
  }

  /**
   * 파편의 case_id 경량 업데이트 (자동 할당용)
   *
   * @param {string}      id     - 파편 ID
   * @param {string}      caseId - 할당할 case_id (UUID)
   * @param {string|null} keyId  - null: 마스터(전체 수정), string: 소유 파편만 수정
   * @returns {Promise<boolean>} 업데이트 성공 여부
   */
  async updateCaseId(id, caseId, keyId = null) {
    const params = [id, caseId];
    let keyFilter = "";
    if (keyId != null) {
      params.push(keyId);
      keyFilter = `AND key_id = $${params.length}`;
    }
    const result = await queryWithAgentVector("system",
      `UPDATE ${SCHEMA}.fragments SET case_id = $2
       WHERE id = $1 AND valid_to IS NULL ${keyFilter}`,
      params,
      "write"
    );
    return (result.rowCount || 0) > 0;
  }

  /**
   * 파편 ttl_tier 경량 업데이트
   *
   * @param {string} id      - 파편 ID
   * @param {string} ttlTier - 새 ttl_tier 값
   * @returns {Promise<boolean>} 업데이트 성공 여부
   */
  async updateTtlTier(id, ttlTier, keyId = null) {
    let sql    = `UPDATE ${SCHEMA}.fragments SET ttl_tier = $2 WHERE id = $1`;
    const args = [id, ttlTier];
    if (keyId) {
      sql += ` AND key_id = $3`;
      args.push(keyId);
    }
    const result = await queryWithAgentVector(keyId ? "default" : "system", sql, args, "write");
    return (result.rowCount || 0) > 0;
  }

  /**
   * 만료된 파편 정리 (유지보수용 - 'system' 컨텍스트 사용)
   *
   * @returns {Promise<number>} 삭제된 행 수
   */
  async deleteExpired() {
    const gc               = MEMORY_CONFIG.gc || {};
    const utilityThreshold = Number(gc.utilityThreshold) || 0.15;
    const gracePeriodDays  = Number(gc.gracePeriodDays) || 7;
    const inactiveDays     = Number(gc.inactiveDays) || 60;
    const maxDelete        = Number(gc.maxDeletePerCycle) || 50;
    const fdPolicy         = gc.factDecisionPolicy || {};
    const fdImportance     = Number(fdPolicy.importanceThreshold) || 0.2;
    const fdOrphanDays     = Number(fdPolicy.orphanAgeDays) || 30;
    const erPolicy         = gc.errorResolvedPolicy || {};
    const erMaxDays        = Number(erPolicy.maxAgeDays) || 30;
    const erMaxImportance  = Number(erPolicy.maxImportance) || 0.3;

    const result = await queryWithAgentVector("system",
      `WITH gc_candidates AS (
         SELECT id FROM ${SCHEMA}.fragments
         WHERE ttl_tier NOT IN ('permanent')
           AND is_anchor = FALSE
           AND created_at < NOW() - make_interval(days => $1)
           AND (
             (utility_score < $2
              AND (accessed_at IS NULL OR accessed_at < NOW() - make_interval(days => $3))
             )
             OR
             (type IN ('fact', 'decision')
              AND importance < $4
              AND access_count = 0
              AND coalesce(array_length(linked_to, 1), 0) = 0
              AND NOT EXISTS (
                SELECT 1 FROM ${SCHEMA}.fragment_links fl
                WHERE fl.from_id = fragments.id OR fl.to_id = fragments.id
              )
              AND created_at < NOW() - make_interval(days => $5)
             )
             OR
             (importance < 0.1
              AND (accessed_at IS NULL OR accessed_at < NOW() - INTERVAL '90 days')
              AND created_at < NOW() - INTERVAL '90 days'
              AND coalesce(array_length(linked_to, 1), 0) < 2
             )
             OR
             (type = 'error'
              AND content LIKE '[해결됨]%'
              AND created_at < NOW() - make_interval(days => $6)
              AND importance < $7
             )
             OR
             (type IS NULL
              AND created_at < NOW() - make_interval(days => $1)
              AND importance < 0.2
             )
           )
         ORDER BY utility_score ASC
         LIMIT $8
       )
       DELETE FROM ${SCHEMA}.fragments WHERE id IN (SELECT id FROM gc_candidates)`,
      [gracePeriodDays, utilityThreshold, inactiveDays, fdImportance, fdOrphanDays, erMaxDays, erMaxImportance, maxDelete],
      "write"
    );

    return result.rowCount;
  }
}
