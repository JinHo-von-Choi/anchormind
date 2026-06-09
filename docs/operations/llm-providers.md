# LLM Provider Fallback 운영 가이드

작성자: 최진호
작성일: 2026-04-16

## 개요

memento-mcp는 내부 LLM 호출(AutoReflect, MorphemeIndex, ConsolidatorGC, ContradictionDetector, MemoryEvaluator)에 16개 provider fallback chain을 지원한다. 기본값은 Gemini CLI 단독 사용으로 기존 동작 완전 보존.

## 활성화

### 기본 상태 (env 미설정)

```bash
# LLM_PRIMARY=gemini-cli (기본값)
# LLM_FALLBACKS=(비어있음)
```

Gemini CLI만 사용. 실패 시 caller가 graceful degradation (AutoReflect skip 등).

### Fallback 체인 구성

```bash
LLM_PRIMARY=gemini-cli
LLM_FALLBACKS='[
  {"provider":"codex-cli","model":"gpt-5.3-codex-spark","timeoutMs":120000},
  {"provider":"anthropic","apiKey":"sk-ant-...","model":"claude-opus-4-6"},
  {"provider":"openai","apiKey":"sk-...","model":"gpt-4o-mini"}
]'
```

Gemini CLI 실패 시 codex-cli → anthropic → openai 순차 시도.
CLI provider(`gemini-cli`, `codex-cli`, `copilot-cli`, `qwen-cli`)도 `LLM_FALLBACKS`의 `model`, `timeoutMs`를 provider config로 전달받는다.

## Provider별 필수 필드

| Provider | apiKey | model | baseUrl | 기본 baseUrl |
|----------|--------|-------|---------|-------------|
| gemini-cli | - | - | - | (CLI 바이너리) |
| codex-cli | - | 선택 | - | (CLI 바이너리 + Codex 인증) |
| copilot-cli | - | - | - | (CLI 바이너리 + GitHub Copilot 인증) |
| qwen-cli | - | 선택 | - | (CLI 바이너리 + Qwen 인증) |
| anthropic | 필수 | 필수 | 선택 | https://api.anthropic.com/v1 |
| openai | 필수 | 필수 | 선택 | https://api.openai.com/v1 |
| google-gemini-api | 필수 | 필수 | 선택 | https://generativelanguage.googleapis.com/v1beta |
| groq | 필수 | 필수 | 선택 | https://api.groq.com/openai/v1 |
| openrouter | 필수 | 필수 | 선택 | https://openrouter.ai/api/v1 |
| xai | 필수 | 필수 | 선택 | https://api.x.ai/v1 |
| ollama | 선택 | 필수 | **필수** | (없음 — 사용자 지정) |
| vllm | 선택 | 필수 | **필수** | (없음 — 사용자 배포) |
| deepseek | 필수 | 필수 | 선택 | https://api.deepseek.com |
| mistral | 필수 | 필수 | 선택 | https://api.mistral.ai/v1 |
| cohere | 필수 | 필수 | 선택 | https://api.cohere.ai/v1 |
| zai | 필수 | 필수 | 선택 | https://open.bigmodel.cn/api/paas/v4 |

## Circuit Breaker

연속 실패 시 provider 자동 격리:
- 기본 5회 연속 실패 → 60초 OPEN 상태
- OPEN 중 해당 provider 호출은 즉시 건너뛰고 다음 체인으로 이동
- 60초 경과 후 자동 CLOSE, 다음 호출에서 재시도
- REDIS_ENABLED=true 시 상태가 Redis에 저장되어 프로세스 재시작에도 유지됨

## Monitoring

Prometheus 쿼리 예시:

```promql
# provider별 성공률
sum(rate(memento_llm_provider_calls_total{outcome="success"}[5m])) by (provider)
  / sum(rate(memento_llm_provider_calls_total{outcome="attempt"}[5m])) by (provider)

# fallback 발동 빈도
rate(memento_llm_fallback_triggered_total[5m])

# provider별 p95 레이턴시
histogram_quantile(0.95, rate(memento_llm_provider_latency_ms_bucket[5m]))

# 토큰 사용량
rate(memento_llm_token_usage_total{direction="input"}[1h])
```

## 보안

**프롬프트 redaction**: Winston REDACT_PATTERNS + LLM 특화 패턴(`sk-ant-`, `sk-`, `gsk_`) 적용. API 키/세션 쿠키/OAuth 토큰은 자동 마스킹되지만 도메인 특화 PII(이름, 주소)는 마스킹 대상 아님.

**외부 provider 차단**: `LLM_FALLBACKS`에서 해당 provider 항목 제거. `LLM_PRIMARY=gemini-cli`만 남기면 외부 LLM 전면 차단.

## 장애 대응

### 특정 provider 전체 차단

```bash
# LLM_FALLBACKS JSON에서 해당 provider 원소 제거 후 서버 재시작
```

### 특정 모델 교체

```bash
# LLM_FALLBACKS JSON의 model 필드를 새 모델명으로 변경 후 서버 재시작
```

### Circuit breaker 수동 reset

```bash
# REDIS_ENABLED=true인 경우
redis-cli --scan --pattern "llm:cb:*" | xargs redis-cli del
# in-memory인 경우 서버 재시작
```

## 통합 테스트

LLM provider 관련 E2E 통합 테스트는 [tests/integration/README.md](../../tests/integration/README.md)가 단일 출처(source of truth)다.
환경변수 가드 목록, 수동 실행 명령, 전제 조건 전체를 해당 문서에서 관리한다.

이 문서와 관련된 환경변수 가드 요약:

| 테스트 파일 | 활성화 변수 |
|-|-|
| `llm-cli-smoke.test.js` | `E2E_LLM_CLI=1` |
| `llm-timeout.test.js` | `E2E_LLM_TIMEOUT=1` |
| `llm-chain-real.test.js` | `E2E_LLM_CHAIN=1` |
| `morpheme-llm-real.test.js` | `E2E_MORPHEME=1` |

세션 토큰 재사용(`E2E_SESSION_REUSE=1`) 등 LLM 비관련 E2E 테스트도 동일 README에 기록되어 있다.

## 알려진 제약

- 프롬프트 캐싱 미지원 (Anthropic cache_control, OpenAI prompt caching 등 — 후속 과제)
- Structured output / tool calling 미지원 — parseJsonResponse heuristic으로 처리
- Token budget cap enforcement는 provider 응답 수신 후 누적 — 선제 차단 아님
- llmText export 없음 — 내부 caller가 전부 JSON 응답 사용

---

## Provider Contract

작성일: 2026-04-19

### 계약 정의

`lib/llm/LlmProvider.js`의 `LlmProviderContract` typedef가 모든 provider의 공개 계약을 명시한다. 필수 메서드는 다음과 같다.

| 메서드 | 시그니처 | 에러 계약 |
|-|-|-|
| isAvailable | () => Promise<boolean> | 항상 resolve. 가용하지 않으면 false |
| callText | (prompt, options?) => Promise<string> | 실패 시 throw. 빈 문자열 반환 금지 |
| callJson | (prompt, options?) => Promise<any> | callText 파싱 실패 시 throw |
| isCircuitOpen | () => Promise<boolean> | 항상 resolve |
| recordFailure | () => Promise<void> | 항상 resolve |
| recordSuccess | () => Promise<void> | 항상 resolve |

에러 타입: `LlmRateLimitError`(429), `LlmAuthError`(401/403), `LlmFatalError`(복구 불가), 그 외 일반 Error.

### 상속 결정 가이드

#### LlmProvider를 직접 상속해야 하는 경우

- POST /v1/chat/completions 이외의 HTTP 스키마를 사용할 때
  - Anthropic: POST /v1/messages, x-api-key 헤더, content[].text 응답
  - Google Gemini API: POST /v1beta/models/{model}:generateContent, API 키 URL 파라미터
  - Cohere: POST /v1/chat, preamble 필드, 최상위 text 응답
- HTTP를 사용하지 않는 stdio / CLI 실행 경로일 때
  - GeminiCliProvider, CodexCliProvider, CopilotCliProvider

이 경우 callText 또는 callJson을 직접 구현하고 circuit breaker 호출을 수동으로 포함해야 한다.

#### OpenAICompatibleProvider를 상속해야 하는 경우

POST /v1/chat/completions 엔드포인트를 그대로 사용하며 baseUrl과 extraHeaders만 다를 때 이 클래스를 상속한다.
해당하는 provider: OpenAI, Groq, OpenRouter, xAI, vLLM, DeepSeek, Mistral, ZAI.

OpenAICompatibleProvider를 상속하면 callText 구현이 자동으로 제공된다. 서브클래스는 생성자에서 name, baseUrl, apiKey, model, extraHeaders를 설정하는 것 외에 추가 코드가 거의 불필요하다.

현재 OpenAICompatibleProvider는 상속 구조이다.

### 현재 provider 상속 분류

| Provider | 상속 클래스 | 경로 |
|-|-|-|
| GeminiCliProvider | LlmProvider | stdio, gemini CLI 바이너리 |
| CodexCliProvider | LlmProvider | stdio, codex CLI 바이너리 |
| CopilotCliProvider | LlmProvider | stdio, gh copilot CLI 바이너리 |
| AnthropicProvider | LlmProvider | POST /v1/messages, 고유 스키마 |
| GoogleGeminiProvider | LlmProvider | POST /v1beta/...generateContent, 고유 스키마 |
| CohereProvider | LlmProvider | POST /v1/chat, 고유 스키마 |
| OllamaProvider | LlmProvider | POST /api/chat, Ollama 전용 스키마 |
| OpenAIProvider | OpenAICompatibleProvider | POST /v1/chat/completions |
| GroqProvider | OpenAICompatibleProvider | POST /v1/chat/completions |
| OpenRouterProvider | OpenAICompatibleProvider | POST /v1/chat/completions |
| XaiProvider | OpenAICompatibleProvider | POST /v1/chat/completions |
| VllmProvider | OpenAICompatibleProvider | POST /v1/chat/completions |
| DeepSeekProvider | OpenAICompatibleProvider | POST /v1/chat/completions |
| MistralProvider | OpenAICompatibleProvider | POST /v1/chat/completions |
| ZaiProvider | OpenAICompatibleProvider | POST /v1/chat/completions |

### 외부 custom provider 작성 예시

POST /v1/chat/completions 호환 엔드포인트를 가진 서비스에 연결하는 경우:

```javascript
import { OpenAICompatibleProvider } from "memento-mcp/lib/llm/providers/OpenAICompatibleProvider.js";

export class MyApiProvider extends OpenAICompatibleProvider {
  constructor(config) {
    super({
      ...config,
      name   : "my-api",
      baseUrl: config.baseUrl || "https://api.example.com/v1"
    });
  }
}
```

고유 HTTP 스키마를 가진 서비스에 연결하는 경우:

```javascript
import { LlmProvider }      from "memento-mcp/lib/llm/LlmProvider.js";
import { fetchWithTimeout } from "memento-mcp/lib/llm/util/fetch-with-timeout.js";

export class MyCustomProvider extends LlmProvider {
  constructor(config) {
    super({ ...config, name: "my-custom" });
    this.apiKey  = config.apiKey;
    this.baseUrl = config.baseUrl;
  }

  async isAvailable() {
    return Boolean(this.apiKey && this.config.model);
  }

  /**
   * @param {string}  prompt
   * @param {object}  [options={}]
   * @returns {Promise<string>}
   */
  async callText(prompt, options = {}) {
    if (await this.isCircuitOpen()) throw new Error("my-custom: circuit breaker open");

    try {
      const res = await fetchWithTimeout(
        `${this.baseUrl}/completions`,
        {
          method : "POST",
          headers: { "Authorization": `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
          body   : JSON.stringify({ prompt, model: options.model || this.config.model })
        },
        options.timeoutMs ?? 30000
      );

      if (!res.ok) {
        await this.recordFailure();
        throw new Error(`my-custom HTTP ${res.status}`);
      }

      const data = await res.json();
      const text = data.text ?? "";
      if (!text) { await this.recordFailure(); throw new Error("my-custom: empty response"); }

      await this.recordSuccess();
      return text;
    } catch (err) {
      await this.recordFailure();
      throw err;
    }
  }
}
```

---

## Split 단계 전용 LLM 체인 설정

`splitLongFragments`는 전역 `LLM_PRIMARY`/`LLM_FALLBACKS` 체인과 독립적으로 별도 provider 집합을 사용할 수 있다.

### 환경 변수

| 변수 | 설명 |
|-|-|
| `MEMENTO_SPLIT_LLM_PRIMARY` | split 단계 주 provider 이름 (예: `xai`, `opencode-cli`, `gemini-cli`). 미설정 시 전역 체인 사용. |
| `MEMENTO_SPLIT_LLM_FALLBACKS` | JSON 배열. `LLM_FALLBACKS`와 동일한 원소 형태. 예: `[{"provider":"gemini-cli"}]` |

미설정 시 `resolveSplitChainConfig()`는 `null`을 반환하고 `splitLongFragments`는 전역 체인을 그대로 사용한다.

### 사용 가능한 provider 이름

`listProviderNames()` 출력: `openai, anthropic, gemini, groq, openrouter, xai, ollama, vllm, deepseek, mistral, cohere, zai, gemini-cli, codex-cli, copilot-cli, qwen-cli, opencode-cli`

- `xai` = Grok (xAI API, `https://api.x.ai/v1`)
- `opencode-cli` = OpenCode CLI (provider/model은 `model` 필드로 선택, 예: `"xiaomi/mimo-v2.5-pro"`)

### provider별 필수 의존성

| split provider | 필수 의존성 | 미충족 시 |
|-|-|-|
| `xai` (Grok) | `XAI_API_KEY` (또는 엔트리의 `apiKey`); `https://api.x.ai/v1` 접근 가능 | `isAvailable()` 실패 → 체인에서 제외 |
| `opencode-cli` | `opencode` 바이너리가 `PATH`에 존재; 허용된 `model` (예: `xiaomi/*`) | 바이너리 없음 → 체인에서 제외 |
| `gemini-cli` | `gemini` 바이너리가 `PATH`에 존재 | 바이너리 없음 → 체인에서 제외 |
| `codex-cli` / `copilot-cli` / `qwen-cli` | 해당 CLI 바이너리가 `PATH`에 존재 | 바이너리 없음 → 체인에서 제외 |
| API providers (`anthropic`, `openai`, …) | 엔트리에 provider API 키 | 키 없음 → 체인에서 제외 |

**주의:** split 단계 체인(`MEMENTO_SPLIT_LLM_PRIMARY`/`MEMENTO_SPLIT_LLM_FALLBACKS`)이 설정됐으나 모든 provider의 의존성이 충족되지 않으면, 체인이 비어 파편마다 `no LLM provider available` 예외가 발생한다. `splitLongFragments`는 이를 파편별 catch로 처리하여 `memento_consolidate_split_skipped_total{reason="provider_error"}`를 증가시키고 `logWarn`을 남기며, `split_attempt_failed_at`을 기록하여 `failureBackoffHours` 동안 재시도를 차단한다. `provider_error` 시리즈가 지속적으로 0이 아니면 split 단계가 잘못 설정된 provider로 인해 사실상 비활성화된 것이다.

### 품질 게이트 설정 (`config/memory.js` → `fragmentSplit`)

| 키 | 기본값 | 설명 |
|-|-|-|
| `minChildLength` | 20 | 이 길이(자) 미만 자식 단편 폐기 |
| `excludeMetaTopics` | `["session_reflect","consolidation","reflection"]` | 분할 제외 topic 목록 |
| `failureBackoffHours` | 24 | 분할 실패 후 재선정 제외 시간 (무한 재분할 루프 차단) |

### `memento_consolidate_split_skipped_total` 카운터

split skip 건수를 `reason` 라벨별로 측정한다.

| reason | 의미 |
|-|-|
| `provider_error` | split 전용 체인이 비어 `dispatchChain` throw (키/바이너리 미충족) |
| `llm_error` | LLM 호출/파싱 기타 실패 |
| `low_yield` | 게이트 통과 자식 수 < `minItems` |
| `insert_shortfall` | insert 후 자식 수 < `minItems` (롤백됨) |
