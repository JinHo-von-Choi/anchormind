/**
 * Proactive Recall Gate Rules v1 — Phase 6
 *
 * 작성자: 최진호
 * 작성일: 2026-04-15
 * 수정일: 2026-05-19
 *
 * 목적: RememberPostProcessor._proactiveRecall 이 overlap >= keywordOverlapMin 로 related
 *       링크 생성을 결정한 뒤, 실제 link 생성 직전에 symbolic 게이트를 통과시킨다.
 *       충돌/격리/cohort 불일치/workspace 불일치/caseId 정책 위반 시 차단한다.
 *
 * 차단 기준:
 *  1. polarity_conflict  : target fragment 에 positive↔negative 대립 claim 존재
 *  2. quarantine         : target 이 quarantine 상태 (caller 가 precomputed flag 주입)
 *  3. cohort_mismatch    : source.case_id 와 target.case_id 가 상이 (case 레벨 격리)
 *  4. workspace_mismatch : 다른 workspace 파편 간 자동 링크 차단 (requireSameWorkspace=true)
 *  5. case_policy        : caseIdPolicy 정책 위반 (both-required/strict-or-adjacent)
 *
 * 반환:
 *  { allowed: boolean, reason: string, ruleVersion: 'v1' }
 *
 * 설계 원칙:
 *  - 순수 함수. 외부 I/O 는 deps.detector 를 통해서만.
 *  - detector 호출 실패 시 fail-open (allowed=true) — 신경 경로 fallback 보존.
 *  - config 오프 상태에서는 caller 가 이 함수를 호출하지 않아야 함. 여기서는 그 판단 없음.
 */

const RULE_VERSION = "v1";

/**
 * @typedef {Object} GateInput
 * @property {{ id: string, case_id?: string|null }} source
 * @property {{ id: string, case_id?: string|null, quarantine_state?: string|null }} target
 * @property {string|null} [keyId]
 */

/**
 * @param {GateInput} input
 * @param {{ detector: import('../../ClaimConflictDetector.js').ClaimConflictDetector }} deps
 * @returns {Promise<{ allowed: boolean, reason: string, ruleVersion: string }>}
 */
export async function evaluateProactiveGate(input, deps) {
  const { source, target, keyId = null } = input || {};
  const detector = deps && deps.detector;

  if (!target || !target.id) {
    return { allowed: false, reason: "invalid_target", ruleVersion: RULE_VERSION };
  }

  /** 2) quarantine 체크: target 에 이미 quarantine flag 가 주입되어 있으면 차단 */
  if (target.quarantine_state && target.quarantine_state !== "released") {
    return { allowed: false, reason: "quarantine", ruleVersion: RULE_VERSION };
  }

  /** 3) cohort (case_id) 체크: 양쪽 모두 case_id 가 있고 서로 다르면 차단 */
  const sourceCase = source && source.case_id;
  const targetCase = target.case_id;
  if (sourceCase && targetCase && sourceCase !== targetCase) {
    return { allowed: false, reason: "cohort_mismatch", ruleVersion: RULE_VERSION };
  }

  /** 4) workspace 일치 체크: config에서 requireSameWorkspace가 활성화된 경우 */
  if (deps && deps.proactiveConfig && deps.proactiveConfig.requireSameWorkspace) {
    const srcWs = source && source.workspace_id;
    const tgtWs = target.workspace_id;
    // 양쪽 모두 workspace가 지정되어 있고 서로 다르면 차단
    if (srcWs && tgtWs && srcWs !== tgtWs) {
      return { allowed: false, reason: "workspace_mismatch", ruleVersion: RULE_VERSION };
    }
  }

  /** 5) caseId 정책 체크 (mode=auto일 때 deps.proactiveConfig 전달) */
  if (deps && deps.proactiveConfig) {
    const policy            = deps.proactiveConfig.caseIdPolicy ?? "strict-or-adjacent";
    const adjacencyWindowMs = deps.proactiveConfig.adjacencyWindowMs ?? 86400000;

    const bothHaveCase = sourceCase != null && targetCase != null;
    const eitherNull   = sourceCase == null || targetCase == null;

    if (policy === "both-required") {
      // 양쪽 모두 caseId 있고 일치해야 통과 — 한쪽이라도 null이면 차단
      if (!bothHaveCase || sourceCase !== targetCase) {
        return { allowed: false, reason: "case_policy", ruleVersion: RULE_VERSION };
      }
    } else if (policy === "strict-or-adjacent") {
      // 한쪽 null이면: sessionId 동일 OR adjacencyWindowMs 내 OR workspace 동일 중 하나 충족 필요
      if (eitherNull) {
        const srcSession = source && source.session_id;
        const tgtSession = target.session_id;
        const sameSession = srcSession && tgtSession && srcSession === tgtSession;

        let withinWindow = false;
        if (source && source.created_at && target.created_at) {
          const diff = Math.abs(
            new Date(source.created_at).getTime() - new Date(target.created_at).getTime()
          );
          withinWindow = diff <= adjacencyWindowMs;
        }

        const srcWs      = source && source.workspace_id;
        const tgtWs      = target.workspace_id;
        const sameWs     = srcWs && tgtWs && srcWs === tgtWs;

        if (!sameSession && !withinWindow && !sameWs) {
          return { allowed: false, reason: "case_policy", ruleVersion: RULE_VERSION };
        }
      }
      // loose: 한쪽 null이면 무조건 허용 — 추가 검사 없음
    }
    // "loose"는 아무 추가 검사 없이 통과
  }

  /** 1) polarity conflict 체크 (마지막: 가장 비싼 I/O) */
  if (detector) {
    try {
      const result = await detector.detectPolarityConflicts(target.id, keyId);
      if (result && Array.isArray(result.conflicts) && result.conflicts.length > 0) {
        return { allowed: false, reason: "polarity_conflict", ruleVersion: RULE_VERSION };
      }
    } catch {
      /** fail-open: detector 오류 시 기본 경로 유지 */
    }
  }

  return { allowed: true, reason: "ok", ruleVersion: RULE_VERSION };
}

export { RULE_VERSION as PROACTIVE_GATE_RULE_VERSION };
