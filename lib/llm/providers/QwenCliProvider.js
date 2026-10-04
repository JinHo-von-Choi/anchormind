/**
 * Qwen CLI Provider (lib/qwen.js 래핑 shim)
 *
 * 작성자: 최진호
 * 작성일: 2026-04-22
 *
 * 순환 의존성 방지 구조:
 *   QwenCliProvider.isAvailable()  → _rawIsQwenCLIAvailable (CLI 바이너리 체크만)
 *   QwenCliProvider.callJson()     → runQwenCLI (CLI 직접 호출)
 *   lib/qwen.js public API         → llm/index.js (chain 전체 위임)
 *
 *   - callJson(): 정상 동작 (CLI 출력 → JSON 블록 추출 → parseJsonResponse)
 *   - callText(): 미구현 — "use callJson" 에러 throw
 */

import { LlmProvider }                                from "../LlmProvider.js";
import { parseJsonResponse }                          from "../util/parse-json.js";
import { runQwenCLI, _rawIsQwenCLIAvailable }        from "../runners/qwen.js";

export class QwenCliProvider extends LlmProvider {
  constructor(config = {}) {
    super({ ...config, name: "qwen-cli" });
  }

  /**
   * Qwen CLI 바이너리(`qwen`) 설치 여부로 가용성을 판단한다.
   *
   * @returns {Promise<boolean>}
   */
  async isAvailable(timeoutMs = null) {
    return _rawIsQwenCLIAvailable(timeoutMs);
  }

  /**
   * qwen-cli는 JSON 전용이므로 callText는 미구현.
   *
   * @throws {Error} 항상 throw
   */
  async callText(_prompt, _options = {}) {
    throw new Error("qwen-cli: use callJson (CLI returns parsed JSON)");
  }

  /**
   * runQwenCLI를 직접 호출하여 JSON 응답을 반환한다.
   * Circuit breaker 연동 포함.
   *
   * @param {string}  prompt
   * @param {object}  [options={}]
   * @param {number}  [options.timeoutMs=120000]
   * @param {string}  [options.model]         - 미지정 시 provider config.model, 없으면 CLI 기본 모델 사용
   * @param {string}  [options.systemPrompt]  - prompt 앞에 prepend
   * @returns {Promise<*>} 파싱된 JSON
   */
  async callJson(prompt, options = {}) {
    if (await this.isCircuitOpen()) {
      throw new Error("qwen-cli: circuit breaker open");
    }

    const finalPrompt = [
      options.systemPrompt,
      "Return one valid JSON value only. Do not wrap it in markdown fences. Do not add commentary before or after the JSON.",
      prompt
    ].filter(Boolean).join("\n\n");

    try {
      const raw     = await runQwenCLI("", finalPrompt, {
        timeoutMs: options.timeoutMs ?? this.config.timeoutMs ?? 120_000,
        model    : options.model ?? this.config.model
      });
      const result  = parseJsonResponse(raw);
      await this.recordSuccess();
      return result;
    } catch (err) {
      await this.recordFailure();
      throw err;
    }
  }
}
