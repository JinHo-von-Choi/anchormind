/**
 * 재개형 백필 도우미
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * idOrderedUpdate 의 id 오름차순 묶음 갱신 위에 두 가지를 더한다.
 * - watermark: 묶음이 커밋될 때마다 작업별 마지막 id 를 기록하므로 중단된 작업은 같은 job
 *   이름으로 다시 실행하면 그 지점부터 이어진다.
 * - 실패 행 기록: 묶음 갱신이 행 단위 오류(SQLSTATE 22, 23 계열)로 실패하면 그 묶음을 행마다
 *   나누어 갱신하고, 실패한 행은 backfill_failures 에 남기고 건너뛴다. 그 밖의 오류(연결 끊김,
 *   교착, 취소)는 행의 문제가 아니므로 그대로 던지며, watermark 가 남아 있어 다시 실행하면 이어진다.
 *
 * 묶음은 커밋 뒤에 watermark 를 기록하므로 중단 직후 같은 묶음이 한 번 더 실행될 수 있다.
 * where 는 이미 갱신된 행이 다시 대상이 되지 않도록 갱신 결과를 제외하는 조건이어야 한다.
 * 같은 job 을 동시에 둘 이상 실행하지 않는다. watermark 는 읽은 값과 같을 때만 갱신하므로, 겹쳐
 * 실행해도 watermark 는 뒤로 가지 않고 늦은 실행은 BackfillConcurrentRunError 로 멈춘다.
 *
 * 갱신 값이 SQL 식만으로 정해지지 않는 백필(본문을 JS로 토큰화하는 content_tokens 등)은 prepareBatch 로
 * 묶음마다 params 를 만든다. prepareBatch 는 그 묶음이 시작할 watermark(afterId)를 받으므로 같은 where 와
 * 묶음 크기로 다음 후보를 읽어 값을 준비할 수 있다.
 *
 * watermark 표와 실패 행 표는 마이그레이션이 아니라 운영 절차(docs/operations/online-migration.md)로
 * 만든다. BACKFILL_TABLES_DDL 과 ensureBackfillTables 가 그 문장을 제공하며, 표가 없으면
 * runResumableBackfill 은 BackfillTableMissingError 로 거부한다.
 */

import { queryWithAgentVector } from "../../tools/db.js";
import { SCHEMA }               from "../schema.js";
import { readBatchClock, selectBatchIds, updateOneBatch } from "./idOrderedUpdate.js";

export const WATERMARK_TABLE = `${SCHEMA}.backfill_watermarks`;
export const FAILURE_TABLE   = `${SCHEMA}.backfill_failures`;

/** 두 표를 만드는 문장. 멱등이다. */
export const BACKFILL_TABLES_DDL = Object.freeze([
  `CREATE TABLE IF NOT EXISTS ${WATERMARK_TABLE} (
     job        text        PRIMARY KEY,
     last_id    text        NOT NULL DEFAULT '',
     rows_done  bigint      NOT NULL DEFAULT 0,
     status     text        NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed')),
     started_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS ${FAILURE_TABLE} (
     job             text        NOT NULL,
     row_id          text        NOT NULL,
     sqlstate        text        NOT NULL,
     error_class     text        NOT NULL,
     constraint_name text,
     attempts        integer     NOT NULL DEFAULT 1,
     failed_at       timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (job, row_id)
   )`,
]);

const JOB_PATTERN        = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const ROW_LEVEL_SQLSTATE = /^(22|23)/;

/** 백필 도우미 오류의 공통 부모. */
export class BackfillError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "BackfillError";
  }
}

/** watermark 표나 실패 행 표가 없다. */
export class BackfillTableMissingError extends BackfillError {
  constructor() {
    super(`${WATERMARK_TABLE} 또는 ${FAILURE_TABLE} 이 없다. docs/operations/online-migration.md 의 절차로 먼저 만든다.`);
    this.name = "BackfillTableMissingError";
  }
}

/**
 * watermark 표와 실패 행 표를 만든다. 운영 스크립트가 호출한다.
 *
 * @param {(sql: string) => Promise<unknown>} run 문장 하나를 실행하는 함수
 * @returns {Promise<void>}
 */
export async function ensureBackfillTables(run) {
  for (const statement of BACKFILL_TABLES_DDL) await run(statement);
}

function assertJob(job) {
  if (typeof job !== "string" || !JOB_PATTERN.test(job)) {
    throw new BackfillError(`job 이름은 소문자 영숫자와 . _ - 로 1~64자여야 한다: ${job}`);
  }
}

function assertBatchSize(batchSize) {
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new BackfillError(`batchSize 는 1 이상의 정수여야 한다: ${batchSize}`);
}

function assertPrepareBatch(prepareBatch) {
  if (prepareBatch !== undefined && typeof prepareBatch !== "function") throw new BackfillError("prepareBatch 는 함수여야 한다");
}

/**
 * 묶음 하나의 params. prepareBatch 가 있으면 그 결과, 없으면 고정 params 다.
 *
 * @param {{params: Array, prepareBatch?: Function}} spec
 * @param {{afterId: string, batchSize: number, clock: Date, onlyId?: string}} batch
 * @returns {Promise<Array>}
 */
async function batchParams({ params, prepareBatch }, batch) {
  return prepareBatch ? prepareBatch(batch) : params;
}

/** 행 단위 오류인지: 데이터 예외(22)와 무결성 위반(23). */
export function isRowLevelError(err) {
  return ROW_LEVEL_SQLSTATE.test(String(err?.code ?? ""));
}

async function assertTables() {
  const { rows: [found] } = await queryWithAgentVector(
    "system", "SELECT to_regclass($1) AS watermark, to_regclass($2) AS failure", [WATERMARK_TABLE, FAILURE_TABLE]
  );
  if (found.watermark === null || found.failure === null) throw new BackfillTableMissingError();
}

/** SQLSTATE 계열의 고정 이름. 오류 메시지는 값을 인용하므로 저장하지 않는다. */
function errorClassLabel(sqlstate) {
  if (sqlstate.startsWith("22")) return "data_exception";
  if (sqlstate.startsWith("23")) return "integrity_constraint_violation";
  return "other";
}

/** 실패 행을 기록한다. SQLSTATE, 계열 이름, 제약 이름만 저장하고 메시지와 값은 저장하지 않는다. */
async function recordFailure(job, rowId, err) {
  const sqlstate = String(err.code);
  await queryWithAgentVector("system",
    `INSERT INTO ${FAILURE_TABLE} (job, row_id, sqlstate, error_class, constraint_name)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (job, row_id) DO UPDATE
        SET sqlstate        = EXCLUDED.sqlstate,
            error_class     = EXCLUDED.error_class,
            constraint_name = EXCLUDED.constraint_name,
            attempts        = ${FAILURE_TABLE}.attempts + 1,
            failed_at       = now()`,
    [job, rowId, sqlstate, errorClassLabel(sqlstate), err.constraint ?? null]
  );
}

/**
 * 실패한 묶음을 행마다 갱신한다. 행 단위 오류인 행은 기록하고 건너뛴다.
 *
 * @returns {Promise<{n: number, lastId: string, failed: number}>}
 * @throws 행 단위가 아닌 오류, 또는 실패를 재현할 후보가 없을 때 원 오류
 */
async function updateRowByRow(spec, job, cause) {
  const ids = await selectBatchIds(spec);
  if (ids.length === 0) throw cause;

  let n = 0;
  let failed = 0;
  for (const id of ids) {
    try {
      const one = await updateOneBatch({ ...spec, afterId: "", onlyId: id });
      n += one.n;
    } catch (err) {
      if (!isRowLevelError(err)) throw err;
      await recordFailure(job, id, err);
      failed += 1;
    }
  }
  return { n, lastId: ids[ids.length - 1], failed };
}

/** 한 묶음을 갱신한다. 행 단위 오류면 행마다 나누어 다시 한다. */
async function runBatch(spec, job) {
  try {
    const batch = await updateOneBatch(spec);
    return { ...batch, failed: 0 };
  } catch (err) {
    if (!isRowLevelError(err)) throw err;
    return updateRowByRow(spec, job, err);
  }
}

/**
 * 작업의 watermark 행을 읽는다. 없으면 만들고, restart 이면 처음 상태로 되돌린다.
 *
 * @returns {Promise<{last_id: string, rows_done: string, status: string}>}
 */
async function loadWatermark(job, restart) {
  if (restart) {
    await queryWithAgentVector("system", `DELETE FROM ${FAILURE_TABLE} WHERE job = $1`, [job]);
    await queryWithAgentVector("system", `DELETE FROM ${WATERMARK_TABLE} WHERE job = $1`, [job]);
  }
  await queryWithAgentVector("system",
    `INSERT INTO ${WATERMARK_TABLE} (job) VALUES ($1) ON CONFLICT (job) DO NOTHING`, [job]);
  const { rows: [state] } = await queryWithAgentVector("system",
    `SELECT last_id, rows_done::text AS rows_done, status FROM ${WATERMARK_TABLE} WHERE job = $1`, [job]);
  return state;
}

/** 다른 실행이 같은 job 의 watermark 를 바꿨다. */
export class BackfillConcurrentRunError extends BackfillError {
  constructor(job) {
    super(`job ${job} 의 watermark 가 이 실행이 읽은 값과 다르다. 다른 실행이 같은 job 을 진행했으므로 이 실행을 중단한다.`);
    this.name = "BackfillConcurrentRunError";
  }
}

/** watermark 를 이전 값과 같을 때만 앞으로 옮긴다. 다르면 다른 실행이 진행한 것이므로 던진다. */
async function saveWatermark(job, previousId, lastId, rowsUpdated) {
  const result = await queryWithAgentVector("system",
    `UPDATE ${WATERMARK_TABLE}
        SET last_id = $2, rows_done = rows_done + $3, updated_at = now()
      WHERE job = $1 AND last_id = $4 AND status = 'running'`,
    [job, lastId, rowsUpdated, previousId]
  );
  if (result.rowCount !== 1) throw new BackfillConcurrentRunError(job);
}

/** 이 실행이 마지막으로 기록한 값과 같을 때만 완료로 표시한다. */
async function markCompleted(job, lastId) {
  const result = await queryWithAgentVector("system",
    `UPDATE ${WATERMARK_TABLE}
        SET status = 'completed', updated_at = now()
      WHERE job = $1 AND last_id = $2 AND status = 'running'`,
    [job, lastId]
  );
  if (result.rowCount !== 1) throw new BackfillConcurrentRunError(job);
}

/**
 * fragments 백필을 watermark 부터 끝까지 실행한다.
 *
 * where, set, params 의 규약은 updateInIdOrder 와 같다. 완료된 job 은 restart 를 주지 않는 한
 * 아무것도 하지 않는다.
 *
 * @param {Object}  spec
 * @param {string}  spec.job        작업 이름(소문자 영숫자와 . _ -)
 * @param {string}  spec.where
 * @param {string}  spec.set
 * @param {Array}   [spec.params]
 * @param {number}  spec.batchSize
 * @param {boolean} [spec.restart]  watermark 와 실패 행 기록을 지우고 처음부터 실행
 * @param {(batch: {afterId: string, batchSize: number, clock: Date, onlyId?: string}) => Promise<Array>} [spec.prepareBatch]
 *   묶음마다 params($4부터)를 만든다. 주면 params 대신 쓴다
 * @returns {Promise<{job: string, rowsUpdated: number, failedRows: number, lastId: string,
 *                    resumedFrom: string, alreadyCompleted: boolean}>}
 * @throws {BackfillError|BackfillTableMissingError}
 */
export async function runResumableBackfill({ job, where, set, params = [], batchSize, restart = false, prepareBatch }) {
  assertJob(job);
  assertBatchSize(batchSize);
  assertPrepareBatch(prepareBatch);
  await assertTables();

  const state       = await loadWatermark(job, restart);
  const resumedFrom = state.last_id;
  if (state.status === "completed") {
    return { job, rowsUpdated: 0, failedRows: 0, lastId: resumedFrom, resumedFrom, alreadyCompleted: true };
  }

  const clock = await readBatchClock();
  let   lastId      = resumedFrom;
  let   rowsUpdated = 0;
  let   failedRows  = 0;

  for (;;) {
    const values = await batchParams({ params, prepareBatch }, { afterId: lastId, batchSize, clock });
    const batch  = await runBatch({ where, set, params: values, batchSize, afterId: lastId, clock }, job);
    if (batch.lastId === null) break;
    rowsUpdated += batch.n;
    failedRows  += batch.failed;
    await saveWatermark(job, lastId, batch.lastId, batch.n);
    lastId       = batch.lastId;
  }

  await markCompleted(job, lastId);
  return { job, rowsUpdated, failedRows, lastId, resumedFrom, alreadyCompleted: false };
}

/**
 * 기록된 실패 행을 다시 갱신한다. 성공하거나 더는 대상이 아닌 행은 기록에서 지우고, 다시
 * 실패한 행은 시도 횟수를 올린다.
 *
 * @param {Object} spec runResumableBackfill 과 같은 job, where, set, params, prepareBatch(행마다 onlyId 로 부른다)
 * @returns {Promise<{resolved: number, stillFailing: number}>}
 */
export async function retryBackfillFailures({ job, where, set, params = [], prepareBatch }) {
  assertJob(job);
  assertPrepareBatch(prepareBatch);
  await assertTables();

  const { rows } = await queryWithAgentVector("system",
    `SELECT row_id FROM ${FAILURE_TABLE} WHERE job = $1 ORDER BY row_id`, [job]);
  const clock = await readBatchClock();

  let resolved     = 0;
  let stillFailing = 0;
  for (const { row_id: rowId } of rows) {
    try {
      const values = await batchParams({ params, prepareBatch }, { afterId: "", batchSize: 1, clock, onlyId: rowId });
      await updateOneBatch({ where, set, params: values, batchSize: 1, clock, onlyId: rowId });
      await queryWithAgentVector("system", `DELETE FROM ${FAILURE_TABLE} WHERE job = $1 AND row_id = $2`, [job, rowId]);
      resolved += 1;
    } catch (err) {
      if (!isRowLevelError(err)) throw err;
      await recordFailure(job, rowId, err);
      stillFailing += 1;
    }
  }
  return { resolved, stillFailing };
}

/**
 * 작업의 실패 행 기록을 id 순으로 읽는다.
 *
 * @param {string} job
 * @returns {Promise<Array<{row_id: string, sqlstate: string, error_class: string, constraint_name: string|null, attempts: number}>>}
 */
export async function listBackfillFailures(job) {
  assertJob(job);
  const { rows } = await queryWithAgentVector("system",
    `SELECT row_id, sqlstate, error_class, constraint_name, attempts FROM ${FAILURE_TABLE} WHERE job = $1 ORDER BY row_id`, [job]);
  return rows;
}
