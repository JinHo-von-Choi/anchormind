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
