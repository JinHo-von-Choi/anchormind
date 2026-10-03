/**
 * 감사 승격 소비자
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * outbox topic audit.record의 처리기. payload를 다시 검증해(audit-event.readAuditPayload)
 * AuditStore.append로 단일 해시 체인 끝에 기록한다. 멱등 키는 outbox의 "topic:id"이고, 같은 이벤트가
 * 다시 전달되면 저장소가 기존 행을 돌려준다. 읽을 수 없는 payload는 OutboxPermanentError로 곧바로
 * dead-letter가 되고, 저장소 오류(잠금 대기 초과, 표 없음)는 재시도한다.
 *
 * registerAuditConsumer는 outbox 작업자를 시작하는 프로세스가 시작 전에 한 번 부른다.
 * MEMENTO_AUDIT_DB=off이면 등록하지 않는다(생산자도 기록하지 않는다).
 */

import { auditDbEnabled, auditRetentionDays } from "../config.js";
import { getPrimaryPool }                     from "../tools/db.js";
import { registerOutboxHandler, OutboxPermanentError } from "../outbox/OutboxHandlers.js";
import { AuditStore }                         from "./AuditStore.js";
import { AUDIT_TOPIC, AuditEventError, readAuditPayload } from "./audit-event.js";
import { auditRecordedTotal, auditCleanedTotal } from "./audit-metrics.js";

export const AUDIT_RETENTION_CHUNK       = 1_000;
export const AUDIT_RETENTION_MAX_PER_RUN = 50_000;

/**
 * 감사 승격 처리기를 만든다.
 *
 * @param {{ append: (record: object, sourceEvent: string) => Promise<{ duplicate: boolean }> }} store
 * @returns {(event: { payload: object, idempotencyKey: string }) => Promise<object>}
 */
export function createAuditHandler(store) {
  return async (event) => {
    let record;
    try {
      record = readAuditPayload(event.payload);
    } catch (err) {
      if (err instanceof AuditEventError) {
        throw new OutboxPermanentError(`감사 payload를 읽을 수 없다(${err.field}): ${err.message}`, { cause: err });
      }
      throw err;
    }
    const result = await store.append(record, event.idempotencyKey);
    if (!result.duplicate) auditRecordedTotal.inc();
    return result;
  };
}

/**
 * 감사 승격 처리기를 등록한다.
 *
 * @param {{ store?: object }} [options] store 기본값: 주 풀의 AuditStore
 * @returns {(() => void)|null} 등록 해제 함수. 스위치가 꺼져 있으면 null
 */
export function registerAuditConsumer({ store = null } = {}) {
  if (!auditDbEnabled()) return null;
  return registerOutboxHandler(AUDIT_TOPIC, createAuditHandler(store ?? new AuditStore(getPrimaryPool())));
}

/**
 * 보존 기간이 지난 감사 행을 묶음 단위로 회차 상한까지 지운다.
 *
 * @param {{ store?: object, retentionDays?: number, chunk?: number, maxPerRun?: number }} [options]
 * @returns {Promise<number>} 지운 행 수
 */
export async function runAuditRetention({
  store = null, retentionDays = auditRetentionDays(), chunk = AUDIT_RETENTION_CHUNK, maxPerRun = AUDIT_RETENTION_MAX_PER_RUN
} = {}) {
  const target  = store ?? new AuditStore(getPrimaryPool());
  let   deleted = 0;
  while (deleted < maxPerRun) {
    const limit = Math.min(chunk, maxPerRun - deleted);
    const n     = await target.cleanup({ retentionDays, limit });
    deleted += n;
    if (n < limit) break;
  }
  if (deleted > 0) auditCleanedTotal.inc(deleted);
  return deleted;
}
