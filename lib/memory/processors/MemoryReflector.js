/**
 * MemoryReflector - Phase 5-B 분해 산출물
 *
 * 작성자: 최진호
 * 작성일: 2026-04-20
 *
 * 이관 대상: reflect / reconstructHistory / stats / consolidate
 *
 * 공개 API 계약은 원본과 100% 동일하게 유지한다.
 */

import { HistoryReconstructor } from "../read/HistoryReconstructor.js";

export class MemoryReflector {
  /**
   * @param {Object} deps
   * @param {Object} deps.reflectProcessor  - ReflectProcessor 인스턴스
   * @param {Object} deps.store             - FragmentStore 인스턴스
   * @param {Object} deps.caseEventStore    - CaseEventStore 인스턴스
   * @param {Object} deps.consolidator      - MemoryConsolidator 인스턴스
   */
  constructor({ reflectProcessor, store, caseEventStore, consolidator }) {
    this.reflectProcessor = reflectProcessor;
    this.store            = store;
    this.caseEventStore   = caseEventStore;
    this.consolidator     = consolidator;
  }

  /**
   * reflect - 세션 종료 시 핵심 내용 요약 저장
   *
   * @param {Object} params
   * @param {string}   params.sessionId
   * @param {string}   params.summary
   * @param {string[]} [params.decisions]
   * @param {string[]} [params.errors_resolved]
   * @param {string[]} [params.new_procedures]
   * @param {string[]} [params.open_questions]
   * @param {string}   [params.agentId]
   * @returns {Promise<Object>} { fragments, count, breakdown }
   */
  async reflect(params) {
    return this.reflectProcessor.process(params);
  }

  /**
   * reconstructHistory - case_id 또는 entity 기반 서사 재구성
   *
   * @param {Object}      params
   * @param {string}      [params.caseId]     - 케이스 식별자
   * @param {string}      [params.entity]     - topic/keywords 기반 필터
   * @param {Object}      [params.timeRange]  - { from: ISO8601, to: ISO8601 }
   * @param {string}      [params.query]      - 추가 content 키워드
   * @param {number}      [params.limit]      - 최대 반환 건수 (기본 100, 최대 500)
   * @param {number|null} [params.keyId]      - API 키 격리
   * @param {string|null} [params.workspace]  - 워크스페이스 격리
   * @returns {Promise<Object>} { ordered_timeline, causal_chains, unresolved_branches, supporting_fragments, summary }
   */
  async reconstructHistory(params) {
    const reconstructor = new HistoryReconstructor(this.store, this.store.links, this.caseEventStore);
    return reconstructor.reconstruct({
      caseId      : params.caseId       ?? null,
      entity      : params.entity       ?? null,
      timeRange   : params.timeRange    ?? null,
      query       : params.query        ?? null,
      limit       : params.limit        ?? 100,
      keyId       : params.keyId        ?? params._keyId        ?? null,
      groupKeyIds : params.groupKeyIds  ?? params._groupKeyIds  ?? [],
      workspace   : params.workspace    ?? params._defaultWorkspace ?? null
    });
  }

  /**
   * consolidate - 유지보수 (주기적 호출용)
   *
   * @param {((event: object) => void)|null} [onProgress]
   * @returns {Promise<Object>}
   */
  async consolidate(onProgress = null) {
    return this.consolidator.consolidate(onProgress);
  }

  /**
   * stats - 전체 통계
   *
   * @returns {Promise<Object>}
   */
  async stats() {
    return this.consolidator.getStats();
  }
}
