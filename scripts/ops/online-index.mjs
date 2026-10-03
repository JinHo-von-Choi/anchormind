#!/usr/bin/env node
/**
 * online-index.mjs: 대형 표 색인을 쓰기 정지 없이 만드는 운영 스크립트
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 목적: fragments, fragment_links, case_events, search_events 의 색인을
 *       scripts/ops/index-manifest.json 의 작업 항목대로 CREATE INDEX CONCURRENTLY 로 만든다.
 *       마이그레이션 파일에는 같은 이름의 IF NOT EXISTS 문만 두고, 이 스크립트가 먼저 만든 색인이
 *       있으면 그 문이 건너뛴다.
 * 호출 조건: 대형 표 색인을 추가하는 배포 전, 저트래픽 시간대, 배포 전 백업 완료 후.
 * 단계: 잠금 대기 제한 설정, 디스크 여유 확인(표 크기의 2배), pg_index.indisvalid 확인,
 *       무효 색인 제거 후 재시도.
 *
 * 접속 대상: --url 또는 표준 PG 환경변수(PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD).
 *            환경 파일은 읽지 않는다. 대상이 명시되지 않으면 실행하지 않는다.
 * 실행 모드: --dry-run 은 연결 없이 단계 순서만 출력한다. 실제 실행은 --confirm 이 있어야 한다.
 *
 * 사용 예:
 *   node scripts/ops/online-index.mjs --dry-run --index idx_example
 *   PGHOST=... PGDATABASE=... PGUSER=... PGPASSWORD=... \
 *     node scripts/ops/online-index.mjs --confirm --index idx_example --data-dir /var/lib/postgresql/data
 */

import path             from "node:path";
import { statfs }       from "node:fs/promises";
import { loadManifest, findBuildableEntry, IndexManifestError, INDEX_SCHEMA } from "./index-manifest.mjs";
import {
  OnlineIndexError, OnlineIndexUsageError, OnlineIndexPreconditionError, OnlineIndexBuildError,
  parseArgs, resolveTarget, resolveFreeBytes, requiredDiskBytes, createSql, dropSql,
  sessionSql, planSteps, formatPlan, INSPECT_SQL, TABLE_SIZE_SQL, DEFAULT_LOCK_TIMEOUT,
} from "./online-index-plan.mjs";

/** 재시도로 회복할 수 있는 SQLSTATE: lock_not_available, deadlock_detected. */
const RETRIABLE_SQLSTATE = new Set(["55P03", "40P01"]);

const USAGE = [
  "사용법: node scripts/ops/online-index.mjs (--dry-run | --confirm) --index <이름> [--index <이름> ...]",
  "  --url <postgres 주소>     접속 대상. 없으면 PGHOST, PGDATABASE 등 표준 PG 환경변수",
  "  --manifest <경로>         작업 목록(기본 scripts/ops/index-manifest.json)",
  `  --lock-timeout <값>       잠금 대기 제한(기본 ${DEFAULT_LOCK_TIMEOUT})`,
  "  --retries <횟수>          실패 뒤 다시 시도할 횟수(기본 2)",
  "  --retry-wait-ms <ms>      재시도 사이 대기(기본 2000)",
  "  --free-bytes <바이트>     디스크 여유(실제 실행에 필요)",
  "  --data-dir <경로>         디스크 여유를 읽을 데이터 디렉터리(--free-bytes 대신)",
].join("\n");

/**
 * 색인 상태를 읽는다.
 *
 * @param {{query: Function}} client
 * @param {{name: string, table: string}} entry
 * @returns {Promise<"absent"|"valid"|"invalid">}
 * @throws {OnlineIndexPreconditionError} 같은 이름의 색인이 다른 표에 있을 때
 */
export async function inspectIndex(client, entry) {
  const { rows } = await client.query(INSPECT_SQL, [INDEX_SCHEMA, entry.name]);
  if (rows.length === 0) return "absent";

  const [row] = rows;
  if (row.table_schema !== INDEX_SCHEMA || row.table_name !== entry.table) {
    throw new OnlineIndexPreconditionError(
      `색인 ${entry.name} 이 이미 ${row.table_schema}.${row.table_name} 에 있다. 대상은 ${INDEX_SCHEMA}.${entry.table} 이다.`
    );
  }
  return row.valid ? "valid" : "invalid";
}

/** 무효인 색인만 제거한다. 유효한 색인은 건드리지 않는다. */
async function dropIfInvalid(client, entry, log) {
  if (await inspectIndex(client, entry) !== "invalid") return;
  log(`무효 색인 ${entry.name} 을 제거한다`);
  await client.query(dropSql(entry));
}

/** 대상 표 크기의 2배가 여유보다 크면 거부한다. */
async function assertDiskRoom(client, entry, freeBytes, log) {
  const { rows } = await client.query(TABLE_SIZE_SQL, [`${INDEX_SCHEMA}.${entry.table}`]);
  const tableBytes = Number(rows[0].bytes);
  const need       = requiredDiskBytes(tableBytes);
  log(`${entry.table} 크기 ${tableBytes} 바이트, 필요 여유 ${need} 바이트, 현재 여유 ${freeBytes} 바이트`);
  if (need > freeBytes) {
    throw new OnlineIndexPreconditionError(
      `디스크 여유가 부족하다: ${entry.table} 크기의 2배 ${need} 바이트가 필요하고 여유는 ${freeBytes} 바이트다.`
    );
  }
}

/**
 * 한 번의 생성 시도. 성공하면 true, 재시도 가능한 실패면 false 를 돌려준다.
 * 재시도할 수 없는 오류는 무효 색인을 정리한 뒤 그대로 던진다.
 */
async function attemptCreate(client, entry, log) {
  try {
    await client.query(createSql(entry));
  } catch (err) {
    await dropIfInvalid(client, entry, log);
    if (!RETRIABLE_SQLSTATE.has(err.code)) throw err;
    log(`재시도 가능한 오류 ${err.code}: ${err.message}`);
    return false;
  }

  if (await inspectIndex(client, entry) === "valid") return true;
  log(`색인 ${entry.name} 이 유효하지 않다`);
  await dropIfInvalid(client, entry, log);
  return false;
}

/**
 * 색인 하나를 만든다. 이미 유효한 색인이 있으면 건너뛴다.
 *
 * @param {{query: Function}} client
 * @param {object} entry 작업 목록의 작업 항목
 * @param {{freeBytes: number, retries: number, retryWaitMs: number,
 *          log: (line: string) => void, sleep: (ms: number) => Promise<void>}} opts
 * @returns {Promise<{status: "exists"|"created", attempts: number}>}
 * @throws {OnlineIndexPreconditionError|OnlineIndexBuildError}
 */
export async function buildIndexOnline(client, entry, opts) {
  const { freeBytes, retries, retryWaitMs, log, sleep } = opts;

  await assertDiskRoom(client, entry, freeBytes, log);

  const state = await inspectIndex(client, entry);
  if (state === "valid") {
    log(`색인 ${entry.name} 이 이미 유효하다. 건너뛴다`);
    return { status: "exists", attempts: 0 };
  }
  if (state === "invalid") await dropIfInvalid(client, entry, log);

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    log(`색인 ${entry.name} 생성 시도 ${attempt}/${retries + 1}`);
    if (await attemptCreate(client, entry, log)) {
      log(`색인 ${entry.name} 이 유효하다`);
      return { status: "created", attempts: attempt };
    }
    if (attempt <= retries) await sleep(retryWaitMs);
  }

  throw new OnlineIndexBuildError(`색인 ${entry.name} 을 ${retries + 1}번 시도했으나 유효하게 만들지 못했다`);
}

/** pg 연결을 연다. 기본 연결 함수. */
async function connectWithPg(config) {
  const { default: pg } = await import("pg");
  const client = new pg.Client(config);
  await client.connect();
  return client;
}

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** 선택한 색인의 작업 항목을 모은다. */
function selectEntries(opts) {
  if (opts.indexes.length === 0) throw new OnlineIndexUsageError("--index 를 하나 이상 준다");
  const manifest = loadManifest(opts.manifest);
  return opts.indexes.map(name => findBuildableEntry(manifest, name));
}

/** 접속 대상 표시. 드라이런은 대상이 없어도 계획을 보여 준다. */
function dryRunLabel(opts, env) {
  try {
    return resolveTarget(opts, env).label;
  } catch (err) {
    if (err instanceof OnlineIndexUsageError && opts.url === undefined) return "<--url 또는 PG 환경변수로 지정한 대상>";
    throw err;
  }
}

/** 연결된 대상에서 계획을 실행한다. */
async function executePlan({ client, entries, opts, freeBytes, io, sleep }) {
  for (const sql of sessionSql(opts.lockTimeout)) await client.query(sql);

  const log     = line => io.out(`[online-index] ${line}`);
  const results = [];
  for (const entry of entries) {
    const result = await buildIndexOnline(client, entry, {
      freeBytes, retries: opts.retries, retryWaitMs: opts.retryWaitMs, log, sleep,
    });
    results.push(`${entry.name}: ${result.status}`);
  }
  io.out(`[online-index] 완료: ${results.join(", ")}`);
}

/** 실제 실행 경로. --confirm 확인 뒤에만 연결한다. */
async function runReal({ opts, entries, env, deps, io }) {
  if (!opts.confirm) {
    throw new OnlineIndexUsageError(
      "실제 실행에는 --confirm 이 필요하다. 배포 전 백업 완료를 확인한 뒤 주고, 단계만 보려면 --dry-run 을 쓴다."
    );
  }
  const target    = resolveTarget(opts, env);
  const freeBytes = await resolveFreeBytes(opts, deps.statfs ?? statfs);

  io.out(formatPlan(planSteps({ entries, lockTimeout: opts.lockTimeout, retries: opts.retries, targetLabel: target.label })).join("\n"));
  const client = await (deps.connect ?? connectWithPg)(target.config);
  try {
    await executePlan({ client, entries, opts, freeBytes, io, sleep: deps.sleep ?? defaultSleep });
  } finally {
    await client.end();
  }
}

/**
 * 진입점. 종료 코드를 돌려준다: 0 성공, 1 실행 실패, 2 인자나 대상 거부.
 *
 * @param {string[]} argv
 * @param {Record<string, string|undefined>} env
 * @param {{connect?: Function, statfs?: Function, sleep?: Function, out?: Function, err?: Function}} [deps]
 * @returns {Promise<number>}
 */
export async function main(argv, env, deps = {}) {
  const io = {
    out: deps.out ?? (line => process.stdout.write(`${line}\n`)),
    err: deps.err ?? (line => process.stderr.write(`${line}\n`)),
  };

  try {
    const opts = parseArgs(argv);
    if (opts.help) { io.out(USAGE); return 0; }

    const entries = selectEntries(opts);
    if (opts.dryRun) {
      const steps = planSteps({ entries, lockTimeout: opts.lockTimeout, retries: opts.retries, targetLabel: dryRunLabel(opts, env) });
      io.out(formatPlan(steps).join("\n"));
      return 0;
    }
    await runReal({ opts, entries, env, deps, io });
    return 0;
  } catch (err) {
    return reportFailure(err, io);
  }
}

/** 오류를 출력하고 종료 코드를 정한다. */
function reportFailure(err, io) {
  const usage = err instanceof OnlineIndexUsageError || err instanceof IndexManifestError;
  io.err(`[online-index] ${usage ? "거부" : "실패"}: ${err.message}`);
  if (err.cause) io.err(`[online-index] 원인: ${err.cause.message ?? err.cause}`);
  if (!usage && !(err instanceof OnlineIndexError)) io.err(String(err.stack ?? ""));
  return usage ? 2 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main(process.argv.slice(2), process.env).then(code => process.exit(code));
}
