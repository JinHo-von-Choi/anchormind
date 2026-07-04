# Configuration

---

## 환경 변수

### 서버

| 변수 | 기본값 | 설명 |
|------|--------|------|
| PORT | 57332 | HTTP 리슨 포트 |
| MEMENTO_ACCESS_KEY | (없음) | Bearer 인증 키. 미설정 시 서버는 "Authentication: DISABLED" 로그를 출력하고 모든 요청을 master 권한으로 처리한다. 명시적 비활성화 선언을 위해 `MEMENTO_AUTH_DISABLED=true`를 병기할 수 있다 |
| MEMENTO_AUTH_DISABLED | false | `true`로 설정 시 인증을 완전히 비활성화하여 모든 요청을 master 권한으로 처리. 개발/테스트 전용. `MEMENTO_ACCESS_KEY`가 비어 있을 때만 유효 |
| SESSION_TTL_MINUTES | 43200 | 세션 유효 시간 (분). 기본값 30일. 슬라이딩 윈도우 방식으로 도구 사용 시마다 갱신 |
| LOG_DIR | ./logs | Winston 로그 파일 저장 디렉토리 |
| ALLOWED_ORIGINS | (없음) | 허용할 Origin 목록. 쉼표로 구분. 미설정 시 모든 Origin 허용 (MCP 클라이언트 호환성 우선) |
| ADMIN_ALLOWED_ORIGINS | (없음) | Admin 콘솔 허용 Origin 목록. 미설정 시 모든 Origin 허용 |
| ENABLE_OPENAPI | false | `true`로 설정 시 `GET /openapi.json` 엔드포인트 활성화. 인증 레벨에 따라 다른 스펙 반환 (master key: 전체 경로 포함, API key: 권한 필터된 도구 목록) |
| RATE_LIMIT_WINDOW_MS | 60000 | Rate limiting 윈도우 크기 (ms) |
| RATE_LIMIT_MAX_REQUESTS | 120 | 윈도우 내 IP당 최대 요청 수 |
| RATE_LIMIT_PER_IP | 30 | IP당 분당 요청 한도 (미인증 요청) |
| RATE_LIMIT_PER_KEY | 100 | API 키당 분당 요청 한도 (인증된 요청) |
| CONSOLIDATE_INTERVAL_MS | 21600000 | 자동 유지보수(consolidate) 실행 간격 (ms). 기본 6시간 |
| EVALUATOR_MAX_QUEUE | 100 | MemoryEvaluator 큐 크기 상한 (초과 시 오래된 작업 드롭) |
| OAUTH_TRUSTED_ORIGINS | (없음) | OAuth redirect_uri 신뢰 도메인 추가 목록 (쉼표 구분, origin 단위). 기본 신뢰 도메인(claude.ai, chatgpt.com, platform.openai.com, copilot.microsoft.com, gemini.google.com)에 추가로 허용할 origin만 지정 |
| MCP_STRICT_ORIGIN | false | `true`로 설정 시 Origin 헤더 엄격 검증 활성화 (DNS rebinding 방어). 허용 목록(`OAUTH_TRUSTED_ORIGINS` + `ALLOWED_ORIGINS` + 기본 신뢰 도메인)에 없는 Origin에서 온 요청을 403으로 거부. Origin 헤더 없는 요청(CLI/curl)은 항상 허용. **opt-in** — 기본 `false`로 기존 동작 유지 |
| MCP_REJECT_NONAPIKEY_OAUTH | true | `false`로 설정 시 `is_api_key=false` OAuth 토큰 허용 (하위 호환). 기본 `true` — non-API-key OAuth 토큰은 `keyId=null` 세션을 생성하여 모든 파편에 master 권한으로 접근할 수 있으므로 차단. API 키 기반 OAuth 토큰(`is_api_key=true`)과 Bearer ACCESS_KEY 직접 사용은 영향 없음 |
| MCP_ALLOW_AUTO_DCR_REGISTER | false | `true`로 설정 시 `/authorize`에서 미등록 `client_id`의 자동 등록 허용 (기존 동작). 기본 `false` — RFC 7591 `POST /register` 엔드포인트 경유 강제 |
| OAUTH_ALLOWED_REDIRECT_URIS | (없음) | OAuth redirect_uri 정확 일치 허용 목록 (쉼표 구분). OAUTH_TRUSTED_ORIGINS와 별도로 동작 |
| DEFAULT_DAILY_LIMIT | 10000 | API 키 생성 시 기본 일일 호출 한도 |
| DEFAULT_PERMISSIONS | read,write | API 키 생성 시 기본 권한 |
| DEFAULT_FRAGMENT_LIMIT | (없음) | API 키 생성 시 기본 파편 할당량. 미설정 시 무제한 |
| DEDUP_BATCH_SIZE | 100 | 시맨틱 중복 제거 배치 크기 |
| DEDUP_MIN_FRAGMENTS | 5 | dedup 최소 파편 수. 이 수 미만이면 중복 제거를 건너뛴다 |
| COMPRESS_AGE_DAYS | 30 | 기억 압축 대상 비활성 일수 |
| COMPRESS_MIN_GROUP | 3 | 압축 그룹 최소 크기. 이 수 미만이면 압축하지 않는다 |
| RERANKER_MODEL | minilm | in-process 모드 ONNX 모델 선택. `minilm` (기본값, ~80MB, 영어 전용) 또는 `bge-m3` (~280MB, 다국어). **비영어권 사용자는 `bge-m3` 권장** — minilm은 영어 MS MARCO 데이터셋으로만 학습되어 한국어 등 비영어 파편 재순위화 품질이 저하됨. `RERANKER_ENABLED`는 별도 환경변수로 존재하지 않음. ONNX 모델 preload 성공 여부(또는 `RERANKER_URL` 설정 여부)로 자동 활성화된다 |
| FRAGMENT_DEFAULT_LIMIT | 5000 | 새 API 키 생성 시 기본 파편 할당량 (기본: 5000, NULL=무제한) |
| ENABLE_RECONSOLIDATION | false | ReconsolidationEngine 활성화. true 시 tool_feedback과 contradicts 감지 시 fragment_links weight/confidence를 동적 갱신한다 |
| ENABLE_SPREADING_ACTIVATION | false | SpreadingActivation 활성화. true 시 recall의 contextText 파라미터로 관련 파편을 선제적 활성화한다. 레이턴시 영향 측정 후 활성화 권장 |
| ENABLE_PATTERN_ABSTRACTION | false | 패턴 추상화 활성화. 데이터 충분 축적 후 활성화 예정 (현재 미구현) |
| MEMENTO_REMEMBER_ATOMIC | false | true 시 remember()의 quota check + INSERT를 단일 트랜잭션으로 원자화. BEGIN → api_keys FOR UPDATE(quota 재검증) → INSERT → COMMIT 순서로 TOCTOU를 완전 차단. false(기본)는 선제 quota check만 수행하며 동시 요청이 드문 환경에 적합 |
| MEMENTO_CASE_BACKPROP_ENABLED | false | true 시 CaseRewardBackprop 활성화. case verification 이벤트마다 증거 파편 importance를 자동 역전파. 비활성 시 호출 자체가 no-op(DB·메트릭 영향 0). DAG 일관성 베이스라인 확보 후 활성화 권장 |
| MEMENTO_STORAGE | pgvector | storage 어댑터 선택. `pgvector`(기본, PgVectorStore) 또는 `sqlite-vec`(SqliteVecStore). 변경 시 서버 재시작 필요 |
| MEMENTO_RECALL_MIN_SIM_FLOOR | (없음) | `SearchParamAdaptor.getMinSimilarity`가 반환하는 적응형 임계값에 옵트인 하한을 강제. 예: `0.45` 설정 시 학습값이 0.45 미만이어도 0.45 반환. 미설정 시 기존 동작 그대로 |
| MIGRATION_LINT_FROM | (없음) | `npm run lint:migrations` 검사 cutoff override. 지정 마이그레이션 번호 이후분만 검사. 미설정 시 전체 검사 |
| MEMENTO_MORPHEME_TOKENIZER | local | 형태소 토크나이저 경로 선택. `local`: garu-ko(한글)·natural PorterStemmer(영어)·@node-rs/jieba(중국어)·kuromoji(일본어) 로컬 CPU 분석기 사용(기본). `llm`: LLM 서브프로세스 경로(`MorphemeIndex._tokenizeViaLLM()`)로 전환. |
| MEMENTO_ENABLE_KUROMOJI | true | `false` 설정 시 kuromoji 일본어 분석기 로딩 생략. 일본어 파편이 없는 환경에서 상주 메모리 약 269MB 절감. `config/memory.js` `morphemeIndex.enableKuromoji`와 동기화됨. |

#### CLI 원격 접속

| 변수 | 기본값 | 설명 |
|------|--------|------|
| MEMENTO_CLI_REMOTE | (없음) | CLI `--remote` 플래그 미지정 시 사용할 원격 MCP 서버 URL. 예: `https://memento.anchormind.net/mcp` |
| MEMENTO_CLI_KEY | (없음) | CLI `--key` 플래그 미지정 시 사용할 원격 서버 인증용 API 키 |

#### Symbolic Memory (opt-in)

모든 플래그 기본 `false` / noop. 단계적 활성화는 CHANGELOG.md Symbolic Memory Migration Guide의 권장 순서를 따른다.

| 변수 | 기본값 | Phase | 설명 |
|------|--------|-------|------|
| MEMENTO_SYMBOLIC_ENABLED | false | 0 | 전체 symbolic 서브시스템 on/off (마스터 킬 스위치) |
| MEMENTO_SYMBOLIC_SHADOW | false | 1 | shadow mode: symbolic 결과를 기록만 하고 미적용 |
| MEMENTO_SYMBOLIC_CLAIM_EXTRACTION | false | 1 | RememberPostProcessor에서 ClaimExtractor 호출 |
| MEMENTO_SYMBOLIC_EXPLAIN | false | 2 | recall 응답 fragment에 `explanations: [{code, detail, ruleVersion}]` 필드 포함 (violations 있을 때만) |
| MEMENTO_SYMBOLIC_LINK_CHECK | false | 3 | LinkIntegrityChecker advisory 경로 활성화 |
| MEMENTO_SYMBOLIC_POLARITY_CONFLICT | false | 3 | ClaimConflictDetector advisory warning 기록 |
| MEMENTO_SYMBOLIC_POLICY_RULES | false | 4 | PolicyRules soft gating — `remember` 응답에 `validation_warnings: string[]` (violations 있을 때만 포함), DB 영속화 |
| MEMENTO_SYMBOLIC_CBR_FILTER | false | 5 | CaseRecall symbolic 필터 적용 |
| MEMENTO_SYMBOLIC_PROACTIVE_GATE | false | 6 | ProactiveRecall polarity gate |
| MEMENTO_SYMBOLIC_RULE_VERSION | v1 | - | 규칙 패키지 버전 식별자 (fragment_claims.rule_version 컬럼) |
| MEMENTO_SYMBOLIC_TIMEOUT_MS | 50 | - | SymbolicOrchestrator 단일 호출 timeout (ms) |
| MEMENTO_SYMBOLIC_MAX_CANDIDATES | 32 | - | symbolic 처리 대상 후보 수 상한 |

`api_keys.symbolic_hard_gate` 컬럼 (migration-033)으로 키 단위 hard gate 전환 가능. 기본 false. true로 설정 시 PolicyRules violations 발생 시 저장이 거부되고 JSON-RPC **프로토콜 레벨** 에러 `-32003`으로 응답한다 (MCP 도구 에러 아님 — `error.data.violations: string[]` 포함). 마스터 키(keyId=NULL) 제외. 캐시 TTL 30초.

#### LLM Provider Fallback Chain

Gemini CLI 외 15개 provider로 자동 fallback 가능. 기본값에서 기존 동작 완전 보존.

##### 기본 설정

| 변수 | 기본값 | 설명 |
|------|--------|------|
| LLM_PRIMARY | gemini-cli | 주 provider 이름. gemini-cli는 env 설정 불필요 |
| LLM_FALLBACKS | (없음) | JSON 배열. 각 원소에 provider/apiKey/model/baseUrl/timeoutMs/extraHeaders 지정 |

##### Circuit Breaker

| 변수 | 기본값 | 설명 |
|------|--------|------|
| LLM_CB_FAILURE_THRESHOLD | 5 | 연속 실패 허용 횟수. 초과 시 해당 provider OPEN 상태 전환 |
| LLM_CB_OPEN_DURATION_MS | 60000 | OPEN 지속 시간 (ms). 경과 후 자동 CLOSE |
| LLM_CB_FAILURE_WINDOW_MS | 60000 | 실패 카운트 윈도우 (ms) |

REDIS_ENABLED=true면 Redis에 상태 저장, 아니면 in-memory.

##### LLM 동시성 제어

| 변수 | 기본값 | 설명 |
|------|--------|------|
| LLM_CONCURRENCY_ENABLED | true | false 시 세마포어 우회. 모든 provider에 동시성 제한 없이 요청 |
| LLM_CONCURRENCY_WAIT_MS | 30000 | 슬롯 대기 타임아웃 (ms). 초과 시 요청 실패 |
| LLM_CONCURRENCY | (아래 기본값) | JSON 객체. chainKey(`provider|baseUrl|model`) 또는 provider 이름 기준 슬롯 한도 |

`LLM_CONCURRENCY` 기본값 (`DEFAULT_LLM_CONCURRENCY`):

```json
{
  "ollama": 16,
  "openai|https://token-plan-sgp.xiaomimimo.com/v1|mimo-v2-pro": 8,
  "gemini-cli": 1,
  "copilot-cli": 1,
  "codex-cli": 1,
  "qwen-cli": 1,
  "opencode-cli": 1
}
```

키가 없는 provider의 기본 슬롯 한도는 10이다. `LLM_CONCURRENCY` env 설정 시 기본값과 병합(merge)된다.

##### Token Usage Cap

| 변수 | 기본값 | 설명 |
|------|--------|------|
| LLM_TOKEN_BUDGET_INPUT | (없음) | 입력 토큰 상한. 설정 시 초과 요청 거부. 미설정 시 관측만 |
| LLM_TOKEN_BUDGET_OUTPUT | (없음) | 출력 토큰 상한 |
| LLM_TOKEN_BUDGET_WINDOW_SEC | 86400 | 리셋 주기 (초). 기본 1일 |

##### 지원 Provider 목록

gemini-cli, anthropic, openai, google-gemini-api, groq, openrouter, xai, ollama, vllm, deepseek, mistral, cohere, zai, **codex-cli**, **copilot-cli**, **qwen-cli**

**codex-cli**: `codex exec --skip-git-repo-check --sandbox read-only --output-last-message FILE` 명령을 실행한다. `OPENAI_API_KEY` 또는 Codex CLI 설정 파일로 인증한다. `LLM_FALLBACKS`의 `model`, `timeoutMs` 설정이 provider config를 통해 실제 CLI 호출까지 전달된다:
```json
[{"provider": "codex-cli", "model": "gpt-5.3-codex-spark"}]
```

**copilot-cli**: GitHub Copilot CLI(`gh copilot suggest`)를 래퍼로 호출한다. `gh` CLI와 Copilot 구독이 필요하다:
```json
[{"provider": "copilot-cli"}]
```

**qwen-cli**: Alibaba Cloud Qwen Code CLI(`qwen`)를 래퍼로 호출한다. Qwen CLI 인증 설정(`qwen auth`)이 필요하다. `LLM_FALLBACKS`의 `model`, `timeoutMs` 설정을 provider config로 전달하며, `model`까지 비어 있으면 CLI 기본 모델을 사용한다:
```json
[{"provider": "qwen-cli"}]
[{"provider": "qwen-cli", "model": "qwen-max"}]
```

**geminiTimeoutMs**: `config/memory.js`의 `morphemeIndex.geminiTimeoutMs` 기본값은 **60000ms**이다. Gemini CLI 및 Ollama Cloud 환경에서는 응답 지연이 20~40s에 달할 수 있어 "all LLM providers failed" 오류를 피하기 위해 이 값으로 설정되어 있다.

이 값은 `MEMENTO_MORPHEME_TOKENIZER=llm` 설정 시 `MorphemeIndex._tokenizeViaLLM()` 내부의 `geminiCLIJson(userPrompt, { timeoutMs: cfg.geminiTimeoutMs })` 호출에 전달된다. 기본값(`MEMENTO_MORPHEME_TOKENIZER=local`)에서는 로컬 분석기(MorphemeTokenizer)를 사용하므로 이 값은 참조되지 않는다. LLM 경로에서 tokenize가 실패하면 형태소 추출 결과가 없으므로 L3 morpheme 검색(recall의 전문 검색 경로)이 비활성화된 것과 동일하게 동작한다 (`_fallbackTokenize` 로 graceful degrade).

**GEMINI_TIMEOUT_MS**: `lib/memory/processors/AutoReflect.js`의 LLM chain 호출 timeout은 30,000 ms로 고정된다(`GEMINI_TIMEOUT_MS = 30_000` 코드 상수, `process.env` 참조 없음). 값을 변경하려면 해당 파일의 상수를 직접 수정해야 한다. MorphemeIndex의 `geminiTimeoutMs`(config/memory.js, 기본 60000)와 별개임에 주의한다.

**buildChain 순서 결정 로직** (`lib/llm/index.js:38–68`): `LLM_PRIMARY` → `LLM_FALLBACKS` 선언 순서로 entries 배열을 구성한 뒤, `seen` Set으로 중복 provider를 제거하고, 각 provider의 `isAvailable()` 체크 성공 여부로 chain에 포함 여부를 결정한다. `LLM_PRIMARY`가 `LLM_FALLBACKS` 목록에도 있으면 fallback의 config 객체가 우선 사용된다. `isAvailable()` 실패 시 해당 provider는 체인에서 제외되고 다음 provider로 즉시 넘어간다. 결과적으로 chain 순서는 환경변수 선언 순서와 1:1 대응한다.

자세한 운영 가이드는 `docs/operations/llm-providers.md` 참조.

#### OAuth 토큰 TTL

OAuth 토큰 TTL은 세션 TTL과 연동된다.

| 환경변수 | 기본값 | 설명 |
|----------|--------|------|
| OAUTH_TOKEN_TTL_SECONDS | 2592000 | OAuth 액세스 토큰 TTL (초). `SESSION_TTL_MINUTES * 60`으로 산출. 기본값 30일 |
| OAUTH_REFRESH_TTL_SECONDS | 5184000 | OAuth 리프레시 토큰 TTL (초). `OAUTH_TOKEN_TTL_SECONDS * 2`. 기본값 60일 |

슬라이딩 윈도우: OAuth 인증된 요청이 들어올 때마다 해당 액세스 토큰의 Redis TTL을 `OAUTH_TOKEN_TTL_SECONDS`로 재설정한다. 도구를 계속 사용하는 한 토큰이 만료되지 않는다.

#### SSE 연결

| 변수 | 기본값 | 설명 |
|------|--------|------|
| SSE_HEARTBEAT_INTERVAL_MS | 25000 | SSE heartbeat ping 전송 간격 (ms). 클라이언트 연결 유지 확인용 |
| SSE_MAX_HEARTBEAT_FAILURES | 3 | 연속 heartbeat 전송 실패 허용 횟수. 초과 시 세션 자동 종료. write backpressure 및 네트워크 오류 감지 |
| SSE_RETRY_MS | 5000 | SSE 재연결 대기 시간 (ms). 클라이언트 `retry:` 필드로 전달 |
| MCP_IDLE_REFLECT_HOURS | 24 | 세션 idle 중간 autoReflect 임계 시간 (시간). 이 시간 이상 비활성 상태인 세션에 주기 정리 시 중간 reflect를 실행하여 기억 손실을 방지. 0 설정 시 사실상 비활성화(단, 0h 초과 조건이므로 매 정리 주기마다 실행됨) |

### PostgreSQL

POSTGRES_* 접두어가 DB_* 접두어보다 우선한다. 두 형식을 혼용할 수 있다.

| 변수 | 설명 |
|------|------|
| POSTGRES_HOST / DB_HOST | 호스트 주소 |
| POSTGRES_PORT / DB_PORT | 포트 번호. 기본 5432 |
| POSTGRES_DB / DB_NAME | 데이터베이스 이름 |
| POSTGRES_USER / DB_USER | 접속 사용자 |
| POSTGRES_PASSWORD / DB_PASSWORD | 접속 비밀번호 |
| DB_MAX_CONNECTIONS | 연결 풀 최대 연결 수. 기본 20 |
| DB_IDLE_TIMEOUT_MS | 유휴 연결 반환 대기 시간 ms. 기본 30000 |
| DB_CONN_TIMEOUT_MS | 연결 획득 타임아웃 ms. 기본 10000 |
| DB_QUERY_TIMEOUT | 쿼리 타임아웃 ms. 기본 30000 |
| BATCH_DATABASE_URL | (없음, 선택) batchPool 전용 PostgreSQL URL. 미설정 시 기본 `DATABASE_URL`을 공유한다. batchPool은 multi-row INSERT 등 무거운 트랜잭션을 전용 풀에서 처리하여 recall 요청의 스타베이션을 방지한다. 풀 크기는 `primaryMax × 0.3`(최소 2)으로 결정되고, `application_name='memento-mcp:batch'`가 pg_stat_activity 분리 모니터링에 사용된다. 풀 크기와 application_name은 코드 내부에서 결정되며 환경변수로 override할 수 없다 |

### batch_remember 비동기 모드

`batch_remember` 도구의 `async=true` 요청은 Redis 큐(`memento:batch_remember_queue`)를 통해 비동기 처리된다.

| 항목 | 값 |
|-|-|
| 큐 키 | `memento:batch_remember_queue` |
| 워커 폴링 간격 | 1000ms |
| Redis 비활성 시 폴백 | 동기 모드로 자동 전환 |
| 자동 재처리 | 없음 (큐 유실 시 재처리 없음) |

이 기능은 `REDIS_ENABLED=true`일 때만 비동기로 동작한다. `REDIS_ENABLED=false` 환경에서는 `async=true` 파라미터를 전달해도 동기 모드로 처리된다.

### Redis

| 변수 | 기본값 | 설명 |
|------|--------|------|
| REDIS_ENABLED | false | Redis 활성화. false면 L1 검색과 캐싱이 비활성화 |
| REDIS_SENTINEL_ENABLED | false | Sentinel 모드 사용 |
| REDIS_HOST | localhost | Redis 서버 호스트 |
| REDIS_PORT | 6379 | Redis 서버 포트 |
| REDIS_PASSWORD | (없음) | Redis 인증 비밀번호 |
| REDIS_DB | 0 | Redis 데이터베이스 번호 |
| REDIS_MASTER_NAME | mymaster | Sentinel 마스터 이름 |
| REDIS_SENTINELS | localhost:26379, localhost:26380, localhost:26381 | Sentinel 노드 목록. 쉼표로 구분된 host:port 형식 |

### 캐싱

| 변수 | 기본값 | 설명 |
|------|--------|------|
| CACHE_ENABLED | REDIS_ENABLED 값과 동일 | 쿼리 결과 캐싱 활성화 |
| CACHE_DB_TTL | 300 | DB 쿼리 결과 캐시 TTL (초) |
| CACHE_SESSION_TTL | SESSION_TTL_MS / 1000 | 세션 캐시 TTL (초) |

### AI

| 변수 | 기본값 | 설명 |
|------|--------|------|
| OPENAI_API_KEY | (없음) | OpenAI API 키. `EMBEDDING_PROVIDER=openai` 시 사용 |
| EMBEDDING_PROVIDER | openai | 임베딩 provider. `openai` \| `gemini` \| `ollama` \| `localai` \| `cloudflare` \| `custom` \| `transformers` |
| EMBEDDING_API_KEY | (없음) | 범용 임베딩 API 키. 미설정 시 `OPENAI_API_KEY` 사용 |
| EMBEDDING_BASE_URL | (없음) | `EMBEDDING_PROVIDER=custom` 시 OpenAI 호환 엔드포인트 URL |
| EMBEDDING_MODEL | (provider 기본값) | 사용할 임베딩 모델. 생략 시 provider별 기본값 자동 적용 |
| EMBEDDING_DIMENSIONS | (provider 기본값) | 임베딩 벡터 차원 수. DB 스키마의 vector 차원과 일치해야 한다 |
| EMBEDDING_SUPPORTS_DIMS_PARAM | (provider 기본값) | dimensions 파라미터 지원 여부 override (`true`\|`false`) |
| GEMINI_API_KEY | (없음) | Google Gemini API 키. `EMBEDDING_PROVIDER=gemini` 시 사용 |
| CF_ACCOUNT_ID | (없음) | Cloudflare 계정 ID. `EMBEDDING_PROVIDER=cloudflare` 시 필수 |
| CF_API_TOKEN | (없음) | Cloudflare API 토큰. `EMBEDDING_PROVIDER=cloudflare` 시 필수 |

---

### 로컬 Transformers 임베딩

> API 키 없이 로컬에서 임베딩을 생성한다. `@huggingface/transformers` 라이브러리를 사용하며 GPU 없이 CPU만으로 동작한다.

```env
EMBEDDING_PROVIDER=transformers
EMBEDDING_MODEL=Xenova/multilingual-e5-small   # 기본값 (384차원, ~60MB)
# EMBEDDING_MODEL=Xenova/bge-m3                # 대안 (1024차원, ~280MB, 다국어 고정밀)
EMBEDDING_DIMENSIONS=384                        # 기본 스키마(1536)와 다른 경우 명시 필요
```

**주의**: API 기반 provider(openai, gemini 등)와 상호 배타적이다. 전환 시 DB 스키마를 변경해야 하며, 기존 임베딩과 차원이 다르면 검색 정밀도가 저하된다.

전환 절차:
```bash
# 1. 스키마 차원 변경 (기존 1536 → 384 예시)
EMBEDDING_DIMENSIONS=384 DATABASE_URL=$DATABASE_URL \
  node scripts/post-migrate-flexible-embedding-dims.js

# 2. 기존 파편 임베딩 재생성
DATABASE_URL=$DATABASE_URL node scripts/backfill-embeddings.js
```

서버 시작 시 `check-embedding-consistency.js`가 DB 벡터 차원과 `EMBEDDING_DIMENSIONS`의 일치 여부를 자동 검증한다. 불일치 시 프로세스를 중단하여 무결성을 보장한다.

상세 내용: [docs/embedding-local.md](embedding-local.md)

---

## MEMORY_CONFIG

`config/memory.js`에 정의된 설정 파일. 랭킹 가중치와 stale 임계값을 서버 코드 수정 없이 조정할 수 있다.

```js
export const MEMORY_CONFIG = {
  ranking: {
    importanceWeight        : 0.4,   // 시간-의미 복합 랭킹에서 중요도 가중치
    recencyWeight           : 0.3,   // 시간 근접도 가중치 (anchorTime 기준 지수 감쇠)
    semanticWeight          : 0.3,   // 시맨틱 유사도 가중치
    activationThreshold     : 0,     // 항상 복합 랭킹 적용
    recencyHalfLifeDays     : 30,    // 시간 근접도 반감기 (일)
    // MemoryRecaller 최종 정렬용 lexical 보정 — hard override 아님, 제한된 가산항.
    // lexWeight는 파편별 rerankerScore 유무로 결정한다.
    lexicalWeightReranked   : 0.12,  // rerankerScore 보유 파편의 lexical 미세 보정
    lexicalWeightFallback   : 0.18,  // rerankerScore 미보유 파편의 lexical 보강 (semanticWeight 0.30보다 명확히 낮게)
    lexicalLinkedMultiplier : 0.5,   // includeLinks 파편의 lexical 가중치 감쇠
    lexicalSaturation       : 8,     // lexicalMatchScore log 정규화 분모
    unrerankedBaseDiscount  : 0.85,  // rerankerScore 미보유 파편 base에 적용하는 페널티
  },
  staleThresholds: {
    procedure: 30,   // 절차 파편의 stale 기준 (일)
    fact      : 60,  // 사실 파편의 stale 기준 (일)
    decision  : 90,  // 결정 파편의 stale 기준 (일)
    default   : 60   // 나머지 유형의 stale 기준 (일)
  },
  halfLifeDays: {
    procedure : 30,  // 감쇠 반감기 — 중요도가 절반이 되는 기간 (일)
    fact      : 60,
    decision  : 90,
    error     : 45,
    preference: 120,
    relation  : 90,
    default   : 60
  },
  rrfSearch: {
    k             : 60,   // RRF 분모 상수. 값이 클수록 상위 랭크 의존도 완화
    l1WeightFactor: 2.0   // L1 Redis 결과에 곱하는 가중치 배수 (최우선 주입)
  },
  linkedFragmentLimit: 10,  // recall의 includeLinks 시 1-hop 연결 파편 최대 수
  embeddingWorker: {
    batchSize      : 10,      // 1회 처리 건수
    intervalMs     : 5000,    // 폴링 간격 (ms)
    retryLimit     : 3,       // 실패 시 재시도 횟수
    retryDelayMs   : 2000,    // 재시도 간격 (ms)
    queueKey       : "memento:embedding_queue"
  },
  contextInjection: {
    maxCoreFragments   : 15,     // Core Memory 최대 파편 수
    maxWmFragments     : 10,     // Working Memory 최대 파편 수
    typeSlots          : {       // 유형별 최대 슬롯
      preference : 5,
      error      : 5,
      procedure  : 5,
      decision   : 3,
      fact       : 3
    },
    defaultTokenBudget : 2000
  },
  pagination: {
    defaultPageSize : 20,
    maxPageSize     : 50
  },
  gc: {
    utilityThreshold       : 0.15,   // 이 값 미만 + 비활성 시 삭제 후보
    gracePeriodDays        : 7,      // 최소 생존 기간 (일)
    inactiveDays           : 60,     // 비활성 기간 (일)
    maxDeletePerCycle      : 50,     // 1회 최대 삭제 건수
    factDecisionPolicy     : {
      importanceThreshold  : 0.2,    // fact/decision GC 기준 중요도
      orphanAgeDays        : 30      // 고립 fact/decision 삭제 기준 (일)
    },
    errorResolvedPolicy    : {
      maxAgeDays           : 30,     // [해결됨] error 파편 삭제 기준 (일)
      maxImportance        : 0.3     // 이 값 미만이면 삭제 대상
    },
    splitChildPolicy: {
      maxImportance      : 0.3,  // split 자식이 이 importance 미만이면 GC 후보 (branch 1)
      orphanAgeDays      : 30,   // 생성 후 이 일수 경과 + 무접근 시 삭제 (branch 1)
      tombstonedGraceDays: 7     // 부모가 tombstone된 split 자식의 유예 일수 (branch 2)
    }
  },
  reflectionPolicy: {
    maxAgeDays       : 30,       // session_reflect 파편 삭제 기준 (일)
    maxImportance    : 0.3,      // 이 값 미만이면 삭제 대상
    keepPerType      : 5,        // type별 최신 N개 보존
    maxDeletePerCycle: 30        // 1회 최대 삭제 건수
  },
  semanticSearch: {
    minSimilarity: 0.2,          // L3 pgvector 검색 최소 유사도 (기본 0.2)
    limit        : 10            // L3 반환 최대 건수
  },
  temperatureBoost: {
    warmWindowDays     : 7,      // 이 기간 내 접근 파편에 warmBoost 적용
    warmBoost          : 0.2,    // 최근 접근 파편 점수 가산
    highAccessBoost    : 0.15,   // 접근 횟수 임계 초과 파편 점수 가산
    highAccessThreshold: 5,      // highAccessBoost 적용 기준 접근 횟수
    learningBoost      : 0.3    // learning_extraction 파편 점수 가산
  }
};
```

importanceWeight + recencyWeight + semanticWeight의 합은 1.0이어야 한다. halfLifeDays는 감쇠의 속도를 결정하며 staleThresholds와 독립적으로 동작한다. rrfSearch.k는 RRF 점수의 분모 안정화 상수로, 60이 일반 용도 기본값이다. gc.factDecisionPolicy는 fact/decision 유형의 고립 파편을 별도 기준으로 정리하여 검색 노이즈를 줄인다.

### proactiveRecall

`config/memory.js`의 `proactiveRecall` 블록 설정이다. remember() 직후 자동으로 관련 파편을 탐색하여 링크를 생성한다. caseIdPolicy와 keywordOverlapMin이 핵심 조건이다.

| 키 | ENV | 기본값 | 설명 |
|-|-|-|-|
| `mode` | `MEMENTO_PROACTIVE_RECALL_MODE` | `"auto"` | `"auto"`: 조건 충족 시 자동 실행. `"off"`: 비활성화 |
| `keywordOverlapMin` | `MEMENTO_PROACTIVE_KW_OVERLAP_MIN` | `0.5` | 키워드 중복 비율 하한. 저장 파편과 후보 파편 간 공통 키워드 비율이 이 값 이상이어야 링크 생성 대상이 됨 |
| `requireSameWorkspace` | — | `true` | workspace가 다른 파편은 ProactiveRecall 대상에서 제외 |
| `caseIdPolicy` | `MEMENTO_PROACTIVE_CASE_POLICY` | `"strict-or-adjacent"` | `"both-required"`: 두 파편 모두 동일 case_id 필요. `"strict-or-adjacent"`: 동일 case_id 또는 adjacencyWindowMs 이내 다른 케이스 허용. `"loose"`: case_id 불일치 시도 허용 |
| `adjacencyWindowMs` | — | `86400000` (24h) | `"strict-or-adjacent"` 정책에서 인접 케이스 허용 시간 범위 (ms) |
| `requireSameTopicOrType` | — | `false` | true 설정 시 topic 또는 type이 동일한 파편끼리만 링크 |

`proactive-gate.js` symbolic 게이트는 `workspace_mismatch`와 `case_policy` 차단 사유를 평가하며, `MEMENTO_SYMBOLIC_PROACTIVE_GATE=true` 환경변수로 활성화된다. proactiveRecall 블록의 caseIdPolicy와 keywordOverlapMin은 런타임 중 환경변수로 변경 가능하다 — 서버 재시작 없이 MEMENTO_PROACTIVE_CASE_POLICY 값을 갱신하면 다음 호출부터 즉시 반영된다. proactiveRecall 비활성화는 mode를 `"off"`로 설정한다.

### consolidate.schemaFit

MemoryConsolidator 자동 실행 전 충분한 변경 누적 여부를 평가하는 게이트 조건이다.

| 키 | 기본값 | 설명 |
|-|-|-|
| `pendingCaseFragmentsMin` | `5` | 미처리 케이스 파편이 이 수 이상이면 조건 충족 |
| `recentRelatedLinksMin` | `20` | 최근 생성된 related 링크가 이 수 이상이면 조건 충족 |
| `fragmentsSinceLastRunMin` | `30` | 마지막 실행 이후 새 파편 수가 이 수 이상이면 조건 충족 |
| `mode` | `"any"` | `"any"`: 3개 조건 중 1개 이상 충족 시 실행. `"all"`: 3개 모두 충족 시 실행. `"off"`: 게이트 비활성화(항상 실행). ENV: `MEMENTO_CONSOLIDATE_GATE_MODE` |

consolidateIntervalMs(기본 6h = 21600000ms) 주기 타이머가 실행될 때마다 이 게이트를 평가한다. 게이트 미통과 시 해당 실행 주기를 건너뛴다. `consolidateIntervalMs`는 `CONSOLIDATE_INTERVAL_MS` 환경변수로 제어한다. proactiveRecall의 caseIdPolicy와 달리 schemaFit.mode는 런타임 변경이 반영되지 않으며 서버 재시작이 필요하다.

### consolidate.enableRiskyStages

LLM 재작성이 수반되어 파편 내용을 변경할 수 있는 3개 stage의 개별 활성화 플래그다.

| 키 | ENV | 기본값 | 해당 stage | 설명 |
|-|-|-|-|-|
| `splitLongFragments` | `MEMENTO_CONSOLIDATE_SPLIT_LONG` | `true` | stage 5 | 긴 파편을 2~3개 원자 파편으로 분할. LLM으로 분할 경계 결정 |
| `detectContradictions` | `MEMENTO_CONSOLIDATE_DETECT_CONTRADICT` | `true` | stage 14 | NLI + LLM 하이브리드 모순 감지 및 contradicts 링크 생성 |
| `compressOldFragments` | `MEMENTO_CONSOLIDATE_COMPRESS_OLD` | `false` | stage 8 | 오래된 파편 그룹을 LLM으로 압축 요약. 기본 비활성 |

플래그가 `false`인 stage는 실행 시 `status: "skipped"` 이벤트를 emit하고 다음 stage로 진행한다. `compressOldFragments`는 원본 파편 내용을 변경하므로 기본값이 `false`다.

### fragmentSplit

`splitLongFragments` stage의 세부 동작을 제어한다. `config/memory.js`의 `fragmentSplit` 블록에서 설정한다.

| 키 | 기본값 | 설명 |
|-|-|-|
| `lengthThreshold` | `300` | 이 길이(자) 초과 파편을 분할 후보로 선정 |
| `batchSize` | `10` | 한 사이클에 처리할 최대 파편 수 |
| `minItems` | `2` | LLM이 최소 이 수 이상 항목으로 분리해야 원본 대체 |
| `maxItems` | `8` | LLM에 요청할 최대 분리 항목 수 |
| `timeoutMs` | `30000` | 파편당 LLM 타임아웃 (ms) |
| `minChildLength` | `20` | 이 길이 미만 자식 단편은 품질 게이트에서 폐기 |
| `excludeMetaTopics` | `["session_reflect","consolidation","reflection"]` | 분할 제외 topic 목록 |
| `failureBackoffHours` | `24` | 분할 실패 후 이 시간 동안 재선정 제외 (`split_attempt_failed_at` 컬럼, migration-036) |

분할 자식 품질 게이트(`split-gate.js`): 최소 길이(`minChildLength`) 미달·대체 문자(`�`) 포함·CJK/가나 혼입(한글 본문 기준)·대명사/메타 시작 토큰이면 reject. fact 타입 자식의 importance가 클램프 후 0.4 미만이면 저장 차단.

Phase 1(gate-only)에서 통과 자식 수 < `minItems`이면 DB insert 없이 해당 파편의 `split_attempt_failed_at`을 갱신하고 `memento_consolidate_split_skipped_total{reason="low_yield"}`를 증가시킨다. 분할 성공 시 원본은 `valid_to = NOW()`, `ttl_tier = 'cold'`, `importance = GREATEST(0.2, importance × 0.3)` 처리된다.

### SearchParamAdaptor (자동 검색 파라미터 학습)

SearchParamAdaptor는 별도 환경변수 없이 자동으로 동작한다. `config/memory.js`의 `semanticSearch.minSimilarity` 값을 기본값으로 사용하며, 50회 이상 검색 후 key_id x query_type x hour 조합별로 학습된 값으로 대체된다.

| 하드코딩 상수 | 값 | 설명 |
|-------------|-----|------|
| MIN_SAMPLE | 50 | 학습 적용 최소 샘플 수 |
| CLAMP_MIN | 0.10 | minSimilarity 하한 |
| CLAMP_MAX | 0.60 | minSimilarity 상한 |
| step | 0.01 | 조정 보폭 (대칭) |

학습 데이터는 `agent_memory.search_param_thresholds` 테이블에 저장된다 (migration-029).

### 런타임 검증

`config/validate-memory-config.js`가 서버 시작 시 `MEMORY_CONFIG`의 구조적 정합성을 1회 검증한다. 검증 실패 시 에러를 throw하여 서버 시작을 중단한다.

검증 항목:
- `ranking` 가중치(importanceWeight + recencyWeight + semanticWeight) 합계 = 1.0
- `contextInjection.rankWeights` 합계 = 1.0
- `semanticSearch.minSimilarity`, `morphemeIndex.minSimilarity`, `gc.utilityThreshold`는 0~1 범위
- `halfLifeDays` 모든 항목은 양수
- `gc.gracePeriodDays` < `gc.inactiveDays`
- `embeddingWorker.batchSize`, `embeddingWorker.intervalMs`, `pagination.defaultPageSize`, `pagination.maxPageSize`, `gc.maxDeletePerCycle`는 양의 정수

---

## 임베딩 Provider 전환

`EMBEDDING_PROVIDER` 환경변수 하나로 provider를 전환할 수 있다. model, dimensions, base URL은 provider 기본값으로 자동 결정되며, 필요 시 개별 환경변수로 override 가능하다.

임베딩은 L3 시맨틱 검색과 자동 링크 생성에 사용된다.

> 차원 변경 시 주의: `EMBEDDING_DIMENSIONS`를 바꾸면 PostgreSQL 스키마도 변경해야 한다. `node scripts/post-migrate-flexible-embedding-dims.js`와 `node scripts/backfill-embeddings.js`를 순서대로 실행할 것.

---

### OpenAI (기본값)

```env
EMBEDDING_PROVIDER=openai
OPENAI_API_KEY=sk-...
```

| 모델 | 차원 | 특징 |
|------|------|------|
| text-embedding-3-small | 1536 | 기본값. 비용 효율적 |
| text-embedding-3-large | 3072 | 고정밀. 비용 2배 |
| text-embedding-ada-002 | 1536 | 레거시 호환 |

---

### Google Gemini

`text-embedding-004`는 2026년 1월 14일 종료. 현재 권장 모델은 `gemini-embedding-001` (3072차원)이다.

```env
EMBEDDING_PROVIDER=gemini
GEMINI_API_KEY=AIza...
```

3072차원은 기본 스키마(1536)와 다르므로 최초 전환 시 migration-007 실행 필요:

```bash
EMBEDDING_DIMENSIONS=3072 DATABASE_URL=$DATABASE_URL \
  node scripts/post-migrate-flexible-embedding-dims.js
DATABASE_URL=$DATABASE_URL node scripts/backfill-embeddings.js
```

> halfvec 타입은 pgvector 0.7.0 이상에서 지원한다. 버전 확인: `SELECT extversion FROM pg_extension WHERE extname = 'vector';`

| 모델 | 차원 | 특징 |
|------|------|------|
| gemini-embedding-001 | 3072 | 현행 권장 모델. 고정밀 |
| text-embedding-004 | 768 | 2026-01-14 종료 |

---

### Ollama (로컬)

Ollama가 `http://localhost:11434`에서 실행 중이어야 한다.

```env
EMBEDDING_PROVIDER=ollama
# EMBEDDING_MODEL=nomic-embed-text  # 기본값
```

```bash
# 모델 다운로드
ollama pull nomic-embed-text
ollama pull mxbai-embed-large
```

| 모델 | 차원 | 특징 |
|------|------|------|
| nomic-embed-text | 768 | 8192 토큰 컨텍스트, MTEB 고성능 |
| mxbai-embed-large | 1024 | 512 컨텍스트, 경쟁력 있는 MTEB 점수 |
| all-minilm | 384 | 초경량, 로컬 테스트에 적합 |

---

### LocalAI (로컬)

```env
EMBEDDING_PROVIDER=localai
```

---

### Cloudflare Workers AI

Cloudflare Workers AI의 OpenAI 호환 엔드포인트를 사용한다. `CF_ACCOUNT_ID`로 base URL을 자동 구성한다.

```env
EMBEDDING_PROVIDER=cloudflare
CF_ACCOUNT_ID=your_account_id
CF_API_TOKEN=your_api_token
# EMBEDDING_MODEL=@cf/baai/bge-small-en-v1.5  # 기본값
```

Cloudflare 대시보드 → 계정 홈 우측 하단에서 Account ID 확인. API 토큰은 "Workers AI" 권한으로 생성.

384차원은 기본 스키마(1536)와 다르므로 최초 전환 시 migration-007 실행 필요:

```bash
EMBEDDING_DIMENSIONS=384 DATABASE_URL=$DATABASE_URL \
  node scripts/post-migrate-flexible-embedding-dims.js
DATABASE_URL=$DATABASE_URL node scripts/backfill-embeddings.js
```

| 모델 | 차원 | 특징 |
|------|------|------|
| @cf/baai/bge-small-en-v1.5 | 384 | 기본값. 경량, 빠름 |
| @cf/baai/bge-base-en-v1.5 | 768 | 균형형 |
| @cf/baai/bge-large-en-v1.5 | 1024 | 고정밀 |

> dimensions 파라미터 미지원. 모델 변경 시 `EMBEDDING_MODEL`과 `EMBEDDING_DIMENSIONS`를 함께 지정할 것.

---

### 커스텀 OpenAI 호환 서버

LM Studio, llama.cpp 등 임의의 OpenAI 호환 서버를 사용할 때 지정한다.

```env
EMBEDDING_PROVIDER=custom
EMBEDDING_BASE_URL=http://my-server:8080/v1   # 포트는 환경에 따라 조정
EMBEDDING_API_KEY=my-key
EMBEDDING_MODEL=my-model
EMBEDDING_DIMENSIONS=1024
```

---

### 상용 API (커스텀 어댑터 필요)

Cohere, Voyage AI, Mistral, Jina AI, Nomic은 OpenAI SDK와 호환되지 않거나 별도의 API 구조를 가진다. `lib/tools/embedding.js`의 `generateEmbedding` 함수를 아래 예시로 교체한다.

#### Cohere

```bash
npm install cohere-ai
```

```js
// lib/tools/embedding.js — generateEmbedding 교체
import { CohereClient } from "cohere-ai";

const cohere = new CohereClient({ token: process.env.COHERE_API_KEY });

export async function generateEmbedding(text) {
  const res = await cohere.v2.embed({
    model:          "embed-v4.0",
    inputType:      "search_document",
    embeddingTypes: ["float"],
    texts:          [text]
  });
  return normalizeL2(res.embeddings.float[0]);
}
```

```env
COHERE_API_KEY=...
EMBEDDING_DIMENSIONS=1536
```

| 모델 | 차원 | 특징 |
|------|------|------|
| embed-v4.0 | 1536 | 최신, 다국어 지원 |
| embed-multilingual-v3.0 | 1024 | 레거시 다국어 |

---

#### Voyage AI

```js
// lib/tools/embedding.js — generateEmbedding 교체
export async function generateEmbedding(text) {
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method:  "POST",
    headers: {
      "Authorization": `Bearer ${process.env.VOYAGE_API_KEY}`,
      "Content-Type":  "application/json"
    },
    body: JSON.stringify({ model: "voyage-3.5", input: [text] })
  });
  const data = await res.json();
  return normalizeL2(data.data[0].embedding);
}
```

```env
VOYAGE_API_KEY=...
EMBEDDING_DIMENSIONS=1024
```

| 모델 | 차원 | 특징 |
|------|------|------|
| voyage-3.5 | 1024 | 최고 정확도 |
| voyage-3.5-lite | 512 | 저비용, 빠름 |
| voyage-code-3 | 1024 | 코드 특화 |

---

#### Mistral AI

OpenAI SDK 호환이므로 `baseURL`만 교체하면 된다.

```js
// lib/tools/embedding.js — generateEmbedding 교체
import OpenAI from "openai";

const client = new OpenAI({
  apiKey:  process.env.MISTRAL_API_KEY,
  baseURL: "https://api.mistral.ai/v1"
});

export async function generateEmbedding(text) {
  const res = await client.embeddings.create({
    model: "mistral-embed",
    input: [text]
  });
  return normalizeL2(res.data[0].embedding);
}
```

```env
MISTRAL_API_KEY=...
EMBEDDING_DIMENSIONS=1024
```

---

#### Jina AI

무료 플랜: 100 RPM / 1M 토큰/월.

```js
// lib/tools/embedding.js — generateEmbedding 교체
export async function generateEmbedding(text) {
  const res = await fetch("https://api.jina.ai/v1/embeddings", {
    method:  "POST",
    headers: {
      "Authorization": `Bearer ${process.env.JINA_API_KEY}`,
      "Content-Type":  "application/json"
    },
    body: JSON.stringify({
      model: "jina-embeddings-v3",
      task:  "retrieval.passage",
      input: [text]
    })
  });
  const data = await res.json();
  return normalizeL2(data.data[0].embedding);
}
```

```env
JINA_API_KEY=...
EMBEDDING_DIMENSIONS=1024
```

| 모델 | 차원 | 특징 |
|------|------|------|
| jina-embeddings-v3 | 1024 | MRL 지원 (32~1024 유동 차원) |
| jina-embeddings-v2-base-en | 768 | 영어 특화 |

---

#### Nomic

무료 플랜: 월 1M 토큰. OpenAI SDK 호환이므로 `baseURL` 변경으로 적용 가능하다.

```js
// lib/tools/embedding.js — generateEmbedding 교체
import OpenAI from "openai";

const client = new OpenAI({
  apiKey:  process.env.NOMIC_API_KEY,
  baseURL: "https://api-atlas.nomic.ai/v1"
});

export async function generateEmbedding(text) {
  const res = await client.embeddings.create({
    model: "nomic-embed-text-v1.5",
    input: [text]
  });
  return normalizeL2(res.data[0].embedding);
}
```

```env
NOMIC_API_KEY=...
EMBEDDING_DIMENSIONS=768
```

---

### 서비스 비교

| 서비스 | 차원 | 설정 방법 | 무료 플랜 |
|--------|------|-----------|-----------|
| OpenAI text-embedding-3-small | 1536 | `EMBEDDING_PROVIDER=openai` | 없음 |
| OpenAI text-embedding-3-large | 3072 | `EMBEDDING_PROVIDER=openai` | 없음 |
| Google Gemini gemini-embedding-001 | 3072 | `EMBEDDING_PROVIDER=gemini` | 있음 (제한적) |
| Ollama (nomic-embed-text) | 768 | `EMBEDDING_PROVIDER=ollama` | 완전 무료 (로컬) |
| Ollama (mxbai-embed-large) | 1024 | `EMBEDDING_PROVIDER=ollama` | 완전 무료 (로컬) |
| LocalAI | 가변 | `EMBEDDING_PROVIDER=localai` | 완전 무료 (로컬) |
| Cloudflare Workers AI (bge-small) | 384 | `EMBEDDING_PROVIDER=cloudflare` | 있음 (10K req/일) |
| Cloudflare Workers AI (bge-large) | 1024 | `EMBEDDING_PROVIDER=cloudflare` | 있음 (10K req/일) |
| 커스텀 호환 서버 | 가변 | `EMBEDDING_PROVIDER=custom` | — |
| Cohere embed-v4.0 | 1536 | 코드 교체 | 없음 |
| Voyage AI voyage-3.5 | 1024 | 코드 교체 | 없음 |
| Mistral mistral-embed | 1024 | 코드 교체 | 없음 |
| Jina jina-embeddings-v3 | 1024 | 코드 교체 | 있음 (1M/월) |
| Nomic nomic-embed-text-v1.5 | 768 | 코드 교체 | 있음 (1M/월) |

---

## 마이그레이션

`npm run migrate`로 미적용 마이그레이션을 순서대로 실행한다. `schema_migrations` 테이블에서 이력을 관리하며, 이미 적용된 마이그레이션은 건너뛴다.

| 번호 | 파일 | 설명 |
|------|------|------|
| 001 | migration-001-temporal.sql | Temporal (valid_from/valid_to, searchAsOf) |
| 002 | migration-002-decay.sql | 지수 감쇠 (last_decay_at) |
| 003 | migration-003-api-keys.sql | api_keys + api_key_usage 테이블 |
| 004 | migration-004-key-isolation.sql | fragments.key_id 컬럼 (API 키 기반 기억 격리) |
| 005 | migration-005-gc-columns.sql | GC 정책 인덱스 (utility_score, access_count) |
| 006 | migration-006-superseded-by-constraint.sql | fragment_links CHECK에 superseded_by 추가 |
| 007 | migration-007-link-weight.sql | fragment_links.weight 컬럼 |
| 008 | migration-008-morpheme-dict.sql | 형태소 사전 테이블 (morpheme_dict) |
| 009 | migration-009-co-retrieved.sql | fragment_links CHECK에 co_retrieved 추가 |
| 010 | migration-010-ema-activation.sql | fragments.ema_activation/ema_last_updated 컬럼 |
| 011 | migration-011-key-groups.sql | key groups (그룹별 파편 공유) |
| 012 | migration-012-quality-verified.sql | quality_verified |
| 013 | migration-013-search-events.sql | search_events 테이블 |
| 014 | migration-014-ttl-short.sql | TTL 단기 계층 |
| 015 | migration-015-created-at-index.sql | created_at 인덱스 |
| 016 | migration-016-agent-topic-index.sql | agent/topic 인덱스 |
| 017 | migration-017-episodic.sql | episodic 타입 (1000자, context_summary, session_id) |
| 018 | migration-018-fragment-quota.sql | fragment quota (기본 5000개) |
| 019 | migration-019-hnsw-tuning.sql | HNSW ef_construction 128, ef_search=80 |
| 020 | migration-020-search-layer-latency.sql | search_events 레이어 레이턴시 컬럼 |
| 021 | migration-021-oauth-clients.sql | OAuth clients 테이블 |
| 022 | migration-022-temporal-link-type.sql | temporal 링크 타입 CHECK 제약 |
| 023 | migration-023-link-weight-float.sql | fragment_links.weight real 타입 (float 가중치) |
| 024 | migration-024-workspace.sql | fragments.workspace VARCHAR(255) NULL |
| 025 | migration-025-case-id-episode.sql | fragments에 case_id + structured episode 컬럼 |
| 026 | migration-026-case-events.sql | case_events + case_event_edges + fragment_evidence 테이블 |
| 027 | migration-027-v25-reconsolidation-episode-spreading.sql | search_events/case_events key_id 타입, fragment_links 재통합 컬럼 + link_reconsolidations 테이블, case_events idempotency_key, fragments.keywords GIN 인덱스 |
| 028 | migration-028-v253-improvements.sql | (agent_id, topic, created_at DESC) 복합 인덱스, (key_id, agent_id, importance DESC) WHERE valid_to IS NULL 부분 인덱스. search_events.rrf_used·fragments.superseded_by 컬럼 제거 |
| 029 | migration-029-search-param-thresholds.sql | search_param_thresholds 테이블 (SearchParamAdaptor 온라인 학습 저장소) |
| 030 | migration-030-search-param-thresholds-key-text.sql | search_param_thresholds.key_id 타입을 fragments.key_id와 동일한 TEXT로 통일. sentinel 값은 문자열 '-1'로 저장 |
| 031 | migration-031-content-hash-per-key.sql | content_hash partial unique index 2개로 크로스 테넌트 ON CONFLICT 경로 차단. master(key_id IS NULL) 전용 `uq_frag_hash_master`, API key(key_id IS NOT NULL) 전용 복합 `uq_frag_hash_per_key` |
| 032 | migration-032-fragment-claims.sql | Symbolic Memory Layer fragment_claims 테이블 |
| 033 | migration-033-symbolic-hard-gate.sql | api_keys.symbolic_hard_gate BOOLEAN (symbolic hard gate opt-in) |
| 034 | migration-034-v2.16.0-bundle.sql | api_keys.default_mode TEXT NULL (Mode preset 키 단위 기본값), fragments.affect TEXT DEFAULT 'neutral' CHECK 6-enum, fragments.idempotency_key TEXT NULL + partial UNIQUE 2종 |
| 035 | migration-035-morpheme-indexed.sql | fragments.morpheme_indexed BOOLEAN NOT NULL DEFAULT false + 부분 인덱스, 기존 파편 백필 |
| 036 | migration-036-split-attempt-failed-at.sql | `fragments.split_attempt_failed_at TIMESTAMPTZ NULL` 컬럼 + partial index. splitLongFragments 분할 실패 backoff에 사용 |
| 037 | migration-037-hnsw-index-rename.sql | HNSW 인덱스명 정합화 (idx_frag_embedding), ef_construction=128 적용 |

---

## Mode Preset 설정

세션 동작 범위를 preset으로 고정한다. 3가지 경로로 설정할 수 있으며, 우선순위는 아래와 같다.

1. **요청별 헤더** (최우선): `X-Memento-Mode: <preset>`
2. **initialize 파라미터**: `{ "method": "initialize", "params": { "mode": "<preset>" } }`
3. **키 단위 기본값** (admin console): `api_keys.default_mode` 컬럼 (migration-034)

| Preset | 설명 | excluded_tools 대표 예 | 권장 사용 맥락 |
|--------|------|------------------------|----------------|
| `recall-only` | 읽기 전용. 쓰기 도구 차단 | remember, batch_remember, amend, forget, link, reflect, memory_consolidate | 읽기 권한만 부여된 공유 API 키, 조회 전용 대시보드 연동 |
| `write-only` | 쓰기 전용. 검색 도구 차단 | recall, context, reconstruct_history, graph_explore, fragment_history, search_traces, memory_stats | CI/크론 잡에서 결과만 기록할 때. 불필요한 조회 도구 노출 없이 토큰 소비 최소화 |
| `onboarding` | 신규 사용자 안내. 모든 도구 노출 + 초심자 가이드 주입 | (없음 — excluded_tools: []) | 파편 수 50개 이하일 때 자동 진입. 50개 초과 시 일반 모드로 자동 전환 |
| `audit` | 감사/컴플라이언스. master key 전용. 쓰기 전체 차단 | remember, batch_remember, amend, forget, link, reflect | 운영 감사, 히스토리 재구성, 메모리 통계 조회 전용. `requiresMaster: true` |

각 preset의 `fixed_tools`(명시 노출 목록), `skill_guide_override`(도구 안내 오버라이드), `requiresMaster` 필드는 `lib/memory/modes/<preset>.json`에 정의되어 있다.

Mode가 미지정이거나 NULL이면 RBAC 기반 기존 권한 체계만 적용된다.

참조: [API Reference — Mode Preset](api-reference.md#mode-preset), [SKILL.md](../SKILL.md)

---

## MCP 연결 설정

### 토큰 기반 세션 재사용

클라이언트가 `Mcp-Session-Id` 없이 재연결하더라도 동일한 Bearer 토큰이면 서버가 기존 세션을 자동으로 복구한다. 세션 ID를 분실하거나 네트워크 단절 후 재연결하는 경우에 유용하다.

- 클라이언트 측에 투명하게 동작: 별도 설정 불필요
- 복구 시 keyId, groupKeyIds, workspace, permissions 등 세션 컨텍스트가 보존된다
- 토큰 TTL 내에서만 유효 (`OAUTH_TOKEN_TTL_SECONDS` 기준)

---

## 테스트

### 전체 테스트 (DB 불필요)
```bash
npm test          # Jest (tests/*.test.js) + node:test (tests/unit/*.test.js) 순차 실행. tests/unit/은 node:test 전용이며 Jest에서 제외된다.
```

개별 실행:
```bash
npm run test:jest        # Jest — tests/*.test.js
npm run test:unit:node   # node:test — tests/unit/*.test.js
npm run test:integration # node:test — tests/integration/*.test.js + tests/e2e/*.test.js
```

### E2E 테스트 (PostgreSQL 필요)

로컬 Docker 환경 (권장):
```bash
npm run test:e2e:local   # docker-compose로 테스트 DB 기동 후 실행
```

기존 DB 연결 사용:
```bash
DATABASE_URL=postgresql://user:pass@host:port/db npm run test:e2e
```

### CI 전체 (DB 필요)
```bash
npm run test:ci          # npm test + test:e2e
```

---

## 관련 문서

- [로컬 임베딩 설정](embedding-local.md) — `EMBEDDING_PROVIDER=transformers` 상세 전환 절차
- [통합/E2E 테스트](../tests/integration/README.md) — 테스트 환경 구성 및 실행 방법
- [API Reference](api-reference.md) — MCP 도구 파라미터 및 Mode preset 상세
- [아키텍처](architecture.md) — 컴포넌트 의존성 및 DB 스키마
