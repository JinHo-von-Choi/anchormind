/**
 * Cohere Provider (Chat API)
 *
 * 상속: LlmProvider 직접 상속.
 * 이유: POST /v1/chat 경로이며 message + preamble + chat_history 구조로 OpenAI와 다르고
 *       응답이 최상위 text 필드로 반환된다.
 *
 * 작성자: 최진호
 * 작성일: 2026-04-16
 *
 * POST /v1/chat — message + preamble + chat_history 구조.
 * system 프롬프트는 'preamble' 필드로 전달 (Cohere 전용 명칭).
 * 응답은 최상위 'text' 필드 (OpenAI choices 구조와 다름).
 *
 * Token usage 출처:
 *   - input tokens : data.meta?.tokens?.input_tokens
 *   - output tokens: data.meta?.tokens?.output_tokens
 */

import { LlmProvider }       from "../LlmProvider.js";
import { fetchWithTimeout }  from "../util/fetch-with-timeout.js";
import { computeCooldown }   from "../util/retry-hints.js";
import { logWarn }           from "../../logger.js";

const DEFAULT_BASE_URL = "https://api.cohere.ai/v1";

/** 429 / 503 쿨다운. Retry-After 헤더가 있으면 그 값을 우선 채택. 최대 60초. */
const COOLDOWN_MIN_MS  = 500;
const COOLDOWN_MAX_MS  = 2000;
const COOLDOWN_HARDCAP = 60_000;

export class CohereProvider extends LlmProvider {
  constructor(config = {}) {
    super({ ...config, name: "cohere" });
    this.baseUrl         = config.baseUrl || DEFAULT_BASE_URL;
    this.apiKey          = config.apiKey;
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
   * Cohere Chat API를 호출하여 텍스트 응답을 반환한다.
   *
   * @param {string}  prompt
   * @param {object}  [options={}]
   * @param {string}  [options.model]          - config.model override
   * @param {number}  [options.maxTokens=2048]
   * @param {number}  [options.temperature=0.2]
   * @param {string}  [options.systemPrompt]   - preamble 필드로 전달
   * @param {number}  [options.timeoutMs=30000]
   * @returns {Promise<string>}
   */
  async callText(prompt, options = {}) {
    if (await this.isCircuitOpen()) {
      throw new Error("cohere: circuit breaker open");
    }

    const model = options.model || this.config.model;

    const body = {
      model      : model,
      message    : prompt,
      temperature: options.temperature ?? 0.2,
      max_tokens : options.maxTokens || 2048
    };

    if (options.systemPrompt) {
      body.preamble = options.systemPrompt;
    }

    const extraHeaders = this.config.extraHeaders || {};

    try {
      const res = await fetchWithTimeout(
        `${this.baseUrl}/chat`,
        {
          method : "POST",
          headers: {
            "Content-Type" : "application/json",
            "Authorization": `Bearer ${this.apiKey}`,
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
          logWarn(`cohere: HTTP ${res.status} — cooldown ${cooldownMs}ms (hint=${hintMs}ms)`, { provider: "cohere" });
        }
        throw new Error(`cohere HTTP ${res.status}: ${errBody.slice(0, 300)}`);
      }

      const data = await res.json();
      const text = data.text ?? "";  // Cohere는 최상위 text 필드

      if (!text) {
        throw new Error("cohere: empty response");
      }

      await this.recordSuccess();
      return text;
    } catch (err) {
      await this.recordFailure();
      throw err;
    }
  }
}
