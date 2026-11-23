/**
 * RetentionGC — 키·workspace별 보존 기간이 지난 파편 삭제
 *
 * 작성자: 최진호
 * 작성일: 2026-11-04
 *
 * key_retention_policies(migration-078, migration-084)의 정책마다 created_at이 보존 일수보다 오래된 파편을 지운다.
 * 정책은 키의 workspace 하나(workspace='W') 또는 키 전체(workspace NULL)에 걸린다. 파편마다 적용할 일수는 이렇게 정한다.
 *   workspace 행이 기간을 정했으면(max_age_days 값이나 no_expiry) 그 행을 따른다. no_expiry면 만료하지 않는다.
 *   workspace 행이 없거나 기간을 정하지 않았으면(자동 정리 설정만 있는 행) 키 전체 행을 같은 규칙으로 따른다.
 * 자동 정리 모드(auto_lifecycle, RetentionGuard)와는 무관하다. 관리자가 정한 기간이라 manual 범위에도 적용한다.
 * 앵커는 지우지 않는다. 닫힌 파편(valid_to)과 작업 기억 행도 같은 기준이다.
 *
 * 만료 삭제(FragmentGC.deleteExpired)와 같은 주기 상한, 시간 예산, 청크 잠금을 쓰고, 지운 행은 forget과 같은
 * 규칙(cleanupDeletedRows)으로 링크, 사례 사본, 색인을 정리한다. 정책 표가 없는 설치(migration-078 전)는
 * 아무것도 지우지 않는다.
 */

import { queryWithAgentVector }    from "../../tools/db.js";
import { SCHEMA, DEINDEX_COLUMNS } from "../schema.js";
import { DELETE_LOCKED_SQL, LOCK_FOR_DELETE } from "../write/rowLock.js";
import { logWarn }                 from "../../logger.js";
import { runGcChunks }             from "./gcChunks.js";
import { gcLimits }                from "./FragmentGC.js";

/** 정의되지 않은 표(migration-078 전)와 열(migration-084 전) */
const UNDEFINED_TABLE  = "42P01";
const UNDEFINED_COLUMN = "42703";

/**
 * 보존 기간이 지난 파편 조건. 파편마다 적용할 일수를 workspace 행, 키 전체 행 순으로 고른다. 기간을 정하지 않은 행은
 * 건너뛰고, no_expiry 행은 -1(만료 없음)로 고른다. 일수 행이 있는 키의 파편만 본다(key_id 색인).
 */
export const RETENTION_CANDIDATE_FROM = `FROM ${SCHEMA}.fragments f
         CROSS JOIN LATERAL (
           SELECT COALESCE(
             (SELECT CASE WHEN p.no_expiry THEN -1 ELSE p.max_age_days END FROM ${SCHEMA}.key_retention_policies p
               WHERE p.key_id = f.key_id AND p.workspace = f.workspace
                 AND (p.no_expiry OR p.max_age_days IS NOT NULL)),
             (SELECT CASE WHEN p.no_expiry THEN -1 ELSE p.max_age_days END FROM ${SCHEMA}.key_retention_policies p
               WHERE p.key_id = f.key_id AND p.workspace IS NULL
                 AND (p.no_expiry OR p.max_age_days IS NOT NULL))
           ) AS days
         ) eff
         WHERE f.key_id IN (SELECT key_id FROM ${SCHEMA}.key_retention_policies WHERE max_age_days IS NOT NULL)
           AND f.is_anchor = FALSE
           AND eff.days > 0
           AND f.created_at < NOW() - make_interval(days => eff.days)`;

/**
 * limit건을 id 순으로 잠그고 지운다.
 *
 * @param {number} limit
 * @param {number} [lockTimeoutMs]
 * @returns {Promise<number>}
 */
async function deleteRetentionChunk(limit, lockTimeoutMs) {
  const lockSql = `WITH candidates AS (
         SELECT f.id ${RETENTION_CANDIDATE_FROM}
         ORDER BY f.created_at ASC
         LIMIT $1
       )
       SELECT id FROM ${SCHEMA}.fragments WHERE id IN (SELECT id FROM candidates)
        ORDER BY id
          ${LOCK_FOR_DELETE}`;
  const result = await queryWithAgentVector("system",
    `${DELETE_LOCKED_SQL} RETURNING ${DEINDEX_COLUMNS}`,
    [],
    { lock: { operation: "gc_delete", sql: lockSql, params: [limit], lockTimeoutMs } }
  );
  const { cleanupDeletedRows } = await import("../write/DeleteCleanup.js");
  await cleanupDeletedRows(result.rows, "system");
  return result.rowCount;
}

/**
 * 보존 기간이 지난 파편을 지운다. 지운 수를 돌려준다.
 *
 * @param {{ deleteChunk?: (limit: number, lockTimeoutMs?: number) => Promise<number> }} [deps]
 * @returns {Promise<number>}
 */
export async function deleteRetentionExpired({ deleteChunk = deleteRetentionChunk } = {}) {
  const limits  = gcLimits();
  const outcome = await runGcChunks({ ...limits, deleteChunk: (limit) => deleteChunk(limit, limits.lockTimeoutMs) });
  if (outcome.stopped === "error") {
    if (outcome.error?.code === UNDEFINED_TABLE || outcome.error?.code === UNDEFINED_COLUMN) return 0;
    if (outcome.deleted === 0) throw outcome.error;
    logWarn(`[RetentionGC] retention delete stopped after ${outcome.deleted} rows: ${outcome.error.message}`);
  }
  return outcome.deleted;
}
