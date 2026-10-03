/**
 * id 오름차순 묶음 갱신
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 다중 행 배경 갱신이 recall 부수효과(incrementAccess, touchLinked)와 같은 순서로
 * 행을 잠그도록 대상을 id 오름차순 묶음으로 나눠 갱신한다. 묶음마다 커밋하므로
 * 한 번에 잡는 행 잠금은 묶음 크기로 제한된다. 모든 묶음은 첫 조회에서 얻은
 * 기준 시각 하나($3)를 쓰므로 행별 결과는 같은 시각의 단일 문장과 같다.
 */

import { envInt, scoreMinDeltaEnv, DEFAULT_SCORE_UPDATE_BATCH } from "../../config.js";
import { queryWithAgentVector } from "../../tools/db.js";
import { SCHEMA }               from "../schema.js";
import { logWarn }              from "../../logger.js";

export { DEFAULT_SCORE_UPDATE_BATCH };
const MAX_SCORE_UPDATE_BATCH = 10000;

/**
 * 묶음 크기. 0이면 호출부가 단일 문장 경로를 쓴다.
 * 정수 0 이상만 값으로 받고 그 밖은 기본값이며, 상한을 넘으면 상한으로 줄인다.
 *
 * @returns {number}
 */
export function scoreUpdateBatchSize() {
  const size = envInt("MEMENTO_SCORE_UPDATE_BATCH", DEFAULT_SCORE_UPDATE_BATCH, { min: 0, fallback: true });
  return Math.min(MAX_SCORE_UPDATE_BATCH, size);
}

/**
 * 재기록 최소 변화량 환경 변수를 읽는다. 미설정과 0은 0(모든 대상 행 재기록)이다.
 * 숫자가 아니거나 음수인 값은 0으로 바꾸고 1을 넘는 값(양의 무한대 포함)은 1로 제한하며 경고를 남긴다.
 *
 * @param {string} name MEMENTO_DECAY_MIN_DELTA 또는 MEMENTO_UTILITY_MIN_DELTA
 * @returns {number} 0 이상 1 이하
 */
export function minDeltaFromEnv(name) {
  const text = (scoreMinDeltaEnv(name) ?? "").trim();
  if (text === "") return 0;
  const raw = Number(text);
  if (Number.isNaN(raw) || raw < 0) {
    logWarn(`[idOrderedUpdate] ${name}="${text}"은 0 이상의 숫자가 아니어서 0으로 처리한다`);
    return 0;
  }
  if (raw > 1) {
    logWarn(`[idOrderedUpdate] ${name}=${text}는 상한을 넘어 1로 제한한다`);
    return 1;
  }
  return raw;
}

/**
 * 저장값이 계산값과 달라 다시 써야 하는 행의 조건과 매개변수. 최소 변화량이 있으면 저장값이
 * NULL이거나 차이가 그 값을 넘는 행만 고르고(값은 $4), 없으면 real 비교로 바뀐 행만 고른다.
 *
 * @param {Object} spec
 * @param {string} spec.stored       저장 컬럼명
 * @param {string} spec.computed     계산식 SQL
 * @param {string} spec.minDeltaEnv  최소 변화량 환경 변수 이름
 * @returns {{ where: string, params: number[] }}
 */
export function changedRowsSpec({ stored, computed, minDeltaEnv }) {
  const minDelta = minDeltaFromEnv(minDeltaEnv);
  if (minDelta === 0) return { where: `${stored} IS DISTINCT FROM (${computed})::real`, params: [] };
  return { where: `${stored} IS NULL OR ABS(${stored} - (${computed})::real) > $4::real`, params: [minDelta] };
}

/**
 * 기준 시각(DB의 NOW())을 한 번 읽는다. 한 번의 갱신 실행에 속한 모든 묶음이 같은 값을 쓴다.
 *
 * @returns {Promise<Date>}
 */
export async function readBatchClock() {
  const { rows: [clock] } = await queryWithAgentVector("system", "SELECT NOW() AS ts", []);
  return clock.ts;
}

/**
 * 마지막 id 뒤의 대상 행 한 묶음을 잠그고 갱신한다. onlyId 를 주면 그 id 한 행만 대상이 되며
 * 그 id는 마지막 자리표시자($4 + params.length)로 붙는다.
 *
 * 잠금 문장이 묶음을 id 순으로 잠그고, 갱신 문장은 같은 트랜잭션에서 잠근 행($1)만 갱신한다.
 * 두 문장은 같은 값 목록을 같은 번호로 받으며 한쪽 문장이 쓰지 않는 자리표시자는 형만 정하는
 * 조건으로 참조한다. 갱신 문장의 $1 은 잠근 id 배열이고 $2 이후는 잠금 문장과 같다.
 *
 * @param {Object}   spec
 * @param {string}   spec.where
 * @param {string}   spec.set
 * @param {Array}    [spec.params]
 * @param {number}   spec.batchSize
 * @param {string}   [spec.afterId=""]  이 id보다 큰 행부터 고른다
 * @param {Date}     spec.clock         readBatchClock 의 값($3)
 * @param {string}   [spec.onlyId]      한 행으로 한정할 id
 * @returns {Promise<{n: number, lastId: string|null}>} 갱신한 행 수와 잠근 마지막 id(대상이 없으면 null)
 */
export async function updateOneBatch({ where, set, params = [], batchSize, afterId = "", clock, onlyId }) {
  const idFilter  = onlyId === undefined ? "" : ` AND id = $${4 + params.length}`;
  const values    = onlyId === undefined ? params : [...params, onlyId];
  const lastParam = 3 + values.length;
  const lockWhere = `(${where}) AND id > $1${idFilter}`;

  const result = await queryWithAgentVector("system",
    `UPDATE ${SCHEMA}.fragments f
        SET ${set}
      WHERE f.id = ANY($1::text[])${paramGuard(set, 2, lastParam)}`,
    [batchSize, clock, ...values],
    { lock: {
      operation: "score_batch",
      sql      : `SELECT id FROM ${SCHEMA}.fragments
                   WHERE ${lockWhere}${paramGuard(lockWhere, 3, lastParam)}
                   ORDER BY id
                   LIMIT $2
                   FOR NO KEY UPDATE`,
      params   : [afterId, batchSize, clock, ...values]
    } }
  );
  const locked = result.lockedIds ?? [];
  return { n: result.rowCount ?? 0, lastId: locked.length > 0 ? locked[locked.length - 1] : null };
}

/**
 * sql 이 참조하지 않는 $first..$last 자리표시자를 text 로 참조하는 조건 조각. 같은 값 목록을 받는
 * 두 문장 중 한쪽에만 나오는 값은 그 문장에서 서버가 형을 정하지 못하므로 이 조각을 붙인다.
 *
 * @param {string} sql
 * @param {number} first
 * @param {number} last
 * @returns {string}
 */
export function paramGuard(sql, first, last) {
  const used  = new Set([...sql.matchAll(/\$(\d+)/g)].map(m => Number(m[1])));
  const guard = [];
  for (let n = first; n <= last; n++) {
    if (!used.has(n)) guard.push(` AND $${n}::text IS NOT NULL`);
  }
  return guard.join("");
}

/**
 * where 에서 참조하지 않는 자리표시자를 text 로 참조하는 조건 조각. 후보 id 조회 문은 갱신 문과
 * 같은 값 목록을 받는데, set 에서만 쓰는 값은 where 에 나타나지 않아 서버가 형을 정하지 못한다.
 * $1 과 $2 는 조회 문이 항상 쓴다.
 *
 * @param {string} where
 * @param {number} paramCount params 길이
 * @returns {string}
 */
export function unreferencedParamGuard(where, paramCount) {
  return paramGuard(where, 3, 3 + paramCount);
}

/**
 * updateOneBatch 가 한 묶음에서 다룰 후보 id 를 id 순으로 읽는다. 잠금을 잡지 않는다.
 *
 * @param {Object}  spec  updateOneBatch 와 같은 where, params, batchSize, afterId, clock
 * @returns {Promise<string[]>}
 */
export async function selectBatchIds({ where, params = [], batchSize, afterId = "", clock }) {
  const { rows } = await queryWithAgentVector("system",
    `SELECT id FROM ${SCHEMA}.fragments
      WHERE (${where}) AND id > $1${unreferencedParamGuard(where, params.length)}
      ORDER BY id
      LIMIT $2`,
    [afterId, batchSize, clock, ...params]
  );
  return rows.map(r => r.id);
}

/**
 * fragments 대상 행을 id 오름차순 묶음으로 잠그고 갱신한다.
 *
 * where는 별칭 없는 컬럼명으로, set은 별칭 f로 쓴다. 자리표시자는 $1(마지막 id),
 * $2(묶음 크기), $3(기준 시각, timestamptz)이 예약되어 있고 params는 $4부터 붙는다.
 *
 * @param {Object}   spec
 * @param {string}   spec.where
 * @param {string}   spec.set
 * @param {Array}    [spec.params]
 * @param {number}   spec.batchSize
 * @returns {Promise<number>} 갱신한 행 수
 */
export async function updateInIdOrder({ where, set, params = [], batchSize }) {
  const clock = await readBatchClock();
  let   lastId = "";
  let   total  = 0;

  for (;;) {
    const batch = await updateOneBatch({ where, set, params, batchSize, afterId: lastId, clock });
    if (batch.lastId === null) return total;
    total  += batch.n;
    lastId  = batch.lastId;
  }
}
