/**
 * Mistral Provider
 *
 * 작성자: 최진호
 * 작성일: 2026-04-16
 */

import { OpenAICompatibleProvider } from "./OpenAICompatibleProvider.js";

export class MistralProvider extends OpenAICompatibleProvider {
  /**
   * @param {object} config
   * @param {string}  config.model    - 사용할 모델명 (필수, 기본값 하드코딩 금지)
   * @param {string}  config.apiKey
   * @param {string}  [config.baseUrl] - 기본값: https://api.mistral.ai/v1
   */
  constructor(config) {
    super({
      ...config,
      name   : "mistral",
      // iron-laws: ignore[AI-101] 공급자 공개 API 기본 주소이며 config.baseUrl로 바꿀 수 있다
      baseUrl: config.baseUrl || "https://api.mistral.ai/v1"
    });
  }
}
