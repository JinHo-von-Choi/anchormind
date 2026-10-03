#!/usr/bin/env node
/**
 * finish-dedup-scope.mjs: 중복 판정 범위 전환의 마무리 단계
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 목적: workspace 범위 content_hash 유일 색인(uq_frag_hash_ws_per_key, uq_frag_hash_ws_master)이
 *       유효한지 확인한 뒤 키 범위 색인(uq_frag_hash_per_key, uq_frag_hash_master)을
 *       DROP INDEX CONCURRENTLY 로 지운다. 표를 다시 만든 설치의 같은 정의 색인
 *       (fragments_new_key_id_content_hash_idx, fragments_new_content_hash_idx)도 함께 지운다.
 *       그 이름의 색인은 정의(유일, 키 열, 부분 색인 술어)가 같을 때만 지우고, 다르면 남기고 알린다.
 *       키 범위 색인이 pg_class 에서 사라져야(무효 상태로 남은 색인도 유일성을 강제하므로
 *       indisvalid 만 보지 않는다) 쓰기 경로가 workspace 범위로 판정한다.
 * 단계: 잠금 대기 제한 설정, 판정 색인 상태 출력, 새 색인 유효성 확인(아니면 거부), 열린 트랜잭션 경고,
 *       키 범위 색인 제거(55P03, 40P01 이면 대기 시간을 두 배로 늘리며 다시 시도), 제거 확인, 최종 상태 출력.
 *       다시 실행해도 안전하다(이미 지운 색인은 건너뛰고, 중단으로 무효 상태로 남은 색인은 다시 지운다).
 *
 * 접속 대상: --url 또는 표준 PG 환경변수(PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD).
 *            환경 파일은 읽지 않는다. 대상이 명시되지 않으면 실행하지 않는다.
 * 실행 모드: 기본은 연결 없이 단계만 출력한다. 실제 실행은 --confirm 이 있어야 한다.
 *
 * 사용 예:
 *   node scripts/ops/finish-dedup-scope.mjs
 *   PGHOST=... PGDATABASE=... PGUSER=... PGPASSWORD=... node scripts/ops/finish-dedup-scope.mjs --confirm
 */

import path             from "node:path";
import { INDEX_SCHEMA } from "./index-manifest.mjs";
import {
  OnlineIndexError, OnlineIndexUsageError, OnlineIndexPreconditionError,
  parseArgs, resolveTarget, retryDelayMs, sessionSql, formatPlan, OPEN_TXN_SQL, DEFAULT_LOCK_TIMEOUT,
} from "./online-index-plan.mjs";
import { warnOpenTransactions } from "./online-index.mjs";

/** workspace 범위 색인(migration-050). 앱의 DedupScope.DEDUP_INDEXES 와 같은 이름이다. */
export const NEW_INDEXES = Object.freeze(["uq_frag_hash_ws_per_key", "uq_frag_hash_ws_master"]);
/** 키 범위 색인(migration-031). */
export const OLD_INDEXES = Object.freeze(["uq_frag_hash_per_key", "uq_frag_hash_master"]);
/** 키 범위 색인의 다른 이름. 앱의 DedupScope.LEGACY_INDEX_ALIASES 와 같다. */
export const OLD_INDEX_ALIASES = Object.freeze({
  fragments_new_key_id_content_hash_idx: "uq_frag_hash_per_key",
  fragments_new_content_hash_idx       : "uq_frag_hash_master",
});
/** 키 범위 색인 정의. 앱의 DedupScope.LEGACY_INDEX_DEFINITIONS 와 같다. */
export const OLD_INDEX_DEFINITIONS = Object.freeze({
  uq_frag_hash_per_key: Object.freeze({ columns: Object.freeze(["key_id", "content_hash"]), predicate: "key_id IS NOT NULL" }),
  uq_frag_hash_master : Object.freeze({ columns: Object.freeze(["content_hash"]),           predicate: "key_id IS NULL" }),
});
/** 지울 수 있는 이름. 키 범위 색인마다 원래 이름, 다른 이름 순이다. */
export const LEGACY_NAMES = Object.freeze(OLD_INDEXES.flatMap(name => [
  name, ...Object.keys(OLD_INDEX_ALIASES).filter(alias => OLD_INDEX_ALIASES[alias] === name),
]));

/** 재시도로 회복할 수 있는 SQLSTATE: lock_not_available, deadlock_detected. */
const RETRIABLE_SQLSTATE = new Set(["55P03", "40P01"]);

/** 이 스크립트가 받지 않는 online-index 옵션. */
const UNUSED_OPTIONS = Object.freeze({ indexes: "--index", manifest: "--manifest", freeBytes: "--free-bytes", dataDir: "--data-dir" });

/** 판정 색인과 다른 이름 색인의 상태와 정의. $1 은 스키마, $2 는 이름 목록이다. */
export const STATE_SQL =
  "SELECT c.relname AS name, i.indisvalid AS valid, i.indisready AS ready, i.indisunique AS unique, "
  + "t.relname AS table_name, "
  + "ARRAY(SELECT pg_get_indexdef(i.indexrelid, k, true) FROM generate_series(1, i.indnkeyatts) AS k ORDER BY k) AS columns, "
  + "pg_get_expr(i.indpred, i.indrelid, true) AS predicate "
  + "FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_class t ON t.oid = i.indrelid "
  + "WHERE c.relnamespace = $1::regnamespace AND c.relname = ANY($2::text[]) "
  + "ORDER BY c.relname";

/** 이름이 남아 있는 관계. 제거 확인은 pg_class 를 직접 본다. */
export const EXISTS_SQL =
  "SELECT relname AS name FROM pg_class WHERE relnamespace = $1::regnamespace AND relname = ANY($2::text[])";

const USAGE = [
  "사용법: node scripts/ops/finish-dedup-scope.mjs [--confirm] [--url <postgres 주소>]",
  "  (옵션 없음)               연결하지 않고 단계만 출력한다",
  "  --confirm                 실제로 키 범위 색인(같은 정의의 다른 이름 색인 포함)을 지운다",
  "  --url <postgres 주소>     접속 대상. 없으면 PGHOST, PGDATABASE 등 표준 PG 환경변수",
  `  --lock-timeout <값>       잠금 대기 제한(기본 ${DEFAULT_LOCK_TIMEOUT})`,
  "  --retries <횟수>          실패 뒤 다시 시도할 횟수(기본 2)",
  "  --retry-wait-ms <ms>      첫 재시도 전 대기(기본 2000). 시도마다 두 배로 늘어난다",
  "  --retry-max-wait-ms <ms>  재시도 대기의 상한(기본 30000)",
].join("\n");

/** 키 범위 색인 제거를 마치지 못한 경우. */
export class FinishDedupScopeError extends OnlineIndexError {
  constructor(message, options) {
    super(message, options);
    this.name = "FinishDedupScopeError";
  }
}

/**
 * 인자를 읽는다. online-index 와 같은 형식이고 이 스크립트가 쓰지 않는 옵션은 거부한다.
 *
 * @param {string[]} argv
 * @returns {ReturnType<typeof parseArgs>}
 */
export function parseFinishArgs(argv) {
  const opts = parseArgs(argv);
  for (const [key, flag] of Object.entries(UNUSED_OPTIONS)) {
    const value = opts[key];
    if (value !== undefined && !(Array.isArray(value) && value.length === 0)) {
      throw new OnlineIndexUsageError(`${flag} 는 이 스크립트에서 쓰지 않는다`);
    }
  }
  return opts;
}

/** 색인 제거 문. */
export function dropOldSql(name) {
  return `DROP INDEX CONCURRENTLY IF EXISTS ${INDEX_SCHEMA}.${name}`;
}

/** 부분 색인 술어 비교용 표기. 공백을 모으고 바깥 괄호 한 겹을 벗긴다. */
function predicateText(predicate) {
  const text = String(predicate ?? "").replace(/\s+/g, " ").trim();
  return /^\(.*\)$/.test(text) ? text.slice(1, -1).trim() : text;
}

/**
 * 다른 이름의 색인이 대신하는 키 범위 색인과 같은 정의인지 본다. fragments 표의 유일 색인이고
 * 키 열과 부분 색인 술어가 같아야 한다.
 *
 * @param {{unique?: boolean, table_name?: string, columns?: string[], predicate?: (string|null)}} row
 * @param {string} legacy
 * @returns {boolean}
 */
export function aliasDefinitionMatches(row, legacy) {
  const expected = OLD_INDEX_DEFINITIONS[legacy];
  if (!expected || row?.unique !== true || row.table_name !== "fragments") return false;
  const columns = Array.isArray(row.columns) ? row.columns : [];
  return columns.length === expected.columns.length
    && columns.every((column, i) => column === expected.columns[i])
    && predicateText(row.predicate) === expected.predicate;
}

/** 제거 단계의 조건 설명. 다른 이름의 색인은 정의가 같을 때만 지운다. */
function dropCondition(name) {
  const legacy = OLD_INDEX_ALIASES[name];
  if (legacy === undefined) return "남아 있으면(무효 상태 포함) 지운다.";
  const { columns, predicate } = OLD_INDEX_DEFINITIONS[legacy];
  return `${legacy} 와 같은 정의(UNIQUE (${columns.join(", ")}) WHERE ${predicate})로 남아 있으면(무효 상태 포함) 지운다.`;
}

/**
 * 실행할 단계의 순서. 데이터베이스에는 닿지 않는다.
 *
 * @param {{lockTimeout: string, retries: number, targetLabel: string}} input
 * @returns {Array<{id: string, index?: string, sql?: string[], text: string}>}
 */
export function planFinish({ lockTimeout, retries, targetLabel }) {
  return [
    { id: "connect",          text: `대상 ${targetLabel} 에 연결한다` },
    { id: "session-settings", sql: sessionSql(lockTimeout), text: "세션의 잠금 대기와 문장 시간 제한을 설정한다" },
    { id: "inspect",          sql: [STATE_SQL], text: `판정 색인 네 개와 다른 이름 색인(${Object.keys(OLD_INDEX_ALIASES).join(", ")})의 indisvalid, indisready 를 출력한다` },
    { id: "require-new",      text: `${NEW_INDEXES.join(", ")} 가 모두 유효하지 않으면 아무것도 지우지 않고 거부한다` },
    { id: "txn-check",        sql: [OPEN_TXN_SQL], text: "열려 있는 트랜잭션을 경고한다(DROP INDEX CONCURRENTLY 는 이 트랜잭션을 기다린다)" },
    ...LEGACY_NAMES.map(name => ({
      id: "drop", index: name, sql: [dropOldSql(name)],
      text: `${dropCondition(name)} 55P03, 40P01 이면 최대 ${retries}회, 기본 대기를 시도마다 두 배로 늘리며 다시 시도한다`,
    })),
    { id: "verify",           sql: [EXISTS_SQL], text: `${LEGACY_NAMES.join(", ")} 가 pg_class 에 남아 있지 않은지(정의가 달라 남긴 색인 제외) 확인하고 최종 상태를 출력한다` },
  ];
}

/**
 * 색인 상태 행을 판정한다. 다른 이름의 색인은 정의가 같으면 지울 대상(oldPresent)이고, 다르면
 * mismatched 에 넣고 지우지 않는다.
 *
 * @param {Array<{name: string, valid: boolean, ready: boolean}>} rows
 * @returns {{newValid: boolean, missingNew: string[], oldPresent: string[], mismatched: string[], lines: string[]}}
 */
export function evaluateState(rows) {
  const byName     = new Map(rows.map(r => [r.name, r]));
  const missingNew = NEW_INDEXES.filter(n => byName.get(n)?.valid !== true);
  const mismatched = LEGACY_NAMES.filter(n => n in OLD_INDEX_ALIASES && byName.has(n)
    && !aliasDefinitionMatches(byName.get(n), OLD_INDEX_ALIASES[n]));
  const oldPresent = LEGACY_NAMES.filter(n => byName.has(n) && !mismatched.includes(n));
  const lines      = [...NEW_INDEXES, ...LEGACY_NAMES].map(name => {
    const row = byName.get(name);
    if (!row) return `${name}: 없음`;
    const note = mismatched.includes(name) ? ` (${OLD_INDEX_ALIASES[name]} 와 정의가 달라 지우지 않는다)` : "";
    return `${name}: valid=${row.valid} ready=${row.ready}${note}`;
  });
  return { newValid: missingNew.length === 0, missingNew, oldPresent, mismatched, lines };
}

/** 판정 색인 상태를 읽어 출력한다. */
async function readState(client, log) {
  const { rows } = await client.query(STATE_SQL, [INDEX_SCHEMA, [...NEW_INDEXES, ...LEGACY_NAMES]]);
  const state    = evaluateState(rows);
  for (const line of state.lines) log(line);
  return state;
}

/**
 * 색인 하나를 지운다. 잠금 대기 초과와 교착은 대기 뒤 다시 시도한다. 중단된 시도는 색인을 무효 상태로
 * 남길 수 있으며 다음 시도가 같은 문으로 지운다.
 */
async function dropWithRetry(client, name, { retries, retryWaitMs, retryMaxWaitMs, log, sleep }) {
  for (let attempt = 1; ; attempt++) {
    try {
      await client.query(dropOldSql(name));
      log(`${name} 을 지웠다`);
      return;
    } catch (err) {
      if (!RETRIABLE_SQLSTATE.has(err.code) || attempt > retries) {
        throw new FinishDedupScopeError(
          `${name} 을 지우지 못했다(시도 ${attempt}회). 무효 상태로 남았을 수 있으며 유일성은 계속 강제된다. `
          + "열린 트랜잭션이 끝난 뒤 다시 실행한다", { cause: err }
        );
      }
      const wait = retryDelayMs(attempt, retryWaitMs, retryMaxWaitMs);
      log(`${name} 제거가 ${err.code} 로 실패했다. ${wait}ms 뒤 다시 시도한다(${attempt}/${retries})`);
      await sleep(wait);
    }
  }
}

/** 연결된 대상에서 단계를 실행한다. */
async function executeFinish(client, opts, io, sleep) {
  const log = line => io.out(`[finish-dedup-scope] ${line}`);
  for (const sql of sessionSql(opts.lockTimeout)) await client.query(sql);

  const before = await readState(client, log);
  if (!before.newValid) {
    throw new OnlineIndexPreconditionError(
      `workspace 범위 색인이 유효하지 않다: ${before.missingNew.join(", ")}. `
      + `scripts/ops/online-index.mjs --confirm --index ${NEW_INDEXES.join(" --index ")} 로 먼저 만든다`
    );
  }
  if (before.oldPresent.length > 0) await warnOpenTransactions(client, log);
  for (const name of before.oldPresent) {
    await dropWithRetry(client, name, { ...opts, log, sleep });
  }
  for (const name of before.mismatched) {
    log(`경고: ${name} 은 ${OLD_INDEX_ALIASES[name]} 와 정의가 달라 지우지 않았다. 쓰기 경로도 판정 색인으로 보지 않는다`);
  }

  const targets  = LEGACY_NAMES.filter(n => !before.mismatched.includes(n));
  const { rows } = await client.query(EXISTS_SQL, [INDEX_SCHEMA, targets]);
  log("최종 상태");
  await readState(client, log);
  if (rows.length > 0) {
    throw new FinishDedupScopeError(`키 범위 색인이 남아 있다: ${rows.map(r => r.name).join(", ")}`);
  }
  log("완료: 키 범위 색인이 없다. 쓰기 경로는 다음 색인 상태 확인(최대 60초)부터 MEMENTO_DEDUP_SCOPE 대로 판정한다");
}

/** pg 연결을 연다. 기본 연결 함수. */
async function connectWithPg(config) {
  const { default: pg } = await import("pg");
  const client = new pg.Client(config);
  await client.connect();
  return client;
}

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** 접속 대상 표시. 단계만 출력할 때는 대상이 없어도 계획을 보여 준다. */
function planLabel(opts, env) {
  try {
    return resolveTarget(opts, env).label;
  } catch (err) {
    if (err instanceof OnlineIndexUsageError && opts.url === undefined) return "<--url 또는 PG 환경변수로 지정한 대상>";
    throw err;
  }
}

/**
 * 진입점. 종료 코드를 돌려준다: 0 성공, 1 실행 실패, 2 인자나 대상 거부.
 *
 * @param {string[]} argv
 * @param {Record<string, string|undefined>} env
 * @param {{connect?: Function, sleep?: Function, out?: Function, err?: Function}} [deps]
 * @returns {Promise<number>}
 */
export async function main(argv, env, deps = {}) {
  const io = {
    out: deps.out ?? (line => process.stdout.write(`${line}\n`)),
    err: deps.err ?? (line => process.stderr.write(`${line}\n`)),
  };
  try {
    const opts = parseFinishArgs(argv);
    if (opts.help) { io.out(USAGE); return 0; }
    if (!opts.confirm || opts.dryRun) {
      io.out(formatPlan(planFinish({ ...opts, targetLabel: planLabel(opts, env) })).join("\n"));
      if (!opts.dryRun) io.out("[finish-dedup-scope] 단계만 출력했다. 실제로 지우려면 --confirm 을 준다");
      return 0;
    }
    const target = resolveTarget(opts, env);
    io.out(formatPlan(planFinish({ ...opts, targetLabel: target.label })).join("\n"));
    const client = await (deps.connect ?? connectWithPg)(target.config);
    try {
      await executeFinish(client, opts, io, deps.sleep ?? defaultSleep);
    } finally {
      await client.end();
    }
    return 0;
  } catch (err) {
    const usage = err instanceof OnlineIndexUsageError;
    io.err(`[finish-dedup-scope] ${usage ? "거부" : "실패"}: ${err.message}`);
    if (err.cause) io.err(`[finish-dedup-scope] 원인: ${err.cause.message ?? err.cause}`);
    return usage ? 2 : 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main(process.argv.slice(2), process.env).then(code => process.exit(code));
}
