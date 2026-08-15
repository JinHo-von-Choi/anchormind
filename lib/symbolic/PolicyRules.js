/**
 * PolicyRules — Phase 4 구조적 스키마 제약 검사 (soft gating)
 *
 * 작성자: 최진호
 * 작성일: 2026-04-15
 *
 * AutoReflect 5원칙(자기완결성 형식 검증)과 영역 분리된 구조적 제약 레이어.
 * 파편 type별로 최소 구조 무결성을 predicate 함수로 검사하여 위반 사항을
 * validation_warnings에 기록한다. store.insert를 block하지 않는다.
 *
 * 6개 predicate:
 * 1. decisionHasRationale     — decision은 linked_to 최소 2건 또는 reason/근거 텍스트 필요
 * 2. errorHasResolutionPath   — error는 원인/해결 키워드 또는 resolution_status 필요
 * 3. procedureHasStepMarkers  — procedure는 단계 마커 필요
 * 4. caseIdHasResolutionStatus— case_id 있는 파편은 resolution_status 필요
 * 5. assertionNotContradictory— assertion_status=verified와 rejected 동시 보유 금지
 * 6. fragmentHasWorkspace     — workspace가 명시값·키 default 어느 쪽으로도 해석되지 않으면 경고
 *
 * AutoReflect 원칙과 중복되지 않는 구조적 제약만 다룬다.
 * (prose 품질, 대명사 해소, 구체 엔티티 등은 AutoReflect 영역)
 */

const STEP_MARKER_REGEX  = /(\b1\.\s|\b2\.\s|\bstep\s*\d|단계|\n\s*-\s|\n\s*\*\s|\n\s*\d+\)\s)/i;
const CAUSE_FIX_REGEX    = /(원인|이유|해결|조치|복구|cause|reason|fix|resolve|root\s*cause|workaround)/i;
const RATIONALE_REGEX    = /(근거|이유|because|reason|rationale|왜냐하면|기반|기반으로)/i;

export class PolicyRules {
  /**
   * 파편에 5개 predicate를 적용하여 위반 목록을 반환한다.
   *
   * @param {Object} fragment
   *   - type               {string}
   *   - content            {string}
   *   - linked_to          {string[]|undefined}
   *   - case_id            {string|null|undefined}
   *   - resolution_status  {string|null|undefined}
   *   - assertion_status   {string|null|undefined}
   * @returns {Array<{ rule: string, severity: string, detail: string, ruleVersion: string }>}
   */
  check(fragment) {
    const violations  = [];
    const ruleVersion = "v1";

    if (!fragment || typeof fragment !== "object") return violations;

    const content      = typeof fragment.content === "string" ? fragment.content : "";
    const type         = fragment.type;
    const linkedCount  = Array.isArray(fragment.linked_to) ? fragment.linked_to.length : 0;

    /** 1. decisionHasRationale — decision은 근거 필수 */
    if (type === "decision") {
      const hasRationaleText = RATIONALE_REGEX.test(content);
      if (linkedCount < 2 && !hasRationaleText) {
        violations.push({
          rule    : "decisionHasRationale",
          severity: "medium",
          detail  : "decision requires 2+ linked fragments or explicit rationale keyword",
          ruleVersion
        });
      }
    }

    /** 2. errorHasResolutionPath — error는 원인/해결 단서 또는 resolution_status */
    if (type === "error") {
      const hasKeywords        = CAUSE_FIX_REGEX.test(content);
      const hasResolutionState = Boolean(fragment.resolution_status);
      if (!hasKeywords && !hasResolutionState) {
        violations.push({
          rule    : "errorHasResolutionPath",
          severity: "low",
          detail  : "error requires cause/fix keyword or resolution_status",
          ruleVersion
        });
      }
    }

    /** 3. procedureHasStepMarkers — procedure는 단계 마커 */
    if (type === "procedure") {
      if (!STEP_MARKER_REGEX.test(content)) {
        violations.push({
          rule    : "procedureHasStepMarkers",
          severity: "low",
          detail  : "procedure should have numbered/bulleted step markers",
          ruleVersion
        });
      }
    }

    /** 4. caseIdHasResolutionStatus — case_id는 resolution_status 동반 */
    if (fragment.case_id && !fragment.resolution_status) {
      violations.push({
        rule    : "caseIdHasResolutionStatus",
        severity: "medium",
        detail  : "case_id requires resolution_status (open|resolved|failed|abandoned)",
        ruleVersion
      });
    }

    /** 5. assertionNotContradictory — verified & rejected 동시 불가 */
    if (fragment.assertion_status === "verified" && fragment.assertion_rejected === true) {
      violations.push({
        rule    : "assertionNotContradictory",
        severity: "high",
        detail  : "assertion cannot be both verified and rejected",
        ruleVersion
      });
    }

    /** 6. fragmentHasWorkspace — workspace 미해석 파편 경고 */
    if (!fragment.workspace) {
      violations.push({
        rule    : "fragmentHasWorkspace",
        severity: "low",
        detail  : "workspace could not be resolved from explicit value or key default",
        ruleVersion
      });
    }

    return violations;
  }
}
