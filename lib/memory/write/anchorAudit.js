/**
 * 앵커 판정 감사 기록
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 쓰기 관문의 앵커 판정(지정 허용, 일반 파편으로 낮춤, 거부, 해제)을 감사 로그에 `anchor` 줄로 남긴다.
 * 행위자는 판정에 쓴 주체(master 또는 키 id)다.
 */

import { logAudit } from "../../logging/audit.js";

/**
 * 감사 기록 details 문자열.
 *
 * @param {{entry: string, op: string, change: string, outcome: string, reason: string}} event
 * @returns {string}
 */
export function formatAnchorAuditDetails({ entry, op, change, outcome, reason }) {
  return `entry=${entry} op=${op} change=${change} outcome=${outcome} reason=${reason}`;
}

/**
 * 앵커 판정 하나를 감사 로그에 남긴다.
 *
 * @param {Object}      event
 * @param {string}      event.entry
 * @param {string}      event.op
 * @param {string}      event.change       - set 또는 clear
 * @param {string}      event.outcome      - granted, downgraded, rejected, cleared
 * @param {string}      event.reason
 * @param {string|null} event.fragmentId
 * @param {string|null} event.fragmentType
 * @param {string|null} event.keyId
 * @param {boolean}     event.isMaster
 * @returns {Promise<void>}
 */
export function auditAnchorDecision(event) {
  return logAudit("anchor", {
    type      : event.fragmentType ?? undefined,
    fragmentId: event.fragmentId ?? undefined,
    success   : event.outcome !== "rejected",
    details   : formatAnchorAuditDetails(event),
    actor     : { keyId: event.isMaster ? "master" : event.keyId }
  });
}
