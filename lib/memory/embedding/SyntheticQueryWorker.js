/**
 * SyntheticQueryWorker - 역질의 생성·임베딩 비동기 워커
 *
 * 작성자: 최진호
 * 작성일: 2026-08-28
 *
 * 전용 큐에서 파편을 꺼내 역질의를 생성하고 임베딩하여 fragment_synthetic_query에
 * 적재한다. 임베딩 큐와 분리해 한쪽의 폭주가 다른 쪽으로 전파되지 않게 한다.
 *
 * 큐 적재가 유실되어도 백필 수집기가 미생성 파편을 주기적으로 회수하므로
 * 적재 실패를 재시도로 메우지 않는다. 재시도는 상한을 두고 초과분은 버린다.
 */

import { popFromQueue, getQueueLength }       from "../../redis.js";
import { generateQueries, isEligible }        from "./SyntheticQueryGenerator.js";
import { generateEmbedding, prepareTextForEmbedding, EMBEDDING_ENABLED } from "../../tools/embedding.js";
import { queryWithAgentVector }               from "../../tools/db.js";
import { MEMORY_CONFIG }                      from "../../../config/memory.js";
import { logInfo, logWarn }                   from "../../logger.js";

const SCHEMA = "agent_memory";

/**
 * 분당 호출 상한을 지키는 단순 토큰 버킷.
 * 외부 의존 없이 호출 시각만 들고 판정한다.
 */
export class RateLimiter {
  /**
   * @param {number} maxPerMinute 0 이하이면 제한 없음
   */
  constructor(maxPerMinute) {
    this.maxPerMinute = maxPerMinute;
    this.timestamps   = [];
  }

  /**
   * 지금 호출해도 되는지 판정하고, 가능하면 사용량을 기록한다.
   *
   * @param {number} [now]
   * @returns {boolean}
   */
  tryAcquire(now = Date.now()) {
    if (!Number.isFinite(this.maxPerMinute) || this.maxPerMinute <= 0) return true;
    const cutoff = now - 60000;
    this.timestamps = this.timestamps.filter(t => t > cutoff);
    if (this.timestamps.length >= this.maxPerMinute) return false;
    this.timestamps.push(now);
    return true;
  }
}

export class SyntheticQueryWorker {
  constructor() {
    this.running     = false;
    this.timer       = null;
    this._processing = false;
    this._drainResolve = null;
    this.limiter     = new RateLimiter(MEMORY_CONFIG.syntheticQuery?.maxCallsPerMinute ?? 20);
    this.stats       = { generated: 0, fragments: 0, skipped: 0, failed: 0 };
  }

  /** 설정 접근자. 런타임 변경을 반영하기 위해 매번 읽는다. */
  get cfg() {
    return MEMORY_CONFIG.syntheticQuery || {};
  }

  /**
   * 워커를 시작한다. 생성이 꺼져 있거나 임베딩이 없으면 기동하지 않는다.
   */
  async start() {
    if (this.cfg.enabled === false) {
      logInfo("[SyntheticQueryWorker] 비활성 설정으로 기동하지 않습니다 (MEMENTO_SYNTHETIC_QUERY_ENABLED=false)");
      return;
    }
    if (!EMBEDDING_ENABLED) {
      logWarn("[SyntheticQueryWorker] 임베딩이 설정되지 않아 워커를 비활성화합니다");
      return;
    }
    if (this.running) return;

    this.running = true;
    logInfo("[SyntheticQueryWorker] Worker started");
    this._poll();
  }

  /**
   * 워커를 중지하고 진행 중 배치 완료를 기다린다.
   *
   * @returns {Promise<void>}
   */
  stop() {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this._processing) {
      return new Promise(resolve => { this._drainResolve = resolve; });
    }
    return Promise.resolve();
  }

  /** intervalMs 간격 폴링 루프 */
  _poll() {
    if (!this.running) return;

    this._processing = true;
    this._processBatch()
      .catch(err => logWarn(`[SyntheticQueryWorker] batch failed: ${err.message}`))
      .finally(() => {
        this._processing = false;
        if (this._drainResolve) {
          this._drainResolve();
          this._drainResolve = null;
          return;
        }
        if (this.running) {
          this.timer = setTimeout(() => this._poll(), this.cfg.intervalMs ?? 5000);
        }
      });
  }

  /**
   * 큐에서 배치만큼 꺼내 처리한다. 큐가 비면 백필 수집기를 한 번 돌린다.
   *
   * @returns {Promise<number>} 처리한 파편 수
   */
  async _processBatch() {
    const batchSize = this.cfg.batchSize ?? 5;
    let   handled   = 0;

    for (let i = 0; i < batchSize; i++) {
      const job = await popFromQueue(this.cfg.queueKey);
      if (!job) break;
      await this._handleJob(job);
      handled++;
    }

    const fromQueue = handled;
    if (handled === 0) {
      handled = await this.backfill();
    }

    if (handled > 0) {
      logInfo(`[SyntheticQueryWorker] batch done: queue=${fromQueue} backfill=${handled - fromQueue} stats=${JSON.stringify(this.stats)}`);
    }
    return handled;
  }

  /**
   * 큐 항목 하나를 처리한다.
   *
   * @param {{fragmentId: string, content?: string, attempt?: number}} job
   * @returns {Promise<boolean>}
   */
  async _handleJob(job) {
    const fragmentId = job?.fragmentId;
    if (!fragmentId) return false;

    const row = await this._loadFragment(fragmentId);
    if (!row) {
      this.stats.skipped++;
      return false;
    }
    if (!isEligible(row, this.cfg)) {
      this.stats.skipped++;
      return false;
    }
    if (!this.limiter.tryAcquire()) {
      /** 상한에 걸리면 이번 회차는 건너뛴다. 백필이 나중에 회수한다. */
      this.stats.skipped++;
      return false;
    }

    return this._generateFor(row);
  }

  /**
   * 파편 하나에 대해 역질의를 생성하고 적재한다.
   *
   * @param {{id: string, content: string, key_id: string|null, agent_id: string, workspace: string|null}} row
   * @returns {Promise<boolean>}
   */
  async _generateFor(row) {
    try {
      const { queries } = await generateQueries(row.content, { timeoutMs: this.cfg.llmTimeoutMs });
      if (queries.length === 0) {
        this.stats.failed++;
        return false;
      }

      const vectors = await Promise.all(
        queries.map(q => generateEmbedding(prepareTextForEmbedding(q, 500)).catch(() => null))
      );

      let inserted = 0;
      for (let i = 0; i < queries.length; i++) {
        if (!vectors[i]) continue;
        await queryWithAgentVector(row.agent_id || "default",
          `INSERT INTO ${SCHEMA}.fragment_synthetic_query
             (fragment_id, query_text, embedding, key_id, agent_id, workspace)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (fragment_id, md5(query_text)) DO NOTHING`,
          [row.id, queries[i], JSON.stringify(vectors[i]), row.key_id ?? null, row.agent_id || "default", row.workspace ?? null],
          "write"
        );
        inserted++;
      }

      this.stats.generated += inserted;
      this.stats.fragments++;
      return inserted > 0;
    } catch (err) {
      this.stats.failed++;
      logWarn(`[SyntheticQueryWorker] 생성 실패 (${row.id}): ${err.message}`);
      return false;
    }
  }

  /**
   * 파편 본문과 스코프를 조회한다.
   *
   * @param {string} fragmentId
   * @returns {Promise<Object|null>}
   */
  async _loadFragment(fragmentId) {
    try {
      const { rows } = await queryWithAgentVector("system",
        `SELECT id, content, type, importance, key_id, agent_id, workspace
           FROM ${SCHEMA}.fragments
          WHERE id = $1 AND valid_to IS NULL`,
        [fragmentId]
      );
      return rows[0] ?? null;
    } catch (err) {
      logWarn(`[SyntheticQueryWorker] 파편 조회 실패 (${fragmentId}): ${err.message}`);
      return null;
    }
  }

  /**
   * 역질의가 없는 대상 파편을 회수해 생성한다.
   *
   * 큐 적재 실패분과 워커 정지 구간의 누락분이 여기서 복구된다.
   * EmbeddingWorker.processOrphanFragments와 같은 역할이다.
   *
   * @param {number} [limit]
   * @returns {Promise<number>} 처리한 파편 수
   */
  async backfill(limit = null) {
    const cfg   = this.cfg;
    const take  = limit ?? cfg.backfillBatch ?? 20;
    const types = Array.isArray(cfg.types) && cfg.types.length > 0 ? cfg.types : null;

    try {
      const params = [cfg.minImportance ?? 0.8, take];
      const typeClause = types ? ` AND f.type = ANY($3::text[])` : "";
      if (types) params.push(types);

      const { rows } = await queryWithAgentVector("system",
        `SELECT f.id, f.content, f.type, f.importance, f.key_id, f.agent_id, f.workspace
           FROM ${SCHEMA}.fragments f
          WHERE f.valid_to IS NULL
            AND f.embedding IS NOT NULL
            AND f.importance >= $1${typeClause}
            AND NOT EXISTS (
              SELECT 1 FROM ${SCHEMA}.fragment_synthetic_query q WHERE q.fragment_id = f.id
            )
          ORDER BY f.importance DESC, f.created_at DESC
          LIMIT $2`,
        params
      );

      let handled = 0;
      for (const row of rows) {
        if (!this.limiter.tryAcquire()) break;
        await this._generateFor(row);
        handled++;
      }
      return handled;
    } catch (err) {
      logWarn(`[SyntheticQueryWorker] backfill 실패: ${err.message}`);
      return 0;
    }
  }

  /**
   * 지정한 파편들에 대해 역질의를 생성한다.
   * 계측이나 수동 백필처럼 대상을 명시하고 싶을 때 쓴다.
   *
   * @param {string[]} fragmentIds
   * @returns {Promise<{processed: number, generated: number}>}
   */
  async generateForFragmentIds(fragmentIds) {
    if (!Array.isArray(fragmentIds) || fragmentIds.length === 0) {
      return { processed: 0, generated: 0 };
    }

    const before = this.stats.generated;
    let   processed = 0;

    try {
      const { rows } = await queryWithAgentVector("system",
        `SELECT id, content, type, importance, key_id, agent_id, workspace
           FROM ${SCHEMA}.fragments
          WHERE id = ANY($1) AND valid_to IS NULL`,
        [fragmentIds]
      );

      for (const row of rows) {
        await this._generateFor(row);
        processed++;
      }
    } catch (err) {
      logWarn(`[SyntheticQueryWorker] 지정 생성 실패: ${err.message}`);
    }

    return { processed, generated: this.stats.generated - before };
  }

  /**
   * 큐 적체량을 조회한다.
   *
   * @returns {Promise<number>}
   */
  async queueLength() {
    try {
      return await getQueueLength(this.cfg.queueKey);
    } catch {
      return 0;
    }
  }
}

/** 프로세스 단일 인스턴스 */
let _instance = null;

/**
 * 공용 워커 인스턴스를 반환한다.
 *
 * @returns {SyntheticQueryWorker}
 */
export function getSyntheticQueryWorker() {
  if (!_instance) _instance = new SyntheticQueryWorker();
  return _instance;
}
