/**
 * 의미 쓰기 관문(WriteGate) 판정 지표.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * entry 라벨은 쓰기 진입점 이름(remember, amend, batch_remember 등)이다.
 * outcome 라벨:
 *   pass  : 정책과 workspace 위반 없이 통과
 *   warn  : 위반이 있으나 경고로 남기고 저장
 *   reject: hard gate 키에서 위반으로 저장 거부
 */

import promClient   from "prom-client";
import { register } from "../../metrics.js";

/** 관문 판정 건수 (entry, outcome별) */
export const writeGateTotal = new promClient.Counter({
  name      : "memento_write_gate_total",
  help      : "의미 쓰기 관문의 진입점별 판정 건수",
  labelNames: ["entry", "outcome"],
  registers : [register]
});

/**
 * 관문 판정을 기록한다.
 *
 * @param {string}                     entry
 * @param {"pass"|"warn"|"reject"}     outcome
 */
export function recordWriteGate(entry, outcome) {
  writeGateTotal.inc({ entry, outcome });
}

/** 검토 표지를 단 쓰기 건수 (entry, reason별) */
export const reviewFlagTotal = new promClient.Counter({
  name      : "memento_review_flag_total",
  help      : "검토 대기열 표지를 단 쓰기의 진입점과 사유별 건수",
  labelNames: ["entry", "reason"],
  registers : [register]
});

/**
 * 검토 표지를 기록한다.
 *
 * @param {string} entry
 * @param {string} reason - ReviewQueue.REVIEW_REASONS 값
 */
export function recordReviewFlag(entry, reason) {
  reviewFlagTotal.inc({ entry, reason });
}

/** 검토 대기열 결정 값. 지표 라벨의 닫힌 집합이다. */
export const REVIEW_DECISION_LABELS = Object.freeze(["approve", "reject", "auto_reject"]);

/** 검토 대기열 결정 건수 (decision별) */
export const reviewDecisionTotal = new promClient.Counter({
  name      : "memento_review_decisions_total",
  help      : "검토 대기열의 승인, 거절, 30일 미결정 자동 거절 건수",
  labelNames: ["decision"],
  registers : [register]
});

/**
 * 검토 결정을 기록한다. 닫힌 집합 밖의 값은 other로 센다.
 *
 * @param {string} decision
 * @param {number} [count]
 */
export function recordReviewDecision(decision, count = 1) {
  reviewDecisionTotal.inc({ decision: REVIEW_DECISION_LABELS.includes(decision) ? decision : "other" }, count);
}
