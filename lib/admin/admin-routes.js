/**
 * Admin HTTP 라우트 핸들러 — UI, 이미지, REST API
 *
 * 작성자: 최진호
 * 작성일: 2026-03-15
 * 수정일: 2026-03-27 (5개 모듈 분할, 디스패처 축소)
 */

import fs     from "node:fs";
import path   from "node:path";
import os     from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

import { validateAdminAccess, validateAdminOrigin, handleAuth, safeErrorMessage, ADMIN_BASE, ADMIN_LOGIN_PAGE } from "./admin-auth.js";

const ADMIN_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data:; font-src 'self' https://fonts.gstatic.com; connect-src 'self'";
import { handleKeys }      from "./admin-keys.js";
import { handleSessions }  from "./admin-sessions.js";
import { handleLogs }      from "./admin-logs.js";
import { handleMemory }    from "./admin-memory.js";
import { handleExport, handleImport } from "./admin-export.js";
import { buildMetricsSummary }        from "./admin-metrics.js";
/* validateMasterKey: 인증 로직은 admin-auth.js 미들웨어에서 처리 */
import { getSessionCounts }   from "../sessions.js";
import { getPrimaryPool, getPoolStats } from "../tools/db.js";
import { redisClient }        from "../redis.js";
import { getSearchMetrics }   from "../memory/signals/SearchMetrics.js";
import { getSearchObservability, getPathPerformance } from "../memory/signals/SearchEventAnalyzer.js";
import { logError }           from "../logger.js";
import { getSchedulerRegistry } from "../scheduler-registry.js";
import { getLastConsolidation } from "../scheduler.js";

/**
 * GET /v1/internal/model/nothing (Admin UI)
 */
export function handleAdminUi(req, res) {
  if (!validateAdminAccess(req)) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Content-Security-Policy", ADMIN_CSP);
    res.end(ADMIN_LOGIN_PAGE);
    return;
  }
  const htmlPath = path.join(__dirname, "..", "..", "assets", "admin", "index.html");
  fs.readFile(htmlPath, "utf8", (err, html) => {
    if (err) { res.statusCode = 404; res.end("Admin UI not found"); return; }
    /** 캐시 버스팅: 정적 자산 URL에 타임스탬프 쿼리스트링 주입 (Cloudflare CDN 캐시 우회) */
    const v   = Date.now();
    const out = html
      .replace(/admin\.css"/, `admin.css?v=${v}"`)
      .replace(/admin\.js"/, `admin.js?v=${v}"`);
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Content-Security-Policy", ADMIN_CSP);
    res.setHeader("Cache-Control", "no-cache");
    res.end(out);
  });
}

/**
 * GET /v1/internal/model/nothing/images/:file (Admin 이미지)
 */
export function handleAdminImage(req, res) {
  if (!validateAdminAccess(req)) {
    res.statusCode = 401;
    res.end("Unauthorized");
    return;
  }
  const url      = new URL(req.url || "/", "http://localhost");
  const filename = path.basename(url.pathname);
  const imgPath  = path.join(__dirname, "..", "..", "assets", "images", filename);
  fs.readFile(imgPath, (err, data) => {
    if (err) { res.statusCode = 404; res.end("Image not found"); return; }
    const ext  = path.extname(filename).toLowerCase();
    const mime = { ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml" }[ext] || "application/octet-stream";
    res.statusCode = 200;
    res.setHeader("Content-Type", mime);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.end(data);
  });
}

/** 정적 자산 MIME 타입 허용 목록 */
const STATIC_MIME = {
  ".html": "text/html",
  ".css":  "text/css",
  ".js":   "application/javascript",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
};

/** 정적 자산 기준 디렉토리 (프로젝트 루트/assets/admin) */
const STATIC_BASE = path.resolve(__dirname, "..", "..", "assets", "admin");

/**
 * GET /v1/internal/model/nothing/assets/:file (Admin 정적 자산)
 * 허용된 확장자만 서빙, path traversal 차단
 */
export function handleAdminStatic(req, res) {
  /* 정적 자산(CSS/JS/이미지)은 인증 면제 — 브라우저 리소스 요청에 Auth 헤더 없음 */
  /* path traversal + 확장자 화이트리스트로 보안 확보 */

  const url      = new URL(req.url || "/", "http://localhost");
  const relative = url.pathname.replace(`${ADMIN_BASE}/assets/`, "");
  const resolved = path.resolve(STATIC_BASE, relative);

  /* path traversal 차단: resolved 경로가 STATIC_BASE 내부인지 검증 */
  if (!resolved.startsWith(STATIC_BASE + path.sep) && resolved !== STATIC_BASE) {
    res.statusCode = 403;
    res.end("Forbidden");
    return;
  }

  const ext  = path.extname(resolved).toLowerCase();
  const mime = STATIC_MIME[ext];

  if (!mime) {
    res.statusCode = 404;
    res.end("Not found");
    return;
  }

  fs.readFile(resolved, (err, data) => {
    if (err) { res.statusCode = 404; res.end("Not found"); return; }
    res.statusCode = 200;
    res.setHeader("Content-Type", mime);
    res.setHeader("Cache-Control", "no-cache");
    res.end(data);
  });
}


/**
 * Admin REST API 라우터
 * 마스터 키 인증 후 각 모듈 핸들러로 위임
 */
export async function handleAdminApi(req, res) {
  if (!validateAdminOrigin(req, res)) return;

  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  const url            = new URL(req.url || "/", "http://localhost");
  const isAuthEndpoint = req.method === "POST" && url.pathname === `${ADMIN_BASE}/auth`;

  if (!isAuthEndpoint && !validateAdminAccess(req)) {
    res.statusCode = 401;
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  /** POST /auth */
  if (isAuthEndpoint) {
    handleAuth(req, res);
    return;
  }

  /** GET /stats */
  if (req.method === "GET" && url.pathname === `${ADMIN_BASE}/stats`) {
    try {
      const pool = getPrimaryPool();

      const [fragR, callR, keyR] = await Promise.all([
        pool.query("SELECT COUNT(*) AS total FROM agent_memory.fragments"),
        pool.query(`SELECT COALESCE(SUM(call_count),0) AS total
                      FROM agent_memory.api_key_usage
                     WHERE usage_date = CURRENT_DATE`),
        pool.query("SELECT COUNT(*) AS total FROM agent_memory.api_keys WHERE status='active'"),
      ]);

      /** 추가 데이터 소스 — 개별 실패가 전체를 크래시하지 않도록 allSettled */
      const [smResult, obsResult, qpResult, psResult, ppResult] = await Promise.allSettled([
        getSearchMetrics().then(m => m?.getStats() ?? null),
        getSearchObservability(7),
        pool.query("SELECT COUNT(*) AS cnt FROM agent_memory.fragments WHERE quality_verified IS NULL"),
        Promise.resolve(getPoolStats()),
        getPathPerformance(7)
      ]);

      const searchMetrics   = smResult.status  === "fulfilled" ? smResult.value  : null;
      const observability   = obsResult.status  === "fulfilled" ? obsResult.value  : null;
      const qualityPending  = qpResult.status   === "fulfilled" ? parseInt(qpResult.value.rows[0].cnt) : 0;
      const poolStats       = psResult.status   === "fulfilled" ? psResult.value   : null;
      const pathPerformance = ppResult.status   === "fulfilled" ? ppResult.value   : null;

      const cpus   = os.cpus();
      const cpuPct = Math.min(100, Math.round((os.loadavg()[0] / cpus.length) * 100));
      const memPct = Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 100);

      let diskPct = 0;
      try {
        const d = fs.statfsSync("/");
        diskPct = Math.round(((d.blocks - d.bfree) / d.blocks) * 100);
      } catch { /* non-posix */ }

      let dbSizeBytes = 0;
      try {
        const { rows: [sr] } = await pool.query(
          "SELECT pg_database_size(current_database()) AS bytes"
        );
        dbSizeBytes = parseInt(sr.bytes);
      } catch { /* ignore */ }

      const redisStat = (redisClient && redisClient.status === "ready")
        ? "connected" : "disconnected";

      /** healthFlags 조건 평가 */
      const healthFlags = [];
      if (redisStat === "disconnected") {
        healthFlags.push("redis_disconnected");
      }
      if (observability?.l1_miss_rate != null && observability.l1_miss_rate > 0.5) {
        healthFlags.push("high_l1_miss_rate");
      }
      if (poolStats?.primary?.waitingCount > 0) {
        healthFlags.push("db_pool_pressure");
      }

      res.statusCode = 200;
      res.end(JSON.stringify({
        fragments:      parseInt(fragR.rows[0].total),
        sessions:       getSessionCounts().total,
        apiCallsToday:  parseInt(callR.rows[0].total),
        activeKeys:     parseInt(keyR.rows[0].total),
        uptime:         Math.floor(process.uptime()),
        nodeVersion:    process.version,
        system:         { cpu: cpuPct, memory: memPct, disk: diskPct, dbSizeBytes },
        db:             "connected",
        redis:          redisStat,
        searchMetrics:   searchMetrics   ?? null,
        observability:   observability   ?? null,
        pathPerformance: pathPerformance ?? null,
        queues:          {
          embeddingBacklog: 0,
          qualityPending:   qualityPending ?? 0
        },
        schedulerJobs:        getSchedulerRegistry().getAll(),
        lastConsolidation:    getLastConsolidation(),
        healthFlags
      }));
    } catch (err) {
      logError("[Admin] /stats error:", err);
      res.statusCode = 500;
      res.end(JSON.stringify({ error: safeErrorMessage(err) }));
    }
    return;
  }

  /** GET /activity */
  if (req.method === "GET" && url.pathname === `${ADMIN_BASE}/activity`) {
    try {
      const pool      = getPrimaryPool();
      const { rows }  = await pool.query(`
        SELECT f.id, f.topic, f.type, f.agent_id, f.key_id, f.created_at,
               LEFT(f.content, 80) AS preview,
               k.name              AS key_name,
               k.key_prefix
        FROM  agent_memory.fragments f
        LEFT JOIN agent_memory.api_keys k ON k.id = f.key_id
        ORDER BY f.created_at DESC
        LIMIT 10
      `);
      res.statusCode = 200;
      res.end(JSON.stringify(rows));
    } catch (err) {
      logError("[Admin] /activity error:", err);
      res.statusCode = 500;
      res.end(JSON.stringify({ error: safeErrorMessage(err) }));
    }
    return;
  }

  /** GET /metrics-summary */
  if (req.method === "GET" && url.pathname === `${ADMIN_BASE}/metrics-summary`) {
    try {
      const windowSec = parseInt(url.searchParams.get("windowSec") || "60", 10) || 60;
      const includeRaw = url.searchParams.get("include");
      const include    = includeRaw
        ? includeRaw.split(",").map(s => s.trim()).filter(Boolean)
        : ["cards", "tools", "errors"];

      const summary = await buildMetricsSummary({ windowSec, include });
      res.statusCode = 200;
      res.end(JSON.stringify(summary));
    } catch (err) {
      logError("[Admin] /metrics-summary error:", err);
      res.statusCode = 500;
      res.end(JSON.stringify({ error: safeErrorMessage(err) }));
    }
    return;
  }

  /** 모듈별 핸들러 위임 */
  if (await handleKeys(req, res, url)) return;
  if (await handleMemory(req, res, url)) return;
  if (await handleSessions(req, res, url)) return;
  if (await handleLogs(req, res, url)) return;
  if (await handleExport(req, res, url)) return;
  if (await handleImport(req, res, url)) return;

  res.statusCode = 404;
  res.end(JSON.stringify({ error: "Not found" }));
}
