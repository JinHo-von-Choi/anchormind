/**
 * BatchRememberProcessor -- batchRemember() 로직 전담 모듈
 *
 * 작성자: 최진호
 * 작성일: 2026-04-05
 * 수정일: 2026-04-27 (Phase B multi-row INSERT — 행별 직렬 await → 청크 단위 VALUES 묶음)
 *
 * MemoryManager.batchRemember() 247줄 본문을 추출.
 * Phase A(유효성 검증), Phase B(트랜잭션 INSERT), Phase C(후처리) 3단계 구조.
 *
 * Phase B 변경:
 *   기존: 트랜잭션 안에서 validFragments를 행마다 직렬 await client.query()
 *   변경: COLS_PER_ROW × N 행 placeholder를 VALUES 묶음으로 조합한 단일 SQL,
 *         RETURNING id 로 입력 순서 매핑. 청크 기준:
 *           - 누적 content 바이트 256 KB 초과, 또는
 *           - 24컬럼 × 500 행 = 12,000 placeholder (Postgres 65535 안전 마진)
 *         중 먼저 도달한 기준으로 분할. chunk 1개당 onProgress emit 1회.
 *         chunk 내 제약 위반은 전체 롤백 후 raw 에러 전파 (chunk halving 금지).
 */

import { getBatchPool }     from "../../tools/db.js";
import { MEMORY_CONFIG }    from "../../../config/memory.js";
import { pushToQueue, redisClient, setBatchJobStatus } from "../../redis.js";
import { FragmentFactory }  from "./FragmentFactory.js";
import { extractRequestCtx } from "../keyId.js";
import { validateContentInput } from "../contentGuard.js";

const MAX_BATCH      = 200;
const SCHEMA         = "agent_memory";
/** 24컬럼 × 500행 = 12,000 placeholder (Postgres 65535 한도 안전 마진) */
const COLS_PER_ROW   = 24;
const MAX_ROWS_CHUNK = 500;
/** content 누적 바이트 기준 256 KB */
const MAX_BYTES_CHUNK = 256 * 1024;

export class BatchRememberProcessor {
  #pool          = null;
  #poolOverridden = false;

  /**
   * @param {Object} deps
   *   - store          {FragmentStore}
   *   - index          {FragmentIndex}
   *   - factory        {FragmentFactory}
   */
  constructor({ store, index, factory }) {
    this.store   = store;
    this.index   = index;
    this.factory = factory;
  }

  /** 테스트용 pool 주입 (null 포함) */
  setPool(pool) {
    this.#pool          = pool;
    this.#poolOverridden = true;
  }

  /** @private */
  _getPool() {
    return this.#poolOverridden ? this.#pool : getBatchPool();
  }

  /**
   * 복수 파편을 단일 트랜잭션으로 일괄 저장한다.
   *
   * @param {Object}   params
   *   - fragments {Array<Object>} 파편 배열
   *   - agentId   {string}       에이전트 ID (선택)
   *   - _keyId    {string|null}  API 키 ID (선택)
   *   - workspace {string|null}  워크스페이스 (선택)
   *   - _defaultWorkspace {string|null}
   * @param {((event: {phase: string, processed: number, total: number, skipped: number, errors: number}) => void)|null} [onProgress]
   *   진행 이벤트 콜백. 제공되지 않거나 null이면 기존 동작 유지 (no-op).
   * @returns {{ results: Array<{id, success, error?}>, inserted: number, skipped: number }}
   */
  async process(params, onProgress = null) {
    const fragments = params.fragments;
    if (!Array.isArray(fragments) || fragments.length === 0) {
      throw new Error("fragments array is required and must not be empty");
    }

    if (fragments.length > MAX_BATCH) {
      throw new Error(`Batch size ${fragments.length} exceeds maximum ${MAX_BATCH}`);
    }

    const { agentId, keyId } = extractRequestCtx(params);
    const workspace = params.workspace ?? params._defaultWorkspace ?? null;
    const results   = [];
    const total     = fragments.length;

    /** @type {(event: object) => void} */
    const emit = (typeof onProgress === "function") ? onProgress : () => {};

    /** Phase A: 유효성 검증 + 파편 생성 (DB 밖에서 수행) */
    const validFragments = [];

    for (let i = 0; i < fragments.length; i++) {
      const item = fragments[i];
      try {
        /** 사전 validate: FragmentFactory.validateContent 전에 명시적 거부 조건 확인 */
        if (item.content === null || item.content === undefined) {
          results.push({ index: i, id: null, success: false, error: "content is required" });
          continue;
        }
        validateContentInput(item.content);
        if (!item.type) {
          results.push({ index: i, id: null, success: false, error: "type is required" });
          continue;
        }

        const validation = FragmentFactory.validateContent(
          (item.content || "").trim(),
          item.type ?? null,
          item.topic ?? null
        );
        if (!validation.valid) {
          results.push({ index: i, id: null, success: false, error: validation.reason });
          continue;
        }

        const fragment     = this.factory.create(item);
        fragment.agent_id  = agentId;
        fragment.key_id    = keyId;
        fragment.workspace = item.workspace ?? workspace;
        validFragments.push({ index: i, fragment });
        results.push({ index: i, id: fragment.id, success: true });
      } catch (err) {
        results.push({ index: i, id: null, success: false, error: err.message });
      }
    }

    const phaseAErrors  = results.filter(r => !r.success).length;
    emit({
      phase    : "A",
      processed: results.length,
      total,
      skipped  : phaseAErrors,
      errors   : phaseAErrors
    });

    if (validFragments.length === 0) {
      /** async 모드는 전량 거부라도 일관된 { async, accepted:0, rejected, jobId:null } 형태로 반환 */
      if (params.async === true && redisClient.status !== "stub") {
        return this._enqueueAsync(params, fragments, validFragments, results);
      }
      return { results, inserted: 0, skipped: fragments.length };
    }

    /** 할당량 초과 검사: API 키의 잔여 슬롯만큼만 INSERT 허용 (partial insert) */
    if (keyId) {
      const quotaResult = await this._checkQuotaPhaseA(keyId, validFragments, results, fragments.length);
      if (quotaResult) return quotaResult;
    }

    /**
     * async(파이어앤포겟) 모드:
     * 선검증(Phase A 스키마/중복 + 할당량 선체크)을 통과한 파편을 Redis 큐에 적재하고
     * 즉시 반환한다. INSERT 본처리는 BatchRememberWorker가 동일 process()를 재호출하여 수행한다.
     * Redis 비활성(stub) 시에는 분기하지 않고 기존 동기 경로로 폴백한다.
     */
    if (params.async === true && redisClient.status !== "stub") {
      return this._enqueueAsync(params, fragments, validFragments, results);
    }

    /** Phase B: 단일 트랜잭션 multi-row INSERT */
    const pool = this._getPool();
    if (!pool) throw new Error("Database pool unavailable");

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const safeAgent = String(agentId).replace(/[^a-zA-Z0-9_-]/g, "");
      await client.query(`SET LOCAL search_path TO ${SCHEMA}, public`);
      // security: agentId sanitized via /[^a-zA-Z0-9_-]/g — SET LOCAL does not support parameter binding
      await client.query(`SET LOCAL app.current_agent_id = '${safeAgent}'`);

      /**
       * Phase B 할당량 재검증 (TOCTOU 방어):
       * Phase A의 quota check와 이 INSERT 트랜잭션 사이 간극에서 동시 요청이
       * limit을 초과할 수 있다. INSERT 트랜잭션 내에서 api_keys를 FOR UPDATE로
       * 재잠금하고 현재 count를 재확인하여 초과분을 재조정한다.
       */
      if (keyId) {
        const quotaResultB = await this._checkQuotaPhaseB(
          client, keyId, safeAgent, validFragments, results, fragments.length
        );
        if (quotaResultB) {
          await client.query("ROLLBACK");
          return quotaResultB;
        }
      }

      let insertedCount = 0;

      /**
       * ON CONFLICT 절: keyId는 배치 전체에서 고정이므로 청크 공통으로 사용.
       *  - master  (key_id IS NULL):     uq_frag_hash_master   (content_hash) WHERE key_id IS NULL
       *  - DB key  (key_id IS NOT NULL): uq_frag_hash_per_key  (key_id, content_hash) WHERE key_id IS NOT NULL
       */
      const onConflictClause = keyId === null
        ? `ON CONFLICT (content_hash) WHERE key_id IS NULL DO UPDATE SET`
        : `ON CONFLICT (key_id, content_hash) WHERE key_id IS NOT NULL DO UPDATE SET`;

      /** validFragments를 청크로 분할 (256KB 또는 500행 중 먼저 도달) */
      const chunks = [];
      let currentChunk = [];
      let currentBytes = 0;

      for (const item of validFragments) {
        const itemBytes = Buffer.byteLength(item.fragment.content || "", "utf8");
        const wouldExceedBytes = currentChunk.length > 0 && (currentBytes + itemBytes) > MAX_BYTES_CHUNK;
        const wouldExceedRows  = currentChunk.length >= MAX_ROWS_CHUNK;

        if (wouldExceedBytes || wouldExceedRows) {
          chunks.push(currentChunk);
          currentChunk = [];
          currentBytes = 0;
        }
        currentChunk.push(item);
        currentBytes += itemBytes;
      }
      if (currentChunk.length > 0) chunks.push(currentChunk);

      /**
       * 청크별 multi-row INSERT.
       * 청크 내 제약 위반은 전체 롤백 후 raw 에러 전파 (chunk halving 금지).
       * 청크 1개당 onProgress emit 1회 (chunkIndex, chunkSize 추가).
       */
      for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
        const chunk       = chunks[chunkIdx];
        const valuesParts = [];
        const params      = [];
        let   paramIdx    = 1;

        for (const { fragment } of chunk) {
          const contentHash     = fragment.content_hash;
          const estimatedTokens = fragment.estimated_tokens || Math.ceil((fragment.content || "").length / 4);
          const validFrom       = fragment.valid_from || new Date().toISOString();
          const isAnchor        = fragment.is_anchor === true;

          valuesParts.push(
            `($${paramIdx}, $${paramIdx+1}, $${paramIdx+2}, $${paramIdx+3}, ` +
            `$${paramIdx+4}, $${paramIdx+5}, $${paramIdx+6}, $${paramIdx+7}, ` +
            `$${paramIdx+8}, $${paramIdx+9}, $${paramIdx+10}, $${paramIdx+11}, ` +
            `$${paramIdx+12}::timestamptz, $${paramIdx+13}, $${paramIdx+14}, ` +
            `$${paramIdx+15}, $${paramIdx+16}, $${paramIdx+17}, $${paramIdx+18}, ` +
            `$${paramIdx+19}, $${paramIdx+20}, $${paramIdx+21}, $${paramIdx+22}, ` +
            `$${paramIdx+23}, NULL)`
          );

          params.push(
            fragment.id,
            fragment.content,
            fragment.topic,
            fragment.keywords || [],
            fragment.type,
            fragment.importance ?? 0.5,
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
            fragment.workspace ?? null,
            fragment.case_id || null,
            fragment.goal || null,
            fragment.outcome || null,
            fragment.phase || null,
            fragment.resolution_status || null,
            fragment.assertion_status || "observed"
          );

          paramIdx += COLS_PER_ROW;
        }

        const insertSql = `INSERT INTO ${SCHEMA}.fragments
                    (id, content, topic, keywords, type, importance, content_hash,
                     source, linked_to, agent_id, ttl_tier, estimated_tokens, valid_from, key_id, is_anchor,
                     context_summary, session_id, workspace,
                     case_id, goal, outcome, phase, resolution_status, assertion_status,
                     embedding)
                 VALUES ${valuesParts.join(", ")}
                 ${onConflictClause}
                    importance  = GREATEST(${SCHEMA}.fragments.importance, EXCLUDED.importance),
                    is_anchor   = ${SCHEMA}.fragments.is_anchor OR EXCLUDED.is_anchor,
                    accessed_at = NOW()
                 RETURNING id`;

        const rows = await client.query(insertSql, params);

        /** RETURNING id는 입력 순서와 동일하게 반환된다 (Postgres 보장) */
        for (let i = 0; i < chunk.length; i++) {
          const { index, fragment } = chunk[i];
          const insertedId          = rows.rows[i]?.id || fragment.id;
          results[index].id         = insertedId;
          insertedCount++;
        }

        const phaseBErrorsSoFar = results.filter(r => !r.success).length - phaseAErrors;
        emit({
          phase      : "B",
          processed  : insertedCount,
          total,
          skipped    : total - insertedCount,
          errors     : Math.max(0, phaseBErrorsSoFar),
          chunkIndex : chunkIdx,
          chunkSize  : chunk.length,
        });
      }

      await client.query("COMMIT");

      /** Phase C: 비동기 후처리 (임베딩 큐, Redis 인덱스) -- 트랜잭션 외부 */
      for (const { fragment } of validFragments) {
        const idx = results.findIndex(r => r.id === fragment.id && r.success);
        if (idx < 0) continue;

        this.index.index({ ...fragment, id: results[idx].id }, null, keyId).catch(() => {});
        pushToQueue(MEMORY_CONFIG.embeddingWorker.queueKey, { fragmentId: results[idx].id }).catch(() => {});
      }

      emit({
        phase    : "C",
        processed: insertedCount,
        total,
        skipped  : total - insertedCount,
        errors   : results.filter(r => !r.success).length
      });

      return {
        results,
        inserted: insertedCount,
        skipped : fragments.length - insertedCount
      };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * async=true 전용: 선검증을 통과한 원본 입력 item을 Redis 큐에 적재하고 즉시 반환한다.
   *
   * 큐 job에는 가공된 fragment 객체가 아닌 원본 입력 item(content/topic/type/
   * idempotencyKey 등)을 담는다. 워커가 동일 process()를 재호출하면 Phase A 검증·
   * FragmentFactory.create·ON CONFLICT INSERT가 그대로 재실행되어 본처리 코드가 한 곳으로
   * 유지되고 idempotencyKey 재시도 안전이 보존된다. 무한 큐 재적재를 막기 위해 job params에는
   * async 플래그를 포함하지 않는다(워커는 동기 경로로 실행).
   *
   * @param {Object} params         원본 호출 파라미터
   * @param {Array<Object>} fragments  원본 입력 item 배열
   * @param {Array<{index:number, fragment:Object}>} validFragments  선검증 통과분
   * @param {Array<{index:number, success:boolean, error?:string}>} results
   * @returns {Promise<{async:true, accepted:number, rejected:Array<{index:number, error:string}>, jobId:string|null}>}
   * @private
   */
  async _enqueueAsync(params, fragments, validFragments, results) {
    const rejected = results
      .filter(r => !r.success)
      .map(r => ({ index: r.index, error: r.error }));

    if (validFragments.length === 0) {
      return { async: true, accepted: 0, rejected, jobId: null };
    }

    const jobId   = `brw-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const queueKey = MEMORY_CONFIG.batchRememberWorker.queueKey.replace(/^memento:/, "");

    /** 선검증 통과한 원본 item만 추려서 job에 담는다 (index 기준). */
    const acceptedItems = validFragments.map(({ index }) => fragments[index]);

    /** 워커가 동기 경로로 재실행하도록 async 플래그를 제외한 컨텍스트만 전달한다. */
    const jobParams = {
      fragments        : acceptedItems,
      agentId          : params.agentId,
      _keyId           : params._keyId ?? null,
      _groupKeyIds     : params._groupKeyIds ?? null,
      workspace        : params.workspace ?? null,
      _defaultWorkspace: params._defaultWorkspace ?? null
    };

    const pushed = await pushToQueue(queueKey, { jobId, params: jobParams, retryCount: 0 });
    if (!pushed) {
      throw new Error("Failed to enqueue batch_remember job to Redis");
    }

    await setBatchJobStatus(jobId, { state: "queued", accepted: acceptedItems.length });

    return { async: true, accepted: acceptedItems.length, rejected, jobId };
  }

  /**
   * Phase A 할당량 검사.
   * keyId의 잔여 슬롯을 확인하고, 초과 시 validFragments를 잘라내거나 전량 거부한다.
   * 전량 거부 시 반환값을 돌려준다. 부분 거부/통과 시 null 반환.
   *
   * @private
   */
  async _checkQuotaPhaseA(keyId, validFragments, results, totalCount) {
    const quotaPool = this._getPool();
    if (!quotaPool) return null;

    const qClient = await quotaPool.connect();
    try {
      await qClient.query("BEGIN");
      await qClient.query("SET LOCAL app.current_agent_id = 'system'");
      const { rows: [keyRow] } = await qClient.query(
        `SELECT fragment_limit FROM agent_memory.api_keys WHERE id = $1 FOR UPDATE`,
        [keyId]
      );
      if (keyRow && keyRow.fragment_limit !== null) {
        const { rows: [countRow] } = await qClient.query(
          `SELECT COUNT(*)::int AS count FROM agent_memory.fragments
           WHERE key_id = $1 AND valid_to IS NULL`,
          [keyId]
        );
        const remaining = keyRow.fragment_limit - countRow.count;
        if (remaining <= 0) {
          /** 전량 초과: 모든 valid 파편을 에러 처리 */
          for (const { index } of validFragments) {
            results[index].success = false;
            results[index].error   = "fragment_limit_exceeded";
            results[index].id      = null;
          }
          await qClient.query("COMMIT");
          return {
            results,
            inserted          : 0,
            skipped           : totalCount,
            fragment_limit    : keyRow.fragment_limit,
            current_count     : countRow.count,
            rejected_by_quota : validFragments.length
          };
        }
        if (remaining < validFragments.length) {
          /** 부분 초과: 잔여 할당량 이후의 파편을 에러 처리 */
          const rejected = validFragments.splice(remaining);
          for (const { index } of rejected) {
            results[index].success = false;
            results[index].error   = "fragment_limit_exceeded";
            results[index].id      = null;
          }
        }
      }
      await qClient.query("COMMIT");
    } catch (err) {
      await qClient.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      qClient.release();
    }

    return null;
  }

  /**
   * Phase B 할당량 재검증 (TOCTOU 방어).
   * INSERT 트랜잭션 내에서 api_keys를 FOR UPDATE로 재잠금하여 초과분 재조정.
   * 전량 거부 시 반환값을 돌려준다. 부분 거부/통과 시 null 반환.
   *
   * @private
   */
  async _checkQuotaPhaseB(client, keyId, safeAgent, validFragments, results, totalCount) {
    await client.query("SET LOCAL app.current_agent_id = 'system'");
    const { rows: [keyRowB] } = await client.query(
      `SELECT fragment_limit FROM ${SCHEMA}.api_keys WHERE id = $1 FOR UPDATE`,
      [keyId]
    );
    if (keyRowB && keyRowB.fragment_limit !== null) {
      const { rows: [countRowB] } = await client.query(
        `SELECT COUNT(*)::int AS count FROM ${SCHEMA}.fragments
         WHERE key_id = $1 AND valid_to IS NULL`,
        [keyId]
      );
      const remainingB = keyRowB.fragment_limit - countRowB.count;
      if (remainingB <= 0) {
        for (const { index } of validFragments) {
          results[index].success = false;
          results[index].error   = "fragment_limit_exceeded";
          results[index].id      = null;
        }
        return {
          results,
          inserted          : 0,
          skipped           : totalCount,
          fragment_limit    : keyRowB.fragment_limit,
          current_count     : countRowB.count,
          rejected_by_quota : validFragments.length
        };
      }
      if (remainingB < validFragments.length) {
        const rejectedB = validFragments.splice(remainingB);
        for (const { index } of rejectedB) {
          results[index].success = false;
          results[index].error   = "fragment_limit_exceeded";
          results[index].id      = null;
        }
      }
    }
    // security: agentId sanitized via /[^a-zA-Z0-9_-]/g — SET LOCAL does not support parameter binding
    await client.query(`SET LOCAL app.current_agent_id = '${safeAgent}'`);
    return null;
  }
}
