# Configuration

---

## 환경 변수

### 허용 범위

숫자, 열거, 불리언 환경 변수가 받는 값이다. 숫자가 아니거나 범위 밖인 값의 처리는 `MEMENTO_CONFIG_STRICT` 행을 따른다. 표에 대체 값이 적힌 변수는 범위 밖일 때 그 값을 쓴다.

| 허용 범위 | 변수 |
|-|-|
| 0 이상의 정수 | CACHE_DB_TTL, CACHE_SESSION_TTL, DB_CONN_TIMEOUT_MS, DB_IDLE_TIMEOUT_MS, DB_QUERY_TIMEOUT, DB_STATEMENT_TIMEOUT_MS, EMBEDDING_MAX_RETRIES, EMBEDDING_SEM_WAIT_MS, HEADERS_TIMEOUT_MS, KEEP_ALIVE_TIMEOUT_MS, LLM_CB_OPEN_DURATION_MS, LLM_CHAIN_TIMEOUT_MS, LLM_CONCURRENCY_WAIT_MS, LLM_PROVIDER_TIMEOUT_MS, LLM_TOKEN_BUDGET_INPUT, LLM_TOKEN_BUDGET_OUTPUT, QUOTA_NEAR_LIMIT_MARGIN, REDIS_DB, REQUEST_TIMEOUT_MS, RERANKER_EXTERNAL_COOLDOWN_MS, SSE_RETRY_MS, TRUST_PROXY_HOPS |
| 0 이상의 숫자 | MCP_IDLE_REFLECT_HOURS, UPDATE_CHECK_INTERVAL_HOURS |
| 1 이상의 정수 | DEFAULT_DAILY_LIMIT, DEFAULT_FRAGMENT_LIMIT, FRAGMENT_DEFAULT_LIMIT, EMBEDDING_CONCURRENCY, EMBEDDING_DIMENSIONS, EMBEDDING_TIMEOUT_MS, LLM_CB_FAILURE_THRESHOLD, LLM_CB_FAILURE_WINDOW_MS, LLM_TOKEN_BUDGET_WINDOW_SEC, NLI_TIMEOUT_MS, RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_PER_IP, RATE_LIMIT_PER_KEY, RATE_LIMIT_WINDOW_MS, RERANKER_TIMEOUT_MS, SESSION_TTL_MINUTES, SSE_MAX_HEARTBEAT_FAILURES |
| 2 이상의 정수 | DB_MAX_CONNECTIONS |
| 1000 이상의 정수 | SSE_HEARTBEAT_INTERVAL_MS |
| 1 이상 65535 이하의 정수 | POSTGRES_PORT, DB_PORT, REDIS_PORT |
| 0 이상 65535 이하의 정수 | PORT |
| 0 이상의 정수, 그 밖은 기본값 | MEMENTO_SHUTDOWN_DEADLINE_MS (60000), MEMENTO_SESSION_KEY_RECHECK_MS (30000), MEMENTO_DCR_MAX_PER_HOUR (100), MEMENTO_SCORE_UPDATE_BATCH (200, 10000을 넘으면 10000) |
| 100 이상 4500 이하의 정수, 그 밖은 2000 | MEMENTO_HEALTH_READY_DB_TIMEOUT_MS |
| 1 이상의 숫자, 그 밖은 `SESSION_TTL_MINUTES * 60` | OAUTH_ACCESS_TOKEN_TTL_SECONDS |
| 0 이상 1 이하의 숫자 (1을 넘으면 1, 음수와 숫자가 아닌 값은 0) | MEMENTO_DECAY_MIN_DELTA, MEMENTO_UTILITY_MIN_DELTA |
| off, warn, enforce (그 밖의 값은 enforce로 동작) | MEMENTO_TOOL_ARGS_VALIDATION |
| warn, enforce (그 밖의 값은 warn) | MEMENTO_SESSION_ID_POLICY, MEMENTO_RESERVED_AGENT_IDS, MEMENTO_OAUTH_REDIRECT_CHECK |
| reflect, observe, allowlist (그 밖의 값은 observe) | MEMENTO_CORS_MODE |
| allow, deny (그 밖의 값은 allow) | MEMENTO_SSE_QUERY_KEY |
| deny (그 밖의 값은 헤더를 붙이지 않음) | MEMENTO_FRAME_OPTIONS |
| 401, 503 (그 밖의 값은 401) | MEMENTO_AUTH_STORE_UNAVAILABLE_STATUS |
| inner, outer (그 밖의 값은 inner) | MEMENTO_SEMANTIC_THRESHOLD_MODE |
| none, all (그 밖의 값은 none) | MEMENTO_LLM_CLI_TOOL_APPROVAL |
| true, false (그 밖의 값은 false) | MEMENTO_CONFIG_STRICT |
| true, false (그 밖의 값은 `MEMORY_CONFIG` 검증에서 기동 실패) | MEMENTO_AUTO_PROMOTE_ANCHORS (true) |
| on, off (그 밖의 값은 off) | MEMENTO_ADMIN_AUTH_BACKOFF |
| true, false (false가 아닌 값은 true) | MEMENTO_API_KEY_DELETE_GUARD, MEMENTO_ALLOW_LEGACY_UNBOUND_AGENT_SCOPE, LLM_CONCURRENCY_ENABLED, MCP_REJECT_NONAPIKEY_OAUTH |
| true, false (true가 아닌 값은 false) | MEMENTO_REMEMBER_DUPLICATE_GUARD, MEMENTO_REMEMBER_ATOMIC, MEMENTO_WORKSPACE_GATE, MEMENTO_TOOL_ARGS_ALLOW_UNKNOWN, ENABLE_RECONSOLIDATION, ENABLE_SPREADING_ACTIVATION, UPDATE_REQUIRE_SIGNED_TAG, MEMENTO_AUTH_DISABLED, REDIS_ENABLED, REDIS_SENTINEL_ENABLED, MEMENTO_REDIS_SESSION_FAIL_CLOSED, EMBEDDING_SUPPORTS_DIMS_PARAM, MEMENTO_RERANKER_ENABLED, MEMENTO_CASE_BACKPROP_ENABLED, UPDATE_CHECK_DISABLED, ENABLE_OPENAPI, MCP_ALLOW_AUTO_DCR_REGISTER, MCP_STRICT_ORIGIN |
| true, false (true가 아닌 값은 REDIS_ENABLED 값) | CACHE_ENABLED |

### 스위치 보고

기능 스위치의 이름, 문서 기본값, 용도, 분류는 `config/switches.js`의 레지스트리에 있다. 환경을 주면 스위치마다 실제로 적용되는 값을 계산한다. 판독 규칙은 사용처와 같고, 잘못된 값은 사용처가 적용하는 값으로 표시한다.

- 표 출력: `npm run switches`(`node scripts/switch-report.mjs`)가 스위치, 적용 값, 기본값, 상태, 기본과 다름, 분류, 예외 분류, 용도를 마크다운 표로 출력한다. 프로세스 환경만 읽고 `.env` 파일은 읽지 않는다. 특정 환경 기준으로 보려면 그 환경 변수를 셸에 올린 뒤 실행한다(`set -a; . <.env 경로>; set +a; npm run switches`). 키, 토큰, 주소를 담는 변수는 레지스트리에 없고, 잘못된 원본 값은 출력하지 않는다.
- 상태 칸: `on`과 `off`는 기능이 켜졌는지 꺼졌는지다. `mode`는 켜고 끄는 값이 아니라 방식을 고르는 열거(`MEMENTO_CORS_MODE` 등)다. 값이 잘못된 스위치는 "기본과 다름" 칸에 `값 오류`로 적고, 적용 값 칸에는 사용처가 쓰는 값을 적는다.
- 관리 API: `GET /v1/internal/model/nothing/stats` 응답의 `switches`에 `total`, `on`, `off`, `mode`, `nonDefaultCount`, `nonDefault`(기본과 다른 스위치 이름), `invalid`(값이 잘못된 스위치 이름)가 있다. 값은 담지 않는다.
- 기동 로그: `[Startup] switches: total=N on=N off=N mode=N nonDefault=N (이름=on|off|열거 값, ...) invalid=N (이름, ...)` 한 줄을 기록한다.
- 새 스위치: `envBool`, `envEnum`으로 읽는 불리언과 열거 변수는 레지스트리에 항목을 추가하고 `.env.example`, 이 문서, 영문판에 적는다. `tests/unit/switch-ledger-structure.test.js`가 빠진 항목을 실패로 알린다. 기능 개폐가 아니라 방식만 고르는 변수는 그 시험의 제외 목록에 이유와 함께 둔다.

### 서버

| 변수 | 기본값 | 설명 |
|------|--------|------|
| PORT | 57332 | HTTP 리슨 포트 |
| MEMENTO_ACCESS_KEY | (없음) | Bearer 인증 키. 미설정 상태로는 서버가 기동하지 않고 종료 코드 78로 멈춘다. 인증 없이 운용하려면 `MEMENTO_AUTH_DISABLED=true`를 함께 지정해야 한다 |
| MEMENTO_AUTH_DISABLED | false | `true`로 설정 시 인증을 완전히 비활성화하여 모든 요청을 master 권한으로 처리. 개발·시험 전용이며 이 선언이 없으면 키 없는 기동 자체가 거부된다. `MEMENTO_ACCESS_KEY`가 비어 있을 때만 유효 |
| DB_STATEMENT_TIMEOUT_MS | 30000 | 사용자 요청 경로의 질의 시간 상한(ms). 0은 무제한. system·admin 유지보수 경로에는 적용하지 않는다 |
| REQUEST_TIMEOUT_MS | 60000 | 요청 수신 상한(ms). 0은 무제한 |
| MEMENTO_CONFIG_STRICT | false | 숫자·열거·불리언 환경 변수의 값 문제를 기동 시 한 줄로 기록한다. 숫자가 아닌 값은 기본값으로 돌아가고, 정수가 아니거나 허용 범위 밖인 값은 그대로 쓰며 기록만 한다(`MEMENTO_HEALTH_READY_DB_TIMEOUT_MS`, `MEMENTO_SHUTDOWN_DEADLINE_MS`, `MEMENTO_SCORE_UPDATE_BATCH`, `MEMENTO_SESSION_KEY_RECHECK_MS`는 범위 밖이어도 기본값). 공백만 있는 값은 미설정과 같다. `true`면 문제가 있을 때 종료 코드 78로 멈춘다 |
| KEEP_ALIVE_TIMEOUT_MS | 75000 | Keep-Alive 연결 유지 시간(ms). 프록시 설정과 맞춘다 |
| HEADERS_TIMEOUT_MS | 76000 | 요청 헤더 수신 상한(ms). KEEP_ALIVE_TIMEOUT_MS보다 크게 둔다 |
| LOG_LEVEL | info (NODE_ENV가 production이 아니면 debug) | winston 로그 레벨 |
| COMPRESSION_LEVEL | 6 | gzip 압축 레벨(0~9) |
| MIN_COMPRESS_SIZE | 1024 | 이 바이트 미만 응답은 압축하지 않는다 |
| MEMENTO_ROTATE_RATE_LIMIT_PER_MIN | 5 | /session/rotate의 IP당 분당 호출 상한 |
| MEMENTO_SPLIT_LLM_PRIMARY / MEMENTO_SPLIT_LLM_FALLBACKS | (없음) | 장문 분할 전용 LLM 체인. 미설정 시 전역 체인 사용 |
| MEMENTO_VECTOR_FORCE_INDEX | (적용) | `off`면 벡터 검색의 인덱스 강제 planner 힌트를 끈다 |
| MEMENTO_SEMANTIC_THRESHOLD_MODE | inner | `outer`면 시맨틱 검색이 이웃 max(limit, 80)개를 먼저 고르고 유사도 임계값을 바깥에서 적용한다 |
| MEMENTO_SCORE_UPDATE_BATCH | 200 | 감쇠와 utility 갱신을 id 오름차순 묶음으로 나눌 때의 묶음 크기. 0이면 단일 UPDATE 문장. 0 이상의 정수만 받고(음수와 정수 아님은 기본값) 10000을 넘으면 10000으로 줄인다. `forget`의 `linked_to` 정리는 이 값과 무관하게 항상 id 오름차순으로 잠근다 |
| MEMENTO_DECAY_MIN_DELTA | 0 | 감쇠량이 이 값보다 작은 행을 건너뛴다. 마지막 감쇠 후 24시간이 지난 행은 항상 갱신(하한 0.05에 닿은 행은 이 상한 때문에 대략 네 번에 한 번 다시 쓰인다). 숫자가 아니거나 음수인 값은 0으로 처리하고 경고를 남기며 1을 넘는 값은 1로 제한한다. `MEMENTO_SCORE_UPDATE_BATCH`가 0이면 적용하지 않는다 |
| MEMENTO_UTILITY_MIN_DELTA | 0 | 저장값과의 차이가 이 값 이하인 utility_score를 다시 쓰지 않는다. 숫자가 아니거나 음수인 값은 0으로 처리하고 경고를 남기며 1을 넘는 값은 1로 제한한다. `MEMENTO_SCORE_UPDATE_BATCH`가 0이면 적용하지 않는다 |
| MEMENTO_RUNTIME | (없음) | `docker`면 Docker 설치로 판정한다 |
| GITHUB_TOKEN | (없음) | 업데이트 확인 시 GitHub API 인증 토큰 |
| WORKER_ID | single | health 응답의 workerId 표기 |
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
| MEMENTO_AUTO_PROMOTE_ANCHORS | true | `false`이면 consolidate의 자동 앵커 승격 stage만 건너뜀. 기존 앵커와 다른 stage는 불변 |
| EVALUATOR_MAX_QUEUE | 100 | MemoryEvaluator 큐 크기 상한 (초과 시 오래된 작업 드롭) |
| OAUTH_TRUSTED_ORIGINS | (없음) | OAuth redirect_uri 신뢰 도메인 추가 목록 (쉼표 구분, origin 단위). 기본 신뢰 도메인(claude.ai, chatgpt.com, platform.openai.com, copilot.microsoft.com, gemini.google.com)에 추가로 허용할 origin만 지정 |
| MCP_STRICT_ORIGIN | false | `true`로 설정 시 Origin 헤더 엄격 검증 활성화 (DNS rebinding 방어). 허용 목록(`OAUTH_TRUSTED_ORIGINS` + `ALLOWED_ORIGINS` + 기본 신뢰 도메인)에 없는 Origin에서 온 요청을 403으로 거부. Origin 헤더 없는 요청(CLI/curl)은 항상 허용. **opt-in** — 기본 `false`로 기존 동작 유지 |
| MEMENTO_CORS_MODE | observe | `ALLOWED_ORIGINS` 미설정 시 교차 출처 응답 방식. `reflect`: 요청 Origin을 그대로 돌려준다. `observe`(기본): `reflect`와 응답이 같고 처음 본 Origin을 `[CORS] cross-origin request from` 로그로 프로세스당 256건까지 남긴다. `allowlist`: 기본 신뢰 도메인과 `OAUTH_TRUSTED_ORIGINS`에 있는 Origin에만 `Access-Control-Allow-Origin`을 붙인다. Origin이 있는 응답에는 `Vary: Origin`이 붙는다. `ALLOWED_ORIGINS`가 설정되면 모드와 무관하게 목록이 우선한다. 호출 시점에 읽으므로 재시작 없이 바뀐다 |
| MEMENTO_FRAME_OPTIONS | (없음) | `deny`로 설정 시 모든 응답에 `X-Frame-Options: DENY`를 붙인다. 미설정이거나 다른 값이면 붙이지 않는다. `X-Content-Type-Options: nosniff`와 `Referrer-Policy: no-referrer`는 모든 응답에 항상 붙는다 |
| MEMENTO_OAUTH_REDIRECT_CHECK | warn | `/authorize` 오류 응답의 리다이렉트 대상 확인. `warn`(기본): 등록되지 않은 `redirect_uri`로 이동시키되 `error redirect target not registered` 경고를 대상 호스트만 담아 남긴다. `enforce`: 그 경우 이동 대신 400 JSON을 준다. `redirect_uri`가 없거나 URL이 아니면 두 모드 모두 400 JSON을 준다 |
| MEMENTO_SSE_QUERY_KEY | allow | Legacy SSE의 `?accessKey=` 쿼리 키 처리. `allow`(기본): 마스터 키 한정으로 받는다. `deny`: 받지 않고 `Authorization` 헤더 사용을 안내하는 401을 준다. 쿼리 값은 프록시 접근 로그에 남는다 |
| MCP_REJECT_NONAPIKEY_OAUTH | true | 기본 `true`는 `is_api_key=false` OAuth 토큰 인증을 거부한다. `false`는 해당 인증만 허용하며 master 권한을 부여하지 않는다. API 키 바인딩이 없는 OAuth 세션의 도구 호출은 `-32001`로 거부된다. API 키 기반 OAuth 토큰(`is_api_key=true`)과 Bearer ACCESS_KEY 직접 사용은 영향 없음 |
| MEMENTO_AUTH_STORE_UNAVAILABLE_STATUS | 401 | `api_keys` 조회 실패로 인증을 판정하지 못한 MCP `initialize`와 세션 자동 복구의 응답 상태. `401`(기본)은 키 무효와 같은 응답이며 세션 복구는 404다. `503`은 `Retry-After: 10`을 붙인 일시 장애 응답이다. 마스터 키 인증은 저장소와 무관하다. 조회 실패는 `mcp_auth_store_errors_total{operation}`과 `memento_auth_denied_total{reason="store_unavailable"}`로 집계한다 |
| MEMENTO_SESSION_ID_POLICY | warn | MCP 세션 ID 수신 처리. `warn`(기본): 쿼리스트링(`?sessionId=`, `?mcp-session-id=`)으로 받은 ID와 서버 발급 형식(UUID)이 아닌 ID의 자동 복구를 `[Session] session id received in query string`, `recovery requested for non-issued id format` 경고로 기록하고 정상 처리한다. `enforce`: 쿼리 ID는 400, UUID가 아닌 ID의 복구는 404로 응답한다. 헤더(`MCP-Session-Id`)로 보낸 UUID 세션은 두 값 모두 영향이 없다. 로그와 reflect 프롬프트의 세션 ID는 앞 8자만 표기한다. `warn` 기간에 클라이언트가 정한 ID로 복구된 세션은 `enforce`로 바꾼 뒤에도 만료될 때까지 계속 동작한다. Legacy `/message?sessionId=`는 프로토콜 요구라 대상이 아니다 |
| MCP_ALLOW_AUTO_DCR_REGISTER | false | `true`로 설정 시 `/authorize`에서 신뢰 목록(기본 신뢰 도메인, `OAUTH_TRUSTED_ORIGINS`, `OAUTH_ALLOWED_REDIRECT_URIS`, localhost)에 없는 `redirect_uri`를 가진 미등록 `client_id`의 자동 등록을 허용한다. 기본 `false`는 그 경우 `invalid_client`로 거부하고 RFC 7591 `POST /register` 경유를 요구한다. 신뢰 목록에 있는 `redirect_uri`는 이 값과 무관하게 자동 등록된다 |
| OAUTH_ALLOWED_REDIRECT_URIS | (없음) | OAuth redirect_uri 정확 일치 허용 목록 (쉼표 구분). OAUTH_TRUSTED_ORIGINS와 별도로 동작 |
| MEMENTO_DCR_MAX_PER_HOUR | 100 | `/register` 시간당 등록 상한 (프로세스 단위 고정 창). 유효한 API 키를 Bearer로 제시한 등록(키에 묶인 등록)과 그 밖의 등록은 같은 상한값을 쓰되 따로 센다. 초과하면 429와 `Retry-After`(현재 창이 끝나기까지 남은 초, 올림, 최소 1). `0`이면 상한 없음. 호출 시점에 읽는다 |
| DEFAULT_DAILY_LIMIT | 10000 | API 키 생성 시 기본 일일 호출 한도 |
| DEFAULT_PERMISSIONS | read,write | API 키 생성 시 기본 권한 |
| DEFAULT_FRAGMENT_LIMIT | (없음) | API 키 생성 시 기본 파편 할당량. 미설정 시 무제한 |
| FRAGMENT_DEFAULT_LIMIT | 5000 | 1 이상의 정수. 값을 읽어 기동 시 검사하지만 처리에는 쓰이지 않는다. API 키 생성의 기본 할당량은 `DEFAULT_FRAGMENT_LIMIT`이 정한다 |
| DEDUP_BATCH_SIZE | 100 | 시맨틱 중복 제거 배치 크기 |
| DEDUP_MIN_FRAGMENTS | 5 | dedup 최소 파편 수. 이 수 미만이면 중복 제거를 건너뛴다 |
| COMPRESS_AGE_DAYS | 30 | 기억 압축 대상 비활성 일수 |
| COMPRESS_MIN_GROUP | 3 | 압축 그룹 최소 크기. 이 수 미만이면 압축하지 않는다 |
| MEMENTO_RERANKER_ENABLED | false | in-process 교차 인코더 리랭커 활성화. 기본은 비활성이다. 기본 모델이 영어 전용이라 한국어 코퍼스에서는 끄는 쪽이 낫다. 절제 실험 기준 Recall@1 74%에서 85%, MRR 0.827에서 0.890, p50 561ms에서 126ms로 개선된다. `RERANKER_URL`로 지정한 외부 리랭커는 이 스위치와 무관하게 동작한다 |
| RERANKER_MODEL | minilm | in-process 리랭커가 활성일 때 쓰는 ONNX 모델. `minilm` (기본값, ~80MB, 영어 전용) 또는 `bge-m3` (~280MB, 다국어). bge-m3는 비영어 판정이 훨씬 낫지만 CPU에서 30건 재정렬에 수 초가 걸리므로 GPU 기반 외부 서비스 뒤에서만 쓴다 |
| RERANKER_EXTERNAL_FALLBACK | skip | external 리랭커 3회 연속 실패 시 정책. `skip`(기본): in-process 전환 없이 `RERANKER_EXTERNAL_COOLDOWN_MS` 동안 external 호출 자체를 생략하고 원점수(RRF 순서)를 그대로 반환. `inprocess`: ONNX in-process 모드로 전환(opt-in, 이전 동작) |
| RERANKER_TIMEOUT_MS | 5000 | 외부 리랭커 호출 타임아웃(ms) |
| NLI_SERVICE_URL | (없음) | 외부 NLI 서비스 URL. 미설정 시 in-process ONNX |
| NLI_TIMEOUT_MS | 5000 | 외부 NLI 호출 타임아웃(ms) |
| RERANKER_EXTERNAL_COOLDOWN_MS | 60000 | `RERANKER_EXTERNAL_FALLBACK=skip`일 때의 쿨다운 유지 시간(ms). 창 만료 후 다음 recall이 external을 1건 재시도하며, 성공 시 정상 복귀·실패 시 쿨다운 재진입 |
| QUOTA_NEAR_LIMIT_MARGIN | 10 | `QuotaChecker.check()`가 FOR UPDATE 정밀 검사로 전환하는 잔여 할당량 임계치. `remaining`이 이 값 이하일 때만 트랜잭션 락을 획득하며, 그 이상이면 10초 TTL 캐시(getUsage) 결과로 락 없이 통과한다 |
| ENABLE_RECONSOLIDATION | false | ReconsolidationEngine 활성화. true 시 tool_feedback과 contradicts 감지 시 fragment_links weight/confidence를 동적 갱신한다 |
| ENABLE_SPREADING_ACTIVATION | false | SpreadingActivation 활성화. true 시 recall의 contextText 파라미터로 관련 파편을 선제적 활성화한다. 레이턴시 영향 측정 후 활성화 권장 |
| ENABLE_PATTERN_ABSTRACTION | (미사용) | 패턴 추상화 예약 변수. 현재 코드에서 읽지 않으므로 설정해도 동작에 영향이 없다 |
| MEMENTO_METRICS_DEFAULT | (없음) | `off`로 설정하면 prom-client 기본 메트릭(CPU·메모리 등) 수집을 생략한다. 그 외 값은 수집 활성 |
| MEMENTO_ADMIN_AUTH_BACKOFF | `off` | `on`이면 관리 인증이 연속 5회 실패한 뒤 이어지는 실패마다 다음 시도를 1, 2, 4초 순으로 최대 60초까지 늦춘다. 지연 중에는 올바른 마스터 키도 지연 시간 동안 `POST /auth`와 관리 API 경로에서 429(Retry-After)를 받는다. 관리 UI 셸과 이미지 경로는 지연 중에도 계속 401을 돌려준다. 이미 발급된 쿠키 세션은 영향받지 않는다. 관리 경로에 일반 API 키 등 마스터 키가 아닌 Bearer를 보내 실패한 요청도 실패로 센다. 마지막 실패로부터 60초 동안 실패가 없으면 누적이 새로 시작되고, 인증에 성공해도 지워진다. 실패 기록은 이 값과 무관하게 남고 상태는 프로세스 메모리에 있다 |
| MEMENTO_ADMIN_METRICS_SAMPLING | (없음) | `off`로 설정하면 admin 콘솔 메트릭 샘플링을 비활성화한다. 그 외 값은 샘플링 활성 |
| UPDATE_CHECK_DISABLED | false | `true`로 설정 시 신규 버전 확인을 수행하지 않는다 |
| UPDATE_CHECK_INTERVAL_HOURS | 24 | 신규 버전 확인 주기(시간) |
| UPDATE_REQUIRE_SIGNED_TAG | false | `true`로 설정 시 git 설치본 업데이트의 install 단계에 `git verify-tag <대상 태그>`가 checkout 앞에 추가된다. 서명 확인에 실패하면 업데이트가 중단된다 |
| TRUST_PROXY_HOPS | (없음) | 신뢰하는 리버스 프록시 hop 수. `X-Forwarded-For` 체인의 오른쪽에서 이 수번째 항목을 클라이언트 주소로 채택하고, `0`이면 헤더를 무시하고 소켓 주소를 쓴다. 미설정 시 기존 동작(첫 항목 사용)이며, 이 상태에서 `X-Forwarded-For`를 처음 받으면 `[Proxy]` 경고를 프로세스당 한 번 남기고 관리 `/stats`의 `healthFlags`에 `trust_proxy_hops_unset`이 더해진다. 기동 시 운영 권장 설정 중 빠진 이름은 `[Startup] Recommended settings not applied:` 한 줄로 나열한다. 실제 프록시 단수와 정확히 일치시켜야 하며, 실제보다 크게 잡으면 클라이언트가 보낸 값이 채택된다. 단일 nginx 뒤에서는 `1` |
| MEMENTO_TOOL_ARGS_VALIDATION | warn | tools/call 인자를 도구의 inputSchema와 대조하는 모드. `off`: 점검 생략, `warn`: 위반을 `[ToolArgs]` 경고 로그(호출자 표기 `key=`, `sid=` 앞 8자, `ua=` 앞 64자 포함)로만 남기고 통과, `enforce`: 위반 시 JSON-RPC `-32602`로 거부. 호출 시점에 읽으므로 재시작 없이 바뀐다 |
| MEMENTO_TOOL_ARGS_ALLOW_UNKNOWN | false | `true`로 설정 시 스키마에 없는 필드를 위반으로 세지 않는다. `enforce` 모드에서 별칭 필드를 쓰는 클라이언트를 수용할 때 쓴다 |
| MEMENTO_LLM_CLI_ENV_PASSTHROUGH | (없음) | CLI provider(gemini-cli, codex-cli, copilot-cli, qwen-cli, agy-cli, opencode-cli) 자식 프로세스에 추가로 전달할 환경변수 이름(쉼표 구분). 기본으로는 PATH, HOME 등 기본 변수와 CLI별 인증 변수만 전달된다 |
| MEMENTO_LLM_CLI_TOOL_APPROVAL | none | gemini-cli, copilot-cli, opencode-cli의 도구 실행 승인 방식(`none`, `all`). 호출 시점에 읽으며 그 밖의 값은 `none`으로 처리하고 설정 문제로 기록한다. `none`: gemini는 `-y`를 붙이지 않고, copilot은 `--deny-tool=shell`, `--deny-tool=write`, `--deny-tool=url`, `--disable-builtin-mcps`, `--no-custom-instructions`를 더하며(비대화형 실행에 필요한 `--allow-all-tools`는 유지, 거부 규칙이 항상 우선), opencode는 `OPENCODE_PERMISSION={"*":"deny"}`를 넘기고, gemini는 임시 디렉터리를 신뢰 작업 공간으로 지정하는 `GEMINI_CLI_TRUST_WORKSPACE=true`를 자식 환경에 더한다. 세 CLI 모두 서버 작업 디렉터리가 아닌 빈 임시 디렉터리에서 실행한다(opencode의 `--dir`는 호출자가 지정한 `cwd`가 우선). `all`: gemini `-y`, copilot `--allow-all-tools`만 쓰고 opencode는 승인 관련 설정을 더하지 않으며 서버 작업 디렉터리에서 실행한다. gemini-cli, copilot-cli, opencode-cli를 쓰는 배포는 기본에서 제한된 호출을 받고, `all`로 설정하면 승인 제한이 없는 호출을 쓴다. codex-cli, qwen-cli, agy-cli에는 적용되지 않는다 |
| MEMENTO_REMEMBER_ATOMIC | false | true 시 remember()의 quota check + INSERT를 단일 트랜잭션으로 원자화. BEGIN → api_keys FOR UPDATE(quota 재검증) → INSERT → COMMIT 순서로 TOCTOU를 완전 차단. false(기본)는 선제 quota check만 수행하며 동시 요청이 드문 환경에 적합 |
| MEMENTO_REMEMBER_DUPLICATE_GUARD | false | `true`면 remember 중복 적중 시 기존 파편에 후처리, TTL 조정, 재색인을 하지 않고 `existing`, `duplicate`(same_scope, other_workspace, closed, unknown)로 알린다. 동일한 저장 두 건이 경합하면 먼저 들어간 행이 삽입의 충돌 경로에서 importance가 더 큰 값으로 올라가고 접근 시각이 갱신될 수 있다 |
| MEMENTO_API_KEY_DELETE_GUARD | true | API 키 삭제 전에 그 키의 파편과 재공고화 이력을 확인하고, 있으면 409로 거부한다. `false`면 확인 없이 삭제 |
| MEMENTO_CASE_BACKPROP_ENABLED | false | true 시 CaseRewardBackprop 활성화. case verification 이벤트마다 증거 파편 importance를 자동 역전파. 비활성 시 호출 자체가 no-op(DB·메트릭 영향 0). DAG 일관성 베이스라인 확보 후 활성화 권장 |
| MEMENTO_STORAGE | pgvector | 저장소 백엔드 이름. 현재 `pgvector` 하나이며 이 값은 동작에 영향을 주지 않는다. |
| MEMENTO_KEYWORD_SEMANTIC_FALLBACK | true | `false` 설정 시 text 없는 keywords-only recall의 L3 시맨틱 보조 경로를 비활성화. 활성 시 정규화된 keywords 합성 텍스트 임베딩 1회가 L2와 병렬 수행되어 저장 keywords에 없는 용어도 content 기반으로 회수된다 |
| MEMENTO_KEYWORD_FALLBACK_TIMEOUT_MS | 1500 | keywords 보조 L3 실행 상한(ms, 100~60000 클램프). 초과 시 빈 결과로 대체하고 searchPath에 `L3kw:timeout`을 남긴다 |
| MEMENTO_CONTEXT_ANCHOR_LIMIT | 20 | context 응답에 항상 포함되는 앵커(isAnchor) 파편의 전체 최대 개수. 종전 기본값 10에서 20으로 변경되었다. 1~30 범위로 클램프되며 파싱 실패 시 20. 앵커는 tokenBudget 절삭 대상이 아니므로 이 개수 상한이 유일한 주입량 제한이다. 종전 주입량이 필요하면 10으로 설정한다 |
| MEMENTO_CONTEXT_WORKSPACE_ANCHOR_RESERVE | 10 | effective workspace가 있는 context에서 해당 workspace의 importance 상위 anchor에 먼저 예약할 슬롯 수. 미설정 시 total/2를 내림한 값(최대 10)으로 유도되므로 기본 total 20에서는 10, total 10에서는 5다. 명시값은 0 이상 total 이하여야 하며 잘못된 값은 서버 기동 검증에서 실패한다. workspace가 없으면 적용하지 않는다 |
| MEMENTO_RECALL_MIN_SIM_FLOOR | (없음) | `SearchParamAdaptor.getMinSimilarity`가 반환하는 적응형 임계값에 옵트인 하한을 강제. 예: `0.45` 설정 시 학습값이 0.45 미만이어도 0.45 반환. 미설정 시 기존 동작 그대로 |
| MIGRATION_LINT_FROM | (없음) | `npm run lint:migrations` 검사 cutoff override. 지정 마이그레이션 번호 이후분만 검사. 미설정 시 전체 검사 |
| MEMENTO_MORPHEME_TOKENIZER | local | 형태소 토크나이저 경로 선택. `local`: garu-ko(한글)·natural PorterStemmer(영어)·@node-rs/jieba(중국어)·kuromoji(일본어) 로컬 CPU 분석기 사용(기본). `llm`: LLM 서브프로세스 경로(`MorphemeIndex._tokenizeViaLLM()`)로 전환. |
| MEMENTO_ENABLE_KUROMOJI | true | `false` 설정 시 kuromoji 일본어 분석기 로딩 생략. 일본어 파편이 없는 환경에서 상주 메모리 약 269MB 절감. `config/memory.js` `morphemeIndex.enableKuromoji`와 동기화됨. |
| MEMENTO_FEEDBACK_SAMPLING | true | remember·amend·forget 성공 응답에 `feedback_sampled` 힌트를 확률적으로 동봉(`config/memory.js` `feedback.sampling.enabled`). `false` 시 힌트 부착 자체를 생략한다 |
| MEMENTO_SPLIT_SUBJECT_GATE | true | 분할 자식이 부모의 주어 앵커를 하나도 담지 못하면 해당 자식을 폐기(`fragmentSplit.requireSubjectAnchor`). `false` 시 주어 검사를 건너뛴다 |
| MEMENTO_SPLIT_MODALITY_GATE | true | 분할 자식이 부모에 없던 양상(예정·의도·추측·당위)을 도입하면 해당 자식을 폐기(`fragmentSplit.rejectIntroducedModality`). `false` 시 양상 검사를 건너뛴다 |

#### workspace 스코프 & 세션 세그먼트

| 변수 | 기본값 | 설명 |
|------|--------|------|
| MEMENTO_WORKSPACE_DECAY | true | `false` 시 workspace 랭킹 감쇠를 비활성화한다. 활성 시 검색 scope에 workspace가 지정되면 불일치·전역(NULL) 파편의 랭킹 점수에 감쇠 배율을 적용한다(반환 자체는 유지). recall과 context 주입 경로 공통 적용 |
| MEMENTO_WORKSPACE_DECAY_PENALTY | 0.7 | workspace 불일치·전역 파편 랭킹 점수에 곱하는 감쇠 배율(0~1) |
| MEMENTO_SESSION_SEGMENT | true | `false` 시 세션 세그먼트 회전을 비활성화하고 전송계층 세션 ID를 그대로 사용한다 |
| MEMENTO_SESSION_KEY_RECHECK_MS | 30000 | 세션 사용 시 API 키 상태를 다시 읽는 주기(ms). 비활성 또는 삭제된 키의 세션은 닫히고 권한 변경은 열린 세션에 반영된다. `0`이면 재확인하지 않는다. 0 이상의 정수만 받고 그 밖은 기본값이다 |
| MEMENTO_SEGMENT_IDLE_MS | 2700000 | 세션 유휴 시간이 이 값(ms)을 초과하면 다음 도구 호출 시 세그먼트를 회전한다. 기본 45분 |
| MEMENTO_SEGMENT_MAX_AGE_MS | 43200000 | 세그먼트 시작 후 이 값(ms)을 초과하면 유휴 여부와 무관하게 세그먼트를 회전한다. 기본 12시간 |
| MEMENTO_SEGMENT_MIN_ACTIVITY | 3 | 세그먼트 회전 시 직전 세그먼트에 대한 AutoReflect 발동에 필요한 세그먼트당 최소 활동(파편+도구 호출) 수 |
| MEMENTO_WORKSPACE_GATE | false | `true` 시 `fragmentHasWorkspace` 위반(workspace가 명시값·키 default 어느 쪽으로도 해석되지 않음)을 hard gate 대상에 포함한다. 기본은 경고만 남기고 저장을 차단하지 않는다. `MEMENTO_SYMBOLIC_POLICY_RULES` 활성화 및 `api_keys.symbolic_hard_gate=true`인 키에서만 실제 차단으로 이어진다 |
| EPISODE_CONTINUITY_CACHE_TTL_MS | 5000 | EpisodeContinuityService가 스코프(`agentId:keyId:scopeType:scopeValue`)별 최근 milestone 이벤트 ID를 보관하는 in-memory 캐시의 TTL(ms). 삽입 순서 기반 LRU이며 최대 1000개 스코프까지 추적한다 |

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
| MEMENTO_SYMBOLIC_TIMEOUT_MS | 50 | - | symbolic 평가 timeout 설정값 (ms). 현재 이 값을 읽는 처리는 없다 |
| MEMENTO_SYMBOLIC_MAX_CANDIDATES | 32 | - | symbolic 후보 수 상한 설정값. 현재 이 값을 읽는 처리는 없다 |

`api_keys.symbolic_hard_gate` 컬럼 (migration-033)으로 키 단위 hard gate 전환 가능. 기본 false. true로 설정 시 PolicyRules violations 발생 시 저장이 거부되고 JSON-RPC **프로토콜 레벨** 에러 `-32003`으로 응답한다 (MCP 도구 에러 아님, `error.data.violations: string[]` 포함). 마스터 키(keyId=NULL) 제외. 캐시 TTL 30초. 값은 admin console 키 상세의 ACCESS POLICY 또는 `PATCH /v1/internal/model/nothing/keys/:id/policy`로 바꾸며, 변경은 이 프로세스의 캐시를 비우며, 진행 중이던 조회가 이전 값을 쓸 수 있어 늦어도 약 30초 안에 적용된다.

#### LLM Provider Fallback Chain

Gemini CLI 외 17개 provider로 자동 fallback 가능. 기본값에서 기존 동작 완전 보존.

##### 기본 설정

| 변수 | 기본값 | 설명 |
|------|--------|------|
| LLM_PRIMARY | gemini-cli | 주 provider 이름. gemini-cli는 env 설정 불필요 |
| LLM_FALLBACKS | (없음) | JSON 배열. 각 원소에 provider/apiKey/model/baseUrl/timeoutMs/extraHeaders 지정 |
| LLM_PROVIDER_TIMEOUT_MS | 60000 | provider 1회 호출 타임아웃(ms). 값을 명시했을 때만 호출자가 넘긴 타임아웃을 대체한다(미설정 시 각 호출 경로의 자체 값 유지) |
| LLM_CHAIN_TIMEOUT_MS | 0 | 체인 전체 데드라인(ms). `0`이면 데드라인 없음. 초과 시 `chain deadline exceeded after Nms` 오류로 중단 |

##### Circuit Breaker

| 변수 | 기본값 | 설명 |
|------|--------|------|
| LLM_CB_FAILURE_THRESHOLD | 5 | `LLM_CB_FAILURE_WINDOW_MS` 안의 실패가 이 횟수에 닿으면 해당 provider를 OPEN 상태로 전환한다. 성공하면 실패 기록이 초기화된다 |
| LLM_CB_OPEN_DURATION_MS | 60000 | OPEN 지속 시간 (ms). 경과 후 자동 CLOSE |
| LLM_CB_FAILURE_WINDOW_MS | 60000 | 실패 카운트 윈도우 (ms) |

REDIS_ENABLED=true면 Redis에 상태 저장, 아니면 in-memory.

##### LLM 동시성 제어

| 변수 | 기본값 | 설명 |
|------|--------|------|
| LLM_CONCURRENCY_ENABLED | true | false 시 세마포어 우회. 모든 provider에 동시성 제한 없이 요청 |
| LLM_CONCURRENCY_WAIT_MS | 30000 | 슬롯 대기 타임아웃 (ms). 초과 시 해당 provider를 실패로 기록하고 다음 fallback으로 넘어간다 |
| LLM_CONCURRENCY | (아래 기본값) | JSON 객체. chainKey(`provider|baseUrl|model`) 또는 provider 이름 기준 슬롯 한도 |

`LLM_CONCURRENCY` 기본값 (`DEFAULT_LLM_CONCURRENCY`):

```json
{
  "ollama": 16,
  "openai|https://token-plan-sgp.xiaomimimo.com/v1|mimo-v2-pro": 8,
  "gemini-cli": 1,
  "agy-cli": 1,
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

gemini-cli, **agy-cli**, anthropic, openai, gemini, groq, openrouter, xai, ollama, vllm, deepseek, mistral, cohere, zai, **codex-cli**, **copilot-cli**, **qwen-cli**, **opencode-cli**

**agy-cli**: Google Antigravity CLI(`agy`)를 `--print --output-format text --mode plan --sandbox` 제약으로 실행한다. AnchorMind의 LLM 변환은 JSON 응답만 사용하므로, provider는 파일 수정과 도구 승인을 하지 않는 plan/sandbox 경로만 사용한다. Antigravity 로그인과 `agy` 바이너리가 필요하며, `model`, `timeoutMs` 설정은 실제 CLI 호출에 전달된다:
```json
[{"provider": "agy-cli", "model": "<agy models에서 확인한 모델명>", "timeoutMs": 40000}]
```

실제 CLI는 `--print` 뒤의 모든 인자를 프롬프트로 처리하므로, AnchorMind는 `--output-format text --mode plan --sandbox [--model MODEL] --print PROMPT` 순서로 실행한다.

macOS launchd로 서버를 실행하는 경우 셸 프로필을 읽지 않으므로, plist의 `PATH`에 `~/.local/bin`을 명시해 `agy`를 찾을 수 있게 해야 한다.

**codex-cli**: `codex exec --skip-git-repo-check --sandbox read-only --output-last-message FILE` 명령을 실행한다. `OPENAI_API_KEY` 또는 Codex CLI 설정 파일로 인증한다. `LLM_FALLBACKS`의 `model`, `timeoutMs` 설정이 provider config를 통해 실제 CLI 호출까지 전달된다:
```json
[{"provider": "codex-cli", "model": "gpt-5.3-codex-spark"}]
```

**copilot-cli**: GitHub Copilot CLI(`copilot -p <프롬프트> --output-format text`)를 래퍼로 호출한다. `copilot` 바이너리와 Copilot 구독이 필요하다:
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

**형태소 보조 검색(morphemeIndex.minSimilarity / fallbackThreshold / fallbackLimit)**: L3 시맨틱 검색과 병렬로 형태소 평균 벡터 기반 보조 검색을 수행한다. 형태소 평균 벡터는 문장 임베딩보다 코사인 유사도가 체계적으로 낮으므로 전용 임계값 `morphemeIndex.minSimilarity`(기본 0.15)를 사용하며, `semanticSearch.minSimilarity`(기본 0.4)를 재사용하지 않는다. 기본 L3 결과 수가 `fallbackThreshold`(기본 5) 이하일 때만 보조 결과를 채택하고, 채택 시 `fallbackLimit`(기본 5)개까지 병합한다. 프로브 자체는 병렬 실행되므로 채택 여부가 응답 지연에 영향을 주지 않는다.

**GEMINI_TIMEOUT_MS**: `lib/memory/processors/AutoReflect.js`의 LLM chain 호출 timeout은 30,000 ms로 고정된다(`GEMINI_TIMEOUT_MS = 30_000` 코드 상수, `process.env` 참조 없음). 값을 변경하려면 해당 파일의 상수를 직접 수정해야 한다. MorphemeIndex의 `geminiTimeoutMs`(config/memory.js, 기본 60000)와 별개임에 주의한다.

**buildChain 순서 결정 로직** (`lib/llm/index.js` `buildChain()`): `LLM_PRIMARY` → `LLM_FALLBACKS` 선언 순서로 entries 배열을 구성한 뒤, `seen` Set으로 중복 provider를 제거하고, 각 provider의 `isAvailable()` 체크 성공 여부로 chain에 포함 여부를 결정한다. `LLM_PRIMARY`가 `LLM_FALLBACKS` 목록에도 있으면 fallback의 config 객체가 우선 사용된다. `isAvailable()` 실패 시 해당 provider는 체인에서 제외되고 다음 provider로 즉시 넘어간다. 결과적으로 chain 순서는 환경변수 선언 순서와 1:1 대응한다.

자세한 운영 가이드는 `docs/operations/llm-providers.md` 참조.

#### OAuth 토큰 TTL

OAuth 토큰 TTL은 세션 TTL과 연동된다.

| 환경변수 | 기본값 | 설명 |
|----------|--------|------|
| OAUTH_ACCESS_TOKEN_TTL_SECONDS | (없음) | OAuth 액세스 토큰 TTL (초, 양의 정수). 미설정이면 `SESSION_TTL_MINUTES * 60`(기본 2592000, 30일). 리프레시 토큰 TTL에는 영향 없음 |
| OAUTH_REFRESH_TTL_SECONDS | 5184000 | OAuth 리프레시 토큰 TTL (초). 환경 변수로 읽지 않고 `SESSION_TTL_MINUTES * 60 * 2`로 정해진다. 기본값 60일 |

슬라이딩 윈도우: OAuth 인증된 요청이 들어올 때마다 해당 액세스 토큰의 Redis TTL을 `OAUTH_TOKEN_TTL_SECONDS`로 재설정한다. 도구를 계속 사용하는 한 토큰이 만료되지 않는다.

#### 응답 헤더와 연결 정책

권장 운영 설정 예시는 아래와 같다. 브라우저 Origin을 싣지 않는 클라이언트(CLI, 데스크톱 MCP 클라이언트, 서버 간 호출)만 쓰는 배포를 가정한 값이므로, 적용 전에 사용 중인 클라이언트 구성을 확인한다. 기본값은 모두 이전과 같은 응답을 유지하는 쪽이다.

```bash
ALLOWED_ORIGINS=https://memento.example.com
MEMENTO_CORS_MODE=allowlist
MEMENTO_FRAME_OPTIONS=deny
MEMENTO_OAUTH_REDIRECT_CHECK=enforce
MEMENTO_SSE_QUERY_KEY=deny
MEMENTO_TOOL_ARGS_VALIDATION=enforce
```

- `ALLOWED_ORIGINS`에는 서비스 자신의 origin만 둔다. 설정하면 목록 밖 Origin을 가진 요청은 403으로 끝나므로, 브라우저에서 쓰는 관리 화면의 origin이 목록에 있어야 한다. 목록을 두지 않고 `MEMENTO_CORS_MODE=allowlist`만 쓰면 기본 신뢰 도메인 밖 Origin의 응답에는 `Access-Control-Allow-Origin`이 붙지 않는다(요청 자체는 처리된다).
- 승격 전에는 `observe`의 `[CORS] cross-origin request from` 로그와 `warn`의 `error redirect target not registered` 로그, 접근 로그의 `GET /sse?` 요청 건수로 실제 사용 여부를 확인한다.
- HSTS(`Strict-Transport-Security`)는 앱이 붙이지 않는다. TLS를 종단하는 리버스 프록시에서 붙인다. nginx에서 location 블록에 `add_header`를 하나라도 두면 server 수준의 `add_header`(HSTS 포함)가 상속되지 않으므로, location에 헤더를 추가할 때는 HSTS를 같은 location에 다시 적는다.

#### SSE 연결

| 변수 | 기본값 | 설명 |
|------|--------|------|
| SSE_HEARTBEAT_INTERVAL_MS | 25000 | SSE heartbeat ping 전송 간격 (ms). 클라이언트 연결 유지 확인용 |
| SSE_MAX_HEARTBEAT_FAILURES | 10 | 연속 heartbeat 전송 실패 허용 횟수. 초과 시 세션 자동 종료. write backpressure 및 네트워크 오류 감지 |
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
| MEMENTO_HEALTH_READY_DB_TIMEOUT_MS | `GET /health/ready`가 주 DB 응답을 기다리는 상한 ms. 기본 2000, 100 이상 4500 이하의 정수만 받고 그 밖의 값은 2000을 쓴다. 와치독 curl 상한 5초보다 짧게 둔다 |
| MEMENTO_SHUTDOWN_DEADLINE_MS | SIGTERM/SIGINT 종료 절차 전체 상한 ms. 넘기면 종료 코드 1로 강제 종료한다. 기본 60000, 0은 상한 없음. 0 이상의 정수만 받고 음수나 정수가 아닌 값은 60000을 쓴다 |
| DB_BACKGROUND_MAX_CONNECTIONS | 스케줄러·워커가 동시에 쓰는 Primary 풀 연결 상한. 기본 DB_MAX_CONNECTIONS의 40%(최소 1). DB_MAX_CONNECTIONS-1을 넘지 않는다. 초과 요청은 FIFO로 대기한다 |
| DB_BACKGROUND_WAIT_MAX_MS | 백그라운드 슬롯 대기 상한(ms). 기본 120000. 넘기면 해당 작업만 실패하고 다음 회차에 재시도한다 |
| PGVECTOR_SCHEMA | pgvector 확장이 설치된 스키마. 미설정 시 기동 시 자동 감지 |
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

**총 문자수 게이트**: `fragments` 배열의 content 총 문자수가 `BATCH_REMEMBER_MAX_TOTAL_CHARS`(기본 200,000자)를 초과하면 sync/async 분기 이전에 배치 요청 전체가 즉시 거부된다. 항목별 4000자 상한(초과 항목만 개별 실패)과는 별개의 상한이며, 대량 배치의 처리 비용을 사전에 제한한다.

| 변수 | 기본값 | 설명 |
|------|--------|------|
| BATCH_REMEMBER_MAX_TOTAL_CHARS | 200000 | `batch_remember` fragments 배열 content 총 문자수 상한 |

### Redis

| 변수 | 기본값 | 설명 |
|------|--------|------|
| REDIS_ENABLED | false | Redis 활성화. false면 L1 검색과 캐싱이 비활성화 |
| REDIS_SENTINEL_ENABLED | false | Sentinel 모드 사용 |
| REDIS_HOST | localhost | Redis 서버 호스트 |
| REDIS_PORT | 6379 | Redis 서버 포트 |
| REDIS_PASSWORD | (없음) | Redis 인증 비밀번호 |
| REDIS_DB | 0 | Redis 데이터베이스 번호 |
| MEMENTO_REDIS_SESSION_FAIL_CLOSED | false | true이면 Redis 세션 저장 실패 시 요청을 실패 처리. false이면 경고 후 in-memory 세션으로 계속 동작 |
| MEMENTO_ALLOW_LEGACY_UNBOUND_AGENT_SCOPE | true | 전환 기간 동안 일반 API key의 non-default agentId 주장을 허용. 실제 사용 시 경고와 `mcp_legacy_unbound_agent_scope_total` 기록. 같은 key 내부 agent 인증은 보장하지 않으며, 이관 후 계수 증가가 없는지 확인하고 false로 strict 모드 적용. includePeerAgents는 항상 master 전용 |
| MEMENTO_RESERVED_AGENT_IDS | warn | 내부 작업 전용 agentId(system, admin) 처리 방식. 정제 후 두 값과 같아지는 입력(예: `SYSTEM`, `sy.stem`)이 대상이다. warn은 요청을 통과시키고 `[AgentScope] reserved agentId requested: key=<키 앞 8자> mode=warn` 경고만 남긴다. enforce는 API key 요청을 FORBIDDEN(-32001)으로 거부한다. master key는 항상 허용. 경고가 일정 기간 없을 때 enforce로 전환 |
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
| EMBEDDING_API_KEY | (없음) | 범용 임베딩 API 키. 미설정 시 `GEMINI_API_KEY`, `CF_API_TOKEN`(또는 `CLOUDFLARE_API_TOKEN`), `OPENAI_API_KEY` 순으로 사용 |
| EMBEDDING_BASE_URL | (없음) | `EMBEDDING_PROVIDER=custom` 시 OpenAI 호환 엔드포인트 URL |
| EMBEDDING_MODEL | (provider 기본값) | 사용할 임베딩 모델. 생략 시 provider별 기본값 자동 적용 |
| EMBEDDING_DIMENSIONS | (provider 기본값) | 임베딩 벡터 차원 수. DB 스키마의 vector 차원과 일치해야 한다 |
| EMBEDDING_SUPPORTS_DIMS_PARAM | (provider 기본값) | dimensions 파라미터 지원 여부 override (`true`\|`false`) |
| GEMINI_API_KEY | (없음) | Google Gemini API 키. `EMBEDDING_PROVIDER=gemini` 시 사용 |
| CF_ACCOUNT_ID | (없음) | Cloudflare 계정 ID. `EMBEDDING_PROVIDER=cloudflare` 시 필수. 미설정 시 `CLOUDFLARE_ACCOUNT_ID`를 대체 이름으로 읽는다 |
| CF_API_TOKEN | (없음) | Cloudflare API 토큰. `EMBEDDING_PROVIDER=cloudflare` 시 필수. 미설정 시 `CLOUDFLARE_API_TOKEN`을 대체 이름으로 읽는다 |
| EMBEDDING_TIMEOUT_MS | 8000 | 임베딩 API 호출 1건당 절대 타임아웃(ms). `AbortSignal.timeout()`으로 적용되며 전체 데드라인 역할을 한다 |
| EMBEDDING_MAX_RETRIES | 0 | OpenAI 호환 클라이언트의 자체 재시도 횟수. per-call 타임아웃이 이미 절대 데드라인이므로 재시도와 중첩되면 세마포어 점유 시간이 timeout × 재시도로 누적되는 것을 막기 위해 기본 0 |
| EMBEDDING_CONCURRENCY | 6 | 프로세스 전역 임베딩 호출 동시성 상한. 임베딩 서비스 지연이 전체 요청 큐로 전파되는 것을 차단하는 세마포어 슬롯 수 |
| EMBEDDING_SEM_WAIT_MS | 3000 | 임베딩 세마포어 슬롯 대기 타임아웃(ms). 초과 시 호출이 reject되고 `mcp_embedding_semaphore_wait_exceeded_total` 카운터가 증가한다 |

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

### 와치독

`memento-watchdog.sh`가 읽는 환경 변수다. 서버의 `.env`가 아니라 와치독을 실행하는 cron 작업의 환경에서 받는다. 초 단위 값은 0 이상의 정수다. 운영 절차는 [maintenance.md](operations/maintenance.md)에 있다.

| 변수 | 기본값 | 설명 |
|-|-|-|
| MEMENTO_WATCHDOG_BASE_URL | `http://127.0.0.1:57332` | 상태 확인 대상 주소 |
| MEMENTO_WATCHDOG_SERVICE | `memento-mcp.service` | 재시작할 systemd 서비스 이름 |
| MEMENTO_WATCHDOG_STATE_FILE | `/tmp/memento-watchdog.state` | 상태 파일 경로. 연속 재시작 횟수, 마지막 재시작 시각, 마지막 ready 응답 코드를 한 줄로 기록한다 |
| MEMENTO_WATCHDOG_LOCK_FILE | 상태 파일 경로에 `.lock`을 붙인 값 | 중복 실행을 막는 잠금 파일 |
| MEMENTO_WATCHDOG_STARTUP_GRACE_SEC | 120 | 서비스 기동 후 이 시간(초) 안에는 응답이 없어도 재시작하지 않는다 |
| MEMENTO_WATCHDOG_BACKOFF_BASE_SEC | 60 | 연속 재시작 사이의 첫 대기 시간(초) |
| MEMENTO_WATCHDOG_BACKOFF_MAX_SEC | 1800 | 연속 재시작 대기 시간의 상한(초) |
| MEMENTO_WATCHDOG_RESTART_CMD | (없음) | 지정하면 `sudo systemctl restart` 대신 이 명령을 실행한다 |
| MEMENTO_WATCHDOG_NOW | 현재 시각(epoch 초) | 시각 주입. 시험용 |
| MEMENTO_WATCHDOG_SERVICE_AGE_SEC | (없음) | 서비스 기동 후 경과 초 주입. 시험용 |
| MEMENTO_WATCHDOG_ACTIVE_ENTER_TIMESTAMP | (없음) | 서비스 기동 시각 주입. 시험용 |

### 백업

`scripts/ops/backup.sh`가 읽는 환경 변수다. 서버의 `.env`가 아니라 백업을 실행하는 셸이나 cron 작업의 환경에서만 읽으며 서버는 읽지 않는다. 잘못된 값은 종료 코드 2로 거부한다. 절차는 [backup-restore.md](operations/backup-restore.md)에 있다.

| 변수 | 기본값 | 설명 |
|-|-|-|
| MEMENTO_BACKUP_DIR | `$XDG_STATE_HOME/memento-mcp/backups`, 없으면 `$HOME/.local/state/memento-mcp/backups` | 백업 저장 위치. 저장소 밖의 경로여야 한다(저장소 안쪽, 파일 시스템 루트, 홈 디렉터리 자체는 거부). `--dir` 인자가 우선한다 |
| MEMENTO_BACKUP_KEEP_DAYS | 14 | 보관할 날짜 수. 1 이상 9999 이하의 정수. `--keep` 인자가 우선한다 |

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
    l1WeightFactor: 2.0,  // L1 Redis 결과에 곱하는 가중치 배수 (최우선 주입)
    graphWeightFactor     : 1.5,  // L2.5 그래프 이웃 결과 가중치 배수
    candidateMinImportance: 0.1   // 비앵커 RRF 후보의 중요도 하한
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
      learning   : 3,
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
    maxImportance    : 0.55,     // 이 값 미만이면 삭제 대상
    keepPerType      : 5,        // type별 최신 N개 보존
    maxDeletePerCycle: 30        // 1회 최대 삭제 건수
  },
  semanticSearch: {
    minSimilarity  : 0.4,        // L3 pgvector 검색 최소 유사도 (기본 0.4)
    limit          : 30,         // L3 반환 최대 건수
    keywordFallback: true,       // text 없는 keywords-only 쿼리에서 L3 시맨틱 보조 실행 (env MEMENTO_KEYWORD_SEMANTIC_FALLBACK=false로 비활성)
    keywordFallbackTimeoutMs: 1500 // keywords 보조 L3 실행 상한 (env MEMENTO_KEYWORD_FALLBACK_TIMEOUT_MS)
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
| `mode` | `MEMENTO_PROACTIVE_RECALL_MODE` | `"auto"` | `"auto"`: 조건 충족 시 자동 실행. `"legacy"`: 키워드 겹침 기준만으로 링크를 만들고 workspace 불일치만 제외(symbolic gate와 caseIdPolicy 미적용). `"off"`: 비활성화 |
| `keywordOverlapMin` | `MEMENTO_PROACTIVE_KW_OVERLAP_MIN` | `0.5` | 키워드 중복 비율 하한. 저장 파편과 후보 파편 간 공통 키워드 비율이 이 값 이상이어야 링크 생성 대상이 됨 |
| `requireSameWorkspace` | - | `true` | workspace가 다른 파편은 ProactiveRecall 대상에서 제외 |
| `caseIdPolicy` | `MEMENTO_PROACTIVE_CASE_POLICY` | `"strict-or-adjacent"` | `"both-required"`: 두 파편 모두 동일 case_id 필요. `"strict-or-adjacent"`: 두 파편이 모두 case_id를 가지면 일치해야 하고(불일치는 `cohort_mismatch`), 한쪽이라도 없으면 sessionId 동일, adjacencyWindowMs 이내, workspace 동일 중 하나를 요구한다. `"loose"`: case_id 불일치 시도 허용 |
| `adjacencyWindowMs` | - | `86400000` (24h) | `"strict-or-adjacent"` 정책에서 인접 케이스 허용 시간 범위 (ms) |
| `requireSameTopicOrType` | - | `false` | 설정값만 있고 현재 이 값을 읽는 처리는 없다 |

`proactive-gate.js` symbolic 게이트는 `workspace_mismatch`와 `case_policy` 차단 사유를 평가하며, `MEMENTO_SYMBOLIC_ENABLED=true`와 `MEMENTO_SYMBOLIC_PROACTIVE_GATE=true`가 모두 설정됐을 때 `auto` 모드에서 실행된다. proactiveRecall 블록의 caseIdPolicy와 keywordOverlapMin은 런타임 중 환경변수로 변경 가능하다. 서버 재시작 없이 MEMENTO_PROACTIVE_CASE_POLICY 값을 갱신하면 다음 호출부터 즉시 반영된다. proactiveRecall 비활성화는 mode를 `"off"`로 설정한다.

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

### consolidate.autoPromoteAnchors

`MEMENTO_AUTO_PROMOTE_ANCHORS`는 자동 앵커 승격 stage의 opt-out 설정이다. 미설정 또는 빈 문자열이면 기본값 `true`로 기존 동작을 유지한다. `false`이면 `promote_anchors` stage가 `status="skipped"`, `reason="disabled_by_config"`로 종료하며 승격 UPDATE를 실행하지 않는다. 그 밖의 비어 있지 않은 값은 설정 오류로 거부한다. 기존 앵커를 강등하거나 다른 consolidation stage를 끄지는 않는다. 설정 변경은 서버 재시작 뒤 적용된다.

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
| `requireSubjectAnchor` | `true` | 부모의 주어 앵커를 하나도 담지 못한 자식을 폐기. ENV: `MEMENTO_SPLIT_SUBJECT_GATE` |
| `rejectIntroducedModality` | `true` | 부모에 없던 양상을 도입한 자식을 폐기. ENV: `MEMENTO_SPLIT_MODALITY_GATE` |
| `subjectAnchorMax` | `12` | 부모 원문에서 추출할 주어 앵커 상한 |

분할 자식 품질 게이트(`split-gate.js`): 최소 길이(`minChildLength`) 미달·대체 문자(`�`) 포함·CJK/가나 혼입(한글 본문 기준)·대명사/메타 시작 토큰이면 reject. fact 타입 자식의 importance가 클램프 후 0.4 미만이면 저장 차단.

주어 앵커 게이트(`requireSubjectAnchor`): 부모 원문에서 형태소 분석기의 고유명사·외국어·한자 토큰과 코드 식별자(camelCase·PascalCase·snake_case), 라틴+한글 혼합 토큰(A사, K팀)을 최대 `subjectAnchorMax`개까지 추출한 뒤, 이 중 어느 것도 담지 못한 자식을 폐기하고 `memento_consolidate_split_skipped_total{reason="subject_loss"}`를 증가시킨다. 한글 1자 토큰은 우연 일치가 잦아 앵커로 쓰지 않는다. 앵커를 하나도 추출하지 못한 경우에만 판정 근거가 없으므로 통과시킨다(fail-open). 형태소 분석기가 로드되지 않아도 코드 식별자·라틴+한글 혼합 토큰은 정규식으로 계속 추출되므로, 분석기 미로드가 곧 게이트 비활성을 뜻하지는 않는다.

양상 표류 게이트(`rejectIntroducedModality`): 부모와 자식의 양상 패밀리(future·intention·conjecture·obligation)를 대조하여, 부모에 없던 패밀리를 자식이 새로 도입하면 폐기하고 `memento_consolidate_split_skipped_total{reason="modality_drift"}`를 증가시킨다. 같은 패밀리 안의 표현 교체("제출할 예정이다" → "제출할 것이다")는 재작성으로 허용하며, 완료 사실이 예정·추측·당위로 바뀌는 경우만 차단한다.

두 게이트는 자식 단위로 판정되므로 한 부모에서 여러 건이 누적될 수 있다. 파편 단위로 1회 기록되는 `low_yield`·`anchor_loss` 등과 같은 분모로 비교하지 않는다.

자식 파편의 `keywords`는 `remember` 경로와 동일하게 자식 본문에서 추출된다(`FragmentFactory.extractKeywords`). 부모의 keywords를 복사하지 않는다.

Phase 1(gate-only)에서 통과 자식 수 < `minItems`이면 DB insert 없이 해당 파편의 `split_attempt_failed_at`을 갱신하고 `memento_consolidate_split_skipped_total{reason="low_yield"}`를 증가시킨다. 분할 성공 시 원본은 `valid_to = NOW()`, `ttl_tier = 'cold'`, `importance = GREATEST(0.2, importance × 0.3)` 처리된다.

앵커 커버리지 검사: 분할은 원문을 자르지 않고 LLM이 다시 쓰므로 명제 하나가 통째로 누락될 수 있다. 자식 저장 직전에 원문의 수치 앵커(날짜·금액·비율·측정값)가 자식 합집합에 모두 남아 있는지 대조하고, 하나라도 빠지면 자식을 저장하지 않고 원본을 그대로 둔다. 이때 `split_attempt_failed_at`을 갱신하고 `memento_consolidate_split_skipped_total{reason="anchor_loss"}`를 증가시킨다. 날짜 `2026-07-15`는 `2026`/`07`/`15`로, 범위 `75~85`는 `75`/`85`로 분해 비교하므로 표기가 바뀌어도 구성 숫자가 남으면 보존으로 판정한다. 자릿수 구분자는 무시하며, 한 자리 숫자와 수치가 전혀 없는 원문은 판정 대상에서 제외한다.

### feedback.sampling

쓰기 계열 도구 응답에 `tool_feedback` 요청 힌트를 확률적으로 동봉한다. 자발적 피드백만으로는 표본이 성공 사례에 편중되므로, 저장·수정·삭제 직후 일정 확률로 평가를 요청한다. `config/memory.js`의 `feedback.sampling` 블록에서 설정한다.

| 키 | 기본값 | 설명 |
|-|-|-|
| `enabled` | `true` | 힌트 동봉 활성화. ENV: `MEMENTO_FEEDBACK_SAMPLING` |
| `rates.remember` | `0.10` | remember 성공 응답의 힌트 표집 확률 |
| `rates.amend` | `0.25` | amend 성공 응답의 힌트 표집 확률 |
| `rates.forget` | `0.25` | forget 성공 응답의 힌트 표집 확률 |
| `maxHintsPerSession` | `2` | 세션당 힌트 상한. 초과 시 무음 |
| `cooldownSeconds` | `900` | 직전 힌트 이후 재발행 금지 시간 |

recall은 자체 힌트 경로를 이미 갖고 있어 `rates`에서 제외된다. 상한·쿨다운 카운터는 Redis(`frag:fbhint:count:*`, `frag:fbhint:cd:*`)에 보관하며, Redis 미가용 시에는 상한·쿨다운 없이 확률 판정만 적용된다(fail-open). `remember(dryRun=true)`·`forget(dryRun=true)`과 실제 갱신이 없었던 `amend`는 표집 대상이 아니다. 표집된 응답에는 `_meta.hints[0]`에 `signal: "feedback_sampled"`와 `args: {tool_name, trigger_type: "sampled"}`가 실린다.

### queryProfiles (질의 의도별 검색 프로파일)

질의 내용을 분석해 `EXACT_SYMBOL` / `CONCEPT_INTENT` / `HYBRID` 중 하나로 분류하고, 의도에 맞는 검색 손잡이를 한 번에 전환한다. `config/memory.js`의 `queryProfiles` 블록에서 설정한다.

| 키 | 설명 |
|-|-|
| `enabled` | 프로파일 전체 활성화. ENV `MEMENTO_QUERY_PROFILE_ENABLED=false`로 끌 수 있다 |
| `l2WeightFactor` | RRF에서 L2(메타데이터·키워드) 레이어 가중 배수 |
| `l3WeightFactor` | RRF에서 L3(pgvector) 레이어 가중 배수 |
| `minSimilarityDelta` | 시맨틱 임계값 보정치. 적용 후 0.10~0.60으로 클램프된다 |
| `morphemeFallbackThreshold` | 형태소 보조 프로브 채택 조건(기본 L3 결과 수 상한) |
| `exactKeywordBoost` | 키워드 정확 일치 가산 |
| `lexicalWeightReranked` / `lexicalWeightFallback` | 최종 재정렬의 lexical 가중치 |

기본값은 다음과 같다.

| 프로파일 | 판정 기준 | l2 | l3 | minSimilarityDelta |
|-|-|-|-|-|
| `EXACT_SYMBOL` | 코드 식별자, 경로, 환경변수, 3자리 이상 수치 포함 | 1.6 | 0.9 | 0.0 |
| `CONCEPT_INTENT` | 의문사, 원인·방법·절차 표현, 식별자 부재 | 0.9 | 1.5 | -0.20 |
| `HYBRID` | 혼재 또는 판정 불가 | 1.0 | 1.1 | -0.06 |

`CONCEPT_INTENT`의 임계값 보정이 큰 이유는 임베딩 모델의 실제 유사도 분포 때문이다. text-embedding-3-small에서 한국어 질의와 영문 기술용어가 섞인 저장문의 패러프레이즈 쌍 코사인이 0.26 부근으로 측정되었고, 임의 파편 대비 분포는 p50 0.228 / p95 0.335였다. 기본 임계값 0.40을 그대로 쓰면 정답 파편이 후보에 진입하지 못한다.

`ranking`의 `importanceWeight` / `recencyWeight` / `semanticWeight`는 합계 1.0을 기동 게이트가 강제하므로 프로파일 조정 대상이 아니다.

효과는 `benchmark` 서브명령으로 계측한다. 100문항 골드셋 격리 모드 기준 Recall@5는 프로파일 비활성 64%에서 활성 86%로, 운영 코퍼스 경쟁 모드에서는 50%에서 76%로 측정되었다.

### syntheticQuery (합성 역질의 증강)

파편 저장 시 회상 시점에 던져질 만한 질문을 생성해 보조 벡터로 색인한다. 본문 임베딩만으로는 저장 표기와 회상 표기가 어긋날 때 후보 진입에 실패하는데, 이 경로가 그 격차를 메운다. 생성은 기존 LLM 체인(`LLM_PRIMARY` + `LLM_FALLBACKS`)에 위임하며 별도 provider나 키를 두지 않는다.

| 키 | ENV | 기본값 | 설명 |
|-|-|-|-|
| `enabled` | `MEMENTO_SYNTHETIC_QUERY_ENABLED` | `false` | 역질의 생성. 기본 비활성이며 `true`로 명시해야 워커가 기동한다 |
| `searchEnabled` | `MEMENTO_SYNTHETIC_QUERY_SEARCH` | `true` | 검색 반영. `false`면 이미 쌓인 보조 벡터를 조회하지 않는다 |
| `minImportance` | `MEMENTO_SYNTHETIC_QUERY_MIN_IMPORTANCE` | `0.8` | 생성 대상 최소 중요도 |
| `types` | `MEMENTO_SYNTHETIC_QUERY_TYPES` | `error,procedure,decision` | 생성 대상 유형(쉼표 구분) |
| `intervalMs` | `MEMENTO_SYNTHETIC_QUERY_INTERVAL_MS` | `5000` | 워커 큐 폴링 간격(ms) |
| `maxCallsPerMinute` | `MEMENTO_SYNTHETIC_QUERY_RPM` | `20` | 분당 LLM 호출 상한. `0`이면 무제한 |
| `batchSize` | `MEMENTO_SYNTHETIC_QUERY_BATCH` | `5` | 큐에서 한 번에 꺼내는 수 |
| `backfillBatch` | `MEMENTO_SYNTHETIC_QUERY_BACKFILL` | `20` | 큐가 비었을 때 회수할 미생성 파편 수 |
| `adoptLimit` | `MEMENTO_SYNTHETIC_QUERY_ADOPT` | `5` | 한 검색에서 보조 경로로 합류시킬 최대 파편 수 |
| `similarityDecay` | - | `0.85` | 보조 히트 유사도 감쇠 계수 |
| `llmTimeoutMs` | `MEMENTO_SYNTHETIC_QUERY_TIMEOUT_MS` | `20000` | 생성 호출 타임아웃 |

두 스위치는 독립이다. 생성을 꺼도 이미 쌓인 보조 벡터는 검색에 쓰이고, 검색을 꺼도 생성은 계속된다.

생성이 기본 비활성인 이유는 비용이다. 업그레이드만으로 파편 저장마다 LLM 호출이 붙으면 예고 없이 사용량이 늘어난다. 켜기 전에 대상 제한(`minImportance`, `types`)과 분당 상한(`maxCallsPerMinute`)을 함께 확인한다.

동작 규약:

- 생성 실패는 파편 저장에 영향을 주지 않는다. 큐 적재 실패도 삼키며, 누락분은 워커의 백필 수집기가 회수한다.
- 생성된 질의는 원문의 고유명사·식별자·수치를 최소 하나 보존해야 채택된다. 원문에 없던 한자·가나가 섞이면 생성 언어가 흔들린 것으로 보고 버린다.
- 검색 시 보조 벡터 조회는 본문 벡터 조회와 병렬로 실행된다. 순차로 붙이면 매 검색에 벡터 조회가 하나 더 얹혀 p95 지연이 배가 된다.
- 보조 히트는 감쇠 계수를 적용한 유사도로 합류하며, 이미 본문 경로가 찾은 파편은 건너뛴다.

`fragment_synthetic_query`는 `fragments`와 분리된 표다. `QuotaChecker`가 `fragments` 행 수로 `fragment_limit`을 판정하므로 같은 표에 넣으면 사용자 할당량을 잠식한다. 파생 자료이므로 유실 시 백필로 재생성한다.

### consolidate.gate (정리 안전 게이트)

시맨틱 중복 제거가 병합을 수행하기 전에 판정한다. 코사인 유사도는 수치나 식별자만 다른 문장을 구분하지 못하므로(`max_connections 200`과 `500`은 0.99 이상), 제거 대상이 가진 변별 토큰(수치·식별자·경로·버전)이 승계자에 남는지 확인한 뒤에만 병합을 허용한다.

| 키 | 기본값 | 설명 |
|-|-|-|
| `enabled` | `true` | `false`면 게이트 없이 기존 동작으로 되돌아간다 |
| `maxLostTokens` | `0` | 허용할 소실 토큰 수 |

차단 사유는 세 가지다.

| 사유 | 판정 |
|-|-|
| `distinctive_token_loss` | 제거 대상의 변별 토큰이 승계자에 없음 |
| `survivor_shorter` | 승계자가 제거 대상보다 1.5배 이상 짧음 |
| `cosine_below_floor` | 코사인 하한 미달 |

차단·통과 건수는 `memento_consolidate_gate_blocked_total`(stage, reason 라벨)과 `memento_consolidate_gate_allowed_total`(stage 라벨)로 노출된다. 삭제 이후가 아니라 파괴 전에 판정하므로 중단 시 복구 절차가 필요 없다.

### SearchParamAdaptor (자동 검색 파라미터 학습)

SearchParamAdaptor는 별도 환경변수 없이 자동으로 동작한다. `config/memory.js`의 `semanticSearch.minSimilarity` 값을 기본값으로 사용하며, 50회 이상 검색 후 key_id x query_type x hour 조합별로 학습된 값으로 대체된다.

| 하드코딩 상수 | 값 | 설명 |
|-------------|-----|------|
| MIN_SAMPLE | 50 | 학습 적용 최소 샘플 수 |
| CLAMP_MIN | 0.10 | minSimilarity 하한 |
| CLAMP_MAX | 0.60 | minSimilarity 상한 |
| step | 0.01 | 조정 보폭 (대칭) |

학습 데이터는 `agent_memory.search_param_thresholds` 테이블에 저장된다 (migration-029).

`topic` 정확일치 필터로 0건이 된 검색은 학습 표본에서 제외된다. topic은 전 계층에서 정확일치로 평가되므로 오기 한 글자에도 모든 계층이 동시에 0건이 되고, 이를 학습에 넣으면 minSimilarity 하향 압력만 남는다. `search_events` 기록은 그대로 유지되며 제외 대상은 SearchParamAdaptor 학습뿐이다. 이 경우 recall은 근접 topic 후보를 조회해 `_meta.hints`에 `topic_mismatch`를 실어 재검색을 유도한다(`TopicResolver`).

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
| HuggingFace Transformers (multilingual-e5-small) | 384 | `EMBEDDING_PROVIDER=transformers` | 완전 무료 (로컬) |
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
| 038 | migration-038-fragment-versions-case-fields.sql | `fragment_versions`에 `resolution_status`·`outcome`·`phase` 컬럼 추가. amend 직전 케이스 상태를 이력에 보존 |
| 039 | migration-039-feedback-instrumentation.sql | `task_feedback`에 `outcome`·`evaluator`·`evidence`·`unmet_requirements` 컬럼 + `outcome`·`evaluator` CHECK 제약, `tool_feedback`에 `irrelevance_reason` 컬럼 + CHECK 제약 + partial index `idx_tf_irrelevance`. 기존 행은 백필하지 않으므로 NULL이 "미보고"를 뜻한다 |
| 040 | migration-040-workspace-audit-columns.sql | `fragments.workspace_source TEXT`(explicit / key_default / inferred / unscoped CHECK, NULL은 미기록), `fragments.quality_rationale TEXT` |
| 041 | migration-041-workspace-backfill-inference.sql | `fragments.workspace_inferred`, `inference_confidence`(0.0~1.0 CHECK), `backfill_batch_id`. 추론 결과를 workspace 컬럼과 분리해 기록 |
| 042 | migration-042-api-keys-allowed-workspaces.sql | `api_keys.allowed_workspaces TEXT[]`. NULL은 무제한. 빈 배열은 모든 workspace 주장을 허가 집합 밖으로 판정해 `workspaceNotAllowed` 경고를 남기고, `MEMENTO_WORKSPACE_GATE=true`이며 키의 hard gate가 켜진 경우에만 저장을 거부한다. workspace가 없는 쓰기는 항상 통과한다. `PATCH /v1/internal/model/nothing/keys/:id/policy`로 편집(최대 64개, 항목당 128자) |
| 043 | migration-043-fragment-synthetic-query.sql | `fragment_synthetic_query` 표(합성 역질의와 임베딩, HNSW 인덱스, 에이전트 격리 정책) |
| 044 | migration-044-idempotency-records.sql | `idempotency_records` 표(`amend`, `tool_feedback`의 재시도 응답 기록, 기본 7일 만료) |
| 045 | migration-045-fragment-rls.sql | `fragments`, `fragment_links`에 RLS ENABLE와 격리 정책. `FORCE ROW LEVEL SECURITY`는 적용하지 않음 |
| 047 | migration-047-agent-scope-audit.sql | `search_events.effective_agent_scope`, `include_peer_agents`, `fragment_versions`와 `case_events`의 `agent_id`, `workspace` snapshot 컬럼 |
| 048 | migration-048-case-events-case-closed.sql | `case_events.event_type` CHECK에 `case_closed` 추가 |
| 049 | migration-049-align-synthetic-query-embedding.sql | 이력 표식. `fragment_synthetic_query.embedding` 차원을 `fragments.embedding`에 맞추는 DDL은 `scripts/migrate.js`가 번호 마이그레이션 뒤에 적용 |

---

## Mode Preset 설정

세션 동작 범위를 preset으로 고정한다. 3가지 경로로 설정할 수 있으며, 우선순위는 아래와 같다.

1. **요청별 헤더** (최우선): `X-Memento-Mode: <preset>`
2. **initialize 파라미터**: `{ "method": "initialize", "params": { "mode": "<preset>" } }`
3. **키 단위 기본값** (admin console 키 상세의 ACCESS POLICY 또는 `PATCH /v1/internal/model/nothing/keys/:id/policy`): `api_keys.default_mode` 컬럼 (migration-034). 마스터 전용 preset(`audit`)은 API 키에 지정할 수 없다. 변경 이후 열린 세션부터 적용된다

| Preset | 설명 | excluded_tools 대표 예 | 권장 사용 맥락 |
|--------|------|------------------------|----------------|
| `recall-only` | 읽기 전용. 쓰기 도구 차단 | remember, batch_remember, amend, forget, link, reflect, memory_consolidate | 읽기 권한만 부여된 공유 API 키, 조회 전용 대시보드 연동 |
| `write-only` | 쓰기 전용. 검색 도구 차단 | recall, context, reconstruct_history, graph_explore, fragment_history, search_traces, memory_stats | CI/크론 잡에서 결과만 기록할 때. 불필요한 조회 도구 노출 없이 토큰 소비 최소화 |
| `onboarding` | 신규 사용자 안내. 모든 도구 노출 + 초심자 가이드 주입 | (없음, excluded_tools: []) | 신규 사용자 세션. 헤더, initialize 파라미터, 키 기본값으로 지정한다 |
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
npm test          # node:test, tests/unit/*.test.js + tests/unit/*/*.test.js (DB 불필요)
```

개별 실행:
```bash
npm run test:integration # node:test, tests/integration/*.test.js + tests/e2e/*.test.js
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
npm run test:ci          # npm test && npm run test:integration
```

---

## 관련 문서

- [로컬 임베딩 설정](embedding-local.md) — `EMBEDDING_PROVIDER=transformers` 상세 전환 절차
- [통합/E2E 테스트](../tests/integration/README.md) — 테스트 환경 구성 및 실행 방법
- [API Reference](api-reference.md) — MCP 도구 파라미터 및 Mode preset 상세
- [아키텍처](architecture.md) — 컴포넌트 의존성 및 DB 스키마
