/**
 * DB 동시성 시험 공통 도구
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 실제 PostgreSQL에 붙는 시험이 쓰는 데이터베이스 준비와 정리, 시드 파편 생성,
 * 교착 계측을 모은다. 시험은 실행마다 자기 데이터베이스를 만들어 쓰고 끝나면
 * 지운다. 접속 값은 prepareLaneDatabase 한 곳에서 정해 process.env에 넣으며,
 * 앱 풀과 직접 연결 모두 그 값을 쓴다. 따라서 앱 모듈은 이 함수가 끝난 뒤에
 * 불러와야 한다. DB에 닿지 못하면 건너뛰지 않고 실패한다.
 *
 * 교착은 두 곳에서 센다. 하나는 pg 클라이언트의 질의 결과로, 던져진 오류든
 * 호출자가 삼킨 오류든 SQLSTATE 40P01이면 질의 문장과 함께 기록한다. 다른 하나는
 * 서버가 집계한 이 실행 데이터베이스의 pg_stat_database.deadlocks 증가분이다.
 */

import crypto           from "node:crypto";
import os               from "node:os";
import path             from "node:path";
import fs               from "node:fs";
import { execFile }     from "node:child_process";
import { promisify }    from "node:util";
import pg               from "pg";
import {
  resolveLaneServer, assertLaneServer, assertLaneDatabaseName, newLaneDatabaseName
} from "./_guard.js";

const execFileAsync = promisify(execFile);

export const SCHEMA = "agent_memory";

const MIGRATE_SCRIPT = path.join(import.meta.dirname, "../../scripts/migrate.js");

/** 준비된 실행 데이터베이스. {name, server} */
let lane = null;

/**
 * 준비된 실행 데이터베이스 이름.
 *
 * @returns {string}
 */
export function laneDatabaseName() {
  if (!lane) throw new Error("prepareLaneDatabase()를 먼저 호출해야 한다");
  return lane.name;
}

/**
 * 실행 데이터베이스에 붙는 pg 연결 설정. 값은 prepareLaneDatabase가 정한 것뿐이다.
 *
 * @returns {pg.ClientConfig}
 */
export function directClientConfig() {
  if (!lane) throw new Error("prepareLaneDatabase()를 먼저 호출해야 한다");
  const { server, name } = lane;
  return { host: server.host, port: server.port, user: server.user, password: server.password, database: name };
}

/**
 * 같은 서버의 관리용 데이터베이스(postgres)에 붙는 연결 설정.
 *
 * @param {{host: string, port: number, user: string, password: string}} server
 * @returns {pg.ClientConfig}
 */
function maintenanceConfig(server) {
  return { host: server.host, port: server.port, user: server.user, password: server.password, database: "postgres" };
}

/**
 * 연결 하나로 질의를 실행하고 연결을 닫는다.
 *
 * @param {pg.ClientConfig} config
 * @param {string} sql
 * @param {unknown[]} [params]
 * @returns {Promise<pg.QueryResult>}
 */
async function queryOnce(config, sql, params = []) {
  const client = new pg.Client(config);
  await client.connect();
  try {
    return await client.query(sql, params);
  } finally {
    await client.end();
  }
}

/**
 * 이번 실행의 데이터베이스를 만들고 확장과 마이그레이션을 적용한 뒤, 앱 풀이 그
 * 데이터베이스를 보도록 process.env를 설정한다. 서버 검사가 통과하기 전에는 어떤
 * 연결도 열지 않고 process.env의 접속 값도 바꾸지 않는다. .env 파일은 읽지 않는다.
 *
 * @param {Record<string, string|undefined>} [env=process.env] 접속 값을 읽을 환경
 * @returns {Promise<{name: string}>}
 */
export async function prepareLaneDatabase(env = process.env) {
  if (lane) return { name: lane.name };

  const server = resolveLaneServer(env);
  assertLaneServer(server, env);

  /** 앱 설정 모듈이 cwd의 .env를 읽지 못하도록 존재하지 않는 경로를 가리킨다. */
  process.env.DOTENV_CONFIG_PATH = path.join(os.tmpdir(), `dbl-no-dotenv-${process.pid}`);

  const name = newLaneDatabaseName();
  await queryOnce(maintenanceConfig(server), `CREATE DATABASE "${name}"`);
  lane = { name, server };

  try {
    await queryOnce(directClientConfig(), "CREATE EXTENSION IF NOT EXISTS vector");
    await queryOnce(directClientConfig(), "CREATE EXTENSION IF NOT EXISTS pg_trgm");
    await migrateLaneDatabase(server, name);
  } catch (err) {
    await dropLaneDatabase().catch(() => {});
    throw new Error(`DB 동시성 시험 데이터베이스 준비 실패 (${name}): ${err.message}`, { cause: err });
  }

  process.env.POSTGRES_HOST     = server.host;
  process.env.POSTGRES_PORT     = String(server.port);
  process.env.POSTGRES_DB       = name;
  process.env.POSTGRES_USER     = server.user;
  process.env.POSTGRES_PASSWORD = server.password;
  process.env.DATABASE_URL      = laneUrl(server, name);
  delete process.env.BATCH_DATABASE_URL;

  return { name };
}

/**
 * @param {{host: string, port: number, user: string, password: string}} server
 * @param {string} name
 * @returns {string}
 */
function laneUrl(server, name) {
  const host = server.host.includes(":") ? `[${server.host}]` : server.host;
  return `postgresql://${server.user}:${encodeURIComponent(server.password)}@${host}:${server.port}/${name}`;
}

/**
 * 저장소의 마이그레이션 러너를 실행 데이터베이스에 적용한다. 러너는 cwd의 .env를
 * 읽으므로 빈 임시 디렉터리에서, 필요한 값만 담은 환경으로 실행한다.
 *
 * @param {{host: string, port: number, user: string, password: string}} server
 * @param {string} name
 * @returns {Promise<void>}
 */
async function migrateLaneDatabase(server, name) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dbl-migrate-"));
  try {
    await execFileAsync(process.execPath, [MIGRATE_SCRIPT], {
      cwd,
      env: {
        PATH              : process.env.PATH,
        DATABASE_URL      : laneUrl(server, name),
        EMBEDDING_ENABLED : "false",
        REDIS_ENABLED     : "false",
        DOTENV_CONFIG_PATH: path.join(cwd, "none")
      },
      maxBuffer: 16 * 1024 * 1024
    });
  } catch (err) {
    throw new Error(`마이그레이션 실패: ${String(err.stderr || err.message).slice(-800)}`, { cause: err });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

/**
 * 실행 데이터베이스를 지운다. 남은 연결을 먼저 끊는다. 이름이 시험 형식이 아니면
 * 지우지 않는다. 준비되지 않았으면 아무것도 하지 않는다.
 *
 * @returns {Promise<void>}
 */
export async function dropLaneDatabase() {
  if (!lane) return;
  const { name, server } = lane;
  assertLaneDatabaseName(name);

  const client = new pg.Client(maintenanceConfig(server));
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
  lane = null;
}

/** SQLSTATE 40P01(deadlock_detected)를 받은 질의 기록. */
const observedDeadlocks = [];
let   probeOriginal     = null;

/**
 * 문장을 한 줄로 줄인다. 어느 경로의 질의였는지 알아볼 수 있도록 문장 앞부분과
 * 갱신 대상(잠금 절이 아닌 첫 UPDATE 이후)을 함께 남긴다.
 *
 * @param {unknown} sql
 * @returns {string}
 */
function sqlHead(sql) {
  const flat   = String(sql ?? "").replace(/\s+/g, " ").trim();
  const update = flat.search(/(?<!FOR |KEY )UPDATE\b/);
  return update > 40 ? `${flat.slice(0, 40)} ... ${flat.slice(update, update + 80)}` : flat.slice(0, 120);
}

/**
 * pg.Client#query를 감싸 40P01 오류를 기록한다. 풀이 내어 준 연결도 같은
 * 프로토타입을 쓰므로 lib 안의 질의까지 잡힌다. 오류는 그대로 다시 던진다.
 * 여러 번 불러도 한 번만 설치한다.
 *
 * @returns {void}
 */
export function installDeadlockProbe() {
  if (probeOriginal) return;

  const original = pg.Client.prototype.query;
  probeOriginal  = original;
  pg.Client.prototype.query = function probedQuery(...args) {
    const text   = typeof args[0] === "string" ? args[0] : args[0]?.text;
    const result = original.apply(this, args);
    if (result && typeof result.then === "function") {
      return result.catch((err) => {
        if (err && err.code === "40P01") observedDeadlocks.push(sqlHead(text));
        throw err;
      });
    }
    return result;
  };
}

/**
 * installDeadlockProbe가 바꾼 pg.Client#query를 원래대로 되돌린다.
 *
 * @returns {void}
 */
export function uninstallDeadlockProbe() {
  if (!probeOriginal) return;
  pg.Client.prototype.query = probeOriginal;
  probeOriginal             = null;
}

/**
 * 계측 시작 이후 기록된 40P01 질의 문장 목록의 사본.
 *
 * @returns {string[]}
 */
export function observedDeadlockStatements() {
  return [...observedDeadlocks];
}

/**
 * 짧은 질의 하나를 실행 데이터베이스에 별도 연결로 실행한다.
 *
 * @param {string} sql
 * @param {unknown[]} [params]
 * @returns {Promise<pg.QueryResult>}
 */
export async function directQuery(sql, params = []) {
  return queryOnce(directClientConfig(), sql, params);
}

/**
 * 서버가 집계한 실행 데이터베이스의 교착 누계를 읽는다.
 *
 * @returns {Promise<number>}
 */
export async function readDeadlockCount() {
  const { rows } = await queryOnce(
    maintenanceConfig(lane.server),
    "SELECT deadlocks FROM pg_stat_database WHERE datname = $1",
    [lane.name]
  );
  return Number(rows[0].deadlocks);
}

/**
 * 교착 누계가 기준값보다 늘었는지 본다. 통계는 백엔드 종료 시점에 반영되므로
 * 최대 waitMs 동안 다시 읽는다. 늦게 반영되면 적게 셀 뿐 많이 세지 않는다.
 *
 * @param {number} before
 * @param {number} [waitMs=3000]
 * @returns {Promise<number>} 증가분
 */
export async function deadlockDelta(before, waitMs = 3000) {
  const deadline = Date.now() + waitMs;
  let   current  = await readDeadlockCount();
  while (current === before && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 200));
    current = await readDeadlockCount();
  }
  return current - before;
}

/**
 * 같은 topic의 파편 count건을 만든다.
 *
 * @param {string} topic
 * @param {number} count
 * @param {string} [type="fact"]
 * @returns {Promise<string[]>} 생성한 id
 */
export async function seedFragments(topic, count, type = "fact") {
  const ids = Array.from({ length: count }, () => crypto.randomUUID());
  await directQuery(
    `INSERT INTO ${SCHEMA}.fragments
            (id, content, type, topic, importance, ttl_tier, agent_id, keywords, content_hash)
     SELECT id, 'db-lane ' || id, $3, $2, 0.5, 'warm', 'default', '{}', md5(id)
       FROM unnest($1::text[]) AS id`,
    [ids, topic, type]
  );
  return ids;
}

/**
 * 배열을 무작위로 섞은 사본을 돌려준다.
 *
 * @template T
 * @param {T[]} items
 * @returns {T[]}
 */
export function shuffled(items) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
