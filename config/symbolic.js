/**
 * Symbolic Memory v2.8.0 환경변수
 *
 * 작성자: 최진호
 * 작성일: 2026-04-15
 *
 * 원칙: 모든 플래그의 기본값은 false/noop이다.
 * 기본값 상태에서 v2.7.0 동작과 완전히 동일해야 한다 (회귀 0건).
 */

const parseBool = (v, def = false) => {
  if (v === undefined || v === null || v === '') return def;
  return String(v).toLowerCase() === 'true';
};

const parseInt10 = (v, def) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
};

/**
 * SYMBOLIC_CONFIG
 *
 * enabled           : 전체 symbolic 서브시스템 on/off (마스터 킬 스위치)
 * claimExtraction   : RememberPostProcessor 에서 ClaimExtractor 호출 여부
 * explain           : recall 응답에 explanation 필드 포함 여부
 * linkCheck         : LinkIntegrityChecker advisory 경로 활성화
 * polarityConflict  : ClaimConflictDetector advisory warning 기록
 * policyRules       : PolicyRules soft gating (validation_warnings)
 * cbrFilter         : CaseRecall symbolic 필터 적용
 * proactiveGate     : ProactiveRecall polarity gate
 * shadow            : shadow mode - symbolic 결과를 기록만 하고 미적용
 * ruleVersion       : 규칙 패키지 버전 식별자 (fragment_claims.rule_version 컬럼에 기록)
 * timeoutMs         : MEMENTO_SYMBOLIC_TIMEOUT_MS 설정값 (ms). 현재 이 값을 읽는 처리는 없다
 * maxCandidates     : MEMENTO_SYMBOLIC_MAX_CANDIDATES 설정값. 현재 이 값을 읽는 처리는 없다
 */
export const SYMBOLIC_CONFIG = Object.freeze({
  enabled         : parseBool(process.env.MEMENTO_SYMBOLIC_ENABLED, false),
  claimExtraction : parseBool(process.env.MEMENTO_SYMBOLIC_CLAIM_EXTRACTION, false),
  explain         : parseBool(process.env.MEMENTO_SYMBOLIC_EXPLAIN, false),
  linkCheck       : parseBool(process.env.MEMENTO_SYMBOLIC_LINK_CHECK, false),
  polarityConflict: parseBool(process.env.MEMENTO_SYMBOLIC_POLARITY_CONFLICT, false),
  policyRules     : parseBool(process.env.MEMENTO_SYMBOLIC_POLICY_RULES, false),
  cbrFilter       : parseBool(process.env.MEMENTO_SYMBOLIC_CBR_FILTER, false),
  proactiveGate   : parseBool(process.env.MEMENTO_SYMBOLIC_PROACTIVE_GATE, false),
  shadow          : parseBool(process.env.MEMENTO_SYMBOLIC_SHADOW, false),
  ruleVersion     : process.env.MEMENTO_SYMBOLIC_RULE_VERSION || 'v1',
  timeoutMs       : parseInt10(process.env.MEMENTO_SYMBOLIC_TIMEOUT_MS, 50),
  maxCandidates   : parseInt10(process.env.MEMENTO_SYMBOLIC_MAX_CANDIDATES, 32),
});
