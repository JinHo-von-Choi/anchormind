#!/usr/bin/env node
/**
 * 복구 훈련: 덤프를 일회용 데이터베이스에 복원하고 원본 기록과 대조한다
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 입력은 backup.sh가 만든 덤프(.dump)와 같은 벌의 체크섬(.dump.sha256), 행 수 매니페스트
 * (.counts.json)다. 덤프의 체크섬을 확인하고, 일회용 데이터베이스(dbl_<pid>_<hex8>)에
 * 복원한 뒤, 복구본에서 같은 행 수 질의(drill-counts.sql)를 실행해 매니페스트와 대조한다.
 * 결과는 표 이름, 숫자, 파일 이름만 담은 JSON 한 개로 표준 출력에 낸다. 행 내용은 읽지도
 * 출력하지도 않는다. 끝나면 일회용 데이터베이스를 지운다(--keep 이면 남긴다).
 *
 * 복구 대상은 일회용 시험 서버뿐이다. 접속 값은 POSTGRES_HOST, POSTGRES_PORT,
 * POSTGRES_USER, POSTGRES_PASSWORD 환경변수에서 읽고(기본은 시험 컨테이너 localhost:35433),
 * 로컬 호스트의 시험 포트가 아니거나 시험 컨테이너 사용자와 비밀번호가 아니면 연결을
 * 열기 전에 거부한다. 운영 서버에는 접속하지 않으며 저장소의 환경 파일은 읽지 않는다.
 *
 * 종료 코드: 0 일치, 1 불일치 또는 실패, 2 사용법 또는 대상 거부
 *
 * 사용:
 *   node scripts/ops/restore-verify.mjs --dump <파일> [--manifest <파일>] [--keep]
 */

import crypto           from "node:crypto";
import fs               from "node:fs";
import path             from "node:path";
import { execFile }     from "node:child_process";
import { promisify }    from "node:util";
import { fileURLToPath } from "node:url";
import pg               from "pg";

import {
  RestoreRefusedError, RestoreVerifyError, resolveRestoreServer, assertRestoreTarget,
  assertRestoreDatabaseName, newRestoreDatabaseName, compareDrillCounts, parseDrillCounts,
  parseChecksumFile, sanitizePgErrors
} from "./restore-lib.mjs";

const execFileAsync = promisify(execFile);

const COUNTS_SQL_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "drill-counts.sql");

/**
 * 명령줄 인자를 해석한다.
 *
 * @param {string[]} argv
 * @returns {{dump: string, manifest: string|null, keep: boolean}}
 */
export function parseArgs(argv) {
  const out = { dump: "", manifest: null, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--keep") {
      out.keep = true;
    } else if (arg === "--dump" || arg === "--manifest") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new RestoreRefusedError(`${arg} 에 값이 필요하다`);
      out[arg.slice(2)] = value;
      i++;
    } else {
      throw new RestoreRefusedError(`알 수 없는 인자: ${arg}`);
    }
  }
  if (!out.dump) throw new RestoreRefusedError("--dump <파일> 이 필요하다");
  return out;
}

/**
 * 같은 벌의 사이드카 파일 경로. 덤프 경로의 확장자 .dump 를 바꿔 만든다.
 *
 * @param {string} dumpPath
 * @param {string} suffix
 * @returns {string}
 */
function sibling(dumpPath, suffix) {
  return dumpPath.endsWith(".dump") ? `${dumpPath.slice(0, -".dump".length)}${suffix}` : `${dumpPath}${suffix}`;
}

/**
 * 파일의 SHA-256을 스트림으로 계산한다.
 *
 * @param {string} file
 * @returns {Promise<string>}
 */
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash   = crypto.createHash("sha256");
    const stream = fs.createReadStream(file);
    stream.on("error", reject);
    stream.on("data", chunk => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * 덤프의 체크섬을 사이드카 파일과 대조한다.
 *
 * @param {string} dumpPath
 * @returns {Promise<"verified"|"mismatch"|"absent">}
 */
async function verifyChecksum(dumpPath) {
  const sidecar = `${dumpPath}.sha256`;
  if (!fs.existsSync(sidecar)) return "absent";
  const expected = parseChecksumFile(fs.readFileSync(sidecar, "utf8"), path.basename(dumpPath));
  return (await sha256File(dumpPath)) === expected ? "verified" : "mismatch";
}

/**
 * @param {{host: string, port: number, user: string, password: string}} server
 * @param {string} database
 * @returns {pg.ClientConfig}
 */
function clientConfig(server, database) {
  return { host: server.host, port: server.port, user: server.user, password: server.password, database };
}

/**
 * 연결 하나로 질의를 실행하고 닫는다.
 *
 * @param {pg.ClientConfig} config
 * @param {string} sql
 * @returns {Promise<pg.QueryResult>}
 */
async function queryOnce(config, sql) {
  const client = new pg.Client(config);
  await client.connect();
  try {
    return await client.query(sql);
  } finally {
    await client.end();
  }
}

/**
 * 일회용 데이터베이스를 지운다. 이름이 복구 훈련 형식이 아니면 지우지 않는다.
 *
 * @param {{host: string, port: number, user: string, password: string}} server
 * @param {string} name
 * @returns {Promise<void>}
 */
async function dropDatabase(server, name) {
  assertRestoreDatabaseName(name);
  const client = new pg.Client(clientConfig(server, "postgres"));
  await client.connect();
  try {
    await client.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [name]
    );
    await client.query(`DROP DATABASE IF EXISTS "${name}"`);
  } finally {
    await client.end();
  }
}

/**
 * 덤프를 일회용 데이터베이스에 복원한다. 소유자와 권한은 복원하지 않는다.
 *
 * @param {{host: string, port: number, user: string, password: string}} server
 * @param {string} name
 * @param {string} dumpPath
 * @returns {Promise<void>}
 */
async function restoreInto(server, name, dumpPath) {
  await queryOnce(clientConfig(server, name), "CREATE EXTENSION IF NOT EXISTS vector");
  await queryOnce(clientConfig(server, name), "CREATE EXTENSION IF NOT EXISTS pg_trgm");
  try {
    await execFileAsync(
      "pg_restore",
      ["--no-owner", "--no-privileges", "--exit-on-error", `--dbname=${name}`, dumpPath],
      {
        env: {
          PATH      : process.env.PATH,
          PGHOST    : server.host,
          PGPORT    : String(server.port),
          PGUSER    : server.user,
          PGPASSWORD: server.password
        },
        maxBuffer: 16 * 1024 * 1024
      }
    );
  } catch (err) {
    if (err.code === "ENOENT") throw new RestoreVerifyError("pg_restore 를 PATH 에서 찾지 못했다", { cause: err });
    const lines = sanitizePgErrors(err.stderr || "");
    throw new RestoreVerifyError(`pg_restore 실패 (종료 코드 ${String(err.code)}): ${lines.join(" | ") || "보고할 수 있는 오류 줄 없음"}`, { cause: err });
  }
}

/**
 * 복구 훈련을 실행하고 보고를 돌려준다. 대상 서버 검사가 통과하기 전에는 어떤 연결도
 * 열지 않고 어떤 파일도 읽지 않는다.
 *
 * @param {string[]} argv
 * @param {Record<string, string|undefined>} [env=process.env]
 * @returns {Promise<{ok: boolean} & Record<string, unknown>>}
 */
export async function run(argv, env = process.env) {
  const args   = parseArgs(argv);
  const server = resolveRestoreServer(env);
  assertRestoreTarget(server, env);

  const dumpPath     = path.resolve(args.dump);
  const manifestPath = path.resolve(args.manifest ?? sibling(dumpPath, ".counts.json"));
  for (const file of [dumpPath, manifestPath]) {
    if (!fs.existsSync(file)) throw new RestoreVerifyError(`파일이 없다: ${path.basename(file)}`);
  }

  const source   = parseDrillCounts(fs.readFileSync(manifestPath, "utf8"));
  const checksum = await verifyChecksum(dumpPath);
  const report   = {
    ok        : false,
    dump      : path.basename(dumpPath),
    manifest  : path.basename(manifestPath),
    target    : { host: server.host, port: server.port, database: null, kept: args.keep },
    checksum  : { status: checksum },
    restoreMs : null,
    comparison: null,
    error     : null,
    cleanup   : null
  };
  if (checksum !== "verified") {
    report.error = checksum === "absent" ? "체크섬 파일이 없다" : "체크섬이 일치하지 않는다";
    return report;
  }

  const name = newRestoreDatabaseName();
  report.target.database = name;
  await queryOnce(clientConfig(server, "postgres"), `CREATE DATABASE "${name}"`);

  try {
    const started = Date.now();
    await restoreInto(server, name, dumpPath);
    report.restoreMs = Date.now() - started;

    const sql      = fs.readFileSync(COUNTS_SQL_PATH, "utf8");
    const { rows } = await queryOnce(clientConfig(server, name), sql);
    const restored = parseDrillCounts(Object.values(rows[0])[0]);

    report.comparison = compareDrillCounts(source, restored);
    report.ok         = report.comparison.ok;
  } catch (err) {
    report.error = err instanceof RestoreVerifyError ? err.message : `${err.name}: ${err.message}`.slice(0, 300);
  } finally {
    if (args.keep) {
      report.cleanup = { dropped: false };
    } else {
      try {
        await dropDatabase(server, name);
        report.cleanup = { dropped: true };
      } catch (err) {
        report.cleanup = { dropped: false, error: `${err.name}: ${err.message}`.slice(0, 300) };
        report.ok      = false;
      }
    }
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await run(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.ok ? 0 : 1;
  } catch (err) {
    if (err instanceof RestoreRefusedError) {
      process.stdout.write(`${JSON.stringify({ ok: false, refused: true, error: err.message }, null, 2)}\n`);
      process.exitCode = 2;
    } else if (err instanceof RestoreVerifyError) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: err.message }, null, 2)}\n`);
      process.exitCode = 1;
    } else {
      throw err;
    }
  }
}
