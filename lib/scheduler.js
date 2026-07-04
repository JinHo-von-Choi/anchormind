/**
 * 주기 작업 스케줄러 — 서버 시작 후 실행되는 모든 setInterval 작업 관리
 *
 * 작성자: 최진호
 * 작성일: 2026-03-12
 */

import { LOG_DIR } from "./config.js";
import { MEMORY_CONFIG } from "../config/memory.js";
import { logInfo, logWarn, logError, logDebug } from "./logger.js";
import { saveAccessStats } from "./tools/index.js";
import { recordConsolidateRun } from "./http-handlers.js";
import { cleanupExpiredSessions, getSessionCounts } from "./sessions.js";
import { cleanupExpiredOAuthData } from "./oauth.js";
import { updateSessionCounts, recordBatchPoolStats } from "./metrics.js";
import { MemoryManager } from "./memory/MemoryManager.js";
import { getMemoryEvaluator } from "./memory/signals/MemoryEvaluator.js";
import { getBatchRememberWorker } from "./memory/write/BatchRememberWorker.js";
import { refreshUtilityBaseline } from "./memory/consolidate/UtilityBaseline.js";
import { getFragmentIndex } from "./memory/FragmentIndex.js";
import { getPrimaryPool, getBatchPool } from "./tools/db.js";
import { getSchedulerRegistry } from "./scheduler-registry.js";

/** 마지막 컨솔리데이션 결과 (admin /stats에서 노출) */
let lastConsolidation = null;

/**
 * schema-fit gate 평가 — DB 상태 3개 지표를 COUNT로 조회하여 실행 여부를 반환한다.
 *
 * 작성자: 최진호
 * 수정일: 2026-05-19
 *
 * @param {import("pg").Pool} pool
 * @param {{ pendingCaseFragmentsMin: number, recentRelatedLinksMin: number, fragmentsSinceLastRunMin: number, mode: string }} cfg
 * @param {string|null} lastRunTimestamp — 마지막 consolidation 완료 시각 (ISO 8601). null이면 epoch 사용.
 * @returns {Promise<boolean>} true면 실행, false면 다음 tick으로 deferred
 */
async function evaluateSchemaFitGate(pool, cfg, lastRunTimestamp) {
  if (cfg.mode === "off") return true;

  const epoch = lastRunTimestamp ?? "1970-01-01T00:00:00Z";

  /** (a) 같은 caseId 미해결 fragment 중 가장 누적이 많은 caseId의 건수 */
  const caseRes = await pool.query(
    `SELECT MAX(cnt) AS max_cnt FROM (
       SELECT COUNT(*) AS cnt
       FROM   fragments
       WHERE  case_id IS NOT NULL
         AND  (resolution_status IS NULL OR resolution_status = 'open')
       GROUP  BY case_id
     ) sub`
  );
  const pendingCaseMax = parseInt(caseRes.rows[0]?.max_cnt ?? 0, 10);

  /** (b) 최근 6h 내 생성된 related 링크 수 */
  const linkRes = await pool.query(
    `SELECT COUNT(*) AS cnt
     FROM   fragment_links
     WHERE  created_at > NOW() - INTERVAL '6 hours'
       AND  relation_type = 'related'`
  );
  const recentRelated = parseInt(linkRes.rows[0]?.cnt ?? 0, 10);

  /** (c) 마지막 consolidation 이후 INSERT된 fragment 수 */
  const fragRes = await pool.query(
    `SELECT COUNT(*) AS cnt FROM fragments WHERE created_at > $1`,
    [epoch]
  );
  const fragsSinceRun = parseInt(fragRes.rows[0]?.cnt ?? 0, 10);

  const condA = pendingCaseMax >= cfg.pendingCaseFragmentsMin;
  const condB = recentRelated  >= cfg.recentRelatedLinksMin;
  const condC = fragsSinceRun  >= cfg.fragmentsSinceLastRunMin;

  if (cfg.mode === "all") {
    return condA && condB && condC;
  }
  /** mode === "any" */
  return condA || condB || condC;
}

/**
 * 마지막 컨솔리데이션 결과를 반환한다.
 * @returns {{ timestamp: string, stages: Array, ...}|null}
 */
export function getLastConsolidation() { return lastConsolidation; }

/**
 * 모든 주기 작업을 시작한다.
 * @param {object} opts
 * @param {object|null} opts.globalEmbeddingWorkerRef - { current: EmbeddingWorker|null } 참조 객체
 */
export function startSchedulers({ globalEmbeddingWorkerRef }) {
  /** 세션 정리 (5분) */
  setInterval(cleanupExpiredSessions, 5 * 60 * 1000);
  setInterval(cleanupExpiredOAuthData, 5 * 60 * 1000);
  logInfo("Session cleanup: Running every 5 minutes");

  /** 세션 수 메트릭 업데이트 (1분) */
  setInterval(() => {
    const { streamable: _ss, legacy: _ls } = getSessionCounts();
    updateSessionCounts(_ss, _ls);
  }, 60 * 1000);
  logInfo("Metrics: Session counts updated every minute");

  /** 배치 풀 메트릭 수집 (1분) */
  setInterval(() => {
    try {
      const bp = getBatchPool();
      recordBatchPoolStats({
        totalCount  : bp.totalCount,
        idleCount   : bp.idleCount,
        waitingCount: bp.waitingCount,
      });
    } catch (err) {
      logWarn(`[BatchPoolMetrics] stats collection failed: ${err.message}`);
    }
  }, 60 * 1000);
  logInfo("Metrics: Batch pool stats updated every minute");

  /** 접근 통계 저장 (10분) */
  setInterval(() => saveAccessStats(LOG_DIR), 10 * 60 * 1000);
  logInfo("Access stats: Saving every 10 minutes");

  /** 기억 시스템 컨솔리데이션 (기본 6시간). ENV 처리는 config/memory.js로 단일화. */
  const CONSOLIDATE_MS = MEMORY_CONFIG.consolidateIntervalMs;
  let consolidateTickActive = false;
  setInterval(async () => {
    if (consolidateTickActive) {
      logWarn("[Consolidate] previous scheduled run still active; skipping tick");
      return;
    }

    consolidateTickActive = true;
    const reg = getSchedulerRegistry();
    try {
      /** schema-fit gate: 조건 미충족 시 이번 tick 건너뜀 */
      const gateCfg = MEMORY_CONFIG.consolidate?.schemaFit;
      if (gateCfg) {
        const pass = await evaluateSchemaFitGate(
          getPrimaryPool(),
          gateCfg,
          lastConsolidation?.timestamp ?? null
        ).catch(err => {
          logWarn(`[Consolidate] schema-fit gate evaluation failed (pass through): ${err.message}`);
          return true; // gate 오류 시 안전하게 통과
        });
        if (!pass) {
          logInfo("[Consolidate] schema-fit gate not met; deferring to next tick");
          consolidateTickActive = false;
          return;
        }
      }

      const mm     = MemoryManager.getInstance();
      const result = await mm.consolidate();
      lastConsolidation = { timestamp: new Date().toISOString(), ...result };
      logInfo(`[Consolidate] done: expired=${result.expiredDeleted}, decay=${result.importanceDecay}, merged=${result.duplicatesMerged}`);
      recordConsolidateRun();
      reg.recordSuccess("consolidate", {
        expiredDeleted:   result.expiredDeleted,
        importanceDecay:  result.importanceDecay,
        duplicatesMerged: result.duplicatesMerged,
      });
      await refreshUtilityBaseline().catch(e => logWarn(`[Consolidate] utility baseline refresh failed: ${e.message}`));
    } catch (err) {
      logError(`[Consolidate] failed: ${err.message}`, err);
      reg.recordFailure("consolidate", err);
    } finally {
      consolidateTickActive = false;
    }
  }, CONSOLIDATE_MS).unref();
  logInfo(`Consolidate: Running every ${CONSOLIDATE_MS / 3600000}h`);

  /** 임베딩 백필 (5분, 배치 500개) — EmbeddingWorker.processOrphanFragments 사용 */
  setInterval(async () => {
    const reg = getSchedulerRegistry();
    try {
      const worker = globalEmbeddingWorkerRef?.current;
      if (!worker) return;
      const count = await worker.processOrphanFragments(500);
      if (count > 0) logInfo(`[EmbeddingBackfill] Generated ${count} embeddings`);
      reg.recordSuccess("embeddingBackfill", { processed: count });
    } catch (err) {
      logError(`[EmbeddingBackfill] failed: ${err.message}`, err);
      reg.recordFailure("embeddingBackfill", err);
    }
  }, 5 * 60_000).unref();
  logInfo("EmbeddingBackfill: Running every 5min (batch 500)");

  /** Phase C: utility baseline 초기화 (confidence 계산용) */
  refreshUtilityBaseline().catch(err => {
    logWarn(`[Startup] utility baseline refresh failed: ${err.message}`);
  });

  /** Redis 인덱스 웜업 — cold start L1 miss 감소 (비차단) */
  getFragmentIndex()
    .warmup(getPrimaryPool())
    .then(count => logInfo(`[Startup] Redis warmup: ${count} fragments indexed`))
    .catch(err  => logWarn(`[Startup] Redis warmup failed: ${err.message}`));

  /** Phase 2: 비동기 지식 품질 평가 워커 시작 */
  getMemoryEvaluator().start().catch(err => {
    logError("[Startup] Failed to start MemoryEvaluator:", err);
  });

  /** batch_remember 비동기 큐 워커 시작 (async=true 모드 처리) */
  getBatchRememberWorker(MemoryManager.getInstance().batchRememberProcessor)
    .start()
    .catch(err => logError("[Startup] Failed to start BatchRememberWorker:", err));

  /** 임베딩 비동기 워커 + GraphLinker 시작 */
  import("./memory/embedding/EmbeddingWorker.js")
    .then(({ EmbeddingWorker }) => {
      const worker = new EmbeddingWorker();
      if (globalEmbeddingWorkerRef) globalEmbeddingWorkerRef.current = worker;
      return worker.start().then(() => worker);
    })
    .then(async (worker) => {
      const { GraphLinker } = await import("./memory/link/GraphLinker.js");
      const graphLinker     = new GraphLinker();

      worker.on("embedding_ready", async ({ fragmentId }) => {
        const reg = getSchedulerRegistry();
        try {
          const count = await graphLinker.linkFragment(fragmentId, "system", null, []);
          if (count > 0) logDebug(`[GraphLinker] Linked ${count} for ${fragmentId}`);
          reg.recordSuccess("graphLinker", { fragmentId, linked: count });
        } catch (err) {
          logWarn(`[GraphLinker] Error: ${err.message}`);
          reg.recordFailure("graphLinker", err);
        }
      });
    })
    .catch(err => {
      logError("[Startup] Failed to start EmbeddingWorker:", err);
    });

  /** NLI 모델 사전 로드 (cold start 방지, 비차단) */
  import("./memory/signals/NLIClassifier.js")
    .then(m => m.preloadNLI())
    .catch(err => {
      logWarn("[Startup] NLI preload skipped:", err.message);
    });
}
