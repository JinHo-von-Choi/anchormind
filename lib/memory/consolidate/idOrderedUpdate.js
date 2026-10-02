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

import { envInt, DEFAULT_SCORE_UPDATE_BATCH } from "../../config.js";
import { queryWithAgentVector } from "../../tools/db.js";
import { SCHEMA }               from "../schema.js";

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
