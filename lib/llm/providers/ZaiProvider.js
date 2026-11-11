/**
 * ZAI (GLM, BigModel) Provider
 *
 * ZhipuAI의 GLM 모델 접근점.
 * 엔드포인트 경로: /api/paas/v4/chat/completions
 * OpenAI 호환이나 baseUrl 기본값이 다르다.
 *
 * 작성자: 최진호
 * 작성일: 2026-04-16
 */

import { OpenAICompatibleProvider } from "./OpenAICompatibleProvider.js";

export class ZaiProvider extends OpenAICompatibleProvider {
  /**
   * @param {object} config
   * @param {string}  config.model    - 사용할 모델명 (필수, 기본값 하드코딩 금지)
   * @param {string}  config.apiKey
   * @param {string}  [config.baseUrl] - 기본값: https://open.bigmodel.cn/api/paas/v4
   */
  constructor(config) {
    super({
      ...config,
      name   : "zai",
      baseUrl: config.baseUrl || "https://open.bigmodel.cn/api/paas/v4"
    });
  }
}
