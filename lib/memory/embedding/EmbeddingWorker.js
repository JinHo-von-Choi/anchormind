/**
 * EmbeddingWorker - Redis 큐 기반 비동기 임베딩 생성 워커
 *
 * 작성자: 최진호
 * 작성일: 2026-03-07
 * 수정일: 2026-04-27
 *
 * FragmentStore.insert()의 인라인 임베딩을 제거하고,
 * Redis 큐에서 파편 ID를 소비하여 임베딩을 생성한 뒤 DB에 저장한다.
 * 임베딩 완료 시 `embedding_ready` 이벤트를 발행한다.
 *
 * Phase 3: _embedMany 배치화 - N건을 generateBatchEmbeddings 1회 호출로 처리.
 * batch 400 응답의 input[N] 인덱스 파싱으로 해당 행 dead-letter 이동 후 나머지 재batch.
 * 인덱스 미명시 에러는 단건 fallback(_embedOne).
 */

import { EventEmitter }    from "node:events";
import { MEMORY_CONFIG }   from "../../../config/memory.js";
import { redisClient }     from "../../redis.js";
import { queryWithAgentVector } from "../../tools/db.js";
import {
  generateEmbedding,
  generateBatchEmbeddings,
  prepareTextForEmbedding,
  vectorToSql,
  EMBEDDING_ENABLED
} from "../../tools/embedding.js";
import { logInfo, logWarn, logError } from "../../logger.js";
import { EmbeddingCache }       from "./EmbeddingCache.js";
import { expandAssistantQuery } from "../read/assistant-query.js";

const SCHEMA = "agent_memory";

export class EmbeddingWorker extends EventEmitter {
  constructor() {
    super();
    this.running = false;
    this.config  = MEMORY_CONFIG.embeddingWorker;
    this.timer   = null;
    this._backoff    = 1000;
    this._backoffMax = 60000;
    this._processing = false;
    this._drainResolve = null;
    /** remember 동기 경로(detectConflicts)가 채운 벡터를 재사용하기 위한 캐시 */
    this.embeddingCache = new EmbeddingCache({ redis: redisClient });
  }

  /**
   * 캐시 조회 키 = 임베딩 생성 입력.
   * FragmentSearch._searchL3/detectConflicts와 동일하게 expandAssistantQuery 확장 후
   * prepareTextForEmbedding(_, 500)로 준비하여 캐시 키 불일치 미스를 방지한다.
   *
   * @param {string} content
   * @returns {string}
   */
  _cacheKeyText(content) {
    const { text } = expandAssistantQuery(content);
    return prepareTextForEmbedding(text, 500);
  }

  /**
   * 워커 시작 - 임베딩 API가 설정되지 않으면 조기 종료
   */
  async start() {
    if (!EMBEDDING_ENABLED) {
      logWarn("[EmbeddingWorker] 임베딩 API가 설정되지 않아 워커를 비활성화합니다. EMBEDDING_API_KEY 또는 EMBEDDING_BASE_URL을 설정하세요.");
      return;
    }
    if (this.running) return;

    this.running = true;
    logInfo("[EmbeddingWorker] Worker started");
    this._poll();
  }

  /**
   * 워커 중지 - 진행 중 배치 완료까지 대기하는 Promise 반환
   *
   * @returns {Promise<void>} 진행 중 배치가 완료되면 resolve
   */
  stop() {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this._processing) {
      logInfo("[EmbeddingWorker] Waiting for in-flight batch to finish...");
      return new Promise(resolve => {
        this._drainResolve = resolve;
      });
    }

    logInfo("[EmbeddingWorker] Worker stopped (no in-flight work)");
    return Promise.resolve();
  }

  /**
   * intervalMs 간격으로 _processBatch 호출
   */
  _poll() {
    if (!this.running) return;

    this._processing = true;
    this._processBatch()
      .then(() => {
        this._backoff = 1000;
      })
      .catch(err => {
        logError("[EmbeddingWorker] _processBatch error", err);
        this._backoff = Math.min(this._backoff * 2, this._backoffMax);
        logWarn(`[EmbeddingWorker] Backing off for ${this._backoff}ms`);
      })
      .finally(() => {
        this._processing = false;
        if (this._drainResolve) {
          logInfo("[EmbeddingWorker] Worker stopped (in-flight batch finished)");
          this._drainResolve();
          this._drainResolve = null;
        }
        if (this.running) {
          const delay = this._backoff > 1000 ? this._backoff : this.config.intervalMs;
          this.timer  = setTimeout(() => this._poll(), delay);
        }
      });
  }

  /**
   * Redis 큐에서 batchSize개 ID를 추출하고 임베딩 생성
   */
  async _processBatch() {
    const queueRedisKey = `queue:${this.config.queueKey}`;
    const ids           = [];

    for (let i = 0; i < this.config.batchSize; i++) {
      const raw = await redisClient.rpop(queueRedisKey);
      if (!raw) break;

      try {
        const data = JSON.parse(raw);
        if (data.fragmentId) {
          ids.push(data.fragmentId);
        }
      } catch (err) {
        logWarn(`[EmbeddingWorker] Invalid queue item: ${raw} - ${err.message}`);
      }
    }

    if (ids.length === 0) return;

    /** DB에서 embedding IS NULL인 파편만 조회 */
    const { rows } = await queryWithAgentVector("system",
      `SELECT id, content FROM ${SCHEMA}.fragments
       WHERE id = ANY($1) AND embedding IS NULL`,
      [ids]
    );

    await this._embedMany(rows);
  }

  /**
   * embedding IS NULL인 파편을 직접 조회하여 임베딩 생성 (consolidate 및 백필 스케줄러 공용)
   *
   * @param {number} limit - 최대 처리 파편 수
   * @returns {Promise<number>} 생성된 임베딩 수
   */
  async processOrphanFragments(limit = 10) {
    if (!EMBEDDING_ENABLED) return 0;

    const { rows } = await queryWithAgentVector("system",
      `SELECT id, content FROM ${SCHEMA}.fragments
       WHERE embedding IS NULL
       ORDER BY importance DESC, created_at DESC
       LIMIT $1`,
      [limit]
    );

    if (rows.length === 0) return 0;

    const count = rows.length;
    try {
      await this._embedMany(rows);
    } catch (err) {
      logWarn(`[EmbeddingWorker] processOrphanFragments _embedMany error: ${err.message}`);
    }
    return count;
  }

  /**
   * 여러 파편을 배치 임베딩으로 처리하고 multi-row UPDATE로 한 번에 저장한다.
   *
   * 처리 순서:
   * 1. 빈 content 사전 필터링
   * 2. 누적 바이트 256KB / 200건 청크 분할
   * 3. 각 청크에 대해 _embedChunk 호출
   *
   * @param {Array<{id: string, content: string}>} rows
   */
  async _embedMany(rows) {
    /** 1. 사전 검증: 빈 content 제거 */
    const valid = rows.filter(r => typeof r.content === "string" && r.content.trim().length > 0);

    if (valid.length === 0) return;

    /** 2. 청크 분할 - 누적 바이트 256KB 또는 200건 제한 */
    const BYTE_CAP  = 256 * 1024;
    const COUNT_CAP = 200;

    const chunks = [];
    let   chunk  = [];
    let   bytes  = 0;

    for (const row of valid) {
      const rowBytes = Buffer.byteLength(row.content, "utf8");
      if (chunk.length > 0 && (bytes + rowBytes > BYTE_CAP || chunk.length >= COUNT_CAP)) {
        chunks.push(chunk);
        chunk = [];
        bytes = 0;
      }
      chunk.push(row);
      bytes += rowBytes;
    }
    if (chunk.length > 0) chunks.push(chunk);

    /** 3. 각 청크를 순차 처리 */
    for (const chunkRows of chunks) {
      await this._embedChunk(chunkRows);
    }
  }

  /**
   * 단일 청크(최대 200건)를 배치 임베딩 처리한다.
   * batch 400 에러 시 인덱스 파싱으로 dead-letter 분리 후 재batch 또는 단건 fallback.
   *
   * @param {Array<{id: string, content: string}>} chunkRows
   */
  async _embedChunk(chunkRows) {
    const texts = chunkRows.map(r => this._cacheKeyText(r.content));

    /** 전건 캐시 히트면 배치 API 호출 자체를 생략 (remember detectConflicts가 채운 벡터 재사용).
     *  일부라도 미스면 인덱스 정합(400 복구 로직)을 위해 기존 배치 경로를 그대로 탄다. */
    const cachedVecs = await Promise.all(texts.map(t => this.embeddingCache.get(t).catch(() => null)));
    let   vecs;
    if (cachedVecs.every(v => Array.isArray(v))) {
      vecs = cachedVecs;
    } else {
      try {
        vecs = await generateBatchEmbeddings(texts);
        /** 생성 성공분을 캐시에 채워 후속 재사용 유도 */
        for (let i = 0; i < texts.length; i++) {
          if (Array.isArray(vecs[i])) this.embeddingCache.set(texts[i], vecs[i]);
        }
      } catch (err) {
        /** input[N] 인덱스 파싱 시도 */
        const indexMatch = /Invalid 'input\[(\d+)\]'/.exec(err.message || "");
        if (indexMatch) {
          const badIdx    = parseInt(indexMatch[1], 10);
          const badRow    = chunkRows[badIdx];
          const remaining = chunkRows.filter((_, i) => i !== badIdx);

          /** bad row dead letter로 이동 */
          if (badRow) {
            const deadLetterKey = `queue:${this.config.queueKey}:dead`;
            try {
              await redisClient.lpush(deadLetterKey, JSON.stringify({
                fragmentId: badRow.id,
                error     : err.message,
                failedAt  : new Date().toISOString()
              }));
              logError(`[EmbeddingWorker] Fragment ${badRow.id} (input[${badIdx}]) moved to dead letter`, err);
            } catch (dlqErr) {
              logError("[EmbeddingWorker] Dead letter push failed", dlqErr);
            }
          }

          /** 나머지 재batch (재귀) */
          if (remaining.length > 0) {
            await this._embedChunk(remaining);
          }
          return;
        }

        /** 인덱스 미명시 에러 - 전체 단건 fallback */
        logWarn(`[EmbeddingWorker] _embedChunk batch error (no index), falling back to _embedOne: ${err.message}`);
        for (const row of chunkRows) {
          await this._embedOne(row);
        }
        return;
      }
    }

    /** 4. multi-row UPDATE */
    if (vecs.length === 0) return;

    const valueParts = [];
    const params     = [];
    let   paramIdx   = 1;

    for (let i = 0; i < chunkRows.length && i < vecs.length; i++) {
      const vecStr = vectorToSql(vecs[i]);
      valueParts.push(`($${paramIdx}::text, $${paramIdx + 1}::vector)`);
      params.push(chunkRows[i].id, vecStr);
      paramIdx += 2;
    }

    const sql = `
      UPDATE ${SCHEMA}.fragments AS f
         SET embedding = v.vec::vector
        FROM (VALUES ${valueParts.join(", ")}) AS v(id, vec)
       WHERE f.id = v.id
    `;

    await queryWithAgentVector("system", sql, params, "write");

    /** 5. 이벤트 발행 */
    for (const row of chunkRows) {
      this.emit("embedding_ready", { fragmentId: row.id });
    }
    this.emit("embedding_batch_done", { count: chunkRows.length });
  }

  /**
   * 단일 파편 임베딩 생성 및 DB 저장
   *
   * @param {Object} row - { id, content }
   */
  async _embedOne(row) {
    let lastError = null;

    for (let attempt = 1; attempt <= this.config.retryLimit; attempt++) {
      try {
        const text      = this._cacheKeyText(row.content);
        let   vec       = await this.embeddingCache.get(text);
        if (!vec) {
          vec = await generateEmbedding(text);
          this.embeddingCache.set(text, vec);
        }
        const vecStr    = vectorToSql(vec);

        await queryWithAgentVector("system",
          `UPDATE ${SCHEMA}.fragments SET embedding = $2::vector WHERE id = $1`,
          [row.id, vecStr],
          "write"
        );

        this.emit("embedding_ready", { fragmentId: row.id });
        return;
      } catch (err) {
        lastError = err;
        logWarn(`[EmbeddingWorker] Attempt ${attempt}/${this.config.retryLimit} failed for ${row.id}: ${err.message}`);

        if (attempt < this.config.retryLimit) {
          await new Promise(r => setTimeout(r, this.config.retryDelayMs));
        }
      }
    }

    /** 재시도 초과 - dead letter 큐로 이동 */
    const deadLetterKey = `queue:${this.config.queueKey}:dead`;
    try {
      await redisClient.lpush(deadLetterKey, JSON.stringify({
        fragmentId: row.id,
        error     : lastError?.message || "unknown",
        failedAt  : new Date().toISOString()
      }));
      logError(`[EmbeddingWorker] Fragment ${row.id} moved to dead letter queue`, lastError);
    } catch (dlqErr) {
      logError("[EmbeddingWorker] Dead letter push failed", dlqErr);
    }
  }
}
