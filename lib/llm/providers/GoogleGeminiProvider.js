/**
 * Google Gemini API Provider (HTTP, REST)
 *
 * 상속: LlmProvider 직접 상속.
 * 이유: POST /v1beta/models/{model}:generateContent 경로이며 API 키를 x-goog-api-key 헤더로
 *       전달하고 응답 구조(candidates[].content.parts[].text)가 OpenAI와 다르다.
 *
 * 작성자: 최진호
 * 작성일: 2026-04-16
 *
 * POST /v1beta/models/{model}:generateContent
 * API 키는 x-goog-api-key 헤더로 전달.
 * Gemini CLI(gemini-cli provider)와 완전히 별개.
 *
 * Token usage 출처:
 *   - input tokens : data.usageMetadata.promptTokenCount
 *   - output tokens: data.usageMetadata.candidatesTokenCount
 */

import { LlmProvider }       from "../LlmProvider.js";
import { fetchWithTimeout }  from "../util/fetch-with-timeout.js";
import { computeCooldown }   from "../util/retry-hints.js";
import { logWarn }           from "../../logger.js";

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

/** 429 / 503 쿨다운 기본값. Gemini 무료 티어는 분당 5~15회 한도이므로
 *  순간 버스트로 429를 맞았을 때 잠깐 물러나 다음 키/fallback으로 돌리기 위한 짧은 지터.
 *  서버가 Retry-After 헤더나 응답 본문 RetryInfo.retryDelay 를 제공하면 그 값을 우선 채택한다.
 *  지나친 대기(>60s)는 상한으로 캡 — 일일 쿼터 소진 시에도 60초마다 재진입하도록 한다. */
const COOLDOWN_MIN_MS  = 500;
const COOLDOWN_MAX_MS  = 2000;
const COOLDOWN_HARDCAP = 60_000;

export class GoogleGeminiProvider extends LlmProvider {
  constructor(config = {}) {
    super({ ...config, name: "google-gemini-api" });
    this.baseUrl         = config.baseUrl || DEFAULT_BASE_URL;
    this.apiKey          = config.apiKey;
    this._cooldownUntil  = 0;
  }

  /**
   * 테스트/외부 진단용 쿨다운 강제 주입.
   *
   * @param {number} ms - 현재 시점부터 쿨다운 만료까지의 밀리초
   */
  _setCooldown(ms) {
    this._cooldownUntil = Date.now() + ms;
  }

  /**
   * apiKey와 model이 모두 설정돼야 호출 가능.
   * 429 쿨다운 진행 중이면 isAvailable()=false 반환 → dispatcher가 다음 fallback으로 즉시 전환.
   *
   * @returns {Promise<boolean>}
   */
  async isAvailable() {
    if (Date.now() < this._cooldownUntil) return false;
    return Boolean(this.apiKey && this.config.model);
  }

  /**
   * Google Gemini generateContent API를 호출하여 텍스트 응답을 반환한다.
   *
   * @param {string}  prompt
   * @param {object}  [options={}]
   * @param {string}  [options.model]         - config.model override
   * @param {number}  [options.maxTokens=2048]
   * @param {number}  [options.temperature=0.2]
   * @param {string}  [options.systemPrompt]  - systemInstruction 필드로 전달
   * @param {number}  [options.timeoutMs=30000]
   * @returns {Promise<string>}
   */
  async callText(prompt, options = {}) {
    if (await this.isCircuitOpen()) {
      throw new Error("google-gemini-api: circuit breaker open");
    }

    const model = options.model || this.config.model;

    const body = {
      contents: [{
        parts: [{ text: prompt }],
        role : "user"
      }],
      generationConfig: {
        maxOutputTokens: options.maxTokens  || 2048,
        temperature    : options.temperature ?? 0.2
      }
    };

    if (options.systemPrompt) {
      body.systemInstruction = { parts: [{ text: options.systemPrompt }] };
    }

    const url = `${this.baseUrl}/models/${encodeURIComponent(model)}:generateContent`;

    const extraHeaders = this.config.extraHeaders || {};

    try {
      const res = await fetchWithTimeout(
        url,
        {
          method : "POST",
          headers: {
            "Content-Type"  : "application/json",
            "x-goog-api-key": this.apiKey,
            ...extraHeaders
          },
          body: JSON.stringify(body)
        },
        options.timeoutMs || 30000
      );

      if (!res.ok) {
        const errBody = await res.text();
        if (res.status === 429 || res.status === 503) {
          const { cooldownMs, hintMs } = computeCooldown({
            res,
            bodyText  : errBody,
            minMs     : COOLDOWN_MIN_MS,
            maxMs     : COOLDOWN_MAX_MS,
            hardCapMs : COOLDOWN_HARDCAP
          });
          this._setCooldown(cooldownMs);
          logWarn(`[google-gemini-api] HTTP ${res.status} received, cooldown ${cooldownMs}ms (hint=${hintMs}ms)`);
        }
        throw new Error(`google-gemini-api HTTP ${res.status}: ${errBody.slice(0, 300)}`);
      }

      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

      if (!text) {
        throw new Error("google-gemini-api: empty response");
      }

      await this.recordSuccess();
      return text;
    } catch (err) {
      await this.recordFailure();
      throw err;
    }
  }
}
