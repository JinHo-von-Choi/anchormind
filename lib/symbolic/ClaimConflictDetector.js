/**
 * ClaimConflictDetector — polarity 충돌 탐지 (v2.8.0)
 *
 * 작성자: 최진호
 * 작성일: 2026-04-15
 *
 * 목적: 동일 (subject, predicate, object) 에서 positive ↔ negative 상반되는
 *       claim 쌍을 탐지하여 advisory warning 을 생성한다. ClaimStore 에 SQL
 *       로직을 위임하고 여기서는 severity 계산·메트릭 기록·결과 정규화만
 *       담당한다 (단일 책임).
 *
 * 설계 원칙:
 *  - advisory 전용. write 는 caller (ConflictResolver) 가 수행.
 *  - ClaimStore.findPolarityConflicts 의 예외는 여기서 흡수. symbolic 경로가
 *    neural 경로 fallback 을 막아서는 안 된다 (degraded=true 유지).
 *  - metrics 호출은 DI 로 주입 가능 (테스트/무효화).
 *  - severity 는 충돌 개수와 평균 confidence 로 산정.
 *
 * 참조:
 *  - lib/symbolic/ClaimStore.js (findPolarityConflicts)
 *  - lib/symbolic/SymbolicMetrics.js
 */

import { ClaimStore }      from "./ClaimStore.js";
import { symbolicMetrics } from "./SymbolicMetrics.js";

const DEFAULT_RULE_VERSION = "v1";
const RULE_ID              = "claim.conflict";

/**
 * @typedef {Object} PolarityConflict
 * @property {string}      conflictWith
 * @property {string}      subject
 * @property {string}      predicate
 * @property {string|null} object
 * @property {string}      ruleVersion
 */

/**
 * @typedef {Object} DetectionResult
 * @property {PolarityConflict[]} conflicts
 * @property {"none"|"low"|"medium"|"high"} severity
 * @property {string} ruleVersion
 * @property {string} [error]
 */

export class ClaimConflictDetector {

  /**
   * @param {Object}              [deps]
   * @param {ClaimStore}          [deps.claimStore]
   * @param {typeof symbolicMetrics} [deps.metrics]
   * @param {string}              [deps.ruleVersion]
   */
  constructor({
    claimStore  = new ClaimStore(),
    metrics     = symbolicMetrics,
    ruleVersion = DEFAULT_RULE_VERSION
  } = {}) {
    this.claimStore  = claimStore;
    this.metrics     = metrics;
    this.ruleVersion = ruleVersion;
  }

  /**
   * 주어진 fragment 에 연결된 polarity 충돌 쌍을 탐지한다.
   *
   * @param {string}      fragmentId
   * @param {string|null} [keyId]
   * @param {{ minConfidence?: number }} [opts]
   * @returns {Promise<DetectionResult>}
   */
  async detectPolarityConflicts(fragmentId, keyId = null, opts = {}) {
    if (!fragmentId) {
      return { conflicts: [], severity: "none", ruleVersion: this.ruleVersion };
    }

    try {
      const rows = await this.claimStore.findPolarityConflicts(fragmentId, keyId, opts);
      if (!Array.isArray(rows) || rows.length === 0) {
        return { conflicts: [], severity: "none", ruleVersion: this.ruleVersion };
      }

      const conflicts = rows.map((r) => ({
        conflictWith: r.f1 === fragmentId ? r.f2 : r.f1,
        subject     : r.subject,
        predicate   : r.predicate,
        object      : r.object ?? null,
        ruleVersion : this.ruleVersion
      }));

      const severity = this._severityFromRows(rows);
      this.metrics.recordWarning(RULE_ID, severity);

      return { conflicts, severity, ruleVersion: this.ruleVersion };
    } catch (err) {
      /** 신경 경로 fallback 보장 — symbolic 실패는 caller 에 예외로 전파하지 않는다 */
      return {
        conflicts  : [],
        severity   : "none",
        ruleVersion: this.ruleVersion,
        error      : err && err.message
      };
    }
  }

  /**
   * 단순 heuristic: 쌍 개수로 severity 산정.
   *   1건 → low, 2~3건 → medium, 4건↑ → high
   * (confidence 평균은 findPolarityConflicts 가 row 에 포함시키지 않는
   *  현재 스키마에서는 불가. caller 가 추후 enrich 하면 확장 예정.)
   * @param {Array} rows
   * @returns {"low"|"medium"|"high"}
   */
  _severityFromRows(rows) {
    if (rows.length >= 4) return "high";
    if (rows.length >= 2) return "medium";
    return "low";
  }
}

export { RULE_ID as CLAIM_CONFLICT_RULE_ID };
