/**
 * OpenAI-compatible API Provider 공통 기반 클래스
 *
 * OpenAI /v1/chat/completions 엔드포인트를 사용하는 모든 provider의 공통 구현.
 * 8개 얇은 서브클래스(OpenAI, Groq, OpenRouter, xAI, vLLM, DeepSeek, Mistral, ZAI)가
 * baseUrl + extraHeaders 값만 달리하여 이 클래스를 상속한다.
 *
 * 상속 관계:
 *   LlmProvider (추상 기반)
 *     └─ OpenAICompatibleProvider  ← 이 클래스 (HTTP helper wrapper)
 *          └─ OpenAIProvider, GroqProvider, OpenRouterProvider, XaiProvider,
 *             VllmProvider, DeepSeekProvider, MistralProvider, ZaiProvider
 *
 * 이 클래스는 LlmProvider의 helper wrapper다. POST /v1/chat/completions 경로를
 * 사용하는 provider만 이 클래스를 상속한다. 그 외 고유 HTTP 스키마(Anthropic Messages API,
 * Google Gemini generateContent)나 stdio 기반 CLI provider는 LlmProvider를 직접 상속한다.
 *
 * @deprecated 상속(extends) 방식은 v2.10.0에서 composition 전환 예정.
 *   v2.10.0부터 baseUrl + extraHeaders를 생성자 파라미터로 받는 단일 OpenAICompatibleProvider
 *   인스턴스로 교체된다. v2.9.x 동안은 기존 상속 구조 유지.
 *
 * 작성자: 최진호
 * 작성일: 2026-04-16
 * 수정일: 2026-04-19 (상속 계약 명시 + composition 전환 일정 기록)
 */

import { LlmProvider }       from "../LlmProvider.js";
import { fetchWithTimeout }  from "../util/fetch-with-timeout.js";
import { computeCooldown }   from "../util/retry-hints.js";
import { LlmRateLimitError, LlmAuthError, LlmFatalError } from "../errors.js";
import { logWarn }           from "../../logger.js";

/** 429 / 503 쿨다운. Retry-After 헤더가 있으면 그 값을 우선 채택. 최대 60초. */
const COOLDOWN_MIN_MS  = 500;
const COOLDOWN_MAX_MS  = 2000;
const COOLDOWN_HARDCAP = 60_000;

export class OpenAICompatibleProvider extends LlmProvider {
  /**
   * @param {object} config
   * @param {string}  config.name         - provider 식별 이름
   * @param {string}  config.baseUrl      - API 기본 URL
   * @param {string}  [config.apiKey]     - Bearer 토큰
   * @param {string}  config.model        - 사용할 모델명 (필수)
   * @param {object}  [config.extraHeaders={}] - provider별 추가 헤더
   * @param {number}  [config.timeoutMs=30000]
   */
  constructor(config) {
    super(config);
    this.baseUrl        = config.baseUrl;
    this.apiKey         = config.apiKey;
    this.extraHeaders   = config.extraHeaders || {};
    this._cooldownUntil = 0;
  }

  /**
   * 429 쿨다운 기간(ms)을 설정한다. 테스트에서도 직접 호출 가능.
   *
   * @param {number} ms - 쿨다운 지속 시간 (밀리초)
   */
  _setCooldown(ms) {
    this._cooldownUntil = Date.now() + ms;
  }

  /**
   * baseUrl, apiKey, model이 모두 설정되어 있어야 사용 가능.
   * vLLM처럼 apiKey 없이도 동작하는 provider는 서브클래스에서 override 가능.
   * 429 쿨다운 기간 중에는 false를 반환하여 체인에서 건너뜀.
   *
   * @returns {Promise<boolean>}
   */
  async isAvailable() {
    if (Date.now() < this._cooldownUntil) return false;
    if (await this.isCircuitOpen()) return false;
    return Boolean(this.apiKey && this.baseUrl && this.config.model);
  }

  /**
   * OpenAI chat completions 엔드포인트를 호출하여 텍스트 응답을 반환한다.
   *
   * @param {string} prompt
   * @param {object} [options={}]
   * @param {string}  [options.model]        - config.model override
   * @param {string}  [options.systemPrompt]
   * @param {number}  [options.maxTokens=2048]
   * @param {number}  [options.temperature=0.2]
   * @param {number}  [options.timeoutMs=30000]
   * @returns {Promise<string>}
   */
  async callText(prompt, options = {}) {
    if (await this.isCircuitOpen()) {
      throw new LlmFatalError(`${this.name}: circuit breaker open`);
    }

    const model = options.model || this.config.model;
    const body  = {
      model,
      messages: [
        ...(options.systemPrompt
          ? [{ role: "system", content: options.systemPrompt }]
          : []),
        { role: "user", content: prompt }
      ],
      max_tokens : options.maxTokens  ?? 2048,
      temperature: options.temperature ?? 0.2
    };

    let res;
    try {
      res = await fetchWithTimeout(
        `${this.baseUrl}/chat/completions`,
        {
          method : "POST",
          headers: {
            "Content-Type" : "application/json",
            "Authorization": `Bearer ${this.apiKey}`,
            ...this.extraHeaders
          },
          body: JSON.stringify(body)
        },
        options.timeoutMs ?? 30000
      );
    } catch (err) {
      await this.recordFailure();
      throw err;
    }

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      await this.recordFailure();

      if (res.status === 401 || res.status === 403) {
        throw new LlmAuthError(
          `${this.name} HTTP ${res.status}: ${errBody.slice(0, 300)}`,
          { status: res.status, provider: this.name }
        );
      }
      if (res.status === 429) {
        const { cooldownMs, hintMs } = computeCooldown({
          res,
          bodyText  : errBody,
          minMs     : COOLDOWN_MIN_MS,
          maxMs     : COOLDOWN_MAX_MS,
          hardCapMs : COOLDOWN_HARDCAP
        });
        this._cooldownUntil = Date.now() + cooldownMs;
        logWarn(`${this.name}: HTTP 429 — cooldown ${cooldownMs}ms (hint=${hintMs}ms)`, { provider: this.name });
        throw new LlmRateLimitError(
          `${this.name} HTTP 429: ${errBody.slice(0, 300)}`,
          { status: 429, provider: this.name }
        );
      }
      throw new Error(`${this.name} HTTP ${res.status}: ${errBody.slice(0, 300)}`);
    }

    let data;
    try {
      data = await res.json();
    } catch (err) {
      await this.recordFailure();
      throw new Error(`${this.name}: failed to parse response JSON: ${err.message}`, { cause: err });
    }

    const text = data.choices?.[0]?.message?.content ?? "";
    if (!text) {
      await this.recordFailure();
      throw new Error(`${this.name}: empty response content`);
    }

    // 토큰 사용량 기록 (Task 9 metrics.js 생성 후 직접 import로 전환 예정)
    const usage = data.usage;
    if (usage) {
      import("../metrics.js")
        .then(m => {
          m.llmTokenUsageTotal?.inc?.({
            provider  : this.name,
            token_type: "prompt"
          }, usage.prompt_tokens ?? 0);
          m.llmTokenUsageTotal?.inc?.({
            provider  : this.name,
            token_type: "completion"
          }, usage.completion_tokens ?? 0);
        })
        .catch(() => {});
    }

    await this.recordSuccess();
    return text;
  }
}
