/**
 * DB 동시성 시험 공통 도구
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 실제 PostgreSQL에 붙는 시험이 쓰는 접속 확인, 시드 파편 생성, 정리,
 * 교착 계측을 모은다. DB에 닿지 못하면 건너뛰지 않고 실패한다.
 *
 * 교착은 두 곳에서 센다. 하나는 pg 클라이언트의 질의 결과로, 던져진 오류든
 * 호출자가 삼킨 오류든 SQLSTATE 40P01이면 질의 문장과 함께 기록한다. 다른 하나는
 * 서버가 집계한 pg_stat_database.deadlocks 증가분이다.
 */

import crypto from "node:crypto";
import pg     from "pg";

export const SCHEMA = "agent_memory";

/** lib 풀과 같은 DB를 보도록 POSTGRES_* 값을 그대로 쓴다. */
export function directClientConfig() {
  return {
    host    : process.env.POSTGRES_HOST     || "localhost",
    port    : Number(process.env.POSTGRES_PORT || 35433),
    user    : process.env.POSTGRES_USER     || "memento",
    password: process.env.POSTGRES_PASSWORD || "",
    database: process.env.POSTGRES_DB       || "memento_test"
  };
}

/** SQLSTATE 40P01(deadlock_detected)를 받은 질의 기록. */
const observedDeadlocks = [];
let   probeInstalled    = false;

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
  if (probeInstalled) return;
  probeInstalled = true;

  const original = pg.Client.prototype.query;
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
 * 계측 시작 이후 기록된 40P01 질의 문장 목록의 사본.
 *
 * @returns {string[]}
 */
export function observedDeadlockStatements() {
  return [...observedDeadlocks];
}

/**
 * 짧은 질의 하나를 별도 연결로 실행한다.
 *
 * @param {string} sql
 * @param {unknown[]} [params]
 * @returns {Promise<pg.QueryResult>}
 */
export async function directQuery(sql, params = []) {
  const client = new pg.Client(directClientConfig());
  await client.connect();
  try {
    return await client.query(sql, params);
  } finally {
    await client.end();
  }
}

/**
 * 시험 DB에 마이그레이션된 스키마가 있는지 확인한다. 없으면 원인을 담아 던진다.
 *
 * @returns {Promise<void>}
 */
export async function assertDatabaseReady() {
  const cfg = directClientConfig();
  try {
    await directQuery(`SELECT 1 FROM ${SCHEMA}.fragments LIMIT 0`);
  } catch (err) {
    throw new Error(
      `DB 동시성 시험에는 마이그레이션된 PostgreSQL이 필요하다 (${cfg.host}:${cfg.port}/${cfg.database}): ${err.message}`,
      { cause: err }
    );
  }
}

/**
 * 서버가 집계한 현재 DB의 교착 누계를 읽는다.
 *
 * @returns {Promise<number>}
 */
export async function readDeadlockCount() {
  const { rows } = await directQuery(
    "SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()"
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
 * topic으로 만든 파편과 그 링크를 지운다.
 *
 * @param {string} topic
 * @returns {Promise<void>}
 */
export async function removeTopic(topic) {
  await directQuery(
    `DELETE FROM ${SCHEMA}.fragment_links fl
      USING ${SCHEMA}.fragments f
      WHERE (fl.from_id = f.id OR fl.to_id = f.id) AND f.topic = $1`,
    [topic]
  );
  await directQuery(`DELETE FROM ${SCHEMA}.fragments WHERE topic = $1`, [topic]);
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
