/**
 * FragmentWriter - PostgreSQL 파편 쓰기 작업
 *
 * 작성자: 최진호
 * 작성일: 2026-03-15
 * 수정일: 2026-04-03 (Narrative Reconstruction Phase 1: case_id, goal, outcome, phase, resolution_status, assertion_status INSERT 추가)
 * 수정일: 2026-04-18 (migration-034-v2.16.0-bundle: affect 정서 태그 컬럼 추가)
 * 수정일: 2026-09-30 (접근 기록 갱신 대상 행을 id 순으로 선점)
 * 수정일: 2026-10-03 (내부 메타데이터 갱신 updateInternal 분리, 중복 판정 범위를 DedupScope로 판정)
 * 수정일: 2026-10-03 (insert의 valid_to와 hash_scope 지정)
 * 수정일: 2026-10-03 (여러 행 갱신과 삭제는 잠금 문장을 앞세운 트랜잭션으로 실행)
 *
 * 의미 메서드(insert, update)는 의미 쓰기 관문(WriteGate)을 거친 값만 받는다. 임베딩, 접근 수,
 * TTL, 감쇠 같은 내부 메타데이터는 updateInternal로 쓰며 의미 열은 쓸 수 없다.
 */

import { getPrimaryPool, queryWithAgentVector } from "../../tools/db.js";
import { buildSearchPath, dedupScope }           from "../../config.js";
import { computeContentHash }                    from "../../tools/embedding.js";
import { logWarn }                               from "../../logger.js";
import { recordTenantIsolationBlocked }          from "../../metrics.js";
import { keyScopeClause, keyScopeGroup, keyScopeScalar } from "../keyScope.js";
import { SCHEMA } from "../schema.js";
import { workspaceCondition } from "../read/WorkspaceScope.js";
import { agentScopeCondition, resolveAgentScope } from "../read/AgentScope.js";
import { VALID_AFFECT_VALUES, sanitizeAffect } from "./affect.js";
import { isGateApproved } from "./gateApproval.js";
import { provenanceInsertParts } from "../provenance.js";
import { reviewInsertParts, appendReviewAssignments } from "./ReviewQueue.js";
import { contentHashInput } from "../WorkingMemoryRows.js";
import {
  effectiveDedupScope, conflictClause, pickDuplicate, findContentHashMatches, isDedupIndexError,
  loadDedupIndexes, invalidateDedupIndexes, noteDedupIndexError, normalizeWorkspace, resolveUniqueConflict
} from "./DedupScope.js";
import { countTokens }    from "./FragmentFactory.js";
import { DELETE_LOCKED_SQL, LOCK_FOR_DELETE, fragmentRowLock } from "./rowLock.js";

export { VALID_AFFECT_VALUES, sanitizeAffect };

/** 의미 열. WriteGate를 거친 insert와 update로만 쓴다. */
export const SEMANTIC_COLUMNS = Object.freeze([
  "content", "topic", "keywords", "is_anchor", "workspace", "key_id", "context_summary", "goal", "outcome"
]);

/** updateInternal이 쓸 수 있는 내부 메타데이터 열 */
export const INTERNAL_COLUMNS = Object.freeze([
  "importance", "ttl_tier", "assertion_status", "quality_verified", "quality_rationale", "utility_score"
]);

/** 의미 메서드가 관문을 거치지 않은 의미 열 쓰기를 받았을 때의 오류 */
export class UngatedSemanticWriteError extends Error {
  /**
   * @param {string}   method  - insert 또는 update
   * @param {string[]} columns - 관문 표식 없이 넘어온 의미 열
   */
  constructor(method, columns) {
    super(`FragmentWriter.${method} requires values from WriteGate.check for semantic columns: ${columns.join(", ")}`);
    this.name    = "UngatedSemanticWriteError";
    this.columns = columns;
  }
}

/**
 * 의미 열을 쓰는 값이 관문을 거쳤는지 확인한다. insert는 행 전체가 의미 쓰기이고, update는
 * 의미 열 키가 있을 때만 확인한다. 의미 열이 없는 update(importance, agent_id 등)는 그대로 둔다.
 *
 * @param {"insert"|"update"} method
 * @param {Object} values
 */
function assertGated(method, values) {
  if (isGateApproved(values)) return;
  const columns = method === "insert"
    ? ["*"]
    : Object.keys(values ?? {}).filter(k => SEMANTIC_COLUMNS.includes(k));
  if (columns.length > 0) throw new UngatedSemanticWriteError(method, columns);
}

/** updateInternal에 쓸 수 없는 열을 넘겼을 때의 오류 */
export class InternalUpdateError extends Error {
  /**
   * @param {string}   message
   * @param {string[]} columns - 거부된 열
   */
  constructor(message, columns) {
    super(message);
    this.name    = "InternalUpdateError";
    this.columns = columns;
  }
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

/**
 * INSERT에 쓸 importance. exact이면 요청 값 그대로, 아니면 유형별 상한을 적용한다.
 *
 * @param {Object}  fragment
 * @param {boolean} isAnchor
 * @param {boolean} exact
 * @returns {number}
 */
function initialImportance(fragment, isAnchor, exact) {
  const requested = fragment.importance ?? 0.5;
  return exact ? requested : sanitizeInsertImportance(fragment.content, fragment.type, requested, isAnchor);
}

/**
 * 되살린 품질 판정 열 값(quality_verified, quality_rationale). 값이 없으면 둘 다 null이다.
 *
 * @param {Object} fragment
 * @returns {[boolean|null, string|null]}
 */
function restoredQualityColumns(fragment) {
  return [fragment.quality_verified ?? null, fragment.quality_rationale ?? null];
}

/**
 * INSERT ... RETURNING id, created 결과를 {id, created}로 바꾼다. 같은 본문 충돌로 기존 행이 갱신된
 * 경우 created는 false다. 행이 돌아오지 않으면 호출자가 넘긴 id를 새로 만든 것으로 본다.
 *
 * importance는 저장된 값이다(상한 적용 뒤).
 *
 * @param {{rows: Array<{id: string, created?: boolean, importance?: number}>}} result
 * @param {string} fragmentId
 * @returns {{id: string, created: boolean, importance: (number|undefined)}}
 */
function insertOutcome(result, fragmentId) {
  const row = result.rows[0];
  return { id: row?.id || fragmentId, created: row?.created !== false, importance: row?.importance };
}

/**
 * 외부 트랜잭션 안에서 INSERT를 저장점으로 감싼다. 실패하면 저장점으로 되돌려 호출자의
 * 트랜잭션을 살려 두고 오류를 그대로 던진다.
 *
 * @param {import('pg').PoolClient} client
 * @param {string}  sql
 * @param {Array}   params
 * @returns {Promise<import('pg').QueryResult>}
 */
async function insertInSavepoint(client, sql, params) {
  await client.query("SAVEPOINT fragment_insert");
  let result;
  try {
    result = await client.query(sql, params);
  } catch (err) {
    await client.query("ROLLBACK TO SAVEPOINT fragment_insert");
    throw err;
  }
  await client.query("RELEASE SAVEPOINT fragment_insert");
  return result;
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
  async insert(fragment, opts = {}) {
    const result = await this.insertDetailed(fragment, opts);
    return result === null ? null : result.id;
  }

  /**
   * 파편 저장과 함께 새 행이 만들어졌는지 돌려준다. 같은 본문이 이미 있으면 created는 false이고
   * id는 기존 행의 id다.
   *
   * @param {Object}      fragment
   * @param {Object}      [opts]
   * @param {import('pg').PoolClient} [opts.client] - 외부 트랜잭션 client (insert와 같다)
   * @param {boolean}     [opts.exactImportance=false] - true이면 importance 상한을 적용하지 않는다.
   *   저장된 값을 되살리는 가져오기에서만 쓴다.
   * @returns {Promise<{id: string, created: boolean, importance: (number|undefined)}|null>} DB 풀이 없으면 null.
   *   importance는 새로 만든 행에 저장된 값이다.
   */
  async insertDetailed(fragment, { client: externalClient, exactImportance = false } = {}) {
    assertGated("insert", fragment);
    const pool = getPrimaryPool();
    if (!pool) return null;

    /**
     * 외부 client 가 주어졌으면 호출자가 이미 그 client 로 스키마 안의 테이블을 조회한 뒤다.
     * 여기서 ensureSchema 를 부르면 client 를 쥔 채 같은 풀에서 연결을 하나 더 요구하게 되므로
     * 자체 트랜잭션 경로에서만 스키마를 확인한다.
     */
    if (!externalClient) await this.ensureSchema();

    const row = this._prepareInsertRow(fragment, exactImportance);
    return this._runInsert(externalClient, row);
  }

  /**
   * INSERT 대상 컬럼값을 정규화하고 SQL/파라미터를 구성한다.
   *
   * @param {Object} fragment - 저장할 파편 객체
   * @param {boolean} exactImportance - true이면 importance 상한을 적용하지 않는다
   * @returns {{agentId: string, contentHash: string, keyId: (string|null), safeAgent: string,
   *   insertHead: string, insertParams: Array, workspace: (string|null), fragmentId: *}}
   */
  _prepareInsertRow(fragment, exactImportance) {
    const agentId     = fragment.agent_id || "default";
    const contentHash = computeContentHash(contentHashInput(fragment));
    const keyId       = fragment.key_id ?? null;
    const safeAgent   = String(agentId).replace(/[^a-zA-Z0-9_-]/g, "");

    const embeddingStr = null;

    const estimatedTokens = fragment.estimated_tokens || Math.ceil((fragment.content || "").length / 4);

    const validFrom      = fragment.valid_from || new Date().toISOString();
    const isAnchor       = fragment.is_anchor === true;
    const affect         = sanitizeAffect(fragment.affect);
    const embeddingParam = embeddingStr ? "$33::vector" : "NULL";

    const importance = initialImportance(fragment, isAnchor, exactImportance);
    const embeddingParams = embeddingStr ? [embeddingStr] : [];
    const provenance      = provenanceInsertParts(fragment, 33 + embeddingParams.length);
    const review          = reviewInsertParts(fragment, 33 + embeddingParams.length + provenance.values.length);

    /** ON CONFLICT 절은 실행 시점의 색인 상태로 정하므로 _insertOnce가 붙인다(DedupScope.conflictClause). */
    const insertHead = `INSERT INTO ${SCHEMA}.fragments
                (id, content, topic, keywords, type, importance, content_hash,
                 source, linked_to, agent_id, ttl_tier, estimated_tokens, valid_from, key_id, is_anchor,
                 context_summary, session_id, workspace,
                 case_id, goal, outcome, phase, resolution_status, assertion_status,
                 validation_warnings, affect, idempotency_key, workspace_source, valid_to,
                 created_at, quality_verified, quality_rationale, embedding${provenance.columns}${review.columns})
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::timestamptz,
                     $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25::jsonb, $26, $27, $28,
                     $29::timestamptz, COALESCE($30::timestamptz, NOW()), $31, $32, ${embeddingParam}${provenance.placeholders}${review.placeholders})`;

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
      normalizeWorkspace(fragment.workspace),
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
      fragment.workspace_source ?? "unscoped",
      fragment.valid_to,
      fragment.created_at ?? null,
      ...restoredQualityColumns(fragment),
      ...embeddingParams,
      ...provenance.values,
      ...review.values
    ];

    return {
      agentId, contentHash, keyId, safeAgent, insertHead, insertParams,
      workspace : normalizeWorkspace(fragment.workspace),
      fragmentId: fragment.id
    };
  }

  /**
   * 중복 검사 후 INSERT SQL을 실행한다.
   *
   * externalClient가 주어지면 이미 열린 트랜잭션 내에서 실행한다 (key_id 격리 적용, 크로스 테넌트 hit 방지).
   * 판정 색인이 운영 단계로 바뀌어 INSERT가 색인 오류(DedupScope.isDedupIndexError)를 받으면
   * 색인 상태를 다시 읽고 한 번 더 판정한다. 그래도 판정 색인이 23505로 막으면 막은 색인의 범위로
   * 기존 행을 다시 읽어 그 id를 돌려준다(DedupScope.resolveUniqueConflict).
   *
   * @param {import('pg').PoolClient|undefined} externalClient
   * @param {ReturnType<FragmentWriter['_prepareInsertRow']>} row
   * @returns {Promise<{id: string, created: boolean}>}
   */
  async _runInsert(externalClient, row) {
    const run = externalClient
      ? (sql, params) => externalClient.query(sql, params)
      : (sql, params) => queryWithAgentVector(row.agentId, sql, params);
    try {
      return await this._insertOnce(externalClient, run, row);
    } catch (err) {
      if (!isDedupIndexError(err)) throw err;
      invalidateDedupIndexes();
    }
    try {
      return await this._insertOnce(externalClient, run, row);
    } catch (err) {
      const existing = await resolveUniqueConflict(run, err, row);
      return { id: existing.id, created: false };
    }
  }

  /**
   * 색인 상태로 판정 범위와 ON CONFLICT 대상을 정하고, 범위 안의 같은 본문이 있으면 그 id를
   * created=false로, 없으면 INSERT 결과(insertOutcome)를 돌려준다.
   *
   * @param {import('pg').PoolClient|undefined} externalClient
   * @param {(sql: string, params: unknown[]) => Promise<Object>} run
   * @param {ReturnType<FragmentWriter['_prepareInsertRow']>} row
   * @returns {Promise<{id: string, created: boolean, importance?: number}>}
   */
  async _insertOnce(externalClient, run, row) {
    const { agentId, contentHash, keyId, workspace, safeAgent, insertHead, insertParams, fragmentId } = row;

    const indexes  = await loadDedupIndexes(run);
    const scope    = effectiveDedupScope(dedupScope(), indexes, keyId);
    const matches  = await findContentHashMatches(run, keyId, [contentHash]);
    const existing = pickDuplicate(matches, workspace, scope);
    if (existing) return { id: existing.id, created: false };

    const insertSql = `${insertHead}
             ${conflictClause(indexes, keyId)}
             RETURNING id, importance, (xmax = 0) AS created`;

    if (externalClient) {
      /** SET LOCAL은 BEGIN 이후에만 유효 — 호출자가 BEGIN을 열었음을 전제한다 */
      await externalClient.query(`SET LOCAL app.current_agent_id = '${safeAgent}'`);
      const result = await insertInSavepoint(externalClient, insertSql, insertParams);
      return insertOutcome(result, fragmentId);
    }

    const result = await queryWithAgentVector(agentId, insertSql, insertParams, "write");
    return insertOutcome(result, fragmentId);
  }

  /**
   * 파편의 현재 상태를 이력 테이블에 저장
   */
  async archiveVersion(fragment, agentId = "default") {
    if (typeof fragment?.agent_id !== "string" || fragment.agent_id.length === 0) {
      throw new Error("Fragment agent scope is required for version history");
    }
    await queryWithAgentVector(agentId,
      `INSERT INTO ${SCHEMA}.fragment_versions
                (fragment_id, content, topic, keywords, type, importance, amended_by, agent_id, workspace)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        fragment.id,
        fragment.content,
        fragment.topic,
        fragment.keywords,
        fragment.type,
        fragment.importance,
        agentId,
        fragment.agent_id,
        fragment.workspace ?? null
      ],
      "write"
    ).catch(err => logWarn(`[FragmentWriter] archiveVersion failed: ${err.message}`));
  }

  /**
   * 가져온 이력 행을 fragment_versions에 기록한다. 호출자가 연 트랜잭션 client로 실행하며,
   * 본문은 호출자가 관문 규칙(민감 정보 마스킹)을 적용한 값이어야 한다.
   *
   * @param {Object} row - {fragment_id, content, topic, keywords, type, importance, amended_at,
   *   amended_by, agent_id, workspace, resolution_status, outcome, phase}
   * @param {{ client: import('pg').PoolClient }} deps
   * @returns {Promise<void>}
   */
  async restoreVersion(row, { client }) {
    await client.query(
      `INSERT INTO ${SCHEMA}.fragment_versions
                (fragment_id, content, topic, keywords, type, importance, amended_at, amended_by,
                 agent_id, workspace, resolution_status, outcome, phase)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, NOW()), $8, $9, $10, $11, $12, $13)`,
      [
        row.fragment_id,
        row.content,
        row.topic ?? null,
        row.keywords ?? null,
        row.type ?? null,
        row.importance ?? null,
        row.amended_at ?? null,
        row.amended_by ?? null,
        row.agent_id ?? null,
        row.workspace ?? null,
        row.resolution_status ?? null,
        row.outcome ?? null,
        row.phase ?? null
      ]
    );
  }

  /**
   * 같은 id의 행이 어느 키 소속인지 조회한다. 없으면 null이다. 가져오기의 id 충돌 판정에 쓴다.
   *
   * @param {string} id
   * @param {{ client: import('pg').PoolClient }} deps
   * @returns {Promise<{key_id: (string|null)}|null>}
   */
  async findKeyOfId(id, { client }) {
    const { rows } = await client.query(`SELECT key_id FROM ${SCHEMA}.fragments WHERE id = $1`, [id]);
    return rows.length > 0 ? { key_id: rows[0].key_id } : null;
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
   * @param {Object}      [opts]
   * @param {string}      [opts.amendedBy] - 이력에 기록할 승인/시스템 주체
   * @returns {Object|null} 갱신된 파편
   */
  async update(id, updates, agentId = "default", keyId = null, existing = null, opts = {}) {
    if (!existing) {
      const lookupParams = [id, agentId || "default"];
      const lookupKeyClause = keyScopeScalar(lookupParams, "key_id", keyId);
      const lookup = await queryWithAgentVector(agentId,
        `SELECT id, content, topic, keywords, type, importance,
                source, linked_to, agent_id, access_count,
                accessed_at, created_at, ttl_tier, verified_at, is_anchor, key_id,
                resolution_status, outcome, phase, workspace
         FROM ${SCHEMA}.fragments WHERE id = $1
           AND (agent_id = $2 OR agent_id = 'default')${lookupKeyClause}`,
        lookupParams
      );
      existing = lookup.rows[0] || null;
      if (!existing) return null;
    }

    if (typeof existing.agent_id !== "string" || existing.agent_id.length === 0) {
      throw new Error("Fragment agent scope is required for version history");
    }
    assertGated("update", updates);

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

      // Every amendment locks before archiving. A waiter must archive the scope
      // committed by an earlier normalization, never its stale preflight row.
      const lockedResult = await client.query(
        `SELECT * FROM ${SCHEMA}.fragments WHERE id = $1 FOR UPDATE`, [id]
      );
      const current = lockedResult.rows[0];
      if (!current || (keyId && current.key_id !== keyId)
        || (current.agent_id !== existing.agent_id && current.agent_id !== "default")) {
        await client.query("ROLLBACK");
        return null;
      }
      if (opts.normalizeVersionAgentToDefault === true
        && (current.agent_id !== existing.agent_id
          || current.key_id !== existing.key_id
          || (current.workspace ?? null) !== (existing.workspace ?? null)
          || current.is_anchor !== existing.is_anchor)) {
        throw new Error("Approved fragment scope changed before normalization");
      }
      if (typeof current.agent_id !== "string" || current.agent_id.length === 0) {
        throw new Error("Fragment agent scope is required for version history");
      }
      existing = current;

      /** 수정 전 상태 아카이빙 (버전 관리).
       *  케이스 상태 3종은 migration-038로 추가됐으며, UPDATE와 동일 트랜잭션에서 기록한다. */
      await client.query(
        `INSERT INTO ${SCHEMA}.fragment_versions
                  (fragment_id, content, topic, keywords, type, importance, amended_by,
                   resolution_status, outcome, phase, agent_id, workspace)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          existing.id,
          existing.content,
          existing.topic,
          existing.keywords,
          existing.type,
          existing.importance,
          opts.amendedBy ?? agentId,
          existing.resolution_status ?? null,
          existing.outcome ?? null,
          existing.phase ?? null,
          existing.agent_id,
          existing.workspace ?? null
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

      // Explicit, approved scope normalization shares the archived history too.
      // Ordinary amendments keep their historical scope snapshots immutable.
      if (opts.normalizeVersionAgentToDefault === true) {
        if (updates.agent_id !== "default" || existing.agent_id !== agentId || !result) {
          throw new Error("Invalid fragment history agent normalization");
        }
        await client.query(
          `UPDATE ${SCHEMA}.fragment_versions
              SET agent_id = 'default'
            WHERE fragment_id = $1`,
          [id]
        );
      }

      await client.query("COMMIT");
      return result;

    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      return await this._recoverAmendConflict(client, err, id, existing, updates);
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
      const dup     = await this._findAmendDuplicate(client, id, existing, newHash);
      if (dup) {
        return { merged: true, existingId: dup.id };
      }

      setClauses.push(`content = $${paramIdx}`);
      params.push(updates.content);
      paramIdx++;

      setClauses.push(`content_hash = $${paramIdx}`);
      params.push(newHash);
      paramIdx++;

      setClauses.push(`estimated_tokens = $${paramIdx}`);
      params.push(countTokens(updates.content));
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

    if (updates.quality_rationale !== undefined) {
      setClauses.push(`quality_rationale = $${paramIdx}`);
      params.push(updates.quality_rationale);
      paramIdx++;
    }

    if (updates.assertion_status !== undefined) {
      setClauses.push(`assertion_status = $${paramIdx}`);
      params.push(updates.assertion_status);
      paramIdx++;
    }

    /** 케이스 상태 전이. INSERT 경로에만 있던 컬럼을 amend에서도 갱신한다. */
    if (updates.resolution_status !== undefined) {
      setClauses.push(`resolution_status = $${paramIdx}`);
      params.push(updates.resolution_status);
      paramIdx++;
    }

    if (updates.outcome !== undefined) {
      setClauses.push(`outcome = $${paramIdx}`);
      params.push(updates.outcome);
      paramIdx++;
    }

    if (updates.phase !== undefined) {
      setClauses.push(`phase = $${paramIdx}`);
      params.push(updates.phase);
      paramIdx++;
    }

    if (updates.affect !== undefined) {
      setClauses.push(`affect = $${paramIdx}`);
      params.push(sanitizeAffect(updates.affect));
      paramIdx++;
    }

    if (updates.agent_id !== undefined) {
      setClauses.push(`agent_id = $${paramIdx}`);
      params.push(updates.agent_id);
      paramIdx++;
    }

    appendReviewAssignments(setClauses, params, updates);
    return { setClauses, params };
  }

  /**
   * amend의 UPDATE를 판정 색인이 23505로 막았으면(색인 상태가 사전 판정 뒤에 바뀌었거나 경합)
   * 막은 색인의 범위로 기존 행을 다시 읽어 병합 신호를 돌려준다. 그 밖의 오류는 던진다.
   *
   * @param {import('pg').PoolClient} client - 트랜잭션을 되돌린 연결
   * @param {Error}  err
   * @param {string} id
   * @param {Object} existing
   * @param {Object} updates
   * @returns {Promise<{merged: true, existingId: string}>}
   */
  async _recoverAmendConflict(client, err, id, existing, updates) {
    if (updates.content === undefined) throw noteDedupIndexError(err);
    const dup = await resolveUniqueConflict((sql, params) => client.query(sql, params), err, {
      keyId      : existing.key_id ?? null,
      contentHash: computeContentHash(updates.content),
      workspace  : existing.workspace ?? null,
      excludeId  : id
    });
    return { merged: true, existingId: dup.id };
  }

  /**
   * amend가 바꿀 본문이 판정 범위 안의 다른 파편과 같은지 본다. 범위는 insert와 같고
   * (DedupScope), 대상 파편의 key_id와 workspace를 기준으로 한다.
   *
   * @param {import('pg').PoolClient} client
   * @param {string} id
   * @param {Object} existing
   * @param {string} newHash
   * @returns {Promise<{id: string}|null>}
   */
  async _findAmendDuplicate(client, id, existing, newHash) {
    const run     = (sql, params) => client.query(sql, params);
    const keyId   = existing.key_id ?? null;
    const indexes = await loadDedupIndexes(run);
    const matches = await findContentHashMatches(run, keyId, [newHash], id);
    return pickDuplicate(matches, existing.workspace ?? null, effectiveDedupScope(dedupScope(), indexes, keyId));
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

    /** linked_to 배열에서 제거. 대상 행은 id 오름차순으로 먼저 잠근다. */
    await queryWithAgentVector(agentId,
      `UPDATE ${SCHEMA}.fragments f
          SET linked_to = array_remove(f.linked_to, $2)
        WHERE f.id = ANY($1::text[])`,
      [id],
      { lock: fragmentRowLock("unlink", "linked_to @> ARRAY[$1]::text[]", [id]) }
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

    /** linked_to 배열에서 일괄 제거. 대상 행은 id 오름차순으로 먼저 잠근다. */
    await queryWithAgentVector(agentId,
      `UPDATE ${SCHEMA}.fragments f
          SET linked_to = (
                SELECT COALESCE(array_agg(elem), '{}')
                  FROM unnest(f.linked_to) AS elem
                 WHERE elem != ALL($2::text[])
              )
        WHERE f.id = ANY($1::text[])`,
      [ids],
      { lock: fragmentRowLock("unlink", "linked_to && $1::text[]", [ids]) }
    ).catch(err => logWarn(`[FragmentWriter] deleteMany linked_to cleanup failed: ${err.message}`));

    let where  = "id = ANY($1)";
    const args = [ids];
    if (keyId) {
      where += keyScopeScalar(args, "key_id", keyId);
    }

    const result = await queryWithAgentVector(agentId, DELETE_LOCKED_SQL, [],
      { lock: fragmentRowLock("delete", where, args, LOCK_FOR_DELETE) });
    return result.rowCount || 0;
  }

  /**
   * 에이전트의 모든 데이터 삭제 (GDPR 준수)
   */
  async deleteByAgent(agentId) {
    if (!agentId || agentId === "default") {
      throw new Error("Cannot delete 'default' agent data via this method");
    }

    const result = await queryWithAgentVector(agentId, DELETE_LOCKED_SQL, [],
      { lock: fragmentRowLock("delete", "agent_id = $1", [agentId], LOCK_FOR_DELETE) });

    return result.rowCount;
  }

  /**
   * 접근 횟수 증가
   *
   * 대상 행은 id 오름차순으로 먼저 잠근 뒤 다음 문장에서 갱신한다. 동시에 도는 갱신이
   * 같은 행 집합을 서로 다른 순서로 잠그지 않도록 순서를 통일한다.
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
        `UPDATE ${SCHEMA}.fragments f
               SET access_count = f.access_count + 1,
                   accessed_at  = NOW()
             WHERE f.id = ANY($1::text[])`,
        [],
        { lock: fragmentRowLock("access", "id = ANY($1)", [ids]) }
      ).catch(err => logWarn(`[FragmentWriter] incrementAccess failed: ${err.message}`));
    } else {
      await queryWithAgentVector(agentId,
        `UPDATE ${SCHEMA}.fragments f
               SET access_count      = f.access_count + 1,
                   accessed_at       = NOW(),
                   ema_activation    = $2 * POWER(
                                         GREATEST(
                                           EXTRACT(EPOCH FROM (NOW() - COALESCE(f.ema_last_updated, f.created_at - INTERVAL '1 day'))),
                                           1
                                         ), -0.5
                                       ) + (1 - $2) * COALESCE(f.ema_activation, 0),
                   ema_last_updated  = NOW()
             WHERE f.id = ANY($1::text[])`,
        [alpha],
        { lock: fragmentRowLock("access", "id = ANY($1)", [ids]) }
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
  async touchLinked(
    retrievedIds,
    agentId,
    keyId = null,
    { workspace = null, allWorkspaces = false } = {}
  ) {
    if (!retrievedIds || retrievedIds.length === 0) return;
    const pool = getPrimaryPool();
    if (!pool) return;

    const params    = [retrievedIds];
    const keyArr    = keyId == null ? null : (Array.isArray(keyId) ? keyId : [keyId]);
    const keyFilter = keyScopeGroup(params, "key_id", keyArr).trimStart();
    const workspaceClause = workspaceCondition(
      params, { workspace, allWorkspaces }, "workspace"
    );
    const workspaceFilter = workspaceClause ? `AND ${workspaceClause}` : "";

    const where = `id IN (
           SELECT DISTINCT
             CASE WHEN fl.from_id = ANY($1::text[]) THEN fl.to_id
                  ELSE fl.from_id
             END
           FROM ${SCHEMA}.fragment_links fl
           WHERE (fl.from_id = ANY($1::text[]) OR fl.to_id = ANY($1::text[]))
             AND fl.relation_type = 'co_retrieved'
         )
         AND id != ALL($1::text[])
         ${keyFilter}
         ${workspaceFilter}`;

    await queryWithAgentVector(agentId,
      `UPDATE ${SCHEMA}.fragments f
          SET accessed_at = NOW()
        WHERE f.id = ANY($1::text[])`,
      [],
      { lock: fragmentRowLock("touch_linked", where, params) }
    ).catch(err => logWarn(`[FragmentWriter] touchLinked failed: ${err.message}`));
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
    return this.updateInternal(id, { assertion_status: assertionStatus }, { keyId });
  }

  /**
   * 내부 메타데이터 열 갱신. 의미 열과 INTERNAL_COLUMNS 밖의 열은 InternalUpdateError로 거부한다.
   * keyId가 null이면 마스터 컨텍스트(전체 수정), 값이 있으면 소유 파편만 수정한다.
   *
   * @param {string}      id
   * @param {Object}      fields - 열 이름을 키로 한 새 값
   * @param {Object}      [opts]
   * @param {string|null} [opts.keyId]
   * @returns {Promise<boolean>} 갱신 여부
   */
  async updateInternal(id, fields, { keyId = null } = {}) {
    const columns  = Object.keys(fields);
    const semantic = columns.filter(c => SEMANTIC_COLUMNS.includes(c));
    if (semantic.length > 0) {
      throw new InternalUpdateError(`updateInternal cannot write semantic columns: ${semantic.join(", ")}`, semantic);
    }
    const unknown = columns.filter(c => !INTERNAL_COLUMNS.includes(c));
    if (unknown.length > 0) {
      throw new InternalUpdateError(`updateInternal does not accept columns: ${unknown.join(", ")}`, unknown);
    }
    if (columns.length === 0) return false;

    const params     = [id];
    const setClauses = columns.map(column => {
      params.push(fields[column]);
      return `${column} = $${params.length}`;
    });
    const keyFilter = keyScopeScalar(params, "key_id", keyId);
    const result    = await queryWithAgentVector(
      keyId != null ? "default" : "system",
      `UPDATE ${SCHEMA}.fragments SET ${setClauses.join(", ")} WHERE id = $1${keyFilter}`,
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
   * @param {Object}      opts   - 선택 시 사용한 agent/key-group/workspace 재검증 범위
   * @returns {Promise<boolean>} 업데이트 성공 여부
   */
  async updateCaseId(id, caseId, keyId = null, opts = {}) {
    const agentScope = resolveAgentScope(opts);
    const params = [id, caseId, agentScope.agentId];
    const keyFilter = keyScopeClause(params, "key_id", {
      keyId, groupKeyIds: opts.groupKeyIds
    });
    const workspaceFilter = workspaceCondition(params, {
      workspace: opts.workspace ?? null,
      allWorkspaces: false
    }, "workspace");
    const result = await queryWithAgentVector(agentScope.agentId,
      `UPDATE ${SCHEMA}.fragments SET case_id = $2
       WHERE id = $1 AND valid_to IS NULL
         AND ${agentScopeCondition("$3", agentScope)}
         ${keyFilter}
         AND ${workspaceFilter}`,
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
    return this.updateInternal(id, { ttl_tier: ttlTier }, { keyId });
  }
}
