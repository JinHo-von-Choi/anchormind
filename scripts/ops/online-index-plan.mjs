/**
 * 온라인 색인 작업의 계획과 인자 처리
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * scripts/ops/online-index.mjs 가 쓰는 순수 함수 모음이다. 데이터베이스에 연결하지 않고
 * 환경 파일도 읽지 않는다. 접속 대상은 --url 또는 표준 PG 환경변수에서만 얻는다.
 */

import { INDEX_SCHEMA } from "./index-manifest.mjs";

export const DEFAULT_LOCK_TIMEOUT = "3s";
export const DEFAULT_RETRIES      = 2;
export const DEFAULT_RETRY_WAIT   = 2000;
export const DEFAULT_RETRY_CAP    = 30000;
export const DISK_FACTOR          = 2;

/** 단계 식별자. 계획과 실행이 같은 이름을 쓴다. */
export const STEP = Object.freeze({
  BACKUP_GATE : "backup-gate",
  CONNECT     : "connect",
  SESSION     : "session-settings",
  DISK_CHECK  : "disk-check",
  TXN_CHECK   : "txn-check",
  INSPECT     : "inspect",
  DROP_INVALID: "drop-invalid",
  CREATE      : "create",
  VERIFY      : "verify",
  RETRY       : "retry",
});

/** 색인 작업 오류의 공통 부모. */
export class OnlineIndexError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "OnlineIndexError";
  }
}

/** 인자나 접속 대상이 잘못되어 실행을 거부한 경우. */
export class OnlineIndexUsageError extends OnlineIndexError {
  constructor(message) {
    super(message);
    this.name = "OnlineIndexUsageError";
  }
}

/** 디스크 여유 부족, 같은 이름의 다른 표 색인 같은 선행 조건 위반. */
export class OnlineIndexPreconditionError extends OnlineIndexError {
  constructor(message) {
    super(message);
    this.name = "OnlineIndexPreconditionError";
  }
}

/** 재시도를 모두 쓰고도 유효한 색인을 얻지 못한 경우. */
export class OnlineIndexBuildError extends OnlineIndexError {
  constructor(message, options) {
    super(message, options);
    this.name = "OnlineIndexBuildError";
  }
}

const VALUE_FLAGS = Object.freeze({
  "--url"          : "url",
  "--manifest"     : "manifest",
  "--lock-timeout" : "lockTimeout",
  "--retries"      : "retries",
  "--retry-wait-ms": "retryWaitMs",
  "--retry-max-wait-ms": "retryMaxWaitMs",
  "--free-bytes"   : "freeBytes",
  "--data-dir"     : "dataDir",
});

const BOOLEAN_FLAGS = Object.freeze({
  "--dry-run": "dryRun",
  "--confirm": "confirm",
  "--help"   : "help",
});

function parseIntegerOption(name, text, { min, max }) {
  if (!/^\d+$/.test(String(text))) throw new OnlineIndexUsageError(`${name} 은 0 이상의 정수여야 한다: ${text}`);
  const value = Number(text);
  if (value < min || value > max) throw new OnlineIndexUsageError(`${name} 은 ${min} 이상 ${max} 이하여야 한다: ${text}`);
  return value;
}

/** 값을 받는 옵션을 의미 있는 값으로 바꾼다. */
function coerceOption(key, text) {
  if (key === "retries")     return parseIntegerOption("--retries",       text, { min: 0, max: 10 });
  if (key === "retryWaitMs") return parseIntegerOption("--retry-wait-ms", text, { min: 0, max: 600000 });
  if (key === "retryMaxWaitMs") return parseIntegerOption("--retry-max-wait-ms", text, { min: 0, max: 3600000 });
  if (key === "freeBytes")   return parseIntegerOption("--free-bytes",    text, { min: 0, max: Number.MAX_SAFE_INTEGER });
  if (key === "lockTimeout" && !/^\d+(ms|s|min)$/.test(text)) {
    throw new OnlineIndexUsageError(`--lock-timeout 은 3s, 500ms, 1min 같은 형식이어야 한다: ${text}`);
  }
  return text;
}

/**
 * 명령행 인자를 읽는다. 알 수 없는 인자와 값 없는 옵션은 거부한다.
 *
 * @param {string[]} argv process.argv.slice(2)
 * @returns {{dryRun: boolean, confirm: boolean, help: boolean, indexes: string[], url?: string,
 *            manifest?: string, lockTimeout: string, retries: number, retryWaitMs: number, retryMaxWaitMs: number,
 *            freeBytes?: number, dataDir?: string}}
 */
export function parseArgs(argv) {
  const opts = {
    dryRun: false, confirm: false, help: false, indexes: [],
    lockTimeout: DEFAULT_LOCK_TIMEOUT, retries: DEFAULT_RETRIES, retryWaitMs: DEFAULT_RETRY_WAIT,
    retryMaxWaitMs: DEFAULT_RETRY_CAP,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg in BOOLEAN_FLAGS) { opts[BOOLEAN_FLAGS[arg]] = true; continue; }
    if (arg === "--index" || arg in VALUE_FLAGS) {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new OnlineIndexUsageError(`${arg} 에 값이 필요하다`);
      if (arg === "--index") opts.indexes.push(value);
      else opts[VALUE_FLAGS[arg]] = coerceOption(VALUE_FLAGS[arg], value);
      continue;
    }
    throw new OnlineIndexUsageError(`알 수 없는 인자: ${arg}`);
  }

  return opts;
}

/**
 * 접속 대상을 정한다. --url 이 있으면 그것을, 없으면 표준 PG 환경변수를 쓴다. 이 함수는
 * 환경 파일을 읽지 않으며 PGHOST 와 PGDATABASE 가 모두 명시되어야 한다. 비밀번호는
 * 표시용 label 에 담지 않는다.
 *
 * @param {{url?: string}} opts
 * @param {Record<string, string|undefined>} env
 * @returns {{config: object, label: string}}
 */
export function resolveTarget(opts, env) {
  if (opts.url !== undefined) return targetFromUrl(opts.url);

  if (!env.PGHOST || !env.PGDATABASE) {
    throw new OnlineIndexUsageError(
      "접속 대상이 명시되지 않았다. --url 을 주거나 PGHOST 와 PGDATABASE(필요하면 PGPORT, PGUSER, PGPASSWORD)를 설정한다."
    );
  }
  const port = Number(env.PGPORT || 5432);
  return {
    config: { host: env.PGHOST, port, database: env.PGDATABASE, user: env.PGUSER, password: env.PGPASSWORD },
    label:  describeTarget(env.PGHOST, port, env.PGDATABASE, env.PGUSER),
  };
}

function targetFromUrl(text) {
  let url;
  try {
    url = new URL(text);
  } catch (err) {
    throw new OnlineIndexUsageError(`--url 이 올바른 주소가 아니다: ${err.message}`);
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new OnlineIndexUsageError("--url 은 postgres:// 또는 postgresql:// 주소여야 한다");
  }
  if (url.search !== "") {
    throw new OnlineIndexUsageError("--url 의 쿼리 매개변수(sslmode 등)는 쓰지 않는다. SSL 대상은 PG 환경변수(PGSSLMODE 등)로 지정한다");
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!url.hostname || !database) throw new OnlineIndexUsageError("--url 에 호스트와 데이터베이스 이름이 필요하다");

  const port = Number(url.port || 5432);
  const user = decodeURIComponent(url.username) || undefined;
  return {
    config: {
      host: url.hostname.replace(/^\[|\]$/g, ""), port, database, user,
      password: url.password ? decodeURIComponent(url.password) : undefined,
    },
    label: describeTarget(url.hostname, port, database, user),
  };
}

function describeTarget(host, port, database, user) {
  return `${user ? `${user}@` : ""}${host}:${port}/${database}`;
}

/**
 * 디스크 여유 바이트를 정한다. --free-bytes 가 우선이고, 없으면 --data-dir 의 파일시스템
 * 여유를 statfs 로 읽는다. 둘 다 없으면 확인할 수 없으므로 거부한다.
 *
 * @param {{freeBytes?: number, dataDir?: string}} opts
 * @param {(dir: string) => Promise<{bsize: number, bavail: number}>} statfs
 * @returns {Promise<number>}
 */
export async function resolveFreeBytes(opts, statfs) {
  if (opts.freeBytes !== undefined) return opts.freeBytes;
  if (opts.dataDir !== undefined) {
    const stat = await statfs(opts.dataDir);
    return Number(stat.bsize) * Number(stat.bavail);
  }
  throw new OnlineIndexUsageError("디스크 여유를 확인할 수 없다. --free-bytes <바이트> 또는 --data-dir <경로> 를 준다.");
}

/**
 * 필요한 디스크 여유. 대상 표 크기(인덱스 포함)의 DISK_FACTOR 배.
 *
 * @param {number} tableBytes
 * @returns {number}
 */
export function requiredDiskBytes(tableBytes) {
  return tableBytes * DISK_FACTOR;
}

/**
 * 재시도 전 대기 시간. 기본 대기를 시도마다 두 배로 늘리고 상한으로 자른다.
 *
 * @param {number} attempt 방금 실패한 시도의 번호(1부터)
 * @param {number} baseMs
 * @param {number} maxMs
 * @returns {number}
 */
export function retryDelayMs(attempt, baseMs, maxMs) {
  return Math.min(maxMs, baseMs * 2 ** (attempt - 1));
}

/** 색인 생성 문. definition 은 작업 목록이 검증한 값이다. */
export function createSql(entry) {
  return `CREATE ${entry.unique ? "UNIQUE " : ""}INDEX CONCURRENTLY IF NOT EXISTS ${entry.name} ${entry.definition}`;
}

/** 색인 제거 문. */
export function dropSql(entry) {
  return `DROP INDEX CONCURRENTLY IF EXISTS ${INDEX_SCHEMA}.${entry.name}`;
}

/** 색인 상태 조회 문. $1 은 스키마, $2 는 색인 이름이다. */
export const INSPECT_SQL =
  "SELECT i.indisvalid AS valid, t.relname AS table_name, tn.nspname AS table_schema "
  + "FROM pg_index i "
  + "JOIN pg_class c ON c.oid = i.indexrelid "
  + "JOIN pg_namespace n ON n.oid = c.relnamespace "
  + "JOIN pg_class t ON t.oid = i.indrelid "
  + "JOIN pg_namespace tn ON tn.oid = t.relnamespace "
  + "WHERE n.nspname = $1 AND c.relname = $2";

/**
 * 같은 데이터베이스에서 열려 있는 다른 세션의 트랜잭션 수와 가장 오래된 시작 시각의 경과 초.
 * CONCURRENTLY 는 이 트랜잭션이 끝나기를 기다린다. 다른 역할의 세션은 권한이 없으면 보이지 않는다.
 */
export const OPEN_TXN_SQL =
  "SELECT count(*)::int AS open_count, "
  + "COALESCE(EXTRACT(EPOCH FROM (now() - min(xact_start)))::int, 0) AS oldest_seconds "
  + "FROM pg_stat_activity "
  + "WHERE datname = current_database() AND pid <> pg_backend_pid() "
  + "AND backend_type = 'client backend' AND xact_start IS NOT NULL";

/** 표 크기 조회 문. $1 은 스키마가 붙은 표 이름이다. */
export const TABLE_SIZE_SQL = "SELECT pg_total_relation_size($1::regclass)::text AS bytes";

/** 세션 설정 문. lockTimeout 은 parseArgs 가 검증한 값이다. */
export function sessionSql(lockTimeout) {
  return [`SET lock_timeout='${lockTimeout}'`, "SET statement_timeout=0"];
}

/**
 * 실행할 단계의 순서를 만든다. 데이터베이스에는 닿지 않는다.
 *
 * @param {{entries: object[], lockTimeout: string, retries: number, targetLabel: string}} input
 * @returns {Array<{id: string, index?: string, sql?: string[], text: string}>}
 */
export function planSteps({ entries, lockTimeout, retries, targetLabel }) {
  const steps = [
    { id: STEP.BACKUP_GATE, text: "배포 전 백업 완료를 확인한다. --confirm 은 이 확인을 뜻한다" },
    { id: STEP.CONNECT,     text: `대상 ${targetLabel} 에 연결한다` },
    { id: STEP.SESSION,     sql: sessionSql(lockTimeout), text: "세션의 잠금 대기와 문장 시간 제한을 설정한다" },
  ];

  for (const entry of entries) steps.push(...indexSteps(entry, retries));
  return steps;
}

function indexSteps(entry, retries) {
  const table = `${INDEX_SCHEMA}.${entry.table}`;
  const base  = { index: entry.name };
  return [
    { ...base, id: STEP.DISK_CHECK,   sql: [TABLE_SIZE_SQL],  text: `${table} 크기의 ${DISK_FACTOR}배 이상 디스크 여유를 확인한다` },
    { ...base, id: STEP.TXN_CHECK,    sql: [OPEN_TXN_SQL],  text: "열려 있는 트랜잭션의 수와 가장 오래된 경과 시간을 경고로 알린다(CONCURRENTLY 는 이 트랜잭션을 기다린다)" },
    { ...base, id: STEP.INSPECT,      sql: [INSPECT_SQL],     text: "같은 이름의 색인 상태를 pg_index 에서 읽는다. 유효하면 건너뛴다" },
    { ...base, id: STEP.DROP_INVALID, sql: [dropSql(entry)],  text: "이전 시도가 남긴 무효 색인이 있을 때만 제거한다" },
    { ...base, id: STEP.CREATE,       sql: [createSql(entry)], text: "색인을 CONCURRENTLY 로 만든다" },
    { ...base, id: STEP.VERIFY,       sql: [INSPECT_SQL],     text: "pg_index.indisvalid 가 참인지 확인한다" },
    { ...base, id: STEP.RETRY,        sql: [dropSql(entry)],  text: `무효이거나 잠금 대기 초과이면 무효 색인을 제거하고 ${STEP.CREATE} 부터 최대 ${retries}회, 기본 대기를 시도마다 두 배로 늘리며 다시 시도한다` },
  ];
}

/**
 * 계획을 사람이 읽는 줄로 바꾼다. 한 줄은 "<번호>. <단계 id> [색인] 설명" 으로 시작한다.
 *
 * @param {ReturnType<typeof planSteps>} steps
 * @returns {string[]}
 */
export function formatPlan(steps) {
  const lines = [];
  steps.forEach((step, i) => {
    lines.push(`${i + 1}. ${step.id}${step.index ? ` [${step.index}]` : ""} ${step.text}`);
    for (const statement of step.sql ?? []) lines.push(`     ${statement}`);
  });
  return lines;
}
