/**
 * 삭제 뒤 정리
 *
 * 작성자: 최진호
 * 작성일: 2026-11-02
 *
 * 모든 파편 삭제 경로(forget 연쇄, 단건·묶음 삭제, 만료 삭제, reflect 정리, 병합, 에이전트 전체 삭제)가 지운 행을
 * 같은 규칙으로 정리한다. 정리가 실패해 남은 linked_to 참조는 정리 주기의 sweepDeadReferences가 지운다.
 * FragmentWriter의 데이터 계층 보조 모듈이다.
 */

import { queryWithAgentVector } from "../../tools/db.js";
import { logWarn, logInfo }     from "../../logger.js";
import { SCHEMA, DEINDEX_COLUMNS } from "../schema.js";
import { deindexRows }          from "../FragmentIndex.js";
import { deleteCleanupFailures, deadReferencesSwept } from "../background-metrics.js";
import { DELETE_LOCKED_SQL, LOCK_FOR_DELETE, fragmentRowLock } from "./rowLock.js";
import { DELETED_SUMMARY, CONTRADICTION_AUDIT_TOPIC } from "./ForgetCascade.js";

/** linked_to 정리 문장 하나가 다루는 지운 id 수. 참조한 행 전체를 한 번에 잠그지 않도록 나눈다. */
const UNLINK_CHUNK = 100;

/**
 * 지운 파편이 남긴 참조와 사본을 정리한다. 삭제가 커밋된 뒤 부른다. 모든 파편 삭제 경로가 같은 정리를 쓴다.
 *   1. copies: 지운 파편을 출처로 한 case_events 요약을 DELETED_SUMMARY로 바꾸고, 출처로 가진 묶음 요약을 지운다.
 *      CASCADE_DELETE_SQL처럼 삭제 문장 안에서 이미 한 경로는 건너뛴다.
 *   2. audit: 지운 파편을 가리키는 서버 기록 모순 해소 파편을 연쇄 삭제한다(해소 기록끼리는 번지지 않는다).
 *   3. links, linked_to: 지운 id의 링크 행과 다른 파편 linked_to의 참조를 지운다. linked_to는 묶음마다 id 순으로 잠근다.
 *   4. deindex: 지운 행의 Redis 색인을 지운다.
 * 단계가 실패해도 다음 단계를 계속하고 memento_delete_cleanup_failures_total{step}을 올린다. 남은 linked_to 참조는
 * 주기 정리의 sweepDeadReferences가 지운다.
 *
 * @param {Array<{id: string}>} rows - 지운 행(DEINDEX_COLUMNS 열)
 * @param {string}  agentId
 * @param {Object}  [opts]
 * @param {boolean} [opts.copies=true] - 사본 정리(1, 2단계)를 할지
 * @returns {Promise<{removedIds: string[], failures: number}>}
 */
export async function cleanupDeletedRows(rows, agentId = "system", { copies = true } = {}) {
  const list = Array.isArray(rows) ? rows.filter(r => r?.id) : [];
  const ids  = list.map(r => r.id);
  if (ids.length === 0) return { removedIds: [], failures: 0 };

  let failures = 0;
  const step = async (name, fn) => {
    try {
      await fn();
    } catch (err) {
      failures++;
      deleteCleanupFailures.inc({ step: name });
      logWarn(`[FragmentWriter] 삭제 뒤 정리 실패(${name}, ${ids.length}건): ${err.message}`);
    }
  };

  if (copies) {
    await step("copies", async () => {
      await queryWithAgentVector(agentId,
        `UPDATE ${SCHEMA}.case_events SET summary = $2
          WHERE source_fragment_id = ANY($1::text[]) AND summary IS DISTINCT FROM $2`,
        [ids, DELETED_SUMMARY], "write");
      await queryWithAgentVector(agentId,
        `DELETE FROM ${SCHEMA}.fragment_digest WHERE source_ids && $1::text[]`, [ids], "write");
    });
    await step("audit", async () => {
      const auditRows = await deleteContradictionAudits(ids, agentId);
      if (auditRows.length > 0) list.push(...auditRows);
    });
  }
  const removedIds = list.map(r => r.id);
  await step("links", () => queryWithAgentVector(agentId,
    `DELETE FROM ${SCHEMA}.fragment_links WHERE from_id = ANY($1) OR to_id = ANY($1)`, [removedIds], "write"));
  await step("linked_to", () => unlinkReferences(removedIds, agentId));
  await step("deindex", () => deindexRows(list));
  return { removedIds, failures };
}

/**
 * 지운 파편(ids)을 linked_to에 가진 서버 기록 모순 해소 파편을 지운다. 해소 기록인 대상은 다른 해소 기록을 끌어오지
 * 않는다(cascadeDeleteLock과 같은 규칙). 지운 해소 기록 행을 돌려준다.
 *
 * @param {string[]} ids
 * @param {string}   agentId
 * @returns {Promise<Object[]>}
 */
async function deleteContradictionAudits(ids, agentId) {
  const { rows } = await queryWithAgentVector(agentId,
    `${DELETE_LOCKED_SQL} RETURNING ${DEINDEX_COLUMNS}`, [],
    { lock: fragmentRowLock("delete",
      "key_id IS NULL AND topic = $2 AND linked_to && $1::text[] AND NOT (id = ANY($1::text[]))",
      [ids, CONTRADICTION_AUDIT_TOPIC], LOCK_FOR_DELETE) });
  return rows ?? [];
}

/**
 * 다른 파편 linked_to에서 ids를 지운다. UNLINK_CHUNK개씩 나눠 문장마다 대상 행을 id 순으로 잠근다.
 *
 * @param {string[]} ids
 * @param {string}   agentId
 */
async function unlinkReferences(ids, agentId) {
  for (let i = 0; i < ids.length; i += UNLINK_CHUNK) {
    const chunk = ids.slice(i, i + UNLINK_CHUNK);
    await queryWithAgentVector(agentId,
      `UPDATE ${SCHEMA}.fragments f
          SET linked_to = (
                SELECT COALESCE(array_agg(elem), '{}')
                  FROM unnest(f.linked_to) AS elem
                 WHERE elem != ALL($2::text[])
              )
        WHERE f.id = ANY($1::text[])`,
      [chunk],
      { lock: fragmentRowLock("unlink", "linked_to && $1::text[]", [chunk]) });
  }
}

/**
 * linked_to에 남은 없는 파편 참조를 지운다(주기 정리 단계). 삭제 뒤 정리가 실패했거나 예전에 정리하지 않던
 * 삭제 경로가 남긴 참조다. id 순으로 훑어 batch건씩 고치고, 묶음마다 대상 행을 id 순으로 잠근다.
 * 남은 참조의 순서는 유지한다. dryRun이면 고치지 않고 센다.
 *
 * @param {Object}  [opts]
 * @param {number}  [opts.batch=500]
 * @param {number}  [opts.maxBatches=40]
 * @param {boolean} [opts.dryRun=false]
 * @returns {Promise<{fragments: number, references: number}>}
 */
export async function sweepDeadReferences({ batch = 500, maxBatches = 40, dryRun = false } = {}) {
  let after      = "";
  let fragments  = 0;
  let references = 0;
  for (let i = 0; i < maxBatches; i++) {
    const { rows } = await queryWithAgentVector("system",
      `SELECT f.id,
              (SELECT count(*) FROM unnest(f.linked_to) AS x
                WHERE NOT EXISTS (SELECT 1 FROM ${SCHEMA}.fragments g WHERE g.id = x))::int AS dead
         FROM ${SCHEMA}.fragments f
        WHERE f.id > $1
          AND EXISTS (SELECT 1 FROM unnest(f.linked_to) AS x
                       WHERE NOT EXISTS (SELECT 1 FROM ${SCHEMA}.fragments g WHERE g.id = x))
        ORDER BY f.id
        LIMIT $2`,
      [after, batch]);
    if (rows.length === 0) break;
    after = rows[rows.length - 1].id;
    const ids = rows.map(r => r.id);
    fragments  += ids.length;
    references += rows.reduce((sum, r) => sum + r.dead, 0);
    if (!dryRun) {
      await queryWithAgentVector("system",
        `UPDATE ${SCHEMA}.fragments f
            SET linked_to = (
                  SELECT COALESCE(array_agg(u.elem ORDER BY u.ord), '{}')
                    FROM unnest(f.linked_to) WITH ORDINALITY AS u(elem, ord)
                   WHERE EXISTS (SELECT 1 FROM ${SCHEMA}.fragments g WHERE g.id = u.elem)
                )
          WHERE f.id = ANY($1::text[])`,
        [],
        { lock: fragmentRowLock("unlink", "id = ANY($1::text[])", [ids]) });
    }
    if (rows.length < batch) break;
  }
  if (!dryRun && references > 0) {
    deadReferencesSwept.inc(references);
    logInfo(`[FragmentWriter] 죽은 linked_to 참조 ${references}건 정리(파편 ${fragments}건)`);
  }
  return { fragments, references };
}
