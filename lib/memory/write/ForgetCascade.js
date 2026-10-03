/**
 * 삭제 연쇄
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * forget이 파편을 지울 때 그 파편 본문의 사본을 같은 트랜잭션에서 지운다.
 *   - case_events.summary: source_fragment_id가 지운 파편인 행의 요약을 DELETED_SUMMARY로 바꾼다
 *   - 모순 해소 기록 파편: topic이 CONTRADICTION_AUDIT_TOPIC이고 key_id가 없으며(서버가 기록한 행)
 *     linked_to에 지울 파편이 있는 행을 함께 지운다
 * 응답의 영수증은 purged.case_summaries, purged.audit_fragments 건수다.
 *
 * 원본 파편이 이미 없는 case_events 요약(고아 사본)은 purgeOrphanCaseSummaries가 정리한다
 * (scripts/purge-orphan-case-summaries.js).
 */

import { SCHEMA }                           from "../schema.js";
import { keyScopeScalar }                   from "../keyScope.js";
import { fragmentRowLock, LOCK_FOR_DELETE } from "./rowLock.js";

/** 원본 파편을 지운 case_events 요약의 대체 값 */
export const DELETED_SUMMARY = "[삭제됨]";

/** 모순 해소 기록 파편의 topic. 모순·대체 탐지 대상에서 빼고, 삭제 연쇄의 대상으로 찾는다. */
export const CONTRADICTION_AUDIT_TOPIC = "contradiction_audit";

/** 고아 사본 정리의 한 문장당 행 수 기본값 */
export const ORPHAN_PURGE_BATCH = 500;

/** 고아 사본 미리보기가 보여 주는 event_id 수 */
const ORPHAN_SAMPLE_SIZE = 20;

/**
 * 잠근 행($1)을 지우고, 지운 id를 출처로 한 case_events 요약을 $2로 바꾼다. 지운 행마다 한 줄을
 * 돌려주며 scrubbed는 바꾼 요약 수(모든 줄에서 같다)다.
 */
export const CASCADE_DELETE_SQL = `
  WITH gone AS (
    DELETE FROM ${SCHEMA}.fragments WHERE id = ANY($1::text[])
    RETURNING id, keywords, topic, type, key_id
  ), scrubbed AS (
    UPDATE ${SCHEMA}.case_events SET summary = $2
     WHERE source_fragment_id = ANY($1::text[])
       AND summary IS DISTINCT FROM $2
    RETURNING event_id
  )
  SELECT g.id, g.keywords, g.topic, g.type, g.key_id,
         (SELECT count(*)::int FROM scrubbed) AS scrubbed
    FROM gone g`;

/** 원본 파편이 없는 case_events 요약 조건(별칭 ce). 빈 문자열 출처는 NULL과 같이 출처 없음이다. */
const ORPHAN_CONDITION = `ce.source_fragment_id IS NOT NULL
         AND ce.source_fragment_id <> ''
         AND ce.summary IS DISTINCT FROM $1
         AND NOT EXISTS (SELECT 1 FROM ${SCHEMA}.fragments f WHERE f.id = ce.source_fragment_id)`;

/** @returns {{case_summaries: number, audit_fragments: number}} */
export function emptyPurge() {
  return { case_summaries: 0, audit_fragments: 0 };
}

/**
 * 두 영수증의 건수를 더한다.
 *
 * @param {{case_summaries: number, audit_fragments: number}} total
 * @param {{case_summaries?: number, audit_fragments?: number}} [part]
 * @returns {{case_summaries: number, audit_fragments: number}}
 */
export function addPurge(total, part) {
  return {
    case_summaries : total.case_summaries  + (part?.case_summaries  ?? 0),
    audit_fragments: total.audit_fragments + (part?.audit_fragments ?? 0)
  };
}

/**
 * forget 응답. purged가 null이면(삭제 연쇄 꺼짐) 영수증을 싣지 않는다.
 *
 * @param {{deleted: number, protected: number, purged: Object|null}} tally
 * @returns {{deleted: number, protected: number, purged?: Object}}
 */
export function forgetReceipt({ deleted, protected: protectedCount, purged }) {
  const response = { deleted, protected: protectedCount };
  if (purged) response.purged = { ...purged };
  return response;
}

/**
 * 삭제 연쇄의 잠금 문장. 키 범위 안의 대상 id와, 모순 해소 기록이 아닌 대상을 linked_to에 가진 서버
 * 기록 모순 해소 파편을 id 오름차순으로 FOR UPDATE 잠근다. 해소 기록끼리는 같은 topic 자동 연결로
 * linked_to를 공유하므로, 해소 기록인 대상은 다른 해소 기록을 끌어오지 않는다. 대상 목록은 ARRAY
 * 하위 질의로 계산한다.
 *
 * @param {string[]}    ids
 * @param {string|null} keyId - null이면 키 범위 없음(master)
 * @returns {{operation: string, sql: string, params: Array}}
 */
export function cascadeDeleteLock(ids, keyId) {
  const params  = [ids];
  const scope   = keyScopeScalar(params, "t.key_id", keyId);
  params.push(CONTRADICTION_AUDIT_TOPIC);
  const topic   = `$${params.length}`;
  const targets = `ARRAY(SELECT t.id FROM ${SCHEMA}.fragments t WHERE t.id = ANY($1::text[])${scope})`;
  const sources = `ARRAY(SELECT t.id FROM ${SCHEMA}.fragments t WHERE t.id = ANY($1::text[])${scope} AND t.topic IS DISTINCT FROM ${topic})`;
  const where   = `id = ANY(${targets})
     OR (topic = ${topic} AND key_id IS NULL AND linked_to && ${sources})`;
  return fragmentRowLock("delete", where, params, LOCK_FOR_DELETE);
}

/**
 * CASCADE_DELETE_SQL 결과를 요청한 대상과 함께 딸려 지운 모순 해소 기록으로 나눈다.
 *
 * @param {string[]} requestedIds
 * @param {Array<{id: string, scrubbed?: number}>} rows
 * @returns {{deleted: number, removedIds: string[], auditRows: Object[],
 *            purged: {case_summaries: number, audit_fragments: number}}}
 */
export function summarizeCascade(requestedIds, rows) {
  const requested = new Set(requestedIds);
  const list      = Array.isArray(rows) ? rows : [];
  const auditRows = list.filter(r => !requested.has(r.id));
  return {
    deleted   : list.length - auditRows.length,
    removedIds: list.map(r => r.id),
    auditRows,
    purged    : {
      case_summaries : list.length > 0 ? Number(list[0].scrubbed ?? 0) : 0,
      audit_fragments: auditRows.length
    }
  };
}

/**
 * 원본 파편이 없는 case_events 요약을 세거나 DELETED_SUMMARY로 바꾼다. 미리보기는 건수와
 * event_id 표본만 돌려주고 요약 본문은 담지 않는다. 실행은 batchSize행씩 문장을 나눠 대상이
 * 남지 않을 때까지 반복하며, 다른 트랜잭션이 잠근 행은 건너뛴다(다음 실행에서 처리).
 *
 * @param {{query: Function}} pool
 * @param {{execute?: boolean, batchSize?: number}} [opts]
 * @returns {Promise<{mode: "dry-run", orphans: number, sample_event_ids: string[]}
 *                  |{mode: "execute", updated: number, batches: number}>}
 */
export async function purgeOrphanCaseSummaries(pool, { execute = false, batchSize = ORPHAN_PURGE_BATCH } = {}) {
  if (!execute) {
    const counted = await pool.query(
      `SELECT count(*)::int AS n FROM ${SCHEMA}.case_events ce WHERE ${ORPHAN_CONDITION}`,
      [DELETED_SUMMARY]
    );
    const sample  = await pool.query(
      `SELECT ce.event_id FROM ${SCHEMA}.case_events ce WHERE ${ORPHAN_CONDITION}
        ORDER BY ce.created_at, ce.event_id LIMIT ${ORPHAN_SAMPLE_SIZE}`,
      [DELETED_SUMMARY]
    );
    return { mode: "dry-run", orphans: counted.rows[0]?.n ?? 0, sample_event_ids: sample.rows.map(r => String(r.event_id)) };
  }

  let updated = 0;
  let batches = 0;
  for (;;) {
    const result = await pool.query(
      `UPDATE ${SCHEMA}.case_events SET summary = $1
        WHERE event_id IN (
          SELECT ce.event_id FROM ${SCHEMA}.case_events ce
           WHERE ${ORPHAN_CONDITION}
           LIMIT $2
             FOR UPDATE SKIP LOCKED
        )`,
      [DELETED_SUMMARY, batchSize]
    );
    batches += 1;
    updated += result.rowCount ?? 0;
    if ((result.rowCount ?? 0) < batchSize) break;
  }
  return { mode: "execute", updated, batches };
}
