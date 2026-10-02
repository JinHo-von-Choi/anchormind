/**
 * ExplanationBuilder — recall 결과에 explanations[] 주입 (v2.8.0 Phase 2)
 *
 * 작성자: 최진호
 * 작성일: 2026-04-15
 *
 * 설계 원칙:
 * 1. 기존 fragment 객체를 불변 복사해서 explanations 필드를 추가한다.
 *    Hot Cache / FragmentStore 의 원본이 오염되지 않아야 한다.
 * 2. rules/v1/explain.js 의 buildReasonCodes 를 단일 진실 공급원으로 재사용한다.
 *    rule_version 은 rules/v1/explain.js 가 RULE_VERSION 상수로 기록한다.
 * 3. searchContext 는 FragmentSearch 내부 구조 (searchPath/layerLatency 등) 를
 *    그대로 전달받는다. 변환 책임은 rules/v1/explain.js 가 가진다.
 * 4. 빈 입력에 대해서는 no-op 반환 (alloc/GC 최소화).
 */

import { buildReasonCodes } from "./rules/v1/explain.js";

export class ExplanationBuilder {
  /**
   * @param {Object} [deps]
   * @param {Function} [deps.reasonBuilder] - buildReasonCodes 대체 주입 (테스트용)
   */
  constructor({ reasonBuilder = buildReasonCodes } = {}) {
    this.reasonBuilder = reasonBuilder;
  }

  /**
   * fragments 에 explanations 필드를 주입한 신규 배열 반환.
   *
   * @param {Array<Object>} fragments
   * @param {Object} searchContext
   *   - searchPath   {string[]}
   *   - layerLatency {Object}
   *   - query        {Object}
   *   - caseContext  {string|undefined}
   * @returns {Array<Object>}
   */
  annotate(fragments, searchContext = {}) {
    if (!Array.isArray(fragments) || fragments.length === 0) {
      return fragments;
    }

    return fragments.map((fragment) => {
      const reasons = this.reasonBuilder(fragment, searchContext);
      return { ...fragment, explanations: reasons };
    });
  }
}

/** 싱글톤 인스턴스 (FragmentSearch 경로 공용). 테스트는 `new ExplanationBuilder()` 사용. */
export const explanationBuilder = new ExplanationBuilder();
