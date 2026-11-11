/**
 * MemoryLinker - MemoryManager 분해
 *
 * 작성자: 최진호
 * 작성일: 2026-04-20
 *
 * 이관 대상: link / unlink / deleteByAgent (+ 보조: _wouldCreateCycle 등)
 *
 * 공개 API 계약은 MemoryManager와 100% 동일하게 유지한다.
 */

import { canActOnGroupFragment, isShareReadable } from "../groupGrants.js";
import { resolveStoredRelation } from "../link/LinkStore.js";
import { LINK_RELATION_TYPES, safeRelationType } from "../link/LinkVisibility.js";

/** unlink가 닫힌 파편에 걸린 링크도 다룰 수 있도록 만료 파편까지 조회한다 */
const UNLINK_LOOKUP = Object.freeze({ includeExpired: true });

/**
 * 응답의 관계 필드. 저장된 관계가 요청과 다를 때만 요청한 관계를 함께 싣는다.
 *
 * @param {string} stored
 * @param {string} requested
 * @returns {{relationType: string, requestedRelationType?: string}}
 */
function storedRelationFields(stored, requested) {
  return stored === requested ? { relationType: stored } : { relationType: stored, requestedRelationType: requested };
}

/**
 * 지울 간선이 없는 경우의 결과. 지울 수 있으면 null이다.
 *
 * @param {string|null} current - 활성 관계
 * @param {string}      requested
 * @returns {{reason: string, currentRelationType?: string}|null}
 */
function unlinkNoop(current, requested) {
  if (current === null) return { reason: "not_found" };
  return current === requested ? null : { reason: "relation_mismatch", currentRelationType: current };
}

/**
 * 지울 수 없는 관계의 사유. 지울 수 있으면 null이다.
 * contradicts를 지우면 해소 기록 없이 모순이 닫힌다. superseded_by는 시작 파편이 닫혀 있으면 대체 이력이다.
 *
 * @param {string} relationType
 * @param {{valid_to?: unknown}} fromFrag
 * @returns {string|null}
 */
function unlinkRefusal(relationType, fromFrag) {
  if (relationType === "contradicts") return "A contradicts link is closed by resolving the conflict, not by unlink";
  if (relationType === "superseded_by" && fromFrag.valid_to != null) return "A superseded_by link on a closed fragment is supersession history";
  return null;
}

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
    const agentId   = params.agentId || "default";
    const keyId     = params._keyId ?? null;
    const endpoints = await this.#authorizedEndpoints(params, { flag: "linked", verb: "Linking" });
    if (endpoints.failure) return endpoints.failure;
    const { fromFrag, toFrag } = endpoints;

    const relationType = params.relationType || "related";

    /** M5 dryRun: 소유권 검사 완료 상태에서 실제 createLink 호출 생략 */
    if (params.dryRun === true) {
      const existing = await this.store.getActiveRelation(params.fromId, params.toId, agentId);
      return {
        dryRun   : true,
        simulated: {
          fromId        : params.fromId,
          toId          : params.toId,
          ...storedRelationFields(resolveStoredRelation(existing, relationType), relationType),
          would_link    : true,
          ownership_ok  : true
        }
      };
    }

    /** 공개 link 호출은 사용자의 명시적인 결정이므로 unlink로 지운 링크도 되살린다. */
    const stored = (await this.store.createLink(params.fromId, params.toId, relationType, agentId, params.weight ?? 1, { reviveUnlinked: true })) ?? relationType;

    /**
     * resolved_by 링크: 해결된 error 파편의 importance를 0.5로 하향하여 warm 계층으로 전환.
     * 해결된 에러는 참조 가치가 감소하되 즉시 삭제는 방지.
     * 규약은 "에러(fromId) → 해결책(toId)"라서 시작점이 error이면 시작점을 내린다.
     * 이전 방향(해결책 → 에러)으로 건 링크는 대상(toId)이 error일 때 대상을 내린다.
     * 기존 관계가 유지되어 resolved_by로 저장되지 않았으면 내리지 않는다.
     */
    if (stored === "resolved_by") {
      const resolved = fromFrag.type === "error"
        ? { id: params.fromId, frag: fromFrag }
        : toFrag.type === "error" ? { id: params.toId, frag: toFrag } : null;
      if (resolved && resolved.frag.importance > 0.5) {
        await this.store.update(resolved.id, { importance: 0.5 }, agentId, keyId);
      }
    }

    return { linked: true, ...storedRelationFields(stored, relationType) };
  }

  /**
   * unlink - 방향이 정해진 링크 한 건을 소프트 삭제한다. 파편과 다른 링크는 바꾸지 않고, link로 다시 걸면 되살아난다.
   *
   * @param {Object} params
   *   - fromId       {string}
   *   - toId         {string}
   *   - relationType {string} 지울 관계. 활성 관계와 일치해야 지운다
   *   - dryRun       {boolean}
   * @returns {Object} { unlinked, reason?, currentRelationType? } 또는 dryRun 시 { dryRun, simulated }
   */
  async unlink(params) {
    const relationType = safeRelationType(params.relationType);
    if (!relationType) {
      return { unlinked: false, code: "invalid_relation", error: `relationType must be one of: ${LINK_RELATION_TYPES.join(", ")}` };
    }

    const endpoints = await this.#authorizedEndpoints(params, { flag: "unlinked", verb: "Unlinking", lookup: UNLINK_LOOKUP });
    if (endpoints.failure) return endpoints.failure;

    const agentId = params.agentId || "default";
    const target  = { fromId: params.fromId, toId: params.toId, relationType };
    const current = await this.store.getActiveRelation(params.fromId, params.toId, agentId);
    const noop    = unlinkNoop(current, relationType);
    if (noop) return params.dryRun === true ? { dryRun: true, simulated: { ...target, would_unlink: false, ...noop } } : { unlinked: false, ...noop };

    const refusal = unlinkRefusal(relationType, endpoints.fromFrag);
    if (refusal) return { unlinked: false, code: "relation_protected", error: refusal };

    if (params.dryRun === true) return { dryRun: true, simulated: { ...target, would_unlink: true } };

    const keyId       = params._keyId ?? null;
    const groupKeyIds = params._groupKeyIds ?? (keyId ? [keyId] : []);
    const removed     = await this.store.softDeleteLink(params.fromId, params.toId, relationType, agentId, { keyId, groupKeyIds });
    return removed ? { unlinked: true, relationType } : { unlinked: false, reason: "not_found" };
  }

  /**
   * link와 unlink가 함께 쓰는 권한 확인. 양 끝 파편이 호출자에게 보여야 하고, 다른 키 파편이면 같은 그룹의 link 권한이 필요하다.
   *
   * @param {Object} params
   * @param {{flag: string, verb: string, lookup?: Object}} action
   * @returns {Promise<{fromFrag?: Object, toFrag?: Object, failure?: Object}>}
   */
  async #authorizedEndpoints(params, { flag, verb, lookup }) {
    const agentId     = params.agentId || "default";
    const keyId       = params._keyId ?? null;
    const groupKeyIds = params._groupKeyIds ?? (keyId ? [keyId] : []);
    const shareCtx    = { keyId, groupShareScopes: params._groupShareScopes };
    const visible     = (f) => (f && isShareReadable(f, shareCtx) ? f : null);
    const fromFrag    = visible(await this.store.getById(params.fromId, agentId, keyId, groupKeyIds, lookup));
    const toFrag      = visible(await this.store.getById(params.toId,   agentId, keyId, groupKeyIds, lookup));

    if (!fromFrag || !toFrag) {
      return { failure: { [flag]: false, error: "One or both fragments not found or no permission" } };
    }

    /** 다른 키 파편이 끝점이면 같은 그룹에서 link 권한을 받아야 한다. 읽을 수 있다고 링크까지 걸 수는 없다. */
    const linkCtx = { keyId, groupGrants: params._groupGrants };
    if (![fromFrag, toFrag].every(f => canActOnGroupFragment(linkCtx, "link", f.key_id ?? null))) {
      return { failure: { [flag]: false, code: "not_owner", error: `${verb} another API key's fragment requires the link permission in a shared group` } };
    }
    return { fromFrag, toFrag };
  }

  /**
   * 에이전트의 모든 기억 삭제
   *
   * @param {string} agentId - 삭제 대상 에이전트 ID
   * @param {{ keyId: string|null, workspace: string|null }} [scope] - 주면 그 키와 workspace의 파편만 지운다
   * @returns {Object} { deleted }
   */
  async deleteByAgent(agentId, scope) {
    if (!agentId || agentId === "default") {
      throw new Error("Invalid agentId for full deletion");
    }

    // 1. Redis 인덱스 삭제 (현재 topic/keyword 전체 스캔이 필요할 수 있으나 생략 가능 - PostgreSQL이 소스임)
    // 2. PostgreSQL 삭제 (Cascade로 버전/링크 자동 삭제)
    const count = await this.store.deleteByAgent(agentId, scope);

    // 3. Working Memory 삭제
    await this.index.clearWorkingMemory(agentId, scope?.keyId ?? null); // sessionId로 쓰이기도 함

    return { deleted: count };
  }
}
