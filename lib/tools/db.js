/**
 * 도구: 데이터베이스 조회
 *
 * 작성자: 최진호
 * 작성일: 2026-01-30
 * 수정일: 2026-02-13 (Phase 2: 연결 풀 최적화, Redis 캐싱)
 * 수정일: 2026-03-09 (DB 도구 핸들러/정의를 db-tools.js로 분리)
 * 수정일: 2026-04-27 (Phase 7: batch 전용 connection pool 분리)
 * 수정일: 2026-10-03 (잠금 문장을 앞세운 갱신 트랜잭션)
 */

import pg from "pg";
const { Pool } = pg;
import { readVectorForceIndex } from "../env-parse.js";

import {
  DB_HOST,
  DB_PORT,
  DB_NAME,
  DB_USER,
  DB_PASSWORD,
  DB_MAX_CONNECTIONS,
  DB_IDLE_TIMEOUT_MS,
  DB_CONN_TIMEOUT_MS,
  DB_BACKGROUND_MAX_CONNECTIONS,
  DB_BACKGROUND_WAIT_MAX_MS,
  buildSearchPath,
  envInt,
  DEFAULT_DB_STATEMENT_TIMEOUT_MS
} from "../config.js";

import { logInfo, logError } from "../logger.js";
import { SCHEMA } from "../memory/schema.js";
import { BackgroundGate, gatePool } from "./pool-gate.js";
import { withLockRetry } from "./lock-retry.js";

/** Primary DB 설정 */
const DB_CONFIG_PRIMARY = {
  host                   : DB_HOST,
  port                   : DB_PORT,
  database               : DB_NAME,
  user                   : DB_USER,
  password               : DB_PASSWORD,
  max                    : DB_MAX_CONNECTIONS,
  idleTimeoutMillis      : DB_IDLE_TIMEOUT_MS,
  connectionTimeoutMillis: DB_CONN_TIMEOUT_MS
};

/** 연결 풀 - Primary */
let poolPrimary = null;

/** 백그라운드 레인(스케줄러·워커)의 Primary 풀 점유 상한 게이트 */
const backgroundGate = new BackgroundGate({
  capacity : DB_BACKGROUND_MAX_CONNECTIONS,
  maxWaitMs: DB_BACKGROUND_WAIT_MAX_MS
});

function getPoolPrimary() {
  if (!poolPrimary) {
    backgroundGate.open();
    poolPrimary = gatePool(new Pool(DB_CONFIG_PRIMARY), backgroundGate);

    poolPrimary.on("error", (err) => {
      logError("[DB Pool Primary] Unexpected error: " + err.message, err);
    });

    poolPrimary.on("connect", (_client) => {
      logInfo(`[DB Pool Primary] Client connected (total: ${poolPrimary.totalCount}, idle: ${poolPrimary.idleCount})`);
    });

    logInfo(`[DB Pool Primary] Initialized with max ${DB_MAX_CONNECTIONS} connections (background cap ${DB_BACKGROUND_MAX_CONNECTIONS})`);
  }
  return poolPrimary;
}

/**
 * 외부 모듈에서 Primary 풀에 접근할 수 있도록 export
 */
export function getPrimaryPool() {
  return getPoolPrimary();
}

/** Batch 전용 연결 풀 싱글톤
 *
 * Phase 7: BatchRememberProcessor의 대용량 multi-row INSERT 트랜잭션이
 * Primary 풀 연결을 장시간 점유하여 동시 recall 요청이 starvation 되는 문제를 해소.
 * - max: primaryMax의 30% (최소 2) — batch 작업이 전체 풀을 독점 방지
 * - BATCH_DATABASE_URL env가 설정된 경우 별도 DB 인스턴스로 라우팅
 * - application_name='memento-mcp:batch': pg_stat_activity 분리 모니터링
 *
 * 호출측(BatchRememberProcessor)은 후속 PR에서 this._getPool() 분기에서
 * getBatchPool()을 우선 선택하도록 연결한다. (Team A 영역 충돌 회피)
 */
let poolBatch = null;

export function getBatchPool() {
  if (!poolBatch) {
    const primaryMax = DB_MAX_CONNECTIONS;
    const batchMax   = Math.max(2, Math.floor(primaryMax * 0.3));

    /** BATCH_DATABASE_URL이 있으면 별도 DB로 라우팅, 없으면 동일 DB 사용 */
    const batchUrl = process.env.BATCH_DATABASE_URL || null;

    const batchConfig = batchUrl
      ? {
          connectionString       : batchUrl,
          max                    : batchMax,
          idleTimeoutMillis      : DB_IDLE_TIMEOUT_MS,
          connectionTimeoutMillis: DB_CONN_TIMEOUT_MS,
          application_name       : "memento-mcp:batch"
        }
      : {
          host                   : DB_HOST,
          port                   : DB_PORT,
          database               : DB_NAME,
          user                   : DB_USER,
          password               : DB_PASSWORD,
          max                    : batchMax,
          idleTimeoutMillis      : DB_IDLE_TIMEOUT_MS,
          connectionTimeoutMillis: DB_CONN_TIMEOUT_MS,
          application_name       : "memento-mcp:batch"
        };

    poolBatch = new Pool(batchConfig);

    poolBatch.on("error", (err) => {
      logError("[DB Pool Batch] Unexpected error: " + err.message, err);
    });

    poolBatch.on("connect", (_client) => {
      logInfo(`[DB Pool Batch] Client connected (total: ${poolBatch.totalCount}, idle: ${poolBatch.idleCount})`);
    });

    logInfo(`[DB Pool Batch] Initialized with max ${batchMax} connections (${batchUrl ? "BATCH_DATABASE_URL" : "primary DB"})`);
  }
  return poolBatch;
}

function getPool() {
  return getPoolPrimary();
}

/**
 * Graceful shutdown - 모든 연결 종료
 */
export async function shutdownPool() {
  if (poolPrimary) {
    logInfo("[DB Pool Primary] Closing all connections...");
    backgroundGate.close();
    await poolPrimary.end();
    poolPrimary = null;
    logInfo("[DB Pool Primary] All connections closed");
  }
  if (poolBatch) {
    logInfo("[DB Pool Batch] Closing all connections...");
    await poolBatch.end();
    poolBatch = null;
    logInfo("[DB Pool Batch] All connections closed");
  }
}

/**
 * 연결 풀 상태 조회
 */
export function getPoolStats() {
  const stats = {
    primary   : { totalCount: 0, idleCount: 0, waitingCount: 0 },
    background: { active: backgroundGate.active, waiting: backgroundGate.waiting, capacity: backgroundGate.capacity },
    batch     : { totalCount: 0, idleCount: 0, waitingCount: 0 },
    totalCount: 0
  };

  if (poolPrimary) {
    stats.primary = {
      totalCount  : poolPrimary.totalCount,
      idleCount   : poolPrimary.idleCount,
      waitingCount: poolPrimary.waitingCount
    };
    stats.totalCount += poolPrimary.totalCount;
  }

  if (poolBatch) {
    stats.batch = {
      totalCount  : poolBatch.totalCount,
      idleCount   : poolBatch.idleCount,
      waitingCount: poolBatch.waitingCount
    };
    stats.totalCount += poolBatch.totalCount;
  }

  return stats;
}


/**
 * 에이전트 컨텍스트 + 벡터 타입 지원 쿼리 (agent_memory 전용)
 *
 * NOTE: SET LOCAL은 PostgreSQL에서 파라미터 바인딩($1)을 지원하지 않는다.
 * SET 명령은 GUC(Grand Unified Configuration) 시스템의 일부로,
 * prepared statement의 파라미터 바인딩 프로토콜과 별개로 동작한다.
 * safeAgent는 [^a-zA-Z0-9_\-] 패턴으로 정제하여 injection을 방지한다.
 *
 * opts.lock 을 주면 같은 트랜잭션에서 잠금 문장을 먼저 실행한다. 잠금 문장은 id 열을
 * 돌려주는 `SELECT id ... ORDER BY id FOR NO KEY UPDATE`(삭제는 FOR UPDATE)이고, sql 은
 * 잠근 id 배열을 $1 로, params 를 $2 부터 받는다. 잠근 행이 없으면 sql 을 실행하지 않는다.
 * 갱신 문장은 잠금이 끝난 뒤의 스냅숏으로 실행되므로 이미 잠근 최신 행 버전만 다루고
 * 다른 트랜잭션을 기다리지 않는다. 트랜잭션 전체는 lock.operation 이름으로
 * withLockRetry 를 거친다. 결과의 lockedIds 는 잠근 id 목록(id 오름차순)이다.
 * lock.lockTimeoutMs 를 주면 잠금 문장 앞에서 그 트랜잭션의 lock_timeout 을 건다.
 *
 * @param {string} agentId
 * @param {string} sql
 * @param {Array}  [params]
 * @param {Object|string} [opts]
 * @param {{operation: string, sql: string, params?: Array, lockTimeoutMs?: number}} [opts.lock]
 * @param {number} [opts.statementTimeoutMs] 이 트랜잭션의 statement_timeout(ms, 양의 정수일 때만)
 * @returns {Promise<import("pg").QueryResult & {lockedIds?: string[]}>}
 */
export async function queryWithAgentVector(agentId, sql, params = [], opts = {}) {
  const lock = typeof opts === "object" && opts !== null ? opts.lock : undefined;
  if (!lock) {
    return runAgentTransaction(agentId, opts, client => client.query(sql, params));
  }
  return withLockRetry(lock.operation, () => runAgentTransaction(agentId, opts, async (client) => {
    if (lock.lockTimeoutMs > 0) await client.query(`SET LOCAL lock_timeout = ${Math.floor(lock.lockTimeoutMs)}`);
    const locked = await client.query(lock.sql, lock.params ?? []);
    const ids    = locked.rows.map(r => r.id);
    if (ids.length === 0) return { rows: [], rowCount: 0, lockedIds: ids };
    const result     = await client.query(sql, [ids, ...params]);
    result.lockedIds = ids;
    return result;
  }));
}

/**
 * 에이전트 컨텍스트를 설정한 트랜잭션 하나에서 body(client)를 실행하고 커밋한다.
 * 실패하면 되돌리고 오류를 그대로 던진다.
 *
 * @template T
 * @param {string} agentId
 * @param {Object|string} opts queryWithAgentVector 의 opts
 * @param {(client: import("pg").PoolClient) => Promise<T>} body
 * @returns {Promise<T>}
 */
async function runAgentTransaction(agentId, opts, body) {
  const pool      = getPool();
  const client    = await pool.connect();
  const safeAgent = String(agentId || "default").replace(/[^a-zA-Z0-9_-]/g, "");
  try {
    await client.query(buildSearchPath(SCHEMA));
    await client.query("BEGIN");
    await client.query(`SET LOCAL app.current_agent_id = '${safeAgent}'`);
    /**
     * API 키 격리 축을 DB 세션에 알린다.
     *
     * 현재 행 수준 보안 정책은 agent_id만 다루고 key_id를 다루지 않는다. 키
     * 격리를 DB가 함께 지켜주려면 어떤 키로 들어온 질의인지 알아야 한다.
     *
     * 값을 주지 않으면 빈 문자열로 둔다. 정책은 빈 값을 "키 범위 없음"으로 읽고
     * 종전과 같이 agent_id만 본다. 따라서 이 값을 넘기지 않는 기존 호출부의
     * 동작은 바뀌지 않는다.
     */
    const rawKeyId  = typeof opts === "object" && opts !== null ? opts.keyId : null;
    const safeKeyId = rawKeyId == null ? "" : String(rawKeyId).replace(/[^a-zA-Z0-9_-]/g, "");
    await client.query(`SET LOCAL app.current_key_id = '${safeKeyId}'`);
    /**
     * 사용자 요청 경로의 질의 시간 상한.
     *
     * 폭주하는 질의 하나가 커넥션을 무기한 점유하면 풀이 마르고 실패가 번진다.
     * 실측 기준 recall p50이 240ms, 임베딩 콜드스타트를 포함한 최댓값이 약 5초다.
     *
     * 통합·정리·백필처럼 오래 도는 유지보수 작업은 system 또는 admin 에이전트로
     * 들어오며 상한을 걸지 않는다. 상한이 배치를 끊으면 부분 적용 상태가 남는다.
     */
    if (safeAgent !== "system" && safeAgent !== "admin") {
      const stmtTimeout = envInt("DB_STATEMENT_TIMEOUT_MS", DEFAULT_DB_STATEMENT_TIMEOUT_MS, { min: 0 });
      if (stmtTimeout > 0) {
        await client.query(`SET LOCAL statement_timeout = ${Math.floor(stmtTimeout)}`);
      }
    }
    /** 호출자가 질의 하나의 시간 상한을 따로 줄 때(본문 어휘 채널 등). 위 상한보다 우선한다. */
    const ownTimeout = typeof opts === "object" && opts !== null ? opts.statementTimeoutMs : undefined;
    if (Number.isInteger(ownTimeout) && ownTimeout > 0) {
      await client.query(`SET LOCAL statement_timeout = ${ownTimeout}`);
    }
    await client.query("SET LOCAL hnsw.ef_search = 80");
    /**
     * 벡터검색 전용 planner 힌트: 호출자가 opts.forceVectorIndex=true를 줄 때만 적용.
     * 이 함수는 GC/CTE/DML 등 60여 비-벡터 쿼리도 거치므로 전역 적용하면 그들
     * planner를 왜곡한다. seqscan뿐 아니라 bitmapscan도 꺼야 한다: valid_to/agent_id
     * 필터가 붙으면 planner가 HNSW 대신 b-tree bitmap scan으로 새어(308ms→104ms)
     * HNSW index scan(7ms)을 회피하기 때문이다. 두 스캔을 모두 차단하면 fragments
     * ORDER BY embedding<=>v LIMIT 경로가 HNSW를 타 308ms→7ms로 단축된다.
     */
    if (opts.forceVectorIndex && readVectorForceIndex(process.env) === "on") {
      await client.query("SET LOCAL enable_seqscan = off");
      await client.query("SET LOCAL enable_bitmapscan = off");
      await client.query("SET LOCAL hnsw.iterative_scan = relaxed_order");
    }
    const result = await body(client);
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
 * BEGIN/COMMIT/ROLLBACK/release 보일러플레이트를 캡슐화한 트랜잭션 실행기.
 *
 * @param {import("pg").Pool} pool
 * @param {(client: import("pg").PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* 원 에러 보존 */ }
    throw err;
  } finally {
    client.release();
  }
}
