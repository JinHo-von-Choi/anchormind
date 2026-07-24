/**
 * SearchScope - 검색 결과 정합 필터 계약
 *
 * 작성자: 최진호
 * 작성일: 2026-05-13
 *
 * agent, workspace, caseId, resolutionStatus, phase, affect 필드를
 * 각 검색 레이어(HotCache, L3, Graph 호출 사이트)에서 fragment 단위로
 * 일관되게 필터링하기 위한 단일 계약 객체.
 *
 * applyTo(fragment) → boolean
 *   false를 반환하면 해당 fragment를 결과에서 제외한다.
 *   workspace가 null이면 전역 fragment(workspace == null)를 포함한다.
 *
 * fromQuery(sq) 정적 팩토리
 *   _buildSearchQuery()가 반환한 정규화된 sq에서 SearchScope를 생성한다.
 */
export class SearchScope {
  /**
   * @param {Object} opts
   * @param {string|null}           opts.workspace
   * @param {string|undefined}      opts.caseId
   * @param {string|undefined}      opts.resolutionStatus
   * @param {string|undefined}      opts.phase
   * @param {string|string[]|undefined} opts.affect
   * @param {string|null}           opts.keyId
   * @param {string|null}           opts.agentId
   * @param {boolean}               opts.includePeerAgents
   */
  constructor({
    workspace = null,
    caseId,
    resolutionStatus,
    phase,
    affect,
    keyId = null,
    agentId = null,
    includePeerAgents = false
  } = {}) {
    this.workspace         = workspace;
    this.caseId            = caseId;
    this.resolutionStatus  = resolutionStatus;
    this.phase             = phase;
    /** affect는 배열로 정규화하여 보관. 미지정이면 null. */
    this.affectSet         = affect
      ? new Set(Array.isArray(affect) ? affect : [affect])
      : null;
    this.keyId             = keyId;
    this.agentId           = agentId;
    this.includePeerAgents = includePeerAgents;
  }

  /**
   * fragment가 이 scope 조건을 모두 통과하면 true를 반환한다.
   *
   * @param {Object} fragment - 파편 객체
   * @returns {boolean}
   */
  applyTo(fragment) {
    if (!fragment) return false;

    /** agent: SQL의 (agent_id = $agentId OR agent_id = 'default')와 동일한 계약.
     *  agentId 미지정 또는 includePeerAgents=true면 agent 조건을 적용하지 않는다. */
    if (this.agentId !== null && !this.includePeerAgents) {
      if (fragment.agent_id !== this.agentId && fragment.agent_id !== "default") {
        return false;
      }
    }

    /** workspace: null scope는 모든 workspace 허용.
     *  non-null scope는 fragment.workspace가 scope와 일치하거나 null(전역)인 경우만 허용. */
    if (this.workspace !== null) {
      if (fragment.workspace !== this.workspace && fragment.workspace != null) {
        return false;
      }
    }

    if (this.caseId !== undefined && fragment.case_id !== this.caseId) {
      return false;
    }

    if (this.resolutionStatus !== undefined && fragment.resolution_status !== this.resolutionStatus) {
      return false;
    }

    if (this.phase !== undefined && fragment.phase !== this.phase) {
      return false;
    }

    if (this.affectSet !== null && !this.affectSet.has(fragment.affect)) {
      return false;
    }

    return true;
  }

  /**
   * 아무 조건도 지정되지 않아 applyTo가 항상 true를 반환하는 no-op scope 여부.
   * 불필요한 filter 루프를 건너뛰는 데 활용할 수 있다.
   *
   * @returns {boolean}
   */
  isNoop() {
    return (
      this.agentId           === null &&
      this.workspace         === null &&
      this.caseId            === undefined &&
      this.resolutionStatus  === undefined &&
      this.phase             === undefined &&
      this.affectSet         === null
    );
  }

  /**
   * 정규화된 sq (FragmentSearch._buildSearchQuery 반환값) 에서 SearchScope 생성.
   *
   * @param {Object} sq
   * @returns {SearchScope}
   */
  static fromQuery(sq) {
    return new SearchScope({
      workspace       : sq.workspace        ?? null,
      caseId          : sq.caseId,
      resolutionStatus: sq.resolutionStatus,
      phase           : sq.phase,
      affect          : sq.affect,
      keyId           : sq.keyId            ?? null,
      agentId         : sq.agentId          ?? null,
      includePeerAgents: sq.includePeerAgents === true
    });
  }
}
