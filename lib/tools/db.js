/**
 * 도구: 데이터베이스 조회
 *
 * 작성자: 최진호
 * 작성일: 2026-01-30
 * 수정일: 2026-02-13 (Phase 2: 연결 풀 최적화, Redis 캐싱)
 * 수정일: 2026-03-09 (DB 도구 핸들러/정의를 db-tools.js로 분리)
 * 수정일: 2026-04-27 (Phase 7: batch 전용 connection pool 분리)
 */

import pg from "pg";
const { Pool } = pg;

import {
  DB_HOST,
  DB_PORT,
  DB_NAME,
  DB_USER,
  DB_PASSWORD,
  DB_MAX_CONNECTIONS,
  DB_IDLE_TIMEOUT_MS,
  DB_CONN_TIMEOUT_MS,
  buildSearchPath
} from "../config.js";

import { logInfo, logError } from "../logger.js";

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

function getPoolPrimary() {
  if (!poolPrimary) {
    poolPrimary = new Pool(DB_CONFIG_PRIMARY);

    poolPrimary.on("error", (err) => {
      logError("[DB Pool Primary] Unexpected error: " + err.message, err);
    });

    poolPrimary.on("connect", (_client) => {
      logInfo(`[DB Pool Primary] Client connected (total: ${poolPrimary.totalCount}, idle: ${poolPrimary.idleCount})`);
    });

    logInfo(`[DB Pool Primary] Initialized with max ${DB_MAX_CONNECTIONS} connections`);
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
 */
export async function queryWithAgentVector(agentId, sql, params = [], options = {}) {
  const pool      = getPool();
  const client    = await pool.connect();
  const safeAgent = String(agentId || "default").replace(/[^a-zA-Z0-9_-]/g, "");
  const hnswEfSearch = clampInteger(options?.hnswEfSearch, 1, 1000, 80);
  const statementTimeoutMs = clampInteger(options?.statementTimeoutMs, 0, 120000, 0);
  try {
    const SCHEMA  = "agent_memory";
    await client.query(buildSearchPath(SCHEMA));
    await client.query("BEGIN");
    await client.query(`SET LOCAL app.current_agent_id = '${safeAgent}'`);
    await client.query(`SET LOCAL hnsw.ef_search = ${hnswEfSearch}`);
    if (statementTimeoutMs > 0) {
      await client.query(`SET LOCAL statement_timeout = ${statementTimeoutMs}`);
    }
    const result = await client.query(sql, params);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

/** 하위 호환 re-export — 신규 코드는 lib/tools/db-tools.js 직접 import 권장 */
export {
  tool_dbQuery, tool_dbTables, tool_dbSchema, tool_dbCount, tool_dbQueryByDate,
  dbQueryDefinition, dbTablesDefinition, dbSchemaDefinition,
  dbCountDefinition, dbQueryByDateDefinition
} from "./db-tools.js";
