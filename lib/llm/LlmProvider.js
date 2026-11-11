/**
 * LLM Provider 추상 기반 클래스
 *
 * 모든 provider 어댑터가 상속해야 한다.
 * callText를 반드시 override해야 하며, callJson은 callText 결과를 파싱하는 기본 구현을 제공한다.
 * Circuit breaker 통합은 이 클래스에서 제공하지만 실제 recordFailure/Success 호출은
 * 각 서브클래스의 callText 내에서 명시적으로 수행한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-04-16
 * 수정일: 2026-04-19 (LlmProviderContract typedef 추가 — 계약 명문화)
 */

/**
 * LLM Provider 공개 계약 (Contract)
 *
 * memento-mcp의 모든 provider는 이 typedef가 정의하는 메서드 집합을 구현해야 한다.
 * 내장 provider는 LlmProvider(직접) 또는 OpenAICompatibleProvider(HTTP wrapper)를 상속한다.
 * 외부 custom provider를 작성할 때도 이 계약을 기준으로 LlmProvider를 상속한다.
 *
 * 에러 계약:
 *   - callText / callJson 실패 시 throw (null/undefined 반환 금지)
 *   - circuit breaker open 상태면 isCircuitOpen() true 반환 → caller는 건너뜀
 *   - LlmRateLimitError(429), LlmAuthError(401/403), LlmFatalError(복구 불가) 구분 throw
 *   - recordFailure() / recordSuccess()는 callText 내에서 명시적으로 호출
 *
 * @typedef {object} LlmProviderContract
 * @property {(config?: object) => void}               constructor    - provider 식별 이름(name) 및 설정 초기화
 * @property {() => Promise<boolean>}                  isAvailable    - API 키, baseUrl, 모델 존재 여부 검사. false 반환 시 chain에서 건너뜀
 * @property {(prompt: string, options?: object) => Promise<string>} callText - 프롬프트 전송 후 원시 텍스트 반환. 반드시 override. 빈 문자열 반환 금지
 * @property {(prompt: string, options?: object) => Promise<*>}      callJson - callText 결과를 parseJsonResponse로 파싱. JSON 전용 provider(CLI 계열)는 override
 * @property {() => Promise<boolean>}                  isCircuitOpen  - circuit breaker open 여부. true면 호출 건너뜀
 * @property {() => Promise<void>}                     recordFailure  - 호출 실패 기록. 임계값(기본 5회) 초과 시 circuit open
 * @property {() => Promise<void>}                     recordSuccess  - 호출 성공 기록. circuit closed 상태로 복원
 */

import { circuitBreaker } from "./util/circuit-breaker.js";
import { parseJsonResponse } from "./util/parse-json.js";

export class LlmProvider {
  /**
   * @param {object} [config={}]
   * @param {string} [config.name]         - provider 식별 이름
   * @param {string} [config.apiKey]       - API 키
   * @param {string} [config.baseUrl]      - 엔드포인트 기본 URL
   * @param {string} [config.model]        - 사용할 모델명
   * @param {number} [config.timeoutMs]    - 기본 타임아웃 (ms)
   */
  constructor(config = {}) {
    this.config = config;
    this.name   = config.name || "abstract";
  }

  /**
   * Provider가 현재 설정되어 호출 가능한지 반환한다.
   * 서브클래스에서 override: apiKey, baseUrl, model 존재 여부 등 검증.
   *
   * @returns {Promise<boolean>}
   */
  async isAvailable() {
    return false;
  }

  /**
   * 프롬프트를 전송하고 JSON으로 파싱된 응답을 반환한다.
   * callText를 호출한 뒤 parseJsonResponse로 파싱하는 기본 구현.
   * JSON 응답이 보장되지 않는 provider는 이 메서드를 override할 수 있다.
   *
   * @param {string} prompt
   * @param {object} [options={}]
   * @returns {Promise<*>}
   */
  async callJson(prompt, options = {}) {
    const text = await this.callText(prompt, options);
    return parseJsonResponse(text);
  }

  /**
   * 프롬프트를 전송하고 원시 텍스트 응답을 반환한다.
   * 모든 서브클래스에서 반드시 구현해야 한다.
   *
   * @param {string} _prompt
   * @param {object} [_options={}]
   * @returns {Promise<string>}
   */
  async callText(_prompt, _options = {}) {
    throw new Error(`callText must be implemented by subclass (provider: ${this.name})`);
  }

  /**
   * 해당 provider의 circuit breaker가 open 상태인지 확인한다.
   * open이면 호출을 건너뛰어야 한다.
   *
   * @returns {Promise<boolean>}
   */
  async isCircuitOpen() {
    return circuitBreaker.isOpen(this.name);
  }

  /**
   * 호출 실패를 circuit breaker에 기록한다.
   * 임계값 초과 시 circuit이 open 상태로 전환된다.
   *
   * @returns {Promise<void>}
   */
  async recordFailure() {
    return circuitBreaker.recordFailure(this.name);
  }

  /**
   * 호출 성공을 circuit breaker에 기록한다.
   * circuit을 closed 상태로 복원한다.
   *
   * @returns {Promise<void>}
   */
  async recordSuccess() {
    return circuitBreaker.recordSuccess(this.name);
  }
}
