/**
 * 훅 접수 사전 확인 질의
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 회고 이벤트를 기록하기 전에 질의 하나로 두 가지를 본다.
 *   seen     같은 멱등 키의 회고가 이미 선점되었거나 끝났는가(idempotency_records, tool hook_reflect).
 *            이미 있으면 처리기는 outbox에 다시 쓰지 않는다.
 *   pending  같은 키(마스터는 key_id 없음)의 대기 중인 hook.reflect 이벤트 수. limit에서 멈춰 센다.
 *
 * idempotency_records는 (scope_key, tool, idempotency_key) 유일 색인으로 찾는다. 대기 이벤트 수는 outbox_events의
 * 대기 행(processed_at, dead_at 모두 NULL)에서 topic과 payload의 keyId로 거르며 limit 건에서 멈춘다.
 */

import { SCHEMA } from "../memory/schema.js";
import { HOOK_REFLECT_TOPIC, HOOK_REFLECT_IDEMPOTENCY_TOOL } from "./hook-contract.js";

const GUARD_SQL = `
  SELECT EXISTS (
           SELECT 1 FROM ${SCHEMA}.idempotency_records
            WHERE scope_key = $1 AND tool = $2 AND idempotency_key = $3 AND expires_at > now()
         ) AS seen,
         (SELECT count(*)::int FROM (
            SELECT 1 FROM ${SCHEMA}.outbox_events
             WHERE processed_at IS NULL AND dead_at IS NULL AND topic = $4
               AND payload->>'keyId' IS NOT DISTINCT FROM $5
             LIMIT $6
          ) AS waiting) AS pending`;

/**
 * @param {{ query: Function }} pool
 * @param {{ keyId: string|null, idempotencyKey: string, limit: number }} args
 * @returns {Promise<{ seen: boolean, pending: number }>}
 */
export async function hookAdmissionState(pool, { keyId, idempotencyKey, limit }) {
  const { rows } = await pool.query(GUARD_SQL, [
    keyId ?? "", HOOK_REFLECT_IDEMPOTENCY_TOOL, idempotencyKey, HOOK_REFLECT_TOPIC, keyId ?? null, limit
  ]);
  return { seen: rows[0]?.seen === true, pending: Number(rows[0]?.pending ?? 0) };
}
