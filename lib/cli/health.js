/**
 * CLI health 서브커맨드 - 연결 상태 진단
 *
 * 작성자: 최진호
 * 작성일: 2026-03-28
 * 수정일: 2026-04-20 (usage export, --format table|json|csv)
 */
import pg from 'pg';
import http from 'node:http';
import {
  DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD,
  REDIS_ENABLED, REDIS_HOST, REDIS_PORT, REDIS_PASSWORD,
  EMBEDDING_ENABLED, EMBEDDING_PROVIDER, EMBEDDING_DIMENSIONS,
  PORT,
} from '../config.js';
import { resolveFormat, renderTable, renderJson, renderCsv } from './_format.js';

export const usage = [
  "Usage: memento-mcp health [options]",
  "",
  "Check connectivity to DB, Redis, embedding provider, and the running server.",
  "",
  "Options:",
  "  --format table|json|csv   Output format (default: table if TTY, json otherwise)",
  "  --json                    Shorthand for --format json",
  "",
  "Examples:",
  "  memento-mcp health",
  "  memento-mcp health --json",
  "  memento-mcp health --format csv",
].join("\n");

const SCHEMA = 'agent_memory';

/**
 * DB 연결 상태 확인 + 응답 시간 측정
 */
async function checkDatabase(pool) {
  const t0 = Date.now();
  try {
    await pool.query('SELECT 1');
    return { status: 'OK', ms: Date.now() - t0 };
  } catch (err) {
    return { status: 'FAIL', error: err.message, ms: Date.now() - t0 };
  }
}

/**
 * Redis 연결 상태 확인
 * REDIS_ENABLED=false이면 DISABLED 반환 (실제 연결 시도 없음)
 */
async function checkRedis() {
  if (!REDIS_ENABLED) {
    return { status: 'DISABLED' };
  }

  const t0 = Date.now();
  try {
    const Redis = (await import('ioredis')).default;
    const client = new Redis({ host: REDIS_HOST, port: REDIS_PORT, password: REDIS_PASSWORD || undefined, db: 0, lazyConnect: true, connectTimeout: 3000 });
    await client.connect();
    await client.ping();
    await client.quit();
    return { status: 'OK', ms: Date.now() - t0 };
  } catch (err) {
    return { status: 'FAIL', error: err.message, ms: Date.now() - t0 };
  }
}

/**
 * 임베딩 프로바이더 상태 (API 호출 없이 설정값만 보고)
 */
function checkEmbedding() {
  if (!EMBEDDING_ENABLED) {
    return { status: 'DISABLED' };
  }
  return { status: 'OK', provider: EMBEDDING_PROVIDER, dimensions: EMBEDDING_DIMENSIONS };
}

/**
 * 마이그레이션 적용 현황 조회
 */
async function checkMigrations(pool) {
  try {
    const { rows: applied } = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM ${SCHEMA}.schema_migrations`
    );

    const fs   = await import('node:fs');
    const path = await import('node:path');
    const dir  = path.join(import.meta.dirname, '..', 'memory', 'migrations');
    const total = fs.readdirSync(dir)
      .filter(f => f.startsWith('migration-') && f.endsWith('.sql'))
      .length;

    return { applied: applied[0].cnt, total };
  } catch {
    return { applied: 0, total: '?', error: 'schema_migrations table not found' };
  }
}

/**
 * 서버 프로세스 상태 확인 (localhost:PORT/health HTTP GET)
 */
function checkServer() {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${PORT}/health`, { timeout: 2000 }, (res) => {
      res.on('data', () => {});
      res.on('end', () => {
        resolve({ status: 'RUNNING', port: PORT });
      });
    });

    req.on('error', () => {
      resolve({ status: 'NOT RUNNING' });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 'NOT RUNNING' });
    });
  });
}

export default async function health(opts) {
  const pool = new pg.Pool({
    host:     DB_HOST,
    port:     DB_PORT,
    database: DB_NAME,
    user:     DB_USER,
    password: DB_PASSWORD,
    max:      2,
  });

  try {
    const [db, redis, migrations, server] = await Promise.all([
      checkDatabase(pool),
      checkRedis(),
      checkMigrations(pool),
      checkServer(),
    ]);

    const embedding = checkEmbedding();

    const results = { database: db, redis, embedding, migrations, server };

    const fmt = resolveFormat(opts);

    if (fmt === "json") {
      console.log(renderJson(results));
      return;
    }

    const fmtStatus = (check) => {
      if (check.status === "OK" && check.ms !== undefined) return `OK (${check.ms}ms)`;
      if (check.status === "FAIL")    return `FAIL (${check.error})`;
      if (check.status === "RUNNING") return `RUNNING (port ${check.port})`;
      return check.status;
    };

    const tableRows = [
      { service: "Database",   status: fmtStatus(db),      latencyMs: db.ms ?? "" },
      { service: "Redis",      status: fmtStatus(redis),   latencyMs: redis.ms ?? "" },
      {
        service:   "Embedding",
        status:    embedding.status === "OK"
          ? `OK (${embedding.provider}, dim=${embedding.dimensions})`
          : embedding.status,
        latencyMs: "",
      },
      {
        service:   "Migrations",
        status:    `${migrations.applied}/${migrations.total} applied`,
        latencyMs: "",
      },
      { service: "Server",    status: fmtStatus(server),   latencyMs: "" },
    ];

    if (fmt === "csv") {
      console.log(renderCsv(tableRows, ["service", "status", "latencyMs"]));
      return;
    }

    console.log("Memento MCP Health Check");
    console.log(renderTable(tableRows, ["service", "status", "latencyMs"]));
  } finally {
    await pool.end();
  }
}
