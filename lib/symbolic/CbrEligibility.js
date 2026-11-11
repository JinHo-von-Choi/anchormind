/**
 * CbrEligibility — Case-Based Recall 후보 symbolic 필터 (v2.8.0)
 *
 * 작성자: 최진호
 * 작성일: 2026-04-15
 *
 * 옵션 A (JS-only) 구현. Prolog 도입 없음.
 *
 * 제약 (AND 조합, 하나라도 실패 시 후보에서 제외):
 * 1. tenant_match   : sq.keyId 와 fragment.key_id 일치 (마스터 키 ↔ API 키 혼입 차단)
 * 2. has_case_id    : case_id 필드가 존재 (cohort 소속 필수)
 * 3. not_quarantine : quarantine_state !== 'soft' (hard 는 별도 처리)
 * 4. resolved_state : resolution_status 가 'resolved' 이거나 null/undefined
 *                     (예비 상태는 허용, 명시적 in_progress/failed 만 차단)
 *
 * 차단 시 symbolicMetrics.recordGateBlock('cbr', reason) 로 관측 지표 기록.
 * SearchParamAdaptor 학습 신호 보호를 위해 pre-filter count 는 호출부가 별도 보존.
 *
 * 설계 원칙:
 * - 비동기 DB 조회를 수행하지 않음 (동기 결정 가능한 필드만 사용).
 * - tenant 비교는 null-safe (`??` 로 undefined/null 정규화 후 엄격 비교).
 */

import { symbolicMetrics } from "./SymbolicMetrics.js";
import { normalizeKeyId } from "../memory/keyId.js";

export class CbrEligibility {
  /**
   * @param {Object} [deps]
   * @param {Object} [deps.metrics] - SymbolicMetrics facade 오버라이드 (테스트용)
   */
  constructor({ metrics = symbolicMetrics } = {}) {
    this.metrics = metrics;
  }

  /**
   * 후보 fragments 필터링.
   *
   * @param {Array<Object>} candidates
   * @param {Object} sq - 검색 쿼리 (keyId 포함)
   * @returns {Promise<Array<Object>>}
   */
  async filter(candidates, sq = {}) {
    if (!Array.isArray(candidates) || candidates.length === 0) {
      return candidates || [];
    }

    const keyId = this._normalizeKeyId(sq.keyId);
    const out   = [];

    for (const fragment of candidates) {
      if (!this._tenantMatch(fragment, keyId)) {
        this._blocked("tenant");
        continue;
      }
      if (!fragment.case_id) {
        this._blocked("no_case");
        continue;
      }
      if (fragment.quarantine_state === "soft") {
        this._blocked("quarantine");
        continue;
      }
      if (fragment.resolution_status && fragment.resolution_status !== "resolved") {
        this._blocked("unresolved");
        continue;
      }

      out.push(fragment);
    }

    return out;
  }

  _normalizeKeyId(keyId) {
    return normalizeKeyId(keyId, { mode: 'cbr' });
  }

  /**
   * fragment.key_id 와 호출자 keyId 가 정확히 일치해야 한다.
   * master(null) ↔ API key(string) 조합은 실패로 처리한다.
   */
  _tenantMatch(fragment, keyId) {
    const fragKey = fragment.key_id ?? null;
    return fragKey === keyId;
  }

  _blocked(reason) {
    this.metrics.recordGateBlock("cbr", reason);
  }
}

/** 싱글톤 인스턴스 (FragmentSearch 경로 공용). 테스트는 `new CbrEligibility()` 사용. */
export const cbrEligibility = new CbrEligibility();
