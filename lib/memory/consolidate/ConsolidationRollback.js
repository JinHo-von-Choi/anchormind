/**
 * ConsolidationRollback - 정리 주기 되돌리기
 *
 * 작성자: 최진호
 * 작성일: 2026-11-10
 *
 * consolidation_changes(migration-082)의 기록으로 한 주기의 변경을 되돌린다. 한 트랜잭션에서 기록의 역순으로
 * 처리한다.
 *
 *   closed    아직 닫혀 있으면 다시 열고(valid_to NULL) before의 importance, ttl_tier를 복원한다. 그 주기가 남긴
 *             대체 링크(fragment → 승계자, superseded_by)를 지운다
 *   created   그 주기가 만든 파편(분할 자식)을 지운다. 계보와 링크는 외래 키로 함께 지워진다
 *   anchored  앵커 지정을 푼다
 *
 * 되돌리지 않는 것: 승계자로 옮긴 링크와 linked_to 참조, 합산한 access_count, 단계가 남긴 모순 해소 감사 파편.
 * 이미 지워진 파편의 기록은 건너뛰고 missing으로 센다. 되돌린 기록에는 rolled_back_at을 남겨 다시 되돌리지 않는다.
 * 되돌린 뒤 다시 연 파편의 색인은 다음 접근 때 다시 만들어지고, 지운 파편의 색인은 이 모듈이 지운다.
 */

import { SCHEMA, DEINDEX_COLUMNS } from "../schema.js";
import { CHANGE_ACTIONS }          from "./ChangeLog.js";
import { logWarn }                 from "../../logger.js";

/** 주기 id 형식 */
export const CYCLE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

/** 목록 조회 상한 */
export const CYCLE_LIST_MAX = 100;

/** 되돌릴 주기가 없을 때의 오류 */
export class CycleNotFoundError extends Error {
  /** @param {string} cycleId */
  constructor(cycleId) {
    super(`consolidation cycle not found or already rolled back: ${cycleId}`);
    this.name    = "CycleNotFoundError";
    this.cycleId = cycleId;
  }
}

/**
 * 최근 주기 목록. 주기마다 단계별, 동작별 건수와 되돌림 여부를 돌려준다.
 *
 * @param {{query: Function}} pool
 * @param {{limit?: number}} [options]
 * @returns {Promise<Array<{cycle_id: string, started_at: string, changes: number, rolled_back: boolean, by_stage: Object}>>}
 */
export async function listCycles(pool, { limit = 20 } = {}) {
  const { rows } = await pool.query(
    `SELECT cycle_id, min(created_at) AS started_at, count(*)::int AS changes,
            bool_and(rolled_back_at IS NOT NULL) AS rolled_back,
            jsonb_object_agg(stage_action, n) AS by_stage
       FROM (SELECT cycle_id, created_at, rolled_back_at, stage || ':' || action AS stage_action,
                    count(*) OVER (PARTITION BY cycle_id, stage, action)::int AS n
               FROM ${SCHEMA}.consolidation_changes) c
      GROUP BY cycle_id
      ORDER BY min(created_at) DESC
      LIMIT $1`,
    [Math.min(Math.max(1, limit), CYCLE_LIST_MAX)]
  );
  return rows;
}

/**
 * 한 주기를 되돌린다.
 *
 * @param {{connect: Function}} pool
 * @param {string} cycleId
 * @param {{deindex?: (rows: Array) => Promise<void>}} [deps]
 * @returns {Promise<{cycle_id: string, reopened: number, deleted: number, unanchored: number, missing: number, skipped: number}>}
 * @throws {CycleNotFoundError}
 */
export async function rollbackCycle(pool, cycleId, { deindex = async () => {} } = {}) {
  const client = await pool.connect();
  const out    = { cycle_id: cycleId, reopened: 0, deleted: 0, unanchored: 0, missing: 0, skipped: 0 };
  const removed = [];
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL app.current_agent_id = 'system'");
    const { rows: changes } = await client.query(
      `SELECT id, action, fragment_id, successor_id, before
         FROM ${SCHEMA}.consolidation_changes
        WHERE cycle_id = $1 AND rolled_back_at IS NULL
        ORDER BY id DESC
        FOR UPDATE`,
      [cycleId]
    );
    if (changes.length === 0) throw new CycleNotFoundError(cycleId);

    for (const change of changes) {
      const result = await undoChange(client, change);
      out[result.counter] += 1;
      if (result.removed) removed.push(...result.removed);
    }
    await client.query(
      `UPDATE ${SCHEMA}.consolidation_changes SET rolled_back_at = NOW() WHERE id = ANY($1::bigint[])`,
      [changes.map(c => c.id)]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(rbErr => logWarn(`[ConsolidationRollback] rollback failed: ${rbErr.message}`));
    throw err;
  } finally {
    client.release();
  }
  if (removed.length > 0) await deindex(removed);
  return out;
}

/**
 * 기록 하나를 되돌린다.
 *
 * @param {{query: Function}} client
 * @param {{action: string, fragment_id: string, successor_id: string|null, before: Object}} change
 * @returns {Promise<{counter: "reopened"|"deleted"|"unanchored"|"missing"|"skipped", removed?: Array}>}
 */
async function undoChange(client, change) {
  const before = change.before ?? {};
  if (change.action === CHANGE_ACTIONS.CLOSED) {
    const { rows } = await client.query(
      `UPDATE ${SCHEMA}.fragments
          SET valid_to   = NULL,
              importance = COALESCE(($2::jsonb ->> 'importance')::real, importance),
              ttl_tier   = COALESCE($2::jsonb ->> 'ttl_tier', ttl_tier)
        WHERE id = $1 AND valid_to IS NOT NULL
        RETURNING id`,
      [change.fragment_id, JSON.stringify(before)]
    );
    if (rows.length === 0) return { counter: await exists(client, change.fragment_id) ? "skipped" : "missing" };
    if (change.successor_id) {
      await client.query(
        `DELETE FROM ${SCHEMA}.fragment_links WHERE from_id = $1 AND to_id = $2 AND relation_type = 'superseded_by'`,
        [change.fragment_id, change.successor_id]
      );
    }
    return { counter: "reopened" };
  }
  if (change.action === CHANGE_ACTIONS.CREATED) {
    const { rows } = await client.query(
      `DELETE FROM ${SCHEMA}.fragments WHERE id = $1 RETURNING ${DEINDEX_COLUMNS}`,
      [change.fragment_id]
    );
    return rows.length === 0 ? { counter: "missing" } : { counter: "deleted", removed: rows };
  }
  if (change.action === CHANGE_ACTIONS.ANCHORED) {
    const { rowCount } = await client.query(
      `UPDATE ${SCHEMA}.fragments SET is_anchor = FALSE WHERE id = $1 AND is_anchor = TRUE`,
      [change.fragment_id]
    );
    if (rowCount > 0) return { counter: "unanchored" };
    return { counter: await exists(client, change.fragment_id) ? "skipped" : "missing" };
  }
  return { counter: "skipped" };
}

/**
 * @param {{query: Function}} client
 * @param {string} id
 * @returns {Promise<boolean>}
 */
async function exists(client, id) {
  const { rows } = await client.query(`SELECT 1 FROM ${SCHEMA}.fragments WHERE id = $1`, [id]);
  return rows.length > 0;
}
