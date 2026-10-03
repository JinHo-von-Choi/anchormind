#!/usr/bin/env node
/**
 * backfill-content-tokens.mjs: content_tokens가 NULL인 기존 파편을 채우는 재개형 백필
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 목적: 마이그레이션 053이 더한 fragments.content_tokens를 저장 경로와 같은 토큰화(LexicalTokens)로 채운다.
 *       본문 어휘 채널은 content_tokens가 NULL인 행을 찾지 못하므로 배포 뒤 한 번 실행한다.
 * 방식: lib/memory/consolidate/resumableBackfill.js(watermark, 실패 행 기록) 위에서 id 순 묶음마다 후보의
 *       본문을 읽어 토큰 문서를 만들고, 잠근 행 가운데 content_hash가 읽은 값과 같은 행만 갱신한다. 그 사이
 *       본문이 바뀐 행은 저장 경로가 이미 토큰을 썼으므로 그대로 둔다. 중단되면 같은 --job으로 다시 실행해
 *       이어 간다.
 * 접속 대상: --url 또는 표준 PG 환경변수(PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD). 환경 파일은 읽지
 *            않는다. 대상이 명시되지 않으면 연결하지 않는다.
 * 실행 모드: 기본은 미리보기(연결해서 키별 미채움 수와 작업 상태만 출력하고 쓰지 않는다). --confirm이 있어야
 *            쓴다.
 * 종료 코드: 0 성공, 1 실행 실패, 2 인자, 대상, 선행 조건 거부.
 *
 * 사용 예:
 *   PGHOST=... PGDATABASE=... PGUSER=... PGPASSWORD=... node scripts/backfill-content-tokens.mjs
 *   PGHOST=... PGDATABASE=... PGUSER=... PGPASSWORD=... node scripts/backfill-content-tokens.mjs --confirm
 */

import os   from "node:os";
import path from "node:path";
import { resolveTarget, OnlineIndexUsageError } from "./ops/online-index-plan.mjs";

export const DEFAULT_JOB        = "content-tokens";
export const DEFAULT_BATCH_SIZE = 200;
export const MAX_BATCH_SIZE     = 5000;

const JOB_PATTERN    = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const LEGACY_DB_KEYS = ["DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_PASSWORD", "DATABASE_URL", "BATCH_DATABASE_URL"];

/** 갱신 대상: 아직 채우지 않은 행 */
export const BACKFILL_WHERE = "content_tokens IS NULL";

/**
 * 갱신 식. $4 id 배열, $5 토큰 문서 배열, $6 content_hash 배열. 읽은 뒤 본문이 바뀐 행(해시 불일치)이나
 * 준비하지 않은 행은 기존 값을 둔다.
 */
export const BACKFILL_SET =
  "content_tokens = COALESCE((SELECT to_tsvector('simple', m.doc) FROM unnest($4::text[], $5::text[], $6::text[]) AS m(id, doc, hash) " +
  "WHERE m.id = f.id AND m.hash = f.content_hash), f.content_tokens)";

/** 묶음 후보 조회. 갱신 대상 조건과 순서, 크기가 resumableBackfill의 잠금 문장과 같다. */
export const CANDIDATE_SQL = Object.freeze({
  batch : `SELECT id, content, content_hash FROM agent_memory.fragments WHERE ${BACKFILL_WHERE} AND id > $1 ORDER BY id LIMIT $2`,
  single: `SELECT id, content, content_hash FROM agent_memory.fragments WHERE ${BACKFILL_WHERE} AND id = $1`
});

/** 키별 미채움 수(미리보기) */
export const MISSING_SQL =
  "SELECT key_id, count(*) AS total, count(*) FILTER (WHERE content_tokens IS NULL) AS missing " +
  "FROM agent_memory.fragments GROUP BY key_id ORDER BY key_id NULLS FIRST";

const TABLES_SQL    = "SELECT to_regclass($1) AS watermark, to_regclass($2) AS failure";
const WATERMARK_SQL = "SELECT last_id, rows_done::text AS rows_done, status FROM agent_memory.backfill_watermarks WHERE job = $1";

const USAGE = [
  "사용법: node scripts/backfill-content-tokens.mjs [--confirm] [옵션]",
  "  (기본)                  미리보기. 키별 미채움 수와 작업 상태만 출력하고 쓰지 않는다",
  "  --confirm               실행(배포 전 백업 완료가 전제다)",
  "  --dry-run               미리보기(--confirm보다 우선)",
  "  --url <postgres 주소>   접속 대상. 없으면 PGHOST, PGDATABASE 등 표준 PG 환경변수",
  `  --job <이름>            작업 이름(기본 ${DEFAULT_JOB}). 같은 이름으로 다시 실행하면 이어 간다`,
  `  --batch-size <수>       묶음 크기(기본 ${DEFAULT_BATCH_SIZE}, 최대 ${MAX_BATCH_SIZE})`,
  "  --restart               watermark와 실패 행 기록을 지우고 처음부터 실행",
  "  --retry-failures        기록된 실패 행만 다시 실행"
].join("\n");

/** 인자나 선행 조건 거부 */
export class BackfillUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "BackfillUsageError";
  }
}

const VALUE_FLAGS   = Object.freeze({ "--url": "url", "--job": "job", "--batch-size": "batchSize" });
const BOOLEAN_FLAGS = Object.freeze({
  "--confirm": "confirm", "--dry-run": "dryRun", "--restart": "restart", "--retry-failures": "retryFailures", "--help": "help"
});

function coerce(key, text) {
  if (key === "batchSize") {
    if (!/^\d+$/.test(text)) throw new BackfillUsageError("--batch-size 는 정수여야 한다");
    const value = Number(text);
    if (value < 1 || value > MAX_BATCH_SIZE) throw new BackfillUsageError(`--batch-size 는 1 이상 ${MAX_BATCH_SIZE} 이하여야 한다`);
    return value;
  }
  if (key === "job" && !JOB_PATTERN.test(text)) throw new BackfillUsageError("--job 은 소문자 영숫자와 . _ - 로 1~64자여야 한다");
  return text;
}

/** 값을 받는 옵션의 값. 오류 메시지는 옵션 이름만 담는다. */
function takeValue(name, inline, argv, i) {
  if (inline !== undefined) {
    if (inline === "") throw new BackfillUsageError(`${name} 에 값이 필요하다`);
    return { value: inline, next: i };
  }
  const value = argv[i + 1];
  if (value === undefined || value.startsWith("--")) throw new BackfillUsageError(`${name} 에 값이 필요하다`);
  return { value, next: i + 1 };
}

/**
 * 명령행 인자를 읽는다. 알 수 없는 인자와 값 없는 옵션은 거부한다.
 *
 * @param {string[]} argv
 * @returns {{confirm: boolean, help: boolean, restart: boolean, retryFailures: boolean, job: string, batchSize: number, url?: string}}
 */
export function parseBackfillArgs(argv) {
  const opts = { confirm: false, dryRun: false, help: false, restart: false, retryFailures: false, job: DEFAULT_JOB, batchSize: DEFAULT_BATCH_SIZE };
  for (let i = 0; i < argv.length; i++) {
    const eq     = argv[i].indexOf("=");
    const name   = argv[i].startsWith("--") && eq > 2 ? argv[i].slice(0, eq) : argv[i];
    const inline = name === argv[i] ? undefined : argv[i].slice(eq + 1);
    if (name in BOOLEAN_FLAGS && inline === undefined) {
      opts[BOOLEAN_FLAGS[name]] = true;
    } else if (name in VALUE_FLAGS) {
      const taken = takeValue(name, inline, argv, i);
      i = taken.next;
      opts[VALUE_FLAGS[name]] = coerce(VALUE_FLAGS[name], taken.value);
    } else {
      throw new BackfillUsageError(`알 수 없는 인자: ${name.startsWith("--") ? name : "(위치 인자)"}`);
    }
  }
  if (opts.restart && opts.retryFailures) throw new BackfillUsageError("--restart 와 --retry-failures 는 함께 쓸 수 없다");
  if (opts.dryRun) opts.confirm = false;
  return opts;
}

/**
 * 연결 설정을 검증한 대상으로 바꾼다. lib 모듈을 불러오기 전에 호출한다. 환경 파일 경로를 빈 장치로 두어
 * lib/config.js의 dotenv가 어떤 .env도 읽지 않게 한다.
 *
 * @param {Record<string, string|undefined>} env 수정 대상
 * @param {{host: string, port: number, database: string, user?: string, password?: string}} target
 */
export function prepareEnvironment(env, target) {
  for (const key of LEGACY_DB_KEYS) delete env[key];
  env.DOTENV_CONFIG_PATH      = os.devNull;
  env.DOTENV_CONFIG_QUIET     = "true";
  env.POSTGRES_HOST           = target.host;
  env.POSTGRES_PORT           = String(target.port);
  env.POSTGRES_DB             = target.database;
  env.POSTGRES_USER           = target.user ?? "";
  env.POSTGRES_PASSWORD       = target.password ?? "";
  env.REDIS_ENABLED           = "false";
  env.CACHE_ENABLED           = "false";
  env.MEMENTO_METRICS_DEFAULT = "off";
  env.LOG_LEVEL             ??= "warn";
  env.LOG_DIR               ??= path.join(os.tmpdir(), "backfill-content-tokens-logs");
}

/**
 * 후보 행으로 묶음 값($4 id, $5 토큰 문서, $6 content_hash)을 만든다.
 *
 * @param {Array<{id: string, content: string, content_hash: string}>} rows
 * @param {(content: string) => Promise<string>} tokenize
 * @returns {Promise<[string[], string[], string[]]>}
 */
export async function buildBatchParams(rows, tokenize) {
  const docs = [];
  for (const row of rows) docs.push(await tokenize(row.content));
  return [rows.map(row => row.id), docs, rows.map(row => row.content_hash)];
}

/**
 * resumableBackfill의 prepareBatch. 묶음 시작 watermark 뒤의 후보(또는 실패 행 하나)를 읽어 값을 만든다.
 *
 * @param {(sql: string, params: unknown[]) => Promise<{rows: Object[]}>} run
 * @param {(content: string) => Promise<string>} tokenize
 * @returns {(batch: {afterId: string, batchSize: number, onlyId?: string}) => Promise<Array>}
 */
export function makePrepareBatch(run, tokenize) {
  return async ({ afterId, batchSize, onlyId }) => {
    const { rows } = onlyId === undefined
      ? await run(CANDIDATE_SQL.batch, [afterId, batchSize])
      : await run(CANDIDATE_SQL.single, [onlyId]);
    return buildBatchParams(rows, tokenize);
  };
}

/** lib 모듈을 불러와 실행 의존성을 만든다. prepareEnvironment 뒤에만 부른다. */
async function loadRuntime() {
  const config     = await import("../lib/config.js");
  const db         = await import("../lib/tools/db.js");
  const backfill   = await import("../lib/memory/consolidate/resumableBackfill.js");
  const schema     = await import("../lib/memory/LexicalSchema.js");
  const tokens     = await import("../lib/memory/embedding/LexicalTokens.js");
  return {
    config               : { DB_HOST: config.DB_HOST, DB_PORT: config.DB_PORT, DB_NAME: config.DB_NAME },
    run                  : (sql, params) => db.queryWithAgentVector("system", sql, params),
    lexicalSchemaSql     : schema.LEXICAL_SCHEMA_SQL,
    ensureBackfillTables : backfill.ensureBackfillTables,
    runResumableBackfill : backfill.runResumableBackfill,
    retryBackfillFailures: backfill.retryBackfillFailures,
    tokenize             : tokens.contentTokenDocument,
    shutdown             : db.shutdownPool
  };
}

function assertConfigMatches(config, target) {
  if (config.DB_HOST !== target.host || Number(config.DB_PORT) !== Number(target.port) || config.DB_NAME !== target.database) {
    throw new BackfillUsageError("불러온 연결 설정이 지정한 대상과 다르다. 실행하지 않는다");
  }
}

async function assertColumn(runtime) {
  const { rows } = await runtime.run(runtime.lexicalSchemaSql, ["agent_memory.fragments"]);
  if (rows[0]?.column_present !== true) {
    throw new BackfillUsageError("fragments.content_tokens 열이 없다. 마이그레이션 053을 먼저 적용한다");
  }
}

async function preview(runtime, opts, io) {
  const { rows } = await runtime.run(MISSING_SQL, []);
  io.out(`[backfill-content-tokens] 미리보기(쓰지 않는다). 작업 ${opts.job}, 묶음 ${opts.batchSize}`);
  for (const row of rows) io.out(`  key_id=${row.key_id ?? "(master)"} total=${row.total} missing=${row.missing}`);
  const { rows: [tables] } = await runtime.run(TABLES_SQL, ["agent_memory.backfill_watermarks", "agent_memory.backfill_failures"]);
  if (!tables?.watermark) {
    io.out("  작업 상태: watermark 표 없음(--confirm 실행이 만든다)");
    return;
  }
  const { rows: [state] } = await runtime.run(WATERMARK_SQL, [opts.job]);
  io.out(state ? `  작업 상태: last_id=${state.last_id} rows_done=${state.rows_done} status=${state.status}` : "  작업 상태: 기록 없음");
}

async function execute(runtime, opts, io) {
  await runtime.ensureBackfillTables(sql => runtime.run(sql, []));
  const spec = {
    job         : opts.job,
    where       : BACKFILL_WHERE,
    set         : BACKFILL_SET,
    batchSize   : opts.batchSize,
    restart     : opts.restart,
    prepareBatch: makePrepareBatch(runtime.run, runtime.tokenize)
  };
  const result = opts.retryFailures ? await runtime.retryBackfillFailures(spec) : await runtime.runResumableBackfill(spec);
  io.out(`[backfill-content-tokens] ${JSON.stringify(result)}`);
}

/**
 * 진입점. 종료 코드를 돌려준다.
 *
 * @param {string[]} argv
 * @param {Record<string, string|undefined>} env 연결 설정을 쓸 환경(보통 process.env)
 * @param {{out?: Function, err?: Function, loadRuntime?: Function}} [deps]
 * @returns {Promise<number>}
 */
export async function main(argv, env, deps = {}) {
  const io = {
    out: deps.out ?? (line => process.stdout.write(`${line}\n`)),
    err: deps.err ?? (line => process.stderr.write(`${line}\n`))
  };
  let runtime = null;
  try {
    const opts = parseBackfillArgs(argv);
    if (opts.help) { io.out(USAGE); return 0; }

    const { config: target, label } = resolveTarget(opts, env);
    prepareEnvironment(env, target);
    runtime = await (deps.loadRuntime ?? loadRuntime)(env);
    assertConfigMatches(runtime.config, target);
    io.out(`[backfill-content-tokens] 대상 ${label}`);
    await assertColumn(runtime);
    await (opts.confirm ? execute(runtime, opts, io) : preview(runtime, opts, io));
    return 0;
  } catch (err) {
    const usage = err instanceof BackfillUsageError || err instanceof OnlineIndexUsageError;
    io.err(`[backfill-content-tokens] ${usage ? "거부" : "실패"}: ${err.message}`);
    return usage ? 2 : 1;
  } finally {
    if (runtime) await runtime.shutdown();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main(process.argv.slice(2), process.env).then(code => process.exit(code));
}
