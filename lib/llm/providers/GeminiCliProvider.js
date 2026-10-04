/**
 * Gemini CLI Provider (기존 lib/gemini.js 래핑 shim)
 *
 * 상속: LlmProvider 직접 상속.
 * 이유: HTTP 엔드포인트가 없는 stdio 기반 CLI 실행 경로이므로
 *       OpenAICompatibleProvider의 /v1/chat/completions 구현이 불필요하다.
 *
 * 작성자: 최진호
 * 작성일: 2026-04-16
 * 수정일: 2026-04-16 (순환 의존성 해소: _rawIsGeminiCLIAvailable + runGeminiCLI 직접 사용)
 *
 * 순환 의존성 방지 구조:
 *   GeminiCliProvider.isAvailable()  → _rawIsGeminiCLIAvailable (CLI 바이너리 체크만)
 *   GeminiCliProvider.callJson()     → runGeminiCLI (CLI 직접 호출)
 *   lib/gemini.js public API         → llm/index.js (chain 전체 위임)
 *
 * gemini-cli는 CLI를 통해 JSON만 반환하므로:
 *   - callJson() : 정상 동작 (CLI JSON 응답 → parseJsonResponse)
 *   - callText() : 미구현 — "use callJson" 에러 throw
 */

import { LlmProvider }                                          from "../LlmProvider.js";
import { parseJsonResponse }                                    from "../util/parse-json.js";
import { runGeminiCLI, _rawIsGeminiCLIAvailable }              from "../runners/gemini.js";

export class GeminiCliProvider extends LlmProvider {
  constructor(config = {}) {
    super({ ...config, name: "gemini-cli" });
  }

  /**
   * Gemini CLI 바이너리(`gemini`) 설치 여부로 가용성을 판단한다.
   * _rawIsGeminiCLIAvailable을 사용하여 chain 재귀 체크를 방지한다.
   *
   * @returns {Promise<boolean>}
   */
  async isAvailable(timeoutMs = null) {
    return _rawIsGeminiCLIAvailable(timeoutMs);
  }

  /**
   * gemini-cli는 JSON 전용이므로 callText는 미구현.
   *
   * @throws {Error} 항상 throw
   */
  async callText(_prompt, _options = {}) {
    throw new Error("gemini-cli: use callJson (CLI returns parsed JSON)");
  }

  /**
   * runGeminiCLI를 직접 호출하여 JSON 응답을 반환한다.
   * Circuit breaker 연동 포함.
   *
   * @param {string}  prompt
   * @param {object}  [options={}]
   * @param {number}  [options.timeoutMs=30000]
   * @param {string}  [options.model]
   * @param {string}  [options.systemPrompt] - prompt 앞에 prepend (CLI는 단일 입력이므로 병합)
   * @returns {Promise<*>} 파싱된 JSON
   */
  async callJson(prompt, options = {}) {
    if (await this.isCircuitOpen()) {
      throw new Error("gemini-cli: circuit breaker open");
    }

    /** CLI는 system role을 별도로 받지 않으므로 prompt 앞에 prepend하여 동등 효과 달성 */
    const finalPrompt = options.systemPrompt
      ? `${options.systemPrompt}\n\n${prompt}`
      : prompt;

    try {
      const raw     = await runGeminiCLI("", finalPrompt, {
        timeoutMs: options.timeoutMs || 30000,
        model    : options.model
      });
      const cleaned = raw.replace(/```json\s*|\s*```/g, "").trim();
      const result  = parseJsonResponse(cleaned);
      await this.recordSuccess();
      return result;
    } catch (err) {
      await this.recordFailure();
      throw err;
    }
  }
}
