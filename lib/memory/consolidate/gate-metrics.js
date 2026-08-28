/**
 * Consolidate safety gate 차단 가시화 메트릭.
 *
 * 작성자: 최진호
 * 작성일: 2026-08-28
 *
 * reason 라벨:
 *   distinctive_token_loss: 제거 대상의 수치·식별자가 승계자에 없어 병합 차단
 *   survivor_shorter      : 승계자가 제거 대상보다 현저히 짧아 정보 삭제로 판정
 *   cosine_below_floor    : 코사인 하한 미달
 *
 * stage 라벨은 게이트가 붙은 정리 단계 이름이다(semantic_dedup 등).
 */

import promClient  from "prom-client";
import { register } from "../../metrics.js";

/** 게이트 차단 건수 (stage, reason별) */
export const gateBlockedTotal = new promClient.Counter({
  name      : "memento_consolidate_gate_blocked_total",
  help      : "정리 단계에서 안전 게이트가 차단한 병합 건수",
  labelNames: ["stage", "reason"],
  registers : [register]
});

/** 게이트를 통과한 병합 건수 (stage별) */
export const gateAllowedTotal = new promClient.Counter({
  name      : "memento_consolidate_gate_allowed_total",
  help      : "정리 단계에서 안전 게이트를 통과한 병합 건수",
  labelNames: ["stage"],
  registers : [register]
});

/**
 * 게이트 차단을 기록한다.
 *
 * @param {string} stage
 * @param {"distinctive_token_loss"|"survivor_shorter"|"cosine_below_floor"} reason
 */
export function recordGateBlock(stage, reason) {
  gateBlockedTotal.inc({ stage, reason });
}

/**
 * 게이트 통과를 기록한다.
 *
 * @param {string} stage
 */
export function recordGateAllow(stage) {
  gateAllowedTotal.inc({ stage });
}
