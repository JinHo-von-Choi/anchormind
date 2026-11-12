/**
 * 풀로 바로 보내는 파편 표 질의에 행 수준 보안 범위를 건다
 *
 * 작성자: 최진호
 * 작성일: 2026-11-12
 *
 * agent_memory.fragments와 fragment_links의 격리 정책은 트랜잭션 설정 app.current_agent_id와
 * app.current_key_ids를 읽는다. queryWithAgentVector(lib/tools/db.js)를 거치지 않고 pool.query로 보내는
 * 질의는 이 설정이 비어 있어서, 정책이 적용되는 접속에서는 default 에이전트의 행만 보이고 키 축은 걸리지 않는다.
 *
 * 이 모듈의 실행기는 그런 질의에 두 가지를 넘긴다.
 * - 키 범위: 키 격리 도우미(lib/memory/keyScope.js)가 바인딩 배열에 적은 키 목록
 * - 주체: 관리 조회는 admin, 백그라운드 작업은 system. 정책은 두 주체에 전체 행을 허용한다
 *
 * 설정을 걸려면 질의를 트랜잭션으로 감싸야 해서 왕복이 세 번 늘어난다. 정책이 접속 역할에 적용되지 않는
 * 설치(표 소유자 접속에 FORCE가 꺼진 기본 구성)에서는 설정을 걸어도 결과가 같으므로 질의를 그대로 보낸다.
 * 적용 여부는 row_security_active()로 확인하고 1분 동안 기억한다.
 *
 * 스키마 이름과 키 목록 모듈만 가져온다. 설정 모듈(lib/config.js)을 가져오지 않으므로, 접속 대상을 인자로만 받는
 * 운영 스크립트가 이 모듈을 거쳐도 환경 파일을 읽지 않는다. 경고는 process.emitWarning으로 남긴다.
 */

import { SCHEMA }                      from "../memory/schema.js";
import { keyScopeIdsOf, keyIdSetting } from "./key-scope-ids.js";

/** 정책이 전체 행을 허용하는 주체 */
export const ROW_SUBJECT = Object.freeze({ ADMIN: "admin", SYSTEM: "system" });

/** 적용 여부를 다시 확인하는 간격 */
const RECHECK_MS = 60_000;

/** 풀마다 기억한 적용 여부. 값은 { active, checkedAt } */
const detected = new WeakMap();

/** pg 풀인지. 단위 시험의 가짜 풀과 이미 트랜잭션 안에 있는 클라이언트는 여기에 해당하지 않는다. */
function isPool(db) {
  return typeof db?.connect === "function" && typeof db.totalCount === "number" && typeof db.release !== "function";
}

/**
 * 접속 역할에 파편 표의 행 수준 보안이 적용되는지. 확인에 실패하면 직전 값을 쓴다(처음이면 false).
 *
 * @param {import("pg").Pool} pool
 * @param {number} [now]
 * @returns {Promise<boolean>}
 */
export async function rowSecurityActive(pool, now = Date.now()) {
  const prev = detected.get(pool);
  if (prev && now - prev.checkedAt < RECHECK_MS) return prev.active;
  /** 확인하는 동안 들어온 요청이 같은 질의를 겹쳐 보내지 않도록 시각을 먼저 적는다 */
  const entry = { active: prev?.active ?? false, checkedAt: now };
  detected.set(pool, entry);
  try {
    const { rows } = await pool.query(`SELECT row_security_active('${SCHEMA}.fragments'::regclass) AS active`);
    entry.active = rows[0]?.active === true;
  } catch (err) {
    process.emitWarning(`[row-scope] 행 수준 보안 적용 여부를 확인하지 못했다: ${err.message}`);
  }
  return entry.active;
}

/**
 * 주체와 키 목록을 트랜잭션 설정 목록([이름, 값])으로 만든다. 넘길 것이 없으면 빈 배열이다.
 *
 * @param {string|null}   subject ROW_SUBJECT 값 또는 null
 * @param {string[]|null} keyIds
 * @returns {Array<[string, string]>}
 */
export function rowScopeSettings(subject, keyIds) {
  const settings = [];
  if (subject === ROW_SUBJECT.ADMIN || subject === ROW_SUBJECT.SYSTEM) settings.push(["app.current_agent_id", subject]);
  const ids = keyIdSetting(keyIds);
  if (ids !== "") settings.push(["app.current_key_ids", ids]);
  return settings;
}

/** 트랜잭션 안의 클라이언트에 설정을 건다. 트랜잭션이 끝나면 풀린다. */
async function setLocal(client, settings) {
  const params = [];
  const calls  = settings.map(([name, value]) => `set_config($${params.push(name)}, $${params.push(value)}, true)`);
  await client.query(`SELECT ${calls.join(", ")}`, params);
}

/**
 * 호출자가 연 트랜잭션에 행 수준 보안 범위를 건다. BEGIN 직후에 부른다.
 * 정책이 적용되지 않는 접속에서는 아무 문장도 보내지 않는다.
 *
 * @param {import("pg").Pool}       pool   트랜잭션의 클라이언트를 내준 풀(적용 여부 확인용)
 * @param {import("pg").PoolClient} client
 * @param {{ subject?: string|null, keyIds?: string[]|null }} scope
 */
export async function applyRowScope(pool, client, { subject = null, keyIds = null } = {}) {
  const settings = rowScopeSettings(subject, keyIds);
  if (settings.length === 0 || !isPool(pool) || !(await rowSecurityActive(pool))) return;
  await setLocal(client, settings);
}

/**
 * 트랜잭션을 열고 행 수준 보안 범위를 건다. 커밋과 롤백은 호출자가 한다.
 *
 * @param {import("pg").Pool}       pool
 * @param {import("pg").PoolClient} client
 * @param {{ subject?: string|null, keyIds?: string[]|null }} scope
 */
export async function beginScoped(pool, client, scope) {
  await client.query("BEGIN");
  await applyRowScope(pool, client, scope);
}

/**
 * 질의 하나를 행 수준 보안 범위와 함께 보낸다. 키 목록은 바인딩 배열에 적힌 것을 쓴다.
 * 넘길 범위가 없거나 정책이 적용되지 않는 접속이면 db.query(sql, params)와 같다.
 *
 * @param {{ query: Function }} db        풀. 트랜잭션 안의 클라이언트를 주면 그대로 보낸다(범위는 트랜잭션을 연 쪽이 건다)
 * @param {string}              sql
 * @param {unknown[]}           [params]
 * @param {string|null}         [subject] ROW_SUBJECT 값. 요청 경로는 생략한다
 * @returns {Promise<import("pg").QueryResult>}
 */
export async function queryScoped(db, sql, params, subject = null) {
  const settings = rowScopeSettings(subject, keyScopeIdsOf(params));
  if (settings.length === 0 || !isPool(db) || !(await rowSecurityActive(db))) {
    return params === undefined ? db.query(sql) : db.query(sql, params);
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await setLocal(client, settings);
    const result = await client.query(sql, params ?? []);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch((rbErr) => process.emitWarning(`[row-scope] 롤백에 실패했다: ${rbErr.message}`));
    throw err;
  } finally {
    client.release();
  }
}
