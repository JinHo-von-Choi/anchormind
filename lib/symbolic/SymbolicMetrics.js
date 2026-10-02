/**
 * SymbolicMetrics — Prometheus 메트릭 (v2.8.0 Phase 0)
 *
 * 작성자: 최진호
 * 작성일: 2026-04-15
 *
 * 4종 지표:
 * - memento_symbolic_warning_total        : 검증 단계에서 발생한 warning 수
 * - memento_symbolic_gate_blocked_total   : symbolic 게이트에서 차단된 작업 수
 * - memento_symbolic_claim_extracted_total: 추출된 claim 수
 * - memento_symbolic_op_latency_ms        : symbolic 연산 레이턴시 히스토그램 (ms)
 *
 * Phase 0 원칙: enabled=false 기본값에서는 어떤 메트릭도 증가해서는 안 된다.
 * 각 호출부가 싱글톤 symbolicMetrics 를 직접 호출한다.
 */

import prometheus from "prom-client";
import { register } from "../metrics.js";

/** Symbolic warning 카운터 */
export const symbolicWarningTotal = new prometheus.Counter({
  name      : "memento_symbolic_warning_total",
  help      : "Symbolic 검증에서 발생한 warning 수",
  labelNames: ["rule", "severity"],
  registers : [register]
});

/** Symbolic gate block 카운터 */
export const symbolicGateBlockedTotal = new prometheus.Counter({
  name      : "memento_symbolic_gate_blocked_total",
  help      : "Symbolic 게이트에서 차단된 작업 수",
  labelNames: ["phase", "reason"],
  registers : [register]
});

/** Symbolic claim 추출 카운터 */
export const symbolicClaimExtractedTotal = new prometheus.Counter({
  name      : "memento_symbolic_claim_extracted_total",
  help      : "추출된 claim 수",
  labelNames: ["extractor", "polarity"],
  registers : [register]
});

/** Symbolic 연산 레이턴시 히스토그램 (ms) */
export const symbolicOpLatencyMs = new prometheus.Histogram({
  name      : "memento_symbolic_op_latency_ms",
  help      : "Symbolic 연산 레이턴시 (ms)",
  labelNames: ["op"],
  buckets   : [1, 5, 10, 20, 50, 100, 200, 500],
  registers : [register]
});

/**
 * SymbolicMetrics facade — 호출부는 이 객체의 메서드만 사용한다.
 * prom-client 인스턴스를 직접 건드리지 않아야 테스트에서 mock 이 쉬워진다.
 */
export const symbolicMetrics = {
  /**
   * 규칙 위반 warning 기록
   * @param {string} rule     - 위반된 규칙 식별자 (예: 'link.cycle', 'claim.conflict')
   * @param {string} severity - 심각도 ('low' | 'medium' | 'high')
   */
  recordWarning(rule, severity = "low") {
    symbolicWarningTotal.inc({ rule, severity });
  },

  /**
   * 게이트 차단 기록
   * @param {string} phase  - Phase 식별자 (예: 'phase3', 'phase4')
   * @param {string} reason - 차단 사유 코드
   */
  recordGateBlock(phase, reason) {
    symbolicGateBlockedTotal.inc({ phase, reason });
  },

  /**
   * Claim 추출 기록
   * @param {string} extractor - 추출기 식별자 (예: 'morpheme-v1', 'llm-v1')
   * @param {string} polarity  - 'affirmative' | 'negative' | 'uncertain'
   */
  recordClaim(extractor, polarity) {
    symbolicClaimExtractedTotal.inc({ extractor, polarity });
  },

  /**
   * 연산 레이턴시 관측
   * @param {string} op - 연산 식별자 (예: 'explain', 'claim_extraction')
   * @param {number} ms - 밀리초
   */
  observeLatency(op, ms) {
    if (!Number.isFinite(ms) || ms < 0) return;
    symbolicOpLatencyMs.observe({ op }, ms);
  }
};
