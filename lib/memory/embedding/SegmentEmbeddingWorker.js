/**
 * SegmentEmbeddingWorker - 긴 파편 본문의 구간별 임베딩 생성 워커
 *
 * 작성자: 최진호
 * 작성일: 2026-10-09
 *
 * 부모 파편의 임베딩이 끝나면(`embedding_ready` 이벤트) 전용 큐에 파편 id가 들어오고, 이 워커가 본문을 구간으로 나눠
 * 임베딩한 뒤 fragment_segment에 적재한다. 큐 적재가 유실되거나 워커가 멈췄던 구간은 복구 스캔이 회수한다.
 * 복구 스캔은 최근 생성분만 본다(created_at 인덱스). 과거 전체는 scripts/backfill-fragment-segments.js가 맡는다.
 *
 * 쓰기 규칙:
 *  - 임베딩 호출은 DB 트랜잭션 밖에서 한다.
 *  - 저장 트랜잭션에서 부모 행을 FOR KEY SHARE로 잡고 content_hash와 유효 상태를 다시 확인한다. 임베딩을 만드는 사이 본문이
 *    바뀌었으면 아무것도 쓰지 않고 폐기한다(낡은 작업이 최신 구간을 지우는 일이 없다).
 *  - 한 조각의 구간은 삭제 후 삽입을 한 트랜잭션으로 한다. 부분 적재가 없다.
 *  - 실패는 프로세스 안에서 지수 백오프로 재시도하고 조각당 maxAttempts에서 멈춘다(독약 파편이 배치를 독점하지 않는다).
 */

import { popFromQueue, getQueueLength }       from "../../redis.js";
import { generateBatchEmbeddings, prepareTextForEmbedding, vectorToSql, EMBEDDING_ENABLED, EMBEDDING_DIMENSIONS } from "../../tools/embedding.js";
import { getPrimaryPool, withTransaction }    from "../../tools/db.js";
import { MEMORY_CONFIG }                      from "../../../config/memory.js";
import { logInfo, logWarn }                   from "../../logger.js";
import { PollingWorker }                      from "../workers/PollingWorker.js";
import { SCHEMA }                             from "../schema.js";
import { RateLimiter }                        from "./SyntheticQueryWorker.js";
import { splitIntoSegments, segmentVersion }  from "./segmenter.js";

const BACKOFF_BASE_MS = 30_000;

/**
 * 구간을 만들 대상인지 판정한다. 길이는 코드 포인트 단위다(SQL char_length와 같다).
 *
 * @param {{content?: string, valid_to?: any}} row
 * @param {{minChars: number}} cfg
 * @returns {boolean}
 */
export function isSegmentEligible(row, cfg) {
  if (!row || row.valid_to != null) return false;
  if (typeof row.content !== "string") return false;
  return Array.from(row.content).length > cfg.minChars;
}

/**
 * 임베딩 응답을 검증한다: 개수, 차원, 유한 값.
 *
 * @param {number[][]} vectors
 * @param {number} expected
 * @param {number} dims
 * @returns {boolean}
 */
export function validVectors(vectors, expected, dims) {
  if (!Array.isArray(vectors) || vectors.length !== expected) return false;
  return vectors.every(v => Array.isArray(v) && v.length === dims && v.every(Number.isFinite));
}

export class SegmentEmbeddingWorker extends PollingWorker {
  /**
   * @param {Object} [deps] 시험용 주입
   */
  constructor(deps = {}) {
    super({
      name      : "SegmentEmbeddingWorker",
      intervalMs: MEMORY_CONFIG.segmentEmbedding?.intervalMs ?? 3000,
      idleOnlyDelay: true
    });
    this.deps = {
      pool    : deps.pool    ?? (() => getPrimaryPool()),
      embed   : deps.embed   ?? generateBatchEmbeddings,
      prepare : deps.prepare ?? prepareTextForEmbedding,
      pop     : deps.pop     ?? popFromQueue,
      now     : deps.now     ?? (() => Date.now()),
      dims    : deps.dims    ?? EMBEDDING_DIMENSIONS,
      cfg     : deps.cfg     ?? null
    };
    this.limiter       = new RateLimiter(this.cfg.maxSegmentsPerMinute ?? 600);
    this.failures      = new Map();
    this.stats         = { fragments: 0, segments: 0, skipped: 0, stale: 0, failed: 0, recovered: 0 };
    this._lastRecovery = 0;
  }

  /** 설정 접근자. 런타임 변경을 반영하기 위해 매번 읽는다. */
  get cfg() {
    return this.deps?.cfg ?? MEMORY_CONFIG.segmentEmbedding ?? {};
  }

  get version() {
    return segmentVersion(this.cfg);
  }

  _shouldStart() {
    if (this.cfg.enabled !== true) {
      logInfo("[SegmentEmbeddingWorker] 비활성 설정으로 기동하지 않습니다 (MEMENTO_SEGMENT_EMBEDDING_ENABLED)");
      return false;
    }
    if (!EMBEDDING_ENABLED) {
      logWarn("[SegmentEmbeddingWorker] 임베딩이 설정되지 않아 워커를 비활성화합니다");
      return false;
    }
    return true;
  }

  /**
   * 큐에서 배치만큼 꺼내 처리한다. 큐가 비고 복구 주기가 지났으면 복구 스캔을 한 번 돌린다.
   *
   * @returns {Promise<number>} 처리한 파편 수
   */
  async _processBatch() {
    const batchSize = this.cfg.batchSize ?? 10;
    let   handled   = 0;

    const ids = [];
    for (let i = 0; i < batchSize; i++) {
      const job = await this.deps.pop(this.cfg.queueKey);
      if (!job) break;
      ids.push(job.fragmentId);
    }
    handled += await this._processMany(ids);

    if (handled === 0 && this.deps.now() - this._lastRecovery >= (this.cfg.recoveryIntervalMs ?? 600000)) {
      this._lastRecovery = this.deps.now();
      const recovered = await this.recover();
      this.stats.recovered += recovered;
      handled += recovered;
    }

    if (handled > 0) logInfo(`[SegmentEmbeddingWorker] batch done: ${handled} stats=${JSON.stringify(this.stats)}`);
    return handled;
  }

  /**
   * 파편 여러 개를 cfg.concurrency 개씩 동시에 처리한다. 임베딩 호출이 대부분의 시간을 쓰므로
   * 직렬 처리는 임베딩 백엔드가 놀아도 처리량이 막힌다.
   *
   * @param {string[]} ids
   * @returns {Promise<number>} 구간을 적재한 파편 수
   */
  async _processMany(ids) {
    const width = Math.max(1, Math.min(this.cfg.concurrency ?? 1, ids.length || 1));
    let next = 0, handled = 0;
    const lane = async () => {
      while (next < ids.length) {
        const id = ids[next++];
        if (await this.processFragment(id)) handled++;
      }
    };
    await Promise.all(Array.from({ length: width }, lane));
    return handled;
  }

  /** 실패 백오프 중이거나 재시도 상한을 넘었으면 건너뛴다 */
  _blocked(id) {
    const f = this.failures.get(id);
    if (!f) return false;
    if (f.attempts >= (this.cfg.maxAttempts ?? 3)) return true;
    return this.deps.now() < f.nextAt;
  }

  _recordFailure(id) {
    const attempts = (this.failures.get(id)?.attempts ?? 0) + 1;
    this.failures.set(id, { attempts, nextAt: this.deps.now() + BACKOFF_BASE_MS * 2 ** (attempts - 1) });
    this.stats.failed++;
  }

  /**
   * 파편 하나의 구간을 만든다.
   *
   * @param {string} fragmentId
   * @returns {Promise<boolean>} 구간을 적재했으면 true
   */
  async processFragment(fragmentId) {
    if (!fragmentId || this._blocked(fragmentId)) { this.stats.skipped++; return false; }
    const pool = this.deps.pool();
    if (!pool) return false;

    try {
      const { rows } = await pool.query(
        `SELECT id, content, content_hash, valid_to FROM ${SCHEMA}.fragments WHERE id = $1`, [fragmentId]);
      const row = rows[0];
      if (!isSegmentEligible(row, this.cfg)) { this.stats.skipped++; return false; }

      const segs = splitIntoSegments(row.content, this.cfg);
      const texts = [], kept = [];
      for (const s of segs) {
        const t = this.deps.prepare(s.text, 500);
        if (t && t.trim()) { texts.push(t); kept.push(s); }
      }
      if (kept.length === 0) { this.stats.skipped++; return false; }
      if (!this.limiter.tryAcquire()) { this.stats.skipped++; return false; }

      const vectors = await this.deps.embed(texts);
      if (!validVectors(vectors, kept.length, this.deps.dims)) throw new Error("임베딩 응답 검증 실패(개수/차원/유한값)");

      const stored = await this._persist(pool, row, kept, vectors);
      if (!stored) { this.stats.stale++; return false; }
      this.failures.delete(fragmentId);
      this.stats.fragments++;
      this.stats.segments += kept.length;
      return true;
    } catch (err) {
      this._recordFailure(fragmentId);
      logWarn(`[SegmentEmbeddingWorker] 생성 실패 (${fragmentId}): ${err.message}`);
      return false;
    }
  }

  /**
   * 한 트랜잭션에서 부모를 잡고 해시를 재확인한 뒤 기존 구간을 지우고 새 구간을 넣는다.
   *
   * @returns {Promise<boolean>} 저장했으면 true, 그 사이 본문이 바뀌었으면 false
   */
  async _persist(pool, row, segs, vectors) {
    const version = this.version;
    return withTransaction(pool, async client => {
      await client.query("SELECT set_config('app.current_agent_id', 'system', true)");
      const cur = await client.query(
        `SELECT id FROM ${SCHEMA}.fragments
          WHERE id = $1 AND content_hash = $2 AND valid_to IS NULL
          FOR KEY SHARE`,
        [row.id, row.content_hash]);
      if (cur.rowCount === 0) return false;

      await client.query(`DELETE FROM ${SCHEMA}.fragment_segment WHERE fragment_id = $1`, [row.id]);

      const params = [row.id, row.content_hash, version];
      const values = segs.map((s, i) => {
        params.push(s.idx, s.start, s.end, vectorToSql(vectors[i]));
        const b = 4 + i * 4;
        return `($1, $${b}, $${b + 1}, $${b + 2}, $${b + 3}::vector, $2, $3)`;
      });
      await client.query(
        `INSERT INTO ${SCHEMA}.fragment_segment
           (fragment_id, seg_idx, seg_start, seg_end, embedding, source_content_hash, seg_version)
         VALUES ${values.join(", ")}`,
        params);
      return true;
    });
  }

  /**
   * 최근 생성분 중 구간이 없는 대상 파편을 회수해 생성한다(큐 유실과 정지 구간 복구).
   * 과거 전체는 scripts/backfill-fragment-segments.js를 쓴다.
   *
   * @param {number} [limit]
   * @param {{sinceHours?: number}} [opts]
   * @returns {Promise<number>} 적재한 파편 수
   */
  async recover(limit = null, opts = {}) {
    const cfg   = this.cfg;
    const take  = limit ?? cfg.recoveryBatch ?? 50;
    const since = opts.sinceHours ?? cfg.recoveryWindowHours ?? 48;
    const pool  = this.deps.pool();
    if (!pool) return 0;

    try {
      const { rows } = await pool.query(
        `SELECT f.id
           FROM ${SCHEMA}.fragments f
          WHERE f.valid_to IS NULL
            AND f.embedding IS NOT NULL
            AND f.created_at > NOW() - make_interval(hours => $1)
            AND char_length(f.content) > $2
            AND NOT EXISTS (
              SELECT 1 FROM ${SCHEMA}.fragment_segment s
               WHERE s.fragment_id = f.id
                 AND s.source_content_hash = f.content_hash
                 AND s.seg_version = $3
                 AND s.embedding IS NOT NULL
            )
          ORDER BY f.created_at DESC
          LIMIT $4`,
        [since, cfg.minChars ?? 400, this.version, take]);

      return await this._processMany(rows.map(r => r.id));
    } catch (err) {
      logWarn(`[SegmentEmbeddingWorker] 복구 스캔 실패: ${err.message}`);
      return 0;
    }
  }

  /**
   * 임베딩이 끝난 파편을 큐에 올린다(scheduler가 embedding_ready 이벤트에서 호출).
   * 대상 여부는 워커가 읽을 때 판정한다. 여기서는 본문을 읽지 않는다.
   *
   * @param {string} fragmentId
   * @param {(queue: string, data: Object) => Promise<any>} push
   */
  async enqueue(fragmentId, push) {
    if (!fragmentId || this.cfg.enabled !== true) return false;
    await push(this.cfg.queueKey, { fragmentId });
    return true;
  }

  async queueLength() {
    try {
      return await getQueueLength(this.cfg.queueKey);
    } catch {
      return 0;
    }
  }
}

/**
 * 워커를 시작하고, 부모 임베딩 완료 이벤트(embedding_ready)를 구간 큐 적재에 연결한다.
 * scheduler가 한 번 호출한다. 설정이 꺼져 있으면 아무 일도 하지 않는다.
 *
 * @param {import("node:events").EventEmitter} [embeddingWorker] embedding_ready를 발행하는 임베딩 워커
 * @returns {Promise<void>}
 */
export async function startSegmentEmbedding(embeddingWorker = null) {
  const worker = getSegmentEmbeddingWorker();
  if (worker.cfg.enabled !== true) return;
  if (embeddingWorker) {
    const { pushToQueue } = await import("../../redis.js");
    embeddingWorker.on("embedding_ready", ({ fragmentId }) => {
      worker.enqueue(fragmentId, pushToQueue).catch(err => logWarn(`[SegmentEmbeddingWorker] 큐 적재 실패: ${err.message}`));
    });
  }
  await worker.start();
}

/** 프로세스 단일 인스턴스 */
let _instance = null;

/**
 * 공용 워커 인스턴스를 반환한다.
 *
 * @returns {SegmentEmbeddingWorker}
 */
export function getSegmentEmbeddingWorker() {
  if (!_instance) _instance = new SegmentEmbeddingWorker();
  return _instance;
}
