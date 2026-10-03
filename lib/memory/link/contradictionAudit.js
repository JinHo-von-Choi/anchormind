/**
 * 모순 해소 기록의 본문과 topic
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * ContradictionDetector와 MemoryConsolidator가 같은 해소 기록을 남기도록 본문 함수와 topic을 한곳에 둔다.
 */

import { forgetCascadeEnabled }      from "../../config.js";
import { CONTRADICTION_AUDIT_TOPIC } from "../write/ForgetCascade.js";

export { CONTRADICTION_AUDIT_TOPIC };

/**
 * 모순 해소 기록의 본문. 삭제 연쇄(MEMENTO_FORGET_CASCADE)가 켜져 있으면 두 파편의 id만 담고,
 * 꺼져 있으면 두 파편 본문의 앞 80자를 담는다.
 *
 * @param {{id: string, content?: string}} loser
 * @param {{id: string, content?: string}} winner
 * @param {string} [reasoning]
 * @returns {string}
 */
export function contradictionAuditContent(loser, winner, reasoning) {
  const basis = reasoning || "시간 순서 기준";
  if (forgetCascadeEnabled()) {
    return `[모순 해결] 대체된 파편 ${loser.id}, 남은 파편 ${winner.id}. 판단 근거: ${basis}`;
  }
  return `[모순 해결] "${(loser.content  || "").substring(0, 80)}" 파편이 "${(winner.content || "").substring(0, 80)}" 으로 대체됨. 판단 근거: ${basis}`;
}
