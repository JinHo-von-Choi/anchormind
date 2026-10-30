/**
 * LinkIntegrityChecker — Phase 3 Advisory Link Integrity
 *
 * 작성자: 최진호
 * 작성일: 2026-04-15
 *
 * SessionLinker.wouldCreateCycle(fromId, toId, agentId, keyId)를 재사용하여
 * caller-side에서 cycle을 advisory 체크한다. LinkStore.createLink 시그니처는
 * 건드리지 않는다 (v2.7.0 RBAC 보안 원칙 유지).
 *
 * advisory only: hasCycle=true여도 block하지 않는다. caller는 warning 메트릭을
 * 기록한 뒤 createLink를 그대로 호출한다. Phase 4 soft gating 이후에만
 * quarantine_state 상향이 발생한다.
 *
 * 반환 스키마: { hasCycle, reason, ruleVersion }
 *   - hasCycle   {boolean}  cycle 존재 여부
 *   - reason     {string}   ok | cycle_detected | non_directional | error
 *   - ruleVersion{string}   규칙 패키지 버전 (SYMBOLIC_CONFIG.ruleVersion)
 */

import { SYMBOLIC_CONFIG }  from "../../config/symbolic.js";
import { symbolicMetrics }  from "./SymbolicMetrics.js";

/**
 * 방향성 관계 타입 집합. 이 타입만 cycle 검사 대상이다.
 * related/related_to 같은 무방향 링크는 사이클 개념이 없으므로 early return.
 */
const DIRECTIONAL_RELATIONS = new Set([
  "caused_by",
  "resolved_by",
  "superseded_by",
  "preceded_by"
]);

export class LinkIntegrityChecker {
  /**
   * @param {Object} deps
   * @param {Object} [deps.sessionLinker] - wouldCreateCycle(fromId, toId, agentId, keyId)을 제공
   */
  constructor({ sessionLinker } = {}) {
    this.sessionLinker = sessionLinker || null;
  }

  /**
   * A → B 링크 생성 시 순환 참조 여부 확인 (advisory).
   *
   * @param {string|number} fromId
   * @param {string|number} toId
   * @param {string}        relationType
   * @param {string}        [agentId="default"]
   * @param {string|null}   [keyId=null]  - API 키 격리 (cross-tenant cycle 차단)
   * @returns {Promise<{ hasCycle: boolean, reason: string, ruleVersion: string }>}
   */
  async checkCycle(fromId, toId, relationType, agentId = "default", keyId = null) {
    const ruleVersion = SYMBOLIC_CONFIG.ruleVersion;

    if (!DIRECTIONAL_RELATIONS.has(relationType)) {
      return { hasCycle: false, reason: "non_directional", ruleVersion };
    }

    if (!this.sessionLinker || typeof this.sessionLinker.wouldCreateCycle !== "function") {
      return { hasCycle: false, reason: "no_linker", ruleVersion };
    }

    try {
      const cycle = await this.sessionLinker.wouldCreateCycle(fromId, toId, agentId, keyId);
      if (cycle) {
        symbolicMetrics.recordWarning("link_cycle", "high");
        return { hasCycle: true, reason: "cycle_detected", ruleVersion };
      }
      return { hasCycle: false, reason: "ok", ruleVersion };
    // iron-laws: ignore[IL-301] 실패를 reason=error로 결과에 드러낸다
    } catch {
      return { hasCycle: false, reason: "error", ruleVersion };
    }
  }

  /**
   * quarantined 파편으로의 링크 위반 확인 (Phase 4 이후 확장 가능).
   * 현재는 no-op: Phase 3 범위에서는 cycle 검증만 수행한다.
   *
   * @returns {Promise<{ violated: boolean, reason: string, ruleVersion: string }>}
   */
  async checkQuarantineViolation() {
    return { violated: false, reason: "not_implemented", ruleVersion: SYMBOLIC_CONFIG.ruleVersion };
  }

  /**
   * case_event_edges preceded_by 순환 검증 (EpisodeContinuityService 연동).
   * 현재는 no-op: Phase 3 범위에서는 fragment_links cycle만 검증한다.
   *
   * @returns {Promise<{ hasCycle: boolean, reason: string, ruleVersion: string }>}
   */
  async checkCaseEventCycle() {
    return { hasCycle: false, reason: "not_implemented", ruleVersion: SYMBOLIC_CONFIG.ruleVersion };
  }
}

export { DIRECTIONAL_RELATIONS };
