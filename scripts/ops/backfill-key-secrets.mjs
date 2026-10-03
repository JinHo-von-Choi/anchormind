#!/usr/bin/env node
/**
 * backfill-key-secrets.mjs: api_keys의 현재 해시를 api_key_secrets로 옮긴다
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 목적: migration-059 뒤 인증은 api_key_secrets를 먼저 보고 해시가 없을 때만 api_keys.key_hash를 본다.
 *       이 스크립트는 비밀 표에 행이 없는 키의 현재 해시를 일괄 insert-select로 옮기고(ON CONFLICT DO NOTHING,
 *       다시 실행해도 안전), 정합을 확인한다. 폐기한 키(revoked_at)의 행은 revoked로 옮긴다.
 * 정합: 모든 키에 현재 해시(api_keys.key_hash)와 같은 비밀 행이 있고, 활성 키 수가 활성 현재 비밀 행 수와 같으며,
 *       폐기한 키에 활성 비밀 행이 없다.
 *       회전 겹침 중인 이전 비밀 행은 따로 센다.
 *
 * 접속 대상: --url 또는 표준 PG 환경변수(PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD).
 *            환경 파일은 읽지 않는다. 대상이 명시되지 않으면 연결하지 않는다.
 * 실행 모드: 기본은 읽기 전용 트랜잭션에서 옮길 건수와 정합만 출력한다. 실제로 옮기려면 --confirm 을 준다.
 *            옮긴 뒤 정합이 맞지 않으면 종료 코드 1이다.
 *
 * 사용 예:
 *   node scripts/ops/backfill-key-secrets.mjs --url postgresql://user@host/db
 *   PGHOST=... PGDATABASE=... PGUSER=... PGPASSWORD=... node scripts/ops/backfill-key-secrets.mjs --confirm
 */

import path             from "node:path";
import { INDEX_SCHEMA } from "./index-manifest.mjs";
import {
  OnlineIndexError, OnlineIndexUsageError, parseArgs, resolveTarget,
} from "./online-index-plan.mjs";

/** 한 번에 옮기는 키 수 */
export const BACKFILL_BATCH = 500;

const KEYS    = `${INDEX_SCHEMA}.api_keys`;
const SECRETS = `${INDEX_SCHEMA}.api_key_secrets`;

/** 이 스크립트가 받지 않는 online-index 옵션 */
const UNUSED_OPTIONS = Object.freeze({ indexes: "--index", manifest: "--manifest", freeBytes: "--free-bytes", dataDir: "--data-dir" });

export const TABLE_SQL = `SELECT to_regclass('${SECRETS}') IS NOT NULL AS present`;

/** 비밀 표에 현재 해시 행이 없는 키 수 */
export const MISSING_SQL =
  `SELECT count(*)::int AS missing FROM ${KEYS} k WHERE NOT EXISTS (SELECT 1 FROM ${SECRETS} s WHERE s.key_hash = k.key_hash)`;

/**
 * 일괄 이관 한 번. $1 은 건수 상한이다. 키 행을 FOR SHARE로 잠가 같은 키의 폐기, 회전(FOR UPDATE)과 직렬화하고,
 * 잠근 뒤의 행 값으로 상태를 정하므로 폐기한 키(revoked_at)에 활성 비밀 행을 만들지 않는다.
 * 비활성(status inactive)이지만 폐기하지 않은 키는 다시 활성화할 수 있으므로 활성 행으로 옮긴다.
 */
export const BACKFILL_SQL = `WITH batch AS (
  SELECT k.key_hash, k.id, k.key_prefix, k.created_at, k.revoked_at
  FROM   ${KEYS} k
  WHERE  NOT EXISTS (SELECT 1 FROM ${SECRETS} s WHERE s.key_hash = k.key_hash)
  ORDER BY k.id
  LIMIT  $1
  FOR SHARE OF k
)
INSERT INTO ${SECRETS} (key_hash, key_id, key_prefix, created_at, status)
SELECT key_hash, id, key_prefix, created_at, CASE WHEN revoked_at IS NULL THEN 'active' ELSE 'revoked' END
FROM   batch
ON CONFLICT (key_hash) DO NOTHING`;

/** 정합 확인 */
export const CONSISTENCY_SQL = `SELECT
  count(*)::int AS keys_total,
  count(s.key_hash)::int AS keys_with_secret,
  count(*) FILTER (WHERE k.status = 'active' AND k.revoked_at IS NULL)::int AS active_keys,
  count(*) FILTER (WHERE k.status = 'active' AND k.revoked_at IS NULL AND s.status = 'active'
                     AND (s.valid_until IS NULL OR s.valid_until > NOW()))::int AS active_keys_with_active_secret,
  (SELECT count(*) FROM ${SECRETS} x WHERE x.status = 'active')::int AS active_secret_rows,
  (SELECT count(*) FROM ${SECRETS} x JOIN ${KEYS} y ON y.id = x.key_id
    WHERE x.key_hash <> y.key_hash AND x.status = 'active'
      AND (x.valid_until IS NULL OR x.valid_until > NOW()))::int AS overlap_secret_rows,
  (SELECT count(*) FROM ${SECRETS} x JOIN ${KEYS} y ON y.id = x.key_id
    WHERE y.revoked_at IS NOT NULL AND x.status = 'active')::int AS active_secrets_of_revoked_keys
FROM ${KEYS} k
LEFT JOIN ${SECRETS} s ON s.key_hash = k.key_hash AND s.key_id = k.id`;

const USAGE = [
  "사용법: node scripts/ops/backfill-key-secrets.mjs [--confirm] [--url <postgres 주소>]",
  "  (옵션 없음)            읽기 전용으로 옮길 건수와 정합만 출력한다",
  "  --confirm              비밀 표에 행이 없는 키의 현재 해시를 옮기고 정합을 확인한다",
  "  --url <postgres 주소>  접속 대상. 없으면 PGHOST, PGDATABASE 등 표준 PG 환경변수",
  `  --lock-timeout <값>    잠금 대기 제한(기본 3s)`,
].join("\n");

/** 이관이나 정합 확인을 마치지 못한 경우 */
export class BackfillKeySecretsError extends OnlineIndexError {
  constructor(message, options) {
    super(message, options);
    this.name = "BackfillKeySecretsError";
  }
}

/**
 * 정합 판정.
 *
 * @param {{ keys_total: number, keys_with_secret: number, active_keys: number, active_keys_with_active_secret: number,
 *           active_secrets_of_revoked_keys?: number }} row
 * @returns {{ consistent: boolean, problems: string[] }}
 */
export function consistencyVerdict(row) {
  const problems = [];
  if (row.keys_with_secret !== row.keys_total) {
    problems.push(`현재 해시 비밀 행이 없는 키 ${row.keys_total - row.keys_with_secret}건`);
  }
  if (row.active_keys_with_active_secret !== row.active_keys) {
    problems.push(`활성 키 ${row.active_keys}건, 활성 현재 비밀 행 ${row.active_keys_with_active_secret}건`);
  }
  if ((row.active_secrets_of_revoked_keys ?? 0) !== 0) {
    problems.push(`폐기한 키의 활성 비밀 행 ${row.active_secrets_of_revoked_keys}건`);
  }
  return { consistent: problems.length === 0, problems };
}

/**
 * 정합 출력 줄.
 *
 * @param {object} row
 * @returns {string}
 */
function formatCounts(row) {
  return `키 ${row.keys_total}건(현재 해시 비밀 행 ${row.keys_with_secret}건), 활성 키 ${row.active_keys}건, `
    + `활성 현재 비밀 행 ${row.active_keys_with_active_secret}건, 활성 비밀 행 전체 ${row.active_secret_rows}건(회전 겹침 ${row.overlap_secret_rows}건), `
    + `폐기한 키의 활성 비밀 행 ${row.active_secrets_of_revoked_keys}건`;
}

/**
 * 인자를 읽는다. online-index 와 같은 형식이고 이 스크립트가 쓰지 않는 옵션은 거부한다.
 *
 * @param {string[]} argv
 * @returns {ReturnType<typeof parseArgs>}
 */
export function parseBackfillArgs(argv) {
  const opts = parseArgs(argv);
  for (const [key, flag] of Object.entries(UNUSED_OPTIONS)) {
    const value = opts[key];
    if (value !== undefined && !(Array.isArray(value) && value.length === 0)) {
      throw new OnlineIndexUsageError(`${flag} 는 이 스크립트에서 쓰지 않는다`);
    }
  }
  return opts;
}

/** pg 연결을 연다. 기본 연결 함수. */
async function connectWithPg(config) {
  const { default: pg } = await import("pg");
  const client = new pg.Client(config);
  await client.connect();
  return client;
}

/**
 * 비밀 표가 있는지 확인한다.
 *
 * @param {{ query: Function }} client
 */
async function assertSecretsTable(client) {
  const { rows } = await client.query(TABLE_SQL);
  if (!rows[0]?.present) throw new BackfillKeySecretsError(`${SECRETS} 표가 없다. migration-059 를 먼저 적용한다`);
}

/**
 * 읽기 전용 점검. 옮길 건수와 정합을 출력한다.
 *
 * @param {{ query: Function }} client
 * @param {{ out: Function }} io
 */
async function inspect(client, io) {
  await client.query("BEGIN READ ONLY");
  try {
    await assertSecretsTable(client);
    const { rows: [missing] } = await client.query(MISSING_SQL);
    const { rows: [counts] }  = await client.query(CONSISTENCY_SQL);
    io.out(`[backfill-key-secrets] 옮길 키 ${missing.missing}건`);
    io.out(`[backfill-key-secrets] ${formatCounts(counts)}`);
  } finally {
    await client.query("ROLLBACK");
  }
  io.out("[backfill-key-secrets] 읽기만 했다. 실제로 옮기려면 --confirm 을 준다");
}

/**
 * 일괄 이관과 정합 확인.
 *
 * @param {{ query: Function }} client
 * @param {{ lockTimeout: string }} opts
 * @param {{ out: Function }} io
 */
async function execute(client, opts, io) {
  await assertSecretsTable(client);
  await client.query(`SET lock_timeout = '${opts.lockTimeout}'`);
  const { rows: [missing] } = await client.query(MISSING_SQL);
  const maxBatches = Math.ceil(missing.missing / BACKFILL_BATCH) + 1;

  let moved = 0;
  for (let i = 0; i < maxBatches; i++) {
    const { rowCount } = await client.query(BACKFILL_SQL, [BACKFILL_BATCH]);
    moved += rowCount;
    if (rowCount === 0) break;
  }
  io.out(`[backfill-key-secrets] 옮긴 키 ${moved}건`);

  const { rows: [counts] } = await client.query(CONSISTENCY_SQL);
  io.out(`[backfill-key-secrets] ${formatCounts(counts)}`);
  const verdict = consistencyVerdict(counts);
  if (!verdict.consistent) throw new BackfillKeySecretsError(`정합 불일치: ${verdict.problems.join(", ")}`);
  io.out("[backfill-key-secrets] 정합: 일치");
}

/**
 * 진입점. 종료 코드를 돌려준다: 0 성공, 1 실행 실패나 정합 불일치, 2 인자나 대상 거부.
 *
 * @param {string[]} argv
 * @param {Record<string, string|undefined>} env
 * @param {{connect?: Function, out?: Function, err?: Function}} [deps]
 * @returns {Promise<number>}
 */
export async function main(argv, env, deps = {}) {
  const io = {
    out: deps.out ?? (line => process.stdout.write(`${line}\n`)),
    err: deps.err ?? (line => process.stderr.write(`${line}\n`)),
  };
  try {
    const opts = parseBackfillArgs(argv);
    if (opts.help) { io.out(USAGE); return 0; }
    const target = resolveTarget(opts, env);
    io.out(`[backfill-key-secrets] 대상: ${target.label}`);
    const client = await (deps.connect ?? connectWithPg)(target.config);
    try {
      if (opts.confirm && !opts.dryRun) await execute(client, opts, io);
      else await inspect(client, io);
    } finally {
      await client.end();
    }
    return 0;
  } catch (err) {
    const usage = err instanceof OnlineIndexUsageError;
    io.err(`[backfill-key-secrets] ${usage ? "거부" : "실패"}: ${err.message}`);
    if (err.cause) io.err(`[backfill-key-secrets] 원인: ${err.cause.message ?? err.cause}`);
    return usage ? 2 : 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main(process.argv.slice(2), process.env).then(code => process.exit(code));
}
