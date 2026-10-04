/**
 * GitHub Copilot CLI Provider (lib/copilot.js 래핑 shim)
 *
 * 작성자: 최진호
 * 작성일: 2026-04-18
 *
 * 순환 의존성 방지 구조:
 *   CopilotCliProvider.isAvailable()  -> _rawIsCopilotCLIAvailable (CLI 바이너리 체크만)
 *   CopilotCliProvider.callJson()     -> runCopilotCLI (CLI 직접 호출)
 *   lib/copilot.js public API         -> llm/index.js (chain 전체 위임)
 *
 * Copilot CLI는 JSON 강제 플래그가 없다. 프롬프트에 "Return ONLY JSON" 같은
 * 지시를 포함하는 것은 caller 책임이다 (GeminiCliProvider와 동일 정책).
 *
 *   - callJson(): 정상 동작 (CLI 출력 -> extractJsonBlock -> parseJsonResponse)
 *   - callText(): 미구현 -- "use callJson" 에러 throw
 */

import { LlmProvider }                                                  from "../LlmProvider.js";
import { parseJsonResponse }                                            from "../util/parse-json.js";
import { runCopilotCLI, extractJsonBlock, _rawIsCopilotCLIAvailable }  from "../runners/copilot.js";

export class CopilotCliProvider extends LlmProvider {
  constructor(config = {}) {
    super({ ...config, name: "copilot-cli" });
  }

  /**
   * Copilot CLI 바이너리(copilot) 설치 여부로 가용성을 판단한다.
   * _rawIsCopilotCLIAvailable을 사용하여 chain 재귀 체크를 방지한다.
   *
   * @returns {Promise<boolean>}
   */
  async isAvailable(timeoutMs = null) {
    return _rawIsCopilotCLIAvailable(timeoutMs);
  }

  /**
   * Copilot CLI는 JSON 블록 추출 방식이므로 callText는 미구현.
   *
   * @throws {Error} 항상 throw
   */
  async callText(_prompt, _options = {}) {
    throw new Error("copilot-cli: use callJson (CLI output requires JSON block extraction)");
  }

  /**
   * runCopilotCLI를 직접 호출하여 JSON 응답을 반환한다.
   * Circuit breaker 연동 포함.
   *
   * @param {string}  prompt
   * @param {object}  [options={}]
   * @param {number}  [options.timeoutMs=180000]   - SIGTERM 타임아웃 (ms)
   * @param {string}  [options.effort="low"]       - reasoning effort
   * @param {boolean} [options.allowAllTools=true] - --allow-all-tools 플래그
   * @param {string}  [options.systemPrompt]       - prompt 앞에 prepend
   * @returns {Promise<*>} 파싱된 JSON
   */
  async callJson(prompt, options = {}) {
    if (await this.isCircuitOpen()) {
      throw new Error("copilot-cli: circuit breaker open");
    }

    /** CLI는 system role을 별도로 받지 않으므로 prompt 앞에 prepend하여 동등 효과 달성 */
    const finalPrompt = options.systemPrompt
      ? `${options.systemPrompt}\n\n${prompt}`
      : prompt;

    try {
      const raw     = await runCopilotCLI(finalPrompt, {
        timeoutMs   : options.timeoutMs    ?? 180_000,
        effort      : options.effort       ?? "low",
        allowAllTools: options.allowAllTools !== false
      });
      const block   = extractJsonBlock(raw) ?? raw;
      const result  = parseJsonResponse(block);
      await this.recordSuccess();
      return result;
    } catch (err) {
      await this.recordFailure();
      throw err;
    }
  }
}
