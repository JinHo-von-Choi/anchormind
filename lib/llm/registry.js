/**
 * LLM Provider 레지스트리
 *
 * 작성자: 최진호
 * 작성일: 2026-04-16
 *
 * JSON config 기반 팩토리 함수를 제공한다.
 * createProvider(config)에 provider 이름(문자열) 또는
 * {provider, apiKey, model, baseUrl, timeoutMs, extraHeaders} 객체를 전달하면
 * 해당 LlmProvider 인스턴스를 반환한다.
 *
 * 신규 provider 추가 절차:
 *   1. lib/llm/providers/<Name>Provider.js 작성
 *   2. 이 파일에 import + PROVIDER_CLASSES 매핑 한 줄 추가
 */

import { OpenAIProvider }       from "./providers/OpenAIProvider.js";
import { AnthropicProvider }    from "./providers/AnthropicProvider.js";
import { GoogleGeminiProvider } from "./providers/GoogleGeminiProvider.js";
import { GroqProvider }         from "./providers/GroqProvider.js";
import { OpenRouterProvider }   from "./providers/OpenRouterProvider.js";
import { XaiProvider }          from "./providers/XaiProvider.js";
import { OllamaProvider }       from "./providers/OllamaProvider.js";
import { VllmProvider }         from "./providers/VllmProvider.js";
import { DeepSeekProvider }     from "./providers/DeepSeekProvider.js";
import { MistralProvider }      from "./providers/MistralProvider.js";
import { CohereProvider }       from "./providers/CohereProvider.js";
import { ZaiProvider }          from "./providers/ZaiProvider.js";
import { GeminiCliProvider }    from "./providers/GeminiCliProvider.js";
import { AgyCliProvider }       from "./providers/AgyCliProvider.js";
import { CodexCliProvider }     from "./providers/CodexCliProvider.js";
import { CopilotCliProvider }   from "./providers/CopilotCliProvider.js";
import { QwenCliProvider }      from "./providers/QwenCliProvider.js";
import { OpenCodeCliProvider }  from "./providers/OpenCodeCliProvider.js";

/** Provider 이름 → 클래스 매핑 */
const PROVIDER_CLASSES = {
  "openai"      : OpenAIProvider,
  "anthropic"   : AnthropicProvider,
  "gemini"      : GoogleGeminiProvider,
  "groq"        : GroqProvider,
  "openrouter"  : OpenRouterProvider,
  "xai"         : XaiProvider,
  "ollama"      : OllamaProvider,
  "vllm"        : VllmProvider,
  "deepseek"    : DeepSeekProvider,
  "mistral"     : MistralProvider,
  "cohere"      : CohereProvider,
  "zai"         : ZaiProvider,
  "gemini-cli"  : GeminiCliProvider,
  "agy-cli"     : AgyCliProvider,
  "codex-cli"   : CodexCliProvider,
  "copilot-cli" : CopilotCliProvider,
  "qwen-cli"    : QwenCliProvider,
  "opencode-cli": OpenCodeCliProvider
};

/**
 * config로부터 LlmProvider 인스턴스를 생성한다.
 *
 * @param {string|object} config
 *   - 문자열: provider 이름 (예: "gemini-cli")
 *   - 객체: { provider, apiKey?, model?, baseUrl?, timeoutMs?, extraHeaders? }
 * @returns {import("./LlmProvider.js").LlmProvider|null}
 *   알 수 없는 provider 이름이면 null 반환.
 */
export function createProvider(config) {
  const name = typeof config === "string" ? config : config?.provider;
  if (!name) return null;

  const Cls = PROVIDER_CLASSES[name];
  if (!Cls) return null;

  /** CLI provider는 API 키/URL 없이 로컬 바이너리 + 선택 model/timeout만 사용 */
  if (name === "gemini-cli" || name === "agy-cli" || name === "codex-cli" || name === "copilot-cli" || name === "qwen-cli" || name === "opencode-cli") {
    return new Cls({
      model    : typeof config === "object" ? config.model ?? null : null,
      timeoutMs: typeof config === "object" ? config.timeoutMs ?? null : null,
      agent    : typeof config === "object" ? config.agent ?? null : null,
      variant  : typeof config === "object" ? config.variant ?? null : null
    });
  }

  return new Cls({
    apiKey      : config.apiKey       ?? null,
    model       : config.model        ?? null,
    baseUrl     : config.baseUrl      ?? null,
    timeoutMs   : config.timeoutMs    ?? null,
    extraHeaders: config.extraHeaders ?? null
  });
}

/**
 * 등록된 모든 provider 이름 목록을 반환한다.
 *
 * @returns {string[]}
 */
export function listProviderNames() {
  return Object.keys(PROVIDER_CLASSES);
}
