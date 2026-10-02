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
 * 숫자가 아니거나 음수인 값은 0으로 바꾸고 1을 넘는 값은 1로 제한하며 경고를 남긴다.
 *
 * @param {string} name MEMENTO_DECAY_MIN_DELTA 또는 MEMENTO_UTILITY_MIN_DELTA
 * @returns {number} 0 이상 1 이하
 */
export function minDeltaFromEnv(name) {
  const text = (scoreMinDeltaEnv(name) ?? "").trim();
  if (text === "") return 0;
  const raw = Number(text);
  if (!Number.isFinite(raw) || raw < 0) {
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
  const { rows: [clock] } = await queryWithAgentVector("system", "SELECT NOW() AS ts", []);
  let   lastId            = "";
  let   total             = 0;

  for (;;) {
    const { rows: [batch] } = await queryWithAgentVector("system",
      `WITH locked AS (
         SELECT id FROM ${SCHEMA}.fragments
          WHERE (${where}) AND id > $1
          ORDER BY id
          LIMIT $2
          FOR NO KEY UPDATE
       ), updated AS (
         UPDATE ${SCHEMA}.fragments f
            SET ${set}
           FROM locked
          WHERE f.id = locked.id
         RETURNING f.id
       )
       SELECT (SELECT count(*)::int FROM updated) AS n,
              (SELECT max(id) FROM locked)        AS last_id`,
      [lastId, batchSize, clock.ts, ...params],
      "write"
    );
    if (batch.last_id === null) return total;
    total  += batch.n;
    lastId  = batch.last_id;
  }
}
