/**
 * MemoryLinker - MemoryManager 분해 (Phase 5-B)
 *
 * 작성자: 최진호
 * 작성일: 2026-04-20
 *
 * 이관 대상: link / deleteByAgent (+ 보조: _wouldCreateCycle 등)
 *
 * 공개 API 계약은 MemoryManager와 100% 동일하게 유지한다.
 */

export class MemoryLinker {
  /**
   * @param {Object} deps
   * @param {Object} deps.store - FragmentStore 인스턴스 (getById / createLink / update / deleteByAgent)
   * @param {Object} deps.index - FragmentIndex 인스턴스 (clearWorkingMemory)
   */
  constructor({ store, index }) {
    this.store = store;
    this.index = index;
  }

  /**
   * link - 파편 간 관계 설정
   *
   * @param {Object} params
   *   - fromId       {string}
   *   - toId         {string}
   *   - relationType {string} related|caused_by|resolved_by|part_of|contradicts
   * @returns {Object} { linked }
   */
  async link(params) {
    const agentId  = params.agentId || "default";
    const keyId       = params._keyId ?? null;
    const groupKeyIds = params._groupKeyIds ?? (keyId ? [keyId] : []);
    const workspace   = params.workspace ?? params._defaultWorkspace ?? null;
    const strictScope = params._keyId != null || workspace != null;
    const scopeOpts   = { workspace, strictScope };
    const fromFrag    = await this.store.getById(params.fromId, agentId, keyId, groupKeyIds, scopeOpts);
    const toFrag      = await this.store.getById(params.toId,   agentId, keyId, groupKeyIds, scopeOpts);

    if (!fromFrag || !toFrag) {
      return { linked: false, error: "One or both fragments not found or no permission" };
    }

    const relationType = params.relationType || "related";

    /** M5 dryRun: 소유권 검사 완료 상태에서 실제 createLink 호출 생략 */
    if (params.dryRun === true) {
      return {
        dryRun   : true,
        simulated: {
          fromId        : params.fromId,
          toId          : params.toId,
          relationType,
          would_link    : true,
          ownership_ok  : true
        }
      };
    }

    const created = await this.store.createLink(params.fromId, params.toId, relationType, agentId, params.weight ?? 1, {
      keyId,
      workspace,
      strictScope
    });
    if (created === false) {
      return { linked: false, error: "One or both fragments are outside the exact scope" };
    }

    /**
     * resolved_by 링크: 대상(toId)이 error 파편이면
     * importance를 0.5로 하향하여 warm 계층으로 전환.
     * 해결된 에러는 참조 가치가 감소하되 즉시 삭제는 방지.
     */
    if (relationType === "resolved_by" && toFrag.type === "error" && toFrag.importance > 0.5) {
      await this.store.update(params.toId, {
        importance: 0.5
      }, agentId, keyId);
    }

    return { linked: true, relationType };
  }

  /**
   * 에이전트의 모든 기억 삭제
   *
   * @param {string} agentId - 삭제 대상 에이전트 ID
   * @returns {Object} { deleted }
   */
  async deleteByAgent(agentId) {
    if (!agentId || agentId === "default") {
      throw new Error("Invalid agentId for full deletion");
    }

    // 1. Redis 인덱스 삭제 (현재 topic/keyword 전체 스캔이 필요할 수 있으나 생략 가능 - PostgreSQL이 소스임)
    // 2. PostgreSQL 삭제 (Cascade로 버전/링크 자동 삭제)
    const count = await this.store.deleteByAgent(agentId);

    // 3. Working Memory 삭제
    await this.index.clearWorkingMemory(agentId); // sessionId로 쓰이기도 함

    return { deleted: count };
  }
}
