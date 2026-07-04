/**
 * GET /health + GET /metrics 핸들러
 *
 * 작성자: 최진호
 * 작성일: 2026-04-04
 */

import { ACCESS_KEY, REDIS_ENABLED } from "../config.js";
import { register as metricsRegister, recordHttpRequest } from "../metrics.js";
import { sendJSON } from "../compression.js";
import { getSessionCounts } from "../sessions.js";
import { validateMasterKey } from "../auth.js";
import { logError } from "../logger.js";
import { getPrimaryPool, getPoolStats } from "../tools/db.js";
import { redisClient } from "../redis.js";
import { getMemoryEvaluator } from "../memory/signals/MemoryEvaluator.js";
import { workerRefs } from "./_common.js";

/**
 * GET /health
 * 비인증 요청 시 상태만 반환, 인증 시 상세 정보 포함
 *
 * 응답 구조 (인증 시):
 * - status: "healthy" | "degraded" | "unhealthy"
 * - services.database: DB 연결 + 응답 시간
 * - services.redis: Redis PING 또는 disabled
 * - services.pgvector: pg_extension 조회
 * - workers: embedding, evaluator, consolidator 상태
 */
export async function handleHealth(req, res, startTime) {
  const isAuthenticated = !ACCESS_KEY || validateMasterKey(req);

  /** DB 상태 확인 + 응답 시간 측정 */
  let dbHealthy    = true;
  let dbLatencyMs  = 0;
  let poolStats    = null;
  try {
    const pool  = getPrimaryPool();
    const t0    = Date.now();
    await pool.query("SELECT 1");
    dbLatencyMs = Date.now() - t0;
    if (isAuthenticated) poolStats = getPoolStats();
  } catch {
    dbHealthy = false;
  }

  /** Redis 상태 확인 + 응답 시간 측정 */
  let redisStatus    = "disabled";
  let redisLatencyMs = null;
  let redisError     = null;
  if (REDIS_ENABLED) {
    try {
      if (redisClient && redisClient.status !== "stub") {
        const t0 = Date.now();
        await redisClient.ping();
        redisLatencyMs = Date.now() - t0;
        redisStatus    = "up";
      } else {
        redisStatus = "down";
        redisError  = "Not connected";
      }
    } catch (err) {
      redisStatus = "down";
      redisError  = err.message;
    }
  }

  /** pgvector 확인 */
  let pgvectorStatus  = "unknown";
  let pgvectorVersion = null;
  if (dbHealthy) {
    try {
      const pool   = getPrimaryPool();
      const result = await pool.query("SELECT extversion FROM pg_extension WHERE extname = 'vector'");
      if (result.rows.length > 0) {
        pgvectorStatus  = "up";
        pgvectorVersion = result.rows[0].extversion;
      } else {
        pgvectorStatus = "not_installed";
      }
    } catch {
      pgvectorStatus = "unknown";
    }
  }

  /** 전체 상태 판정 */
  let status;
  if (!dbHealthy)              status = "unhealthy";
  else if (redisStatus === "down") status = "degraded";
  else                         status = "healthy";

  const statusCode = status === "unhealthy" ? 503 : 200;

  /** 비인증 — 최소 응답 */
  if (!isAuthenticated) {
    await sendJSON(res, statusCode, { status, timestamp: new Date().toISOString() }, req);
    const duration = Number(process.hrtime.bigint() - startTime) / 1e9;
    recordHttpRequest(req.method, "/health", statusCode, duration);
    return;
  }

  /** 워커 상태 수집 */
  let embeddingRunning  = "unknown";
  let evaluatorRunning  = "unknown";

  try {
    const ew = workerRefs.embeddingWorkerRef?.current;
    if (ew) embeddingRunning = !!ew.running;
  } catch { /* 접근 불가 시 unknown 유지 */ }

  try {
    const ev = getMemoryEvaluator();
    if (ev) evaluatorRunning = !!ev.running;
  } catch { /* 접근 불가 시 unknown 유지 */ }

  /** 인증된 요청 — 상세 정보 포함 */
  const health = {
    status,
    timestamp: new Date().toISOString(),
    uptime:    process.uptime(),
    pid:       process.pid,
    workerId:  process.env.WORKER_ID || "single",
    memory:    process.memoryUsage(),
    services:  {
      database: dbHealthy
        ? { status: "up", latency_ms: dbLatencyMs, pool: poolStats }
        : { status: "down", error: "Connection failed" },
      redis: redisStatus === "disabled"
        ? { status: "disabled" }
        : redisStatus === "up"
          ? { status: "up", latency_ms: redisLatencyMs }
          : { status: "down", error: redisError },
      pgvector: pgvectorVersion
        ? { status: pgvectorStatus, version: pgvectorVersion }
        : { status: pgvectorStatus }
    },
    workers: {
      embedding:    { running: embeddingRunning },
      evaluator:    { running: evaluatorRunning },
      consolidator: { last_run: workerRefs.lastConsolidateRun || null }
    },
    checks: {}
  };

  /** 하위 호환: checks 필드 유지 */
  health.checks.database = health.services.database;
  health.checks.redis    = health.services.redis;

  if (redisStatus === "down") {
    health.warnings = health.warnings || [];
    health.warnings.push("Redis unavailable — L1 cache and working memory disabled");
  }

  const _sc = getSessionCounts();
  health.checks.sessions = {
    streamable: _sc.streamable,
    legacy:     _sc.legacy,
    total:      _sc.total
  };

  await sendJSON(res, statusCode, health, req);

  const duration = Number(process.hrtime.bigint() - startTime) / 1e9;
  recordHttpRequest(req.method, "/health", statusCode, duration);
}

/**
 * GET /metrics
 * ACCESS_KEY 설정 시 마스터 키 인증 필수
 */
export async function handleMetrics(req, res, startTime) {
  if (ACCESS_KEY && !validateMasterKey(req)) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "Unauthorized" }));
    const duration = Number(process.hrtime.bigint() - startTime) / 1e9;
    recordHttpRequest(req.method, "/metrics", 401, duration);
    return;
  }

  try {
    res.statusCode = 200;
    res.setHeader("Content-Type", metricsRegister.contentType);
    res.end(await metricsRegister.metrics());

    const duration = Number(process.hrtime.bigint() - startTime) / 1e9;
    recordHttpRequest(req.method, "/metrics", 200, duration);
  } catch (err) {
    logError("[Metrics] Error generating metrics:", err);
    res.statusCode = 500;
    res.end("Internal Server Error");
  }
}
