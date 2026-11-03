/**
 * RetentionGC — 키·workspace별 보존 기간이 지난 파편 삭제
 *
 * 작성자: 최진호
 * 작성일: 2026-11-04
 *
 * key_retention_policies(migration-078)의 정책마다 created_at이 max_age_days보다 오래된 파편을 지운다. 정책은
 * 키의 workspace 하나(workspace='W') 또는 키 전체(workspace NULL)에 걸리고, 같은 키에 둘 다 있으면 그 workspace
 * 파편에는 workspace 정책이 우선한다. 앵커는 지우지 않는다. 닫힌 파편(valid_to)과 작업 기억 행도 같은 기준이다.
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

/** 정의되지 않은 표(migration-078 전) */
const UNDEFINED_TABLE = "42P01";

/**
 * 보존 기간이 지난 파편 조건. 파편마다 적용할 정책 일수를 workspace 정책, 키 전체 정책 순으로 고른다.
 * 정책이 있는 키의 파편만 본다(key_id 색인).
 */
export const RETENTION_CANDIDATE_FROM = `FROM ${SCHEMA}.fragments f
         WHERE f.key_id IN (SELECT key_id FROM ${SCHEMA}.key_retention_policies)
           AND f.is_anchor = FALSE
           AND f.created_at < NOW() - make_interval(days => COALESCE(
                 (SELECT p.max_age_days FROM ${SCHEMA}.key_retention_policies p
                   WHERE p.key_id = f.key_id AND p.workspace = f.workspace),
                 (SELECT p.max_age_days FROM ${SCHEMA}.key_retention_policies p
                   WHERE p.key_id = f.key_id AND p.workspace IS NULL)
               ))`;

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
    if (outcome.error?.code === UNDEFINED_TABLE) return 0;
    if (outcome.deleted === 0) throw outcome.error;
    logWarn(`[RetentionGC] retention delete stopped after ${outcome.deleted} rows: ${outcome.error.message}`);
  }
  return outcome.deleted;
}
