/**
 * ChangeLog - 정리 주기의 변경 기록
 *
 * 작성자: 최진호
 * 작성일: 2026-11-10
 *
 * 정리 주기(MemoryConsolidator)는 주기마다 cycle_id를 정하고 runInCycle 안에서 단계를 실행한다. 파편을 닫거나,
 * 만들거나, 앵커로 올리는 단계는 그 변경과 같은 SQL 문장에서 consolidation_changes(migration-082)에 기록을 남긴다.
 * 변경과 기록이 한 문장이라 기록 없이 변경만 남는 경우가 없다. 주기 밖에서 단계를 직접 부르면 cycle_id가 없어
 * 기록하지 않는다($n IS NOT NULL 조건).
 *
 * 되돌리기는 ConsolidationRollback.js가 한다.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID }        from "node:crypto";
import { SCHEMA }            from "../schema.js";

/** consolidation_changes.action 값 */
export const CHANGE_ACTIONS = Object.freeze({ CLOSED: "closed", CREATED: "created", ANCHORED: "anchored" });

/** 변경 기록 보존 기간(일). 이 기간이 지난 기록은 되돌릴 수 없다. */
export const CHANGE_RETENTION_DAYS = 30;

const cycleStore = new AsyncLocalStorage();

/**
 * 새 주기 id.
 *
 * @returns {string}
 */
export function newCycleId() {
  return `cyc-${randomUUID()}`;
}

/**
 * 주기 문맥 안에서 fn을 실행한다.
 *
 * @template T
 * @param {string} cycleId
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function runInCycle(cycleId, fn) {
  return cycleStore.run({ cycleId }, fn);
}

/**
 * 지금 실행 중인 주기 id. 주기 밖이면 null이다.
 *
 * @returns {string|null}
 */
export function currentCycleId() {
  return cycleStore.getStore()?.cycleId ?? null;
}

/**
 * 닫기 문장. 대상 파편을 닫고(valid_to), 바꾼 열의 이전 값을 기록한다. 이미 닫힌 파편은 바꾸지도 기록하지도 않는다.
 *
 *   $1 파편 id 배열, $2 주기 id(null이면 기록 안 함), $3 단계 이름, $4 승계자 id 배열(파편 id와 같은 순서, 없으면 NULL)
 *
 * setExtra는 valid_to 외에 함께 바꿀 SET 조각이다(예: 분할 부모의 importance, ttl_tier). 이전 값은 before에 남는다.
 * returning은 id를 포함한 열 목록이며 그 열들로 이루어진 행을 돌려준다.
 *
 * @param {{setExtra?: string, returning: string}} options
 * @returns {string}
 */
export function closeWithLogSql({ setExtra = "", returning }) {
  return `
    WITH target AS (
      SELECT t.id, t.successor
        FROM unnest($1::text[], $4::text[]) AS t(id, successor)
    ), prev AS (
      SELECT f.id, f.importance, f.ttl_tier, tg.successor
        FROM ${SCHEMA}.fragments f JOIN target tg ON tg.id = f.id
       WHERE f.valid_to IS NULL
    ), closed AS (
      UPDATE ${SCHEMA}.fragments
         SET valid_to = NOW()${setExtra}
       WHERE id IN (SELECT id FROM prev) AND valid_to IS NULL
      RETURNING ${returning}
    ), logged AS (
      INSERT INTO ${SCHEMA}.consolidation_changes (cycle_id, stage, action, fragment_id, successor_id, before)
      SELECT $2, $3, '${CHANGE_ACTIONS.CLOSED}', prev.id, prev.successor,
             jsonb_build_object('importance', prev.importance, 'ttl_tier', prev.ttl_tier)
        FROM prev JOIN closed c ON c.id = prev.id
       WHERE $2::text IS NOT NULL
    )
    SELECT * FROM closed`;
}

/**
 * 만든 파편 기록. $1 파편 id 배열, $2 주기 id, $3 단계 이름, $4 원본 id. 주기 밖이면 아무것도 하지 않는다.
 *
 * @param {(sql: string, params: Array) => Promise<unknown>} query
 * @param {string[]} ids
 * @param {string} stage
 * @param {string|null} [sourceId]
 * @returns {Promise<void>}
 */
export async function logCreated(query, ids, stage, sourceId = null) {
  const cycleId = currentCycleId();
  if (cycleId === null || !Array.isArray(ids) || ids.length === 0) return;
  await query(
    `INSERT INTO ${SCHEMA}.consolidation_changes (cycle_id, stage, action, fragment_id, successor_id)
     SELECT $2, $3, '${CHANGE_ACTIONS.CREATED}', id, $4 FROM unnest($1::text[]) AS id`,
    [ids, cycleId, stage, sourceId]
  );
}

/** 보존 기간이 지난 변경 기록을 지운다. */
export const PURGE_OLD_CHANGES_SQL = `
  DELETE FROM ${SCHEMA}.consolidation_changes
   WHERE created_at < NOW() - make_interval(days => $1)`;
