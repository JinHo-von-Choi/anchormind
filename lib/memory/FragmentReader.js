/**
 * FragmentReader - PostgreSQL 파편 읽기 전용 작업
 *
 * 작성자: 최진호
 * 작성일: 2026-03-15
 * 수정일: 2026-04-03 (Narrative Reconstruction Phase 1: case_id, goal, outcome, phase, resolution_status, assertion_status SELECT 추가)
 * 수정일: 2026-04-18 (migration-034-v2.16.0-bundle: affect 정서 태그 검색 필터 추가)
 */

import { queryWithAgentVector } from "../tools/db.js";
import { vectorToSql }          from "../tools/embedding.js";

const SCHEMA = "agent_memory";

export class FragmentReader {

  /**
   * ID로 파편 조회
   *
   * @param {string}      id
   * @param {string}      agentId
   * @param {string|null} keyId        - null: 마스터(전체), string: 해당 API 키 소유만
   * @param {string[]}    groupKeyIds  - 같은 그룹 내 키 목록 (keyId가 있을 때만 유효)
   */
  async getById(id, agentId = "default", keyId = null, groupKeyIds = []) {
    const baseWhere = `id = $1 AND (agent_id = $2 OR agent_id = 'default') AND valid_to IS NULL`;
    let   keyFilter = "";
    const params    = [id, agentId];

    /** keyId가 있으면 SQL 레벨에서 소유권 필터 적용 */
    if (keyId !== null) {
      const allKeys = Array.isArray(groupKeyIds) && groupKeyIds.length > 0
        ? groupKeyIds
        : [keyId];
      params.push(keyId, allKeys);
      keyFilter = ` AND (key_id IS NOT DISTINCT FROM $3 OR key_id = ANY($4::text[]))`;
    }

    const result = await queryWithAgentVector(agentId,
      `SELECT id, content, topic, keywords, type, importance, utility_score,
                    source, linked_to, agent_id, access_count,
                    accessed_at, created_at, ttl_tier, verified_at, is_anchor, key_id,
                    context_summary, session_id,
                    case_id, goal, outcome, phase, resolution_status, assertion_status
             FROM ${SCHEMA}.fragments WHERE ${baseWhere}${keyFilter}`,
      params
    );

    return result.rows[0] || null;
  }

  /**
   * 복수 ID로 파편 조회
   *
   * @param {string[]}    ids
   * @param {string}      agentId
   * @param {string|null} keyId - null: 마스터(전체), string: 해당 API 키 소유만
   */
  async getByIds(ids, agentId = "default", keyId = null) {
    if (ids.length === 0) return [];

    const baseConds = ["id = ANY($1)", `(agent_id = $2 OR agent_id = 'default')`, "valid_to IS NULL"];
    const params    = [ids, agentId];
    if (keyId) {
      /** keyId는 단일 UUID 문자열이지만 ANY()가 배열을 요구하므로 래핑 */
      baseConds.push("key_id = ANY($3)");
      params.push(Array.isArray(keyId) ? keyId : [keyId]);
    }
    const whereClause = "WHERE " + baseConds.join(" AND ");

    const result = await queryWithAgentVector(agentId,
      `SELECT id, content, topic, keywords, type, importance, utility_score,
                    source, linked_to, agent_id, access_count,
                    accessed_at, created_at, ttl_tier, verified_at, is_anchor, valid_to,
                    context_summary, session_id, workspace,
                    case_id, goal, outcome, phase, resolution_status, assertion_status
             FROM ${SCHEMA}.fragments
             ${whereClause}
             ORDER BY importance DESC, accessed_at DESC NULLS LAST`,
      params
    );

    return result.rows;
  }

  /**
   * 파편의 전체 변경 이력 조회 (fragment_versions + superseded_by 체인)
   *
   * @param {string}      fragmentId
   * @param {string}      agentId
   * @param {string|null} keyId       - null: 마스터(전체), string: 해당 API 키 소유만
   * @param {string[]}    groupKeyIds - 그룹 키 목록
   * @returns {Promise<Object>} { current, versions, superseded_by_chain }
   */
  async getHistory(fragmentId, agentId = "default", keyId = null, groupKeyIds = []) {
    const current = await this.getById(fragmentId, agentId, keyId, groupKeyIds);

    const versions = await queryWithAgentVector(agentId,
      `SELECT fragment_id, content, topic, keywords, type, importance,
              amended_by, amended_at
       FROM ${SCHEMA}.fragment_versions
       WHERE fragment_id = $1
       ORDER BY amended_at DESC`,
      [fragmentId]
    );

    const chain = await queryWithAgentVector(agentId,
      `SELECT fl.to_id, f.content, f.created_at, f.valid_from
       FROM ${SCHEMA}.fragment_links fl
       JOIN ${SCHEMA}.fragments f ON f.id = fl.to_id
       WHERE fl.from_id = $1 AND fl.relation_type = 'superseded_by'
       ORDER BY f.created_at ASC`,
      [fragmentId]
    );

    return {
      current            : current || null,
      versions           : versions.rows,
      superseded_by_chain: chain.rows
    };
  }

  /**
   * 키워드 기반 검색 (GIN 인덱스)
   */
  async searchByKeywords(keywords, options = {}) {
    const agentId    = options.agentId || "default";
    const conditions = ["keywords && $1", `(agent_id = $2 OR agent_id = 'default')`];
    const params     = [keywords, agentId];
    let paramIdx     = 3;

    if (options.type) {
      conditions.push(`type = $${paramIdx}`);
      params.push(options.type);
      paramIdx++;
    }
    if (options.topic) {
      conditions.push(`topic = $${paramIdx}`);
      params.push(options.topic);
      paramIdx++;
    }
    if (options.minImportance) {
      conditions.push(`importance >= $${paramIdx}`);
      params.push(options.minImportance);
      paramIdx++;
    }
    if (options.isAnchor !== undefined) {
      conditions.push(`is_anchor = $${paramIdx}`);
      params.push(options.isAnchor);
      paramIdx++;
    }

    /** API 키 격리 필터: keyId가 있으면 해당 키 소유 파편만 조회 */
    if (options.keyId) {
      conditions.push(`key_id = ANY($${paramIdx})`);
      params.push(Array.isArray(options.keyId) ? options.keyId : [options.keyId]);
      paramIdx++;
    }

    if (options.workspace) {
      conditions.push(`(workspace = $${paramIdx} OR workspace IS NULL)`);
      params.push(options.workspace);
      paramIdx++;
    }

    /** superseded 파편 필터: includeSuperseded가 아니면 valid_to IS NULL만 조회 */
    if (!options.includeSuperseded) {
      conditions.push("valid_to IS NULL");
    }

    /** timeRange 필터 (created_at 기준) */
    if (options.timeRange) {
      if (options.timeRange.from) {
        conditions.push(`created_at >= $${paramIdx}`);
        params.push(options.timeRange.from);
        paramIdx++;
      }
      if (options.timeRange.to) {
        conditions.push(`created_at < $${paramIdx}`);
        params.push(options.timeRange.to);
        paramIdx++;
      }
    }

    /** Narrative Reconstruction 필터 (case_id, resolution_status, phase) */
    if (options.caseId) {
      conditions.push(`case_id = $${paramIdx}`);
      params.push(options.caseId);
      paramIdx++;
    }
    if (options.resolutionStatus) {
      conditions.push(`resolution_status = $${paramIdx}`);
      params.push(options.resolutionStatus);
      paramIdx++;
    }
    if (options.phase) {
      conditions.push(`phase = $${paramIdx}`);
      params.push(options.phase);
      paramIdx++;
    }

    /** 정서 태그 필터 (migration-034-v2.16.0-bundle): 배열이면 ANY($N), 단일 문자열이면 = $N */
    if (options.affect) {
      if (Array.isArray(options.affect) && options.affect.length > 0) {
        conditions.push(`f.affect = ANY($${paramIdx})`);
        params.push(options.affect);
        paramIdx++;
      } else if (typeof options.affect === "string") {
        conditions.push(`f.affect = $${paramIdx}`);
        params.push(options.affect);
        paramIdx++;
      }
    }

    const limit = options.limit || 20;
    params.push(limit);

    const result = await queryWithAgentVector(agentId,
      `SELECT f.id, f.content, f.topic, f.keywords, f.type, f.importance, f.utility_score,
                    f.linked_to, f.access_count, f.created_at, f.verified_at, f.is_anchor, f.valid_to,
                    f.key_id, f.context_summary, f.session_id, f.workspace,
                    f.case_id, f.goal, f.outcome, f.phase, f.resolution_status, f.assertion_status,
                    f.affect,
                    (SELECT count(*) FROM unnest(f.keywords) k WHERE k = ANY($1))::float
                      / NULLIF(array_length($1, 1), 0)::float AS keyword_score
             FROM ${SCHEMA}.fragments f
             WHERE ${conditions.join(" AND ")}
             ORDER BY keyword_score DESC NULLS LAST, f.importance DESC, f.created_at DESC
             LIMIT $${paramIdx}`,
      params
    );

    return result.rows;
  }

  /**
   * 토픽 기반 검색 (L2 fallback)
   */
  async searchByTopic(topic, options = {}) {
    const agentId    = options.agentId || "default";
    const conditions = ["topic = $1", `(agent_id = $2 OR agent_id = 'default')`];
    const params     = [topic, agentId];
    let paramIdx     = 3;

    if (options.type) {
      conditions.push(`type = $${paramIdx}`);
      params.push(options.type);
      paramIdx++;
    }
    if (options.minImportance) {
      conditions.push(`importance >= $${paramIdx}`);
      params.push(options.minImportance);
      paramIdx++;
    }
    if (options.keyId) {
      conditions.push(`key_id = ANY($${paramIdx})`);
      params.push(Array.isArray(options.keyId) ? options.keyId : [options.keyId]);
      paramIdx++;
    }
    if (options.workspace) {
      conditions.push(`(workspace = $${paramIdx} OR workspace IS NULL)`);
      params.push(options.workspace);
      paramIdx++;
    }
    if (!options.includeSuperseded) {
      conditions.push("valid_to IS NULL");
    }

    /** timeRange 필터 (created_at 기준) */
    if (options.timeRange) {
      if (options.timeRange.from) {
        conditions.push(`created_at >= $${paramIdx}`);
        params.push(options.timeRange.from);
        paramIdx++;
      }
      if (options.timeRange.to) {
        conditions.push(`created_at < $${paramIdx}`);
        params.push(options.timeRange.to);
        paramIdx++;
      }
    }

    /** Narrative Reconstruction 필터 (case_id, resolution_status, phase) */
    if (options.caseId) {
      conditions.push(`case_id = $${paramIdx}`);
      params.push(options.caseId);
      paramIdx++;
    }
    if (options.resolutionStatus) {
      conditions.push(`resolution_status = $${paramIdx}`);
      params.push(options.resolutionStatus);
      paramIdx++;
    }
    if (options.phase) {
      conditions.push(`phase = $${paramIdx}`);
      params.push(options.phase);
      paramIdx++;
    }

    /** 정서 태그 필터 (migration-034-v2.16.0-bundle) */
    if (options.affect) {
      if (Array.isArray(options.affect) && options.affect.length > 0) {
        conditions.push(`f.affect = ANY($${paramIdx})`);
        params.push(options.affect);
        paramIdx++;
      } else if (typeof options.affect === "string") {
        conditions.push(`f.affect = $${paramIdx}`);
        params.push(options.affect);
        paramIdx++;
      }
    }

    const limit = options.limit || 20;
    params.push(limit);

    const result = await queryWithAgentVector(agentId,
      `SELECT f.id, f.content, f.topic, f.keywords, f.type, f.importance, f.utility_score,
              f.linked_to, f.access_count, f.created_at, f.verified_at, f.is_anchor, f.valid_to,
              f.key_id, f.context_summary, f.session_id, f.workspace,
              f.case_id, f.goal, f.outcome, f.phase, f.resolution_status, f.assertion_status,
              f.affect
         FROM ${SCHEMA}.fragments f
         WHERE ${conditions.join(" AND ")}
         ORDER BY f.importance DESC, f.created_at DESC
         LIMIT $${paramIdx}`,
      params
    );

    return result.rows;
  }

  /**
   * 벡터 유사도 검색
   *
   * @param {number[]}    queryEmbedding
   * @param {number}      limit
   * @param {number}      minSimilarity
   * @param {string}      agentId
   * @param {string|null} keyId - null: 마스터(전체), string: 해당 API 키 소유만
   * @param {boolean}     includeSuperseded
   */
  async searchBySemantic(queryEmbedding, limit = 10, minSimilarity = 0.3, agentId = "default", keyId = null, includeSuperseded = false, timeRange = null, workspace = null, affect = null, morphemeOnly = false, searchOptions = {}) {
    const vecStr     = vectorToSql(queryEmbedding);
    const conditions = [
      "f.embedding IS NOT NULL",
      `1 - (f.embedding <=> $1::vector) >= $2`,
      `(f.agent_id = $4 OR f.agent_id = 'default')`
    ];
    const params     = [vecStr, minSimilarity, limit, agentId];
    let   paramIdx   = 5;

    /** API 키 격리 필터 */
    if (keyId) {
      conditions.push(`f.key_id = ANY($${paramIdx})`);
      params.push(Array.isArray(keyId) ? keyId : [keyId]);
      paramIdx++;
    }

    if (workspace) {
      conditions.push(`(f.workspace = $${paramIdx} OR f.workspace IS NULL)`);
      params.push(workspace);
      paramIdx++;
    }

    /** superseded 파편 필터: includeSuperseded가 아니면 valid_to IS NULL만 조회 */
    if (!includeSuperseded) {
      conditions.push("f.valid_to IS NULL");
    }

    /** timeRange 필터 (created_at 기준) */
    if (timeRange) {
      if (timeRange.from) {
        conditions.push(`f.created_at >= $${paramIdx}`);
        params.push(timeRange.from);
        paramIdx++;
      }
      if (timeRange.to) {
        conditions.push(`f.created_at < $${paramIdx}`);
        params.push(timeRange.to);
        paramIdx++;
      }
    }

    /** 정서 태그 필터 (migration-034-v2.16.0-bundle): Array.isArray 가드 적용 */
    if (affect) {
      if (Array.isArray(affect) && affect.length > 0) {
        conditions.push(`f.affect = ANY($${paramIdx})`);
        params.push(affect);
        paramIdx++;
      } else if (typeof affect === "string") {
        conditions.push(`f.affect = $${paramIdx}`);
        params.push(affect);
        paramIdx++;
      }
    }

    /**
     * Phase 4 Consistency Gate: morpheme 임베딩 기반 검색 경로에서만 적용.
     * morpheme_indexed=true 파편만 반환하여 형태소 등록 미완료 파편의 노이즈 제거.
     * 단순 keywords 매치(searchByKeywords)는 이 조건을 적용하지 않는다.
     */
    if (morphemeOnly) {
      conditions.push("f.morpheme_indexed = true");
    }

    const result = await queryWithAgentVector(agentId,
      `SELECT f.id, f.content, f.topic, f.keywords, f.type, f.importance, f.utility_score,
                    f.linked_to, f.access_count, f.created_at, f.verified_at, f.is_anchor, f.valid_to,
                    f.key_id, f.context_summary, f.session_id, f.workspace,
                    f.case_id, f.goal, f.outcome, f.phase, f.resolution_status, f.assertion_status,
                    f.affect,
                    1 - (f.embedding <=> $1::vector) AS similarity
             FROM ${SCHEMA}.fragments f
             WHERE ${conditions.join(" AND ")}
             ORDER BY f.embedding <=> $1::vector ASC
             LIMIT $3`,
      params,
      searchOptions
    );

    return result.rows;
  }

  /**
   * 시간 범위 기반 검색 (created_at BETWEEN from AND to)
   *
   * 임베딩 계산 없이 날짜 인덱스만으로 후보를 추출하는 Phase 1 전용 메서드.
   *
   * @param {Date|null} from    - 시작 시각 (null이면 하한 없음)
   * @param {Date|null} to      - 종료 시각 (null이면 상한 없음)
   * @param {Object}    options
   *   - agentId {string}      에이전트 ID (기본 "default")
   *   - keyId   {string|null} API 키 격리 필터
   *   - limit   {number}      최대 반환 수 (기본 30)
   * @returns {Promise<Object[]>} created_at DESC 정렬된 파편 배열
   */
  async searchByTimeRange(from, to, options = {}) {
    const agentId    = options.agentId || "default";
    const conditions = [`(agent_id = $1 OR agent_id = 'default')`, "valid_to IS NULL"];
    const params     = [agentId];
    let paramIdx     = 2;

    if (from) {
      conditions.push(`created_at >= $${paramIdx}`);
      params.push(from);
      paramIdx++;
    }
    if (to) {
      conditions.push(`created_at < $${paramIdx}`);
      params.push(to);
      paramIdx++;
    }

    if (options.keyId) {
      conditions.push(`key_id = ANY($${paramIdx})`);
      params.push(Array.isArray(options.keyId) ? options.keyId : [options.keyId]);
      paramIdx++;
    }

    if (options.workspace) {
      conditions.push(`(workspace = $${paramIdx} OR workspace IS NULL)`);
      params.push(options.workspace);
      paramIdx++;
    }

    /** Narrative Reconstruction 필터 (case_id, resolution_status, phase) */
    if (options.caseId) {
      conditions.push(`case_id = $${paramIdx}`);
      params.push(options.caseId);
      paramIdx++;
    }
    if (options.resolutionStatus) {
      conditions.push(`resolution_status = $${paramIdx}`);
      params.push(options.resolutionStatus);
      paramIdx++;
    }
    if (options.phase) {
      conditions.push(`phase = $${paramIdx}`);
      params.push(options.phase);
      paramIdx++;
    }

    /** 정서 태그 필터 (migration-034-v2.16.0-bundle) */
    if (options.affect) {
      if (Array.isArray(options.affect) && options.affect.length > 0) {
        conditions.push(`affect = ANY($${paramIdx})`);
        params.push(options.affect);
        paramIdx++;
      } else if (typeof options.affect === "string") {
        conditions.push(`affect = $${paramIdx}`);
        params.push(options.affect);
        paramIdx++;
      }
    }

    const limit = options.limit || 30;
    params.push(limit);

    const result = await queryWithAgentVector(agentId,
      `SELECT id, content, topic, keywords, type, importance, utility_score,
              linked_to, access_count, created_at, verified_at, is_anchor, valid_to,
              context_summary, session_id, workspace,
              case_id, goal, outcome, phase, resolution_status, assertion_status,
              affect
       FROM ${SCHEMA}.fragments
       WHERE ${conditions.join(" AND ")}
       ORDER BY created_at DESC
       LIMIT $${paramIdx}`,
      params
    );

    return result.rows;
  }

  /**
   * 동일 session_id + topic에서 이미 할당된 case_id를 찾는다.
   * 자동 case_id 할당에 사용.
   *
   * @param {string}      sessionId
   * @param {string}      topic
   * @param {string|null} keyId - null: 마스터(전체), string: 해당 API 키 소유만
   * @returns {Promise<string|null>} 기존 case_id 또는 null
   */
  async findCaseIdBySessionTopic(sessionId, topic, keyId = null) {
    const params = [sessionId, topic];
    let keyFilter = "";
    if (keyId != null) {
      params.push(keyId);
      keyFilter = `AND key_id = $${params.length}`;
    }
    const { rows } = await queryWithAgentVector("default",
      `SELECT case_id FROM ${SCHEMA}.fragments
        WHERE session_id = $1 AND topic = $2
          AND case_id IS NOT NULL AND valid_to IS NULL
          ${keyFilter}
        LIMIT 1`,
      params
    );
    return rows.length > 0 ? rows[0].case_id : null;
  }

  /**
   * 동일 session_id + topic에서 type=error 파편이 존재하는지 확인하고
   * 해당 파편 ID 목록을 반환한다.
   *
   * @param {string}      sessionId
   * @param {string}      topic
   * @param {string|null} keyId - null: 마스터(전체), string: 해당 API 키 소유만
   * @returns {Promise<string[]>} error 파편 ID 배열
   */
  async findErrorFragmentsBySessionTopic(sessionId, topic, keyId = null) {
    const params = [sessionId, topic];
    let keyFilter = "";
    if (keyId != null) {
      params.push(keyId);
      keyFilter = `AND key_id = $${params.length}`;
    }
    const { rows } = await queryWithAgentVector("default",
      `SELECT id FROM ${SCHEMA}.fragments
        WHERE session_id = $1 AND topic = $2
          AND type = 'error' AND valid_to IS NULL
          ${keyFilter}
        LIMIT 10`,
      params
    );
    return rows.map(r => r.id);
  }

  /**
   * idempotency_key + key_id 범위로 단일 파편을 조회한다.
   * master(keyId=null)와 tenant(keyId=string) 경로를 분리하여 크로스 테넌트 히트를 차단한다.
   *
   * @param {string}      idempotencyKey - 클라이언트 지정 재시도 안전 식별자
   * @param {string|null} keyId          - null: 마스터 테넌트, string: DB API key
   * @returns {Promise<Object|null>} 파편 객체 또는 null
   */
  async findByIdempotencyKey(idempotencyKey, keyId = null) {
    let sql;
    let params;

    if (keyId === null) {
      sql = `SELECT id, content, topic, keywords, type, importance, ttl_tier,
                    source, linked_to, agent_id, is_anchor, key_id,
                    context_summary, session_id, case_id,
                    goal, outcome, phase, resolution_status, assertion_status,
                    idempotency_key
             FROM ${SCHEMA}.fragments
             WHERE idempotency_key = $1
               AND key_id IS NULL
               AND valid_to IS NULL
             LIMIT 1`;
      params = [idempotencyKey];
    } else {
      sql = `SELECT id, content, topic, keywords, type, importance, ttl_tier,
                    source, linked_to, agent_id, is_anchor, key_id,
                    context_summary, session_id, case_id,
                    goal, outcome, phase, resolution_status, assertion_status,
                    idempotency_key
             FROM ${SCHEMA}.fragments
             WHERE idempotency_key = $1
               AND key_id = $2
               AND valid_to IS NULL
             LIMIT 1`;
      params = [idempotencyKey, keyId];
    }

    const { rows } = await queryWithAgentVector("default", sql, params);
    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * source 필드 기반 파편 검색
   *
   * @param {string}      source  - 파편 source 값 (예: "learning_extraction")
   * @param {string}      agentId - 에이전트 ID (RLS 격리용)
   * @param {string|null} keyId   - null: 마스터(전체), string: 해당 API 키 소유만
   * @param {number}      limit   - 최대 반환 수 (기본 5)
   * @returns {Promise<Object[]>} 파편 배열
   */
  async searchBySource(source, agentId, keyId, limit = 5, workspace = null) {
    let query = `SELECT id, content, topic, type, keywords, importance, source,
                        agent_id, created_at, is_anchor, access_count, accessed_at,
                        context_summary, session_id, workspace,
                        case_id, goal, outcome, phase, resolution_status, assertion_status
                 FROM ${SCHEMA}.fragments
                 WHERE source = $1 AND (agent_id = $2 OR agent_id = 'default') AND valid_to IS NULL`;
    const params = [source, agentId || "default"];
    if (keyId) {
      params.push(keyId);
      query += ` AND key_id = $${params.length}`;
    }
    if (workspace) {
      params.push(workspace);
      query += ` AND (workspace = $${params.length} OR workspace IS NULL)`;
    }
    query += ` ORDER BY importance DESC, created_at DESC LIMIT $${params.length + 1}`;
    params.push(limit);
    const result = await queryWithAgentVector(agentId, query, params);
    return result.rows || [];
  }

  /**
   * 특정 시점 기준 파편 조회 (Point-in-time Query)
   *
   * valid_from <= asOf AND (valid_to IS NULL OR valid_to > asOf) 조건으로
   * 해당 시점에 유효했던 파편 집합을 반환한다.
   *
   * @param {string} asOf     - ISO 8601 타임스탬프 (예: '2026-01-15T00:00:00Z')
   * @param {string} agentId  - 에이전트 ID (RLS 격리용)
   * @param {Object} opts     - 옵션
   *   - limit  {number} 최대 반환 수 (기본 50)
   *   - topic  {string} 주제 필터 (선택)
   *   - type   {string} 유형 필터 (선택)
   * @returns {Promise<Object[]>} 파편 배열
   */
  async searchAsOf(asOf, agentId = "default", opts = {}, keyId = null) {
    const tsDate = new Date(asOf);
    if (isNaN(tsDate.getTime())) {
      throw new Error(`searchAsOf: invalid asOf value "${asOf}"`);
    }
    const ts         = tsDate.toISOString();
    const conditions = [
      "(agent_id   = $1 OR agent_id = 'default')",
      "valid_from <= $2::timestamptz",
      "(valid_to IS NULL OR valid_to > $2::timestamptz)"
    ];
    const params     = [agentId, ts];
    let paramIdx     = 3;

    if (opts.topic) {
      conditions.push(`topic = $${paramIdx}`);
      params.push(opts.topic);
      paramIdx++;
    }

    if (opts.type) {
      conditions.push(`type = $${paramIdx}`);
      params.push(opts.type);
      paramIdx++;
    }

    if (keyId) {
      conditions.push(`key_id = ANY($${paramIdx})`);
      params.push(Array.isArray(keyId) ? keyId : [keyId]);
      paramIdx++;
    }

    if (opts.workspace) {
      conditions.push(`(workspace = $${paramIdx} OR workspace IS NULL)`);
      params.push(opts.workspace);
      paramIdx++;
    }

    params.push(opts.limit ?? 50);

    const { rows } = await queryWithAgentVector(agentId, `
      SELECT id, content, topic, type, importance, keywords,
             valid_from, valid_to, created_at, verified_at, is_anchor, estimated_tokens,
             context_summary, session_id,
             case_id, goal, outcome, phase, resolution_status, assertion_status
      FROM   ${SCHEMA}.fragments
      WHERE  ${conditions.join("\n        AND  ")}
      ORDER  BY importance DESC
      LIMIT  $${paramIdx}
    `, params);

    return rows;
  }
}
