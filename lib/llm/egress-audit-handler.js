/**
 * 외부 전송 감사 이벤트(audit.llm.egress)의 기본 outbox 처리기
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 관문(EgressGate)이 외부 제공자로 보내기 전에 남긴 이벤트를 감사 로그 파일(lib/logging/audit.js)에 한 줄로 옮긴다.
 * 줄에는 키 id(행위자), 단계, 제공자, 분류, 바이트, 가린 규칙 수, workspace 수, 이벤트 id만 담고 본문과
 * workspace 이름은 담지 않는다.
 *
 * 멱등: 같은 프로세스에서 같은 idempotencyKey가 다시 오면 쓰지 않는다(최근 키 EVENT_MEMORY개 기억).
 * 다른 프로세스의 재전달은 줄의 event= 값으로 구분한다. 기록 실패는 던져 outbox가 재시도한다.
 *
 * 등록: 기동 시 registerEgressAuditHandler()를 부른다. onDuplicate "chain"으로 등록하므로 다른 소비자(예: DB 감사
 * 저장소)가 같은 topic에 먼저 또는 나중에 "chain"으로 등록하면 둘 다 불린다. 묶인 처리기는 모두 멱등이어야 한다.
 */

import { writeAuditLine }                                from "../logging/audit.js";
import { registerOutboxHandler, OutboxPermanentError }   from "../outbox/OutboxHandlers.js";
import { EGRESS_AUDIT_TOPIC }                            from "./EgressGate.js";

/** 감사 줄의 operation 이름 */
export const EGRESS_AUDIT_OPERATION = "llm_egress";

/** 프로세스 안에서 기억하는 처리 완료 이벤트 수 */
const EVENT_MEMORY = 4096;

/** @param {unknown} value */
const isText = (value) => typeof value === "string" && value !== "";

/**
 * payload에서 감사 줄 필드를 만든다. 형식이 맞지 않으면 재시도해도 같으므로 OutboxPermanentError다.
 *
 * @param {{ idempotencyKey: string, payload: object }} event
 * @returns {{ type: string, success: true, details: string, actor: { keyId: string } }}
 */
function auditFields(event) {
  const p = event?.payload;
  if (!p || typeof p !== "object" || !isText(p.stage) || !isText(p.provider) || !Number.isInteger(p.bytes)) {
    throw new OutboxPermanentError(`audit.llm.egress payload is malformed (event ${event?.idempotencyKey ?? "?"})`);
  }
  const actorKey = isText(p.key_id) ? p.key_id : (p.key_context === "master" ? "master" : "none");
  const details  = [
    `event=${event.idempotencyKey}`,
    `provider=${p.provider}`,
    `class=${p.provider_class ?? "-"}`,
    `bytes=${p.bytes}`,
    `masked_rules=${Number.isInteger(p.masked_rules) ? p.masked_rules : 0}`,
    `workspaces=${Array.isArray(p.workspaces) ? p.workspaces.length : 0}`
  ].join(" ");
  return { type: p.stage, success: true, details, actor: { keyId: actorKey } };
}

/**
 * 처리기를 만든다.
 *
 * @param {{ write?: (operation: string, fields: object) => Promise<void> }} [deps]
 * @returns {(event: object) => Promise<void>}
 */
export function createEgressAuditHandler({ write = writeAuditLine } = {}) {
  const done = new Set();
  return async (event) => {
    if (done.has(event.idempotencyKey)) return;
    await write(EGRESS_AUDIT_OPERATION, auditFields(event));
    done.add(event.idempotencyKey);
    if (done.size > EVENT_MEMORY) done.delete(done.values().next().value);
  };
}

/** 현재 등록의 해제 함수. 없으면 null */
let registration = null;

/**
 * audit.llm.egress의 기본 처리기를 등록한다. 이미 등록했으면 같은 해제 함수를 돌려준다.
 *
 * @param {{ write?: Function }} [deps]
 * @returns {() => void} 해제 함수
 */
export function registerEgressAuditHandler(deps = {}) {
  if (registration) return registration;
  const unregister = registerOutboxHandler(EGRESS_AUDIT_TOPIC, createEgressAuditHandler(deps), { onDuplicate: "chain" });
  registration = () => {
    unregister();
    registration = null;
  };
  return registration;
}
