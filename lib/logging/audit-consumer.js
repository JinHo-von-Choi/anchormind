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
 * runAuditRetention은 묶음마다 AuditStore.cleanup을 부르고, cleanup은 묶음마다 보존 기준점 행 하나를 체인 끝에 남긴다.
 *
 * registerAuditConsumer는 outbox 작업자를 시작하는 프로세스가 시작 전에 한 번 부른다.
 * MEMENTO_AUDIT_DB=off이면 등록하지 않는다(생산자도 기록하지 않는다).
 *
 * 다른 형식의 감사 topic: 다른 기능이 자기 payload로 남기는 감사 topic은 registerAuditTopic(topic, toAuditEvent)으로
 * 같은 체인에 옮긴다. toAuditEvent(event)는 outbox 이벤트를 buildAuditPayload 입력({ action, outcome, actor,
 * target, workspace, detail, occurredAt })으로 바꾸고, 형식이 맞지 않으면 AuditEventError를 던진다(dead-letter).
 * 이 등록은 onDuplicate "chain"이므로 같은 topic의 다른 처리기(예: 외부 전송 감사의 파일 기록 처리기)와 함께
 * 불린다. 묶인 처리기는 모두 idempotencyKey로 멱등이어야 한다. 외부 전송 감사 topic(audit.llm.egress)은
 * egressAuditEvent로 옮긴다.
 */

import { auditDbEnabled, auditRetentionDays } from "../config.js";
import { getPrimaryPool }                     from "../tools/db.js";
import { registerOutboxHandler, OutboxPermanentError } from "../outbox/OutboxHandlers.js";
import { AuditStore }                         from "./AuditStore.js";
import { AUDIT_TOPIC, AuditEventError, readAuditPayload, buildAuditPayload } from "./audit-event.js";
import { auditRecordedTotal, auditCleanedTotal } from "./audit-metrics.js";

export const AUDIT_RETENTION_CHUNK       = 10_000;
export const AUDIT_RETENTION_MAX_PER_RUN = 50_000;

/** 외부 전송 감사 topic. lib/llm/EgressGate.js의 EGRESS_AUDIT_TOPIC과 같은 값이다. */
export const AUDIT_EGRESS_TOPIC = "audit.llm.egress";

/**
 * 감사 승격 처리기를 만든다.
 *
 * @param {{ append: (record: object, sourceEvent: string) => Promise<{ duplicate: boolean }> }} store
 * @param {{ toAuditEvent?: ((event: object) => object)|null }} [options] toAuditEvent: payload가 감사 payload가 아닌
 *   topic에서 outbox 이벤트를 buildAuditPayload 입력으로 바꾸는 함수
 * @returns {(event: { payload: object, idempotencyKey: string }) => Promise<object>}
 */
export function createAuditHandler(store, { toAuditEvent = null } = {}) {
  return async (event) => {
    let record;
    try {
      record = readAuditPayload(toAuditEvent ? buildAuditPayload(toAuditEvent(event)) : event.payload);
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
  const target  = store ?? new AuditStore(getPrimaryPool());
  const release = [
    registerOutboxHandler(AUDIT_TOPIC, createAuditHandler(target)),
    registerAuditTopic(AUDIT_EGRESS_TOPIC, egressAuditEvent, { store: target })
  ];
  return () => release.reverse().forEach((fn) => fn());
}

/**
 * 다른 payload 형식의 감사 topic을 같은 체인에 옮기는 처리기를 "chain"으로 등록한다.
 *
 * @param {string} topic
 * @param {(event: object) => object} toAuditEvent outbox 이벤트를 buildAuditPayload 입력으로 바꾼다
 * @param {{ store?: object }} [options]
 * @returns {() => void} 해제 함수
 */
export function registerAuditTopic(topic, toAuditEvent, { store = null } = {}) {
  const target = store ?? new AuditStore(getPrimaryPool());
  return registerOutboxHandler(topic, createAuditHandler(target, { toAuditEvent }), { onDuplicate: "chain" });
}

/**
 * 외부 전송 감사 이벤트(audit.llm.egress)를 감사 이벤트로 바꾼다. 본문과 workspace 이름은 담지 않고 단계, 제공자,
 * 분류, 바이트, 가린 규칙 수, workspace 수만 담는다. 행위자는 키(마스터 문맥은 master, 키 없는 서버 작업은 system)다.
 *
 * @param {{ payload: object, createdAt?: Date|string }} event
 * @returns {object} buildAuditPayload 입력
 */
export function egressAuditEvent(event) {
  const p = event?.payload;
  if (!p || typeof p !== "object" || typeof p.stage !== "string" || typeof p.provider !== "string" || !Number.isInteger(p.bytes)) {
    throw new AuditEventError("payload", "audit.llm.egress payload에 stage, provider, bytes가 없다");
  }
  const keyId = typeof p.key_id === "string" && p.key_id !== "" ? p.key_id : (p.key_context === "master" ? "master" : null);
  return {
    action    : "llm.egress",
    actor     : keyId ? { keyId } : "system",
    target    : { type: "llm_provider", id: p.provider },
    occurredAt: event.createdAt ?? new Date(),
    detail    : {
      stage         : p.stage,
      providerClass : typeof p.provider_class === "string" ? p.provider_class : null,
      bytes         : p.bytes,
      maskedRules   : Number.isInteger(p.masked_rules) ? p.masked_rules : 0,
      workspaceCount: Array.isArray(p.workspaces) ? p.workspaces.length : 0
    }
  };
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
