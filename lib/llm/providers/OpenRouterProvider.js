/**
 * OpenRouter Provider
 *
 * 작성자: 최진호
 * 작성일: 2026-04-16
 */

import { OpenAICompatibleProvider } from "./OpenAICompatibleProvider.js";

export class OpenRouterProvider extends OpenAICompatibleProvider {
  /**
   * @param {object} config
   * @param {string}  config.model     - 사용할 모델명 (필수, 기본값 하드코딩 금지)
   * @param {string}  config.apiKey
   * @param {string}  [config.baseUrl] - 기본값: https://openrouter.ai/api/v1
   * @param {object}  [config.extraHeaders] - 사용자 지정 헤더 (HTTP-Referer, X-Title 등)
   */
  constructor(config) {
    super({
      ...config,
      name        : "openrouter",
      baseUrl     : config.baseUrl || "https://openrouter.ai/api/v1",
      extraHeaders: {
        "HTTP-Referer": "https://github.com/memento-mcp",
        "X-Title"     : "memento-mcp",
        ...(config.extraHeaders || {})
      }
    });
  }
}
