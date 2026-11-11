/**
 * Anthropic Claude Provider (Messages API)
 *
 * 상속: LlmProvider 직접 상속.
 * 이유: POST /v1/messages 스키마(x-api-key 헤더, system 최상위 필드, content[].text 응답)가
 *       OpenAI /v1/chat/completions 구조와 달라 OpenAICompatibleProvider 재사용이 불가하다.
 *
 * 작성자: 최진호
 * 작성일: 2026-04-16
 *
 * POST /v1/messages — x-api-key + anthropic-version 헤더.
 * system 프롬프트는 별도 최상위 필드로 전달 (messages 배열 외부).
 *
 * Token usage 출처:
 *   - input tokens : data.usage.input_tokens
 *   - output tokens: data.usage.output_tokens
 */

import { LlmProvider }       from "../LlmProvider.js";
import { fetchWithTimeout }  from "../util/fetch-with-timeout.js";
import { computeCooldown }   from "../util/retry-hints.js";
import { logWarn }           from "../../logger.js";

const DEFAULT_BASE_URL = "https://api.anthropic.com/v1";
const DEFAULT_VERSION  = "2023-06-01";

/** 429 / 503 쿨다운. Retry-After 헤더가 있으면 그 값을 우선 채택. 최대 60초. */
const COOLDOWN_MIN_MS  = 500;
const COOLDOWN_MAX_MS  = 2000;
const COOLDOWN_HARDCAP = 60_000;

export class AnthropicProvider extends LlmProvider {
  constructor(config = {}) {
    super({ ...config, name: "anthropic" });
    this.baseUrl         = config.baseUrl || DEFAULT_BASE_URL;
    this.apiKey          = config.apiKey;
    this.version         = config.version || DEFAULT_VERSION;
    this._cooldownUntil  = 0;
  }

  /**
   * 테스트/외부 진단용 쿨다운 강제 주입.
   *
   * @param {number} ms
   */
  _setCooldown(ms) {
    this._cooldownUntil = Date.now() + ms;
  }

  /**
   * apiKey와 model이 모두 설정돼야 호출 가능.
   * 429 쿨다운 기간 중에는 false 반환 → 체인에서 건너뜀.
   *
   * @returns {Promise<boolean>}
   */
  async isAvailable() {
    if (Date.now() < this._cooldownUntil) return false;
    return Boolean(this.apiKey && this.config.model);
  }

  /**
   * Anthropic Messages API를 호출하여 텍스트 응답을 반환한다.
   *
   * @param {string}  prompt
   * @param {object}  [options={}]
   * @param {string}  [options.model]         - config.model override
   * @param {number}  [options.maxTokens=2048]
   * @param {number}  [options.temperature=0.2]
   * @param {string}  [options.systemPrompt]  - system 필드로 전달
   * @param {number}  [options.timeoutMs=30000]
   * @returns {Promise<string>}
   */
  async callText(prompt, options = {}) {
    if (await this.isCircuitOpen()) {
      throw new Error("anthropic: circuit breaker open");
    }

    const model = options.model || this.config.model;

    const body = {
      model      : model,
      max_tokens : options.maxTokens  || 2048,
      temperature: options.temperature ?? 0.2,
      messages   : [{ role: "user", content: prompt }]
    };

    if (options.systemPrompt) {
      body.system = options.systemPrompt;
    }

    const extraHeaders = this.config.extraHeaders || {};

    try {
      const res = await fetchWithTimeout(
        `${this.baseUrl}/messages`,
        {
          method : "POST",
          headers: {
            "Content-Type"     : "application/json",
            "x-api-key"        : this.apiKey,
            "anthropic-version": this.version,
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
          logWarn(`anthropic: HTTP ${res.status} — cooldown ${cooldownMs}ms (hint=${hintMs}ms)`, { provider: "anthropic" });
        }
        throw new Error(`anthropic HTTP ${res.status}: ${errBody.slice(0, 300)}`);
      }

      const data  = await res.json();
      const text  = data.content?.[0]?.text ?? "";

      if (!text) {
        throw new Error("anthropic: empty response");
      }

      await this.recordSuccess();
      return text;
    } catch (err) {
      await this.recordFailure();
      throw err;
    }
  }
}
