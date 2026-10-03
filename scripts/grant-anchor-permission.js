#!/usr/bin/env node
/**
 * grant-anchor-permission.js: 최근 앵커를 만든 키에 anchor 권한 부여
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 목적: 최근 90일 동안 앵커 파편(is_anchor, created_at)을 만든 키를 찾아, 활성이고 anchor 권한이 없는
 *       키 가운데 write 권한이 있는 키에만 anchor를 덧붙인다. 앵커 지정은 anchor 권한으로 분리되어 있으므로(MEMENTO_ANCHOR_PERMISSION)
 *       앵커를 실제로 쓰는 키가 배포 뒤에도 앵커를 계속 지정하게 한다. 배포 전에 실행한다(이전 버전의 서버는
 *       키 권한 목록의 anchor 값을 무시한다).
 * 출력: 대상 키(id, 이름, 상태, 권한, 90일 앵커 수, 처리)와 집계를 JSON 한 덩어리로 표준 출력에 쓴다.
 *       처리 값은 grant(부여 대상), skip_has_permission(anchor 또는 admin 보유), skip_inactive(비활성 키),
 *       skip_no_write(write 권한 없음). 기간 안의 앵커에는 정리 작업의 자동 앵커 승격으로 앵커가 된 파편도
 *       들어간다(is_anchor와 created_at만 보므로 지정 경로를 가리지 않는다).
 *
 * 접속 대상: --url 또는 표준 PG 환경변수(PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD).
 *            환경 파일은 읽지 않는다. 대상이 명시되지 않으면 실행하지 않는다.
 * 실행 모드: 기본은 dry-run이다(조회만 하고 쓰지 않는다). 실제 부여는 --apply가 있어야 하며
 *            조회와 갱신을 한 트랜잭션에서 실행한다. 다시 실행해도 안전하다(이미 부여된 키는 건너뛴다).
 *
 * 사용 예:
 *   PGHOST=... PGDATABASE=... PGUSER=... PGPASSWORD=... node scripts/grant-anchor-permission.js
 *   PGHOST=... PGDATABASE=... PGUSER=... PGPASSWORD=... node scripts/grant-anchor-permission.js --apply
 */

import path                                     from "node:path";
import { resolveTarget, OnlineIndexUsageError } from "./ops/online-index-plan.mjs";
import { hasAnchorPermission }                  from "../lib/rbac.js";
import { SCHEMA }                               from "../lib/memory/schema.js";

/** 앵커 생성 이력을 보는 기간(일) */
export const WINDOW_DAYS = 90;

/** 최근 기간에 앵커를 만든 키와 키별 앵커 수. $1은 기간(일)이다. */
export const CANDIDATES_SQL =
  `SELECT k.id, k.name, k.status, k.permissions, COUNT(*)::int AS anchors_created `
  + `FROM ${SCHEMA}.fragments f JOIN ${SCHEMA}.api_keys k ON k.id = f.key_id `
  + `WHERE f.is_anchor = TRUE AND f.created_at > now() - make_interval(days => $1) `
  + `GROUP BY k.id, k.name, k.status, k.permissions `
  + `ORDER BY anchors_created DESC, k.id`;

/** 대상 키에 anchor를 덧붙인다. 활성이고 write가 있으며 anchor가 없는 키만 바뀐다. $1은 키 id 배열이다. */
export const GRANT_SQL =
  `UPDATE ${SCHEMA}.api_keys SET permissions = array_append(permissions, 'anchor') `
  + `WHERE id = ANY($1::text[]) AND status = 'active' AND 'write' = ANY(permissions) `
  + `AND NOT ('anchor' = ANY(permissions)) `
  + `RETURNING id, name, permissions`;

const USAGE = [
  "사용법: node scripts/grant-anchor-permission.js [--apply] [--url <postgres 주소>]",
  "  (옵션 없음)            최근 90일 앵커를 만든 키와 처리 예정을 JSON으로 출력하고 쓰지 않는다",
  "  --apply                활성이고 write가 있으며 anchor가 없는 대상 키에 anchor를 부여한다",
  "  --url <postgres 주소>  접속 대상. 없으면 PGHOST, PGDATABASE 등 표준 PG 환경변수"
].join("\n");

/**
 * 인자를 읽는다.
 *
 * @param {string[]} argv
 * @returns {{apply: boolean, help: boolean, url?: string}}
 * @throws {OnlineIndexUsageError}
 */
export function parseGrantArgs(argv) {
  const opts = { apply: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply")      opts.apply = true;
    else if (arg === "--help")  opts.help  = true;
    else if (arg === "--url") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new OnlineIndexUsageError("--url 에 값이 필요하다");
      opts.url = value;
      i++;
    } else {
      throw new OnlineIndexUsageError(`알 수 없는 인자: ${arg.startsWith("--") ? arg : "(위치 인자)"}`);
    }
  }
  return opts;
}

/**
 * 대상 키의 처리를 정한다.
 *
 * @param {{status: string, permissions: string[]}} row
 * @returns {"grant"|"skip_has_permission"|"skip_inactive"|"skip_no_write"}
 */
export function classifyKey(row) {
  if (row.status !== "active")                  return "skip_inactive";
  if (hasAnchorPermission(row.permissions))      return "skip_has_permission";
  if (!(row.permissions ?? []).includes("write")) return "skip_no_write";
  return "grant";
}

/**
 * 출력 보고서를 만든다.
 *
 * @param {{mode: string, target: string, rows: Array<Object>, granted: string[]}} input
 * @returns {Object}
 */
function buildReport({ mode, target, rows, granted }) {
  const keys = rows.map(row => ({
    id            : row.id,
    name          : row.name,
    status        : row.status,
    permissions   : row.permissions,
    anchorsCreated: Number(row.anchors_created),
    action        : classifyKey(row)
  }));
  return {
    mode,
    target,
    windowDays: WINDOW_DAYS,
    keys,
    summary   : {
      candidates: keys.length,
      toGrant   : keys.filter(k => k.action === "grant").length,
      granted   : granted.length
    },
    granted
  };
}

/** 조회만 한다. */
async function dryRun(client, target) {
  const { rows } = await client.query(CANDIDATES_SQL, [WINDOW_DAYS]);
  return buildReport({ mode: "dry-run", target, rows, granted: [] });
}

/** 한 트랜잭션에서 조회하고 부여한다. 실패하면 되돌린다. */
async function apply(client, target) {
  await client.query("BEGIN");
  try {
    const { rows } = await client.query(CANDIDATES_SQL, [WINDOW_DAYS]);
    const targets  = rows.filter(row => classifyKey(row) === "grant").map(row => row.id);
    let   granted  = [];
    if (targets.length > 0) {
      const result = await client.query(GRANT_SQL, [targets]);
      granted      = result.rows.map(row => row.id);
    }
    await client.query("COMMIT");
    return buildReport({ mode: "apply", target, rows, granted });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

/** pg 연결을 연다. 기본 연결 함수. */
async function connectWithPg(config) {
  const { default: pg } = await import("pg");
  const client = new pg.Client(config);
  await client.connect();
  return client;
}

/**
 * 진입점. 종료 코드를 돌려준다: 0 성공, 1 실행 실패, 2 인자나 대상 거부.
 *
 * @param {string[]} argv
 * @param {Record<string, string|undefined>} env
 * @param {{connect?: Function, out?: Function, err?: Function}} [deps]
 * @returns {Promise<number>}
 */
export async function main(argv, env, deps = {}) {
  const io = {
    out: deps.out ?? (line => process.stdout.write(`${line}\n`)),
    err: deps.err ?? (line => process.stderr.write(`${line}\n`))
  };
  try {
    const opts = parseGrantArgs(argv);
    if (opts.help) { io.out(USAGE); return 0; }

    const target = resolveTarget(opts, env);
    const client = await (deps.connect ?? connectWithPg)(target.config);
    let   report;
    try {
      report = opts.apply ? await apply(client, target.label) : await dryRun(client, target.label);
    } finally {
      await client.end();
    }
    io.out(JSON.stringify(report, null, 2));
    if (!opts.apply) io.err("[grant-anchor-permission] dry-run: 쓰지 않았다. 부여하려면 --apply 를 준다");
    return 0;
  } catch (err) {
    const usage = err instanceof OnlineIndexUsageError;
    io.err(`[grant-anchor-permission] ${usage ? "거부" : "실패"}: ${err.message}`);
    return usage ? 2 : 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main(process.argv.slice(2), process.env).then(code => process.exit(code));
}
