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
| 1 이상의 정수, 그 밖은 기본값 | MEMENTO_WM_FALLBACK_MAX_ROWS (2000), MEMENTO_ANCHOR_LIMIT_PER_KEY (1000) |
| 100 이상 4500 이하의 정수, 그 밖은 2000 | MEMENTO_HEALTH_READY_DB_TIMEOUT_MS |
| 100 이상 100000 이하의 정수, 그 밖은 4000 | MEMENTO_GC_MAX_DELETE_PER_CYCLE |
| 1000 이상 600000 이하의 정수, 그 밖은 60000 | MEMENTO_GC_TIME_BUDGET_MS |
| 1 이상 100 이하의 정수, 그 밖은 12 | MEMENTO_OUTBOX_MAX_ATTEMPTS |
| 1 이상 3650 이하의 정수, 그 밖은 7 | MEMENTO_OUTBOX_RETENTION_DAYS, MEMENTO_OUTBOX_UNHANDLED_DAYS |
| 1 이상 3650 이하의 정수, 그 밖은 400 | MEMENTO_AUDIT_RETENTION_DAYS |
| 0 이상 720 이하의 정수, 그 밖은 24 | MEMENTO_KEY_ROTATION_GRACE_HOURS |
| 0 이상 86400 이하의 정수, 그 밖은 60 | MEMENTO_KEY_LAST_USED_INTERVAL_SEC |
| 0 이상 10 이하의 정수, 그 밖은 3 | MEMENTO_DB_LOCK_RETRY_MAX |
| 10 이상 10000 이하의 정수, 그 밖은 120 | MEMENTO_LEXICAL_TIMEOUT_MS |
| 1 이상의 숫자, 그 밖은 `SESSION_TTL_MINUTES * 60` | OAUTH_ACCESS_TOKEN_TTL_SECONDS |
| 0 이상 1 이하의 숫자 (1을 넘으면 1, 음수와 숫자가 아닌 값은 0) | MEMENTO_DECAY_MIN_DELTA, MEMENTO_UTILITY_MIN_DELTA |
| off, warn, enforce (공백만 있는 값을 포함한 그 밖의 값은 enforce로 동작) | MEMENTO_TOOL_ARGS_VALIDATION |
| off, warn, enforce (그 밖의 값은 warn) | MEMENTO_ANCHOR_PERMISSION |
| warn, enforce (그 밖의 값은 warn) | MEMENTO_SESSION_ID_POLICY, MEMENTO_RESERVED_AGENT_IDS, MEMENTO_OAUTH_REDIRECT_CHECK |
| off, warn, enforce (그 밖의 값은 warn) | MEMENTO_WORKSPACE_READ_AUTHZ |
| reflect, observe, allowlist (그 밖의 값은 observe) | MEMENTO_CORS_MODE |
| allow, deny (그 밖의 값은 allow) | MEMENTO_SSE_QUERY_KEY |
| deny (그 밖의 값은 헤더를 붙이지 않음) | MEMENTO_FRAME_OPTIONS |
| 401, 503 (그 밖의 값은 401) | MEMENTO_AUTH_STORE_UNAVAILABLE_STATUS |
| inner, outer (그 밖의 값은 inner) | MEMENTO_SEMANTIC_THRESHOLD_MODE |
| configured, local_only (그 밖의 값은 configured) | MEMENTO_EGRESS_UNKNOWN_KEY |
| none, all (그 밖의 값은 none) | MEMENTO_LLM_CLI_TOOL_APPROVAL |
| true, false (그 밖의 값은 false) | MEMENTO_CONFIG_STRICT |
| true, false (그 밖의 값은 `MEMORY_CONFIG` 검증에서 기동 실패) | MEMENTO_AUTO_PROMOTE_ANCHORS (true) |
| on, off (그 밖의 값은 off) | MEMENTO_ADMIN_AUTH_BACKOFF |
| 쉼표로 나눈 `id:32바이트 키`(base64 또는 64자 hex), 그 밖은 미설정으로 동작 | MEMENTO_ADMIN_SEAL_KEY |
| on, off (그 밖의 값은 on) | MEMENTO_WRITE_GATE, MEMENTO_OUTBOX, MEMENTO_OUTBOX_WORKER, MEMENTO_WM_PG_FALLBACK, MEMENTO_RANK_BEFORE_BUDGET, MEMENTO_RANKING_FIX_V2, MEMENTO_GC_THROUGHPUT, MEMENTO_CONTEXT_ANNOTATE, MEMENTO_PROVENANCE, MEMENTO_REVIEW_QUEUE, MEMENTO_HOOK_ENDPOINTS, MEMENTO_FORGET_CASCADE, MEMENTO_EGRESS_POLICY, MEMENTO_AUDIT_DB, MEMENTO_ADMIN_USERS, MEMENTO_LEXICAL_CHANNEL |
| mask, reject, off (그 밖의 값은 mask) | MEMENTO_SENSITIVE_SCAN |
| workspace, key (그 밖의 값은 workspace) | MEMENTO_DEDUP_SCOPE |
| true, false (false가 아닌 값은 true) | MEMENTO_API_KEY_DELETE_GUARD, MEMENTO_ALLOW_LEGACY_UNBOUND_AGENT_SCOPE, LLM_CONCURRENCY_ENABLED, MCP_REJECT_NONAPIKEY_OAUTH, MEMENTO_DERIVED_FRESHNESS_ENFORCE |
| true, false (true가 아닌 값은 false) | MEMENTO_LOG_STDERR, MEMENTO_REMEMBER_DUPLICATE_GUARD, MEMENTO_REMEMBER_ATOMIC, MEMENTO_WORKSPACE_GATE, MEMENTO_TOOL_ARGS_ALLOW_UNKNOWN, ENABLE_RECONSOLIDATION, ENABLE_SPREADING_ACTIVATION, UPDATE_REQUIRE_SIGNED_TAG, MEMENTO_AUTH_DISABLED, REDIS_ENABLED, REDIS_SENTINEL_ENABLED, MEMENTO_REDIS_SESSION_FAIL_CLOSED, EMBEDDING_SUPPORTS_DIMS_PARAM, MEMENTO_RERANKER_ENABLED, MEMENTO_CASE_BACKPROP_ENABLED, UPDATE_CHECK_DISABLED, ENABLE_OPENAPI, MCP_ALLOW_AUTO_DCR_REGISTER, MCP_STRICT_ORIGIN |
| true, false (true가 아닌 값은 REDIS_ENABLED 값) | CACHE_ENABLED |

### 스위치 보고

기능 스위치의 이름, 문서 기본값, 용도, 분류는 `config/switches.js`의 레지스트리에 있다. 환경을 주면 스위치마다 실제로 적용되는 값을 계산한다. 판독 규칙은 사용처와 같고, 잘못된 값은 사용처가 적용하는 값으로 표시한다.

- 표 출력: `npm run switches`(`node scripts/switch-report.mjs`)가 스위치, 적용 값, 기본값, 상태, 기본과 다름, 분류, 예외 분류, 용도를 마크다운 표로 출력한다. 프로세스 환경만 읽고 `.env` 파일은 읽지 않는다. 특정 환경 기준으로 보려면 그 환경 변수를 셸에 올린 뒤 실행한다(`set -a; . <.env 경로>; set +a; npm run switches`). 키, 토큰, 주소를 담는 변수는 레지스트리에 없고, 잘못된 원본 값은 출력하지 않는다.
- 릴리스 관문: `npm run switches -- --strict`는 값이 잘못된 스위치가 하나라도 있으면 표를 출력한 뒤 종료 코드 1로 끝난다(없으면 0). 옵션이 없으면 항상 0이다. 종료 전에 stderr에 잘못된 스위치 이름을 적는다.
- 상태 칸: `on`과 `off`는 기능이 켜졌는지 꺼졌는지다. `mode`는 켜고 끄는 값이 아니라 방식을 고르는 열거(`MEMENTO_CORS_MODE` 등)다. 값이 잘못된 스위치는 "기본과 다름" 칸에 `값 오류`로 적고, 적용 값 칸에는 사용처가 쓰는 값을 적는다.
- 관리 API: `GET /v1/internal/model/nothing/stats` 응답의 `switches`에 `total`, `on`, `off`, `mode`, `nonDefaultCount`, `nonDefault`(기본과 다른 스위치 이름), `invalid`(값이 잘못된 스위치 이름)가 있다. 값은 담지 않는다.
- 기동 로그: `[Startup] switches: total=N on=N off=N mode=N nonDefault=N (이름=on|off|열거 값, ...) invalid=N (이름, ...)` 한 줄을 기록한다.
- 새 스위치: `envBool`, `envEnum`으로 읽는 불리언과 열거 변수는 레지스트리에 항목을 추가하고 `.env.example`, 이 문서, 영문판에 적는다. `tests/unit/switch-ledger-structure.test.js`가 빠진 항목을 실패로 알린다. 기능 개폐가 아니라 방식만 고르는 변수는 그 시험의 제외 목록에 이유와 함께 둔다.

### 환경 변수 접근 규칙

새 환경 변수는 `lib/config.js`나 `config/` 아래 중앙 모듈에서 `envInt`, `envBool`, `envEnum` 같은 도우미로 읽는다. 그 밖의 파일이 `process.env`를 직접 읽는 예외는 `config/env-access.js`에 파일, 분류, 변수, 사유를 적어 등록한다.

분류는 코드에서 자동으로 판정하며 대장의 값과 같아야 한다.

| 분류 | 뜻 | 환경 변경 반영 |
|------|----|---------------|
| startup | 모듈 최상위에서 읽는다 | 서버를 다시 시작해야 반영된다 |
| runtime | 함수 안에서 읽는다 | 호출할 때마다 읽으므로 바로 반영된다 |
| cli | `lib/cli`, `bin`의 CLI 진입점이 읽거나 쓴다 | 명령을 실행할 때 반영된다 |

- 점검: `npm run env-access`(`node scripts/env-access-report.mjs`)가 분류별 변수 수를 출력한다. `-- --strict`는 위반이 있으면 종료 코드 1로 끝난다.
- 위반: 등록되지 않은 접근, 코드에 없는 등록, 분류가 어긋난 등록이다. `tests/structure/env-access.test.js`가 같은 검사를 시험으로 돌린다.
- runtime 항목을 startup으로 옮기면 서버를 켠 채 바꾸던 토글이 더는 반영되지 않는다. 옮기려면 호출 시점 변경 시험을 함께 둔다.
- `lint:ratchet`의 직접 읽기 수치는 파일별 개수의 상한이고, 이 대장은 분류와 사유를 요구한다. 둘은 서로 보완한다.

### 서버

| 변수 | 기본값 | 설명 |
|------|--------|------|
| PORT | 57332 | HTTP 리슨 포트 |
| MEMENTO_ACCESS_KEY | (없음) | Bearer 인증 키. 미설정 상태로는 서버가 기동하지 않고 종료 코드 78로 멈춘다. 인증 없이 운용하려면 `MEMENTO_AUTH_DISABLED=true`를 함께 지정해야 한다 |
| MEMENTO_AUTH_DISABLED | false | `true`로 설정 시 인증을 완전히 비활성화하여 모든 요청을 master 권한으로 처리. 개발·시험 전용이며 이 선언이 없으면 키 없는 기동 자체가 거부된다. `MEMENTO_ACCESS_KEY`가 비어 있을 때만 유효 |
| DB_STATEMENT_TIMEOUT_MS | 30000 | 사용자 요청 경로의 질의 시간 상한(ms). 0은 무제한. system·admin 유지보수 경로에는 적용하지 않는다 |
| REQUEST_TIMEOUT_MS | 60000 | 요청 수신 상한(ms). 0은 무제한 |
| MEMENTO_CONFIG_STRICT | false | 숫자·열거·불리언 환경 변수의 값 문제를 기동 시 한 줄로 기록한다. 숫자가 아닌 값은 기본값으로 돌아가고, 정수가 아니거나 허용 범위 밖인 값은 그대로 쓰며 기록만 한다(`MEMENTO_HEALTH_READY_DB_TIMEOUT_MS`, `MEMENTO_SHUTDOWN_DEADLINE_MS`, `MEMENTO_SCORE_UPDATE_BATCH`, `MEMENTO_SESSION_KEY_RECHECK_MS`, `MEMENTO_DB_LOCK_RETRY_MAX`, `MEMENTO_LEXICAL_TIMEOUT_MS`는 범위 밖이어도 기본값). 공백만 있는 값은 미설정과 같다. `true`면 문제가 있을 때 종료 코드 78로 멈춘다 |
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
| MEMENTO_DB_LOCK_RETRY_MAX | 3 | 파편 행을 여러 개 잠그는 쓰기 트랜잭션이 교착(40P01)이나 잠금 대기 상한(55P03)으로 끝났을 때 처음부터 다시 실행하는 최대 횟수. 재시도 전 대기는 25ms에서 두 배씩 늘어 400ms를 넘지 않으며 그 범위의 절반에서 상한 사이 임의 값이다. 0이면 재시도하지 않는다. 0 이상 10 이하의 정수만 받고 그 밖은 기본값. 재시도 수는 `memento_db_deadlock_retries_total`(operation 라벨)로 노출된다 |
| MEMENTO_DECAY_MIN_DELTA | 0 | 감쇠량이 이 값보다 작은 행을 건너뛴다. 마지막 감쇠 후 24시간이 지난 행은 항상 갱신(하한 0.05에 닿은 행은 이 상한 때문에 대략 네 번에 한 번 다시 쓰인다). 숫자가 아니거나 음수인 값은 0으로 처리하고 경고를 남기며 1을 넘는 값은 1로 제한한다. `MEMENTO_SCORE_UPDATE_BATCH`가 0이면 적용하지 않는다 |
| MEMENTO_UTILITY_MIN_DELTA | 0 | 저장값과의 차이가 이 값 이하인 utility_score를 다시 쓰지 않는다. 숫자가 아니거나 음수인 값은 0으로 처리하고 경고를 남기며 1을 넘는 값은 1로 제한한다. `MEMENTO_SCORE_UPDATE_BATCH`가 0이면 적용하지 않는다 |
| MEMENTO_GC_THROUGHPUT | on | 만료 파편 정리의 처리량 스위치. `on`이면 정리 단계 `expired_delete`가 후보를 100건 청크로 반복해 주기당 삭제 상한(`MEMENTO_GC_MAX_DELETE_PER_CYCLE`), 시간 예산(`MEMENTO_GC_TIME_BUDGET_MS`), 후보 소진 중 먼저 닿는 것에서 멈춘다. 청크마다 별도 트랜잭션에서 대상 행을 id 오름차순으로 잠근 뒤 잠근 행만 지우며(잠금 대기 상한 3초, 교착과 잠금 대기 초과는 `MEMENTO_DB_LOCK_RETRY_MAX`까지 재실행), 청크가 실패하면 그때까지 지운 수를 돌려주고 다음 주기가 이어간다. 다른 정리 주기나 `forget`이 청크 도중에 대상 행을 먼저 지우면 그 청크가 요청보다 적게 지워 이번 주기가 일찍 끝날 수 있다(안전하며 다음 주기가 이어간다). 청크의 잠금 대기 상한은 `fragment_links`와 버전 행의 연쇄 삭제에도 적용되고, 재시도(`MEMENTO_DB_LOCK_RETRY_MAX`)까지 겹치면 청크 하나가 시간 예산을 넘어 약 12초 더 기다릴 수 있다. `off`이면 주기당 `gc.maxDeletePerCycle`(50)건을 한 문장으로 지운다. 호출 시점에 읽는다 |
| MEMENTO_GC_MAX_DELETE_PER_CYCLE | 4000 | 만료 파편 정리가 한 주기(`CONSOLIDATE_INTERVAL_MS`, 기본 6시간)에 지우는 최대 건수. 기본값은 30일 일평균 파편 유입(약 1900건)의 두 배 이상이다. 100 이상 100000 이하의 정수만 받고 그 밖은 기본값이다. `MEMENTO_GC_THROUGHPUT=off`이면 쓰지 않는다. 호출 시점에 읽는다 |
| MEMENTO_GC_TIME_BUDGET_MS | 60000 | 만료 파편 정리 한 주기에서 새 청크를 시작할 수 있는 시간(ms). 청크 하나는 항상 끝까지 실행한다. 1000 이상 600000 이하의 정수만 받고 그 밖은 기본값이다. `MEMENTO_GC_THROUGHPUT=off`이면 쓰지 않는다. 정리 주기가 끝날 때 남은 만료 후보 수(상한 100000에서 세기를 멈추는 근사값)를 `memento_gc_backlog` 게이지에 기록한다. 게이지는 동시에 도는 정리 주기 사이에서 마지막으로 쓴 값이 남고 첫 정리 주기 전에는 0이다. 호출 시점에 읽는다 |
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
| MEMENTO_WORKSPACE_READ_AUTHZ | warn | 읽기 경로 workspace 허가. 대상은 tools/call의 recall, context, graph_explore, fragment_history, reconstruct_history, search_traces와 resources/read 전체이고, 요청의 effective workspace(명시 `workspace` 인자, 없으면 키 기본 workspace, 둘 다 없으면 전역)를 API 키의 `allowed_workspaces`로 판정한다. 마스터 키와 `allowed_workspaces`가 NULL인 키는 제한이 없고, 값이 있는 키는 목록의 workspace와 전역(workspace 없음) 파편만 읽는다. 저장소 전체를 집계하는 도구(memory_stats)는 전체 workspace 대상이며 지금은 마스터 전용이다. 같은 스위치가 master가 아닌 세션의 master 전용 mode preset(`audit`) 요청(`X-Memento-Mode` 헤더, `initialize`의 `params.mode`, 키 `default_mode`)도 판정한다. `warn`(기본): 허가 밖 요청을 그대로 처리하고(preset은 무시해 전체 도구를 노출) `memento_workspace_read_authz_total{surface,reason,outcome="would_deny"}`와 `[WorkspaceReadAuthz] would_deny` 경고 로그(키 id, 표면, 사유, 대상 workspace 또는 preset과 출처)를 남긴다. `enforce`: 허가 밖 읽기는 처리기에 들어가지 않고 JSON-RPC 오류 `-32001`로 끝나며, master 전용 preset 요청은 세션을 만들지 않고 HTTP 403과 `-32001`로 거부한다(`outcome="denied"`). 허가된 범위 제한 키의 검색은 파편 단위로도 같은 판정(SearchScope)을 적용한다. `off`: 판정하지 않는다. 사유 라벨: `explicit_out_of_range`, `default_out_of_range`(키 기본 workspace가 `allowed_workspaces` 밖), `all_workspaces`, `lookup_failed`(`allowed_workspaces` 조회 실패), `preset_requires_master`. `enforce`로 바꾸기 전에 `warn` 기간의 would_deny 로그를 키별로 확인한다. `allowed_workspaces` 변경은 키별 30초 캐시를 거쳐 적용된다. `warn` 기간에 master 전용 preset으로 열린 세션은 `enforce`로 바꾼 뒤에도 만료될 때까지 preset을 무시한 채 동작한다. 호출 시점에 읽는다 |
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
| RERANKER_WINDOW | 30 | 리랭커가 다시 줄 세우는 RRF 상위 후보 수(1~100). 재정렬 시간은 이 값에 비례한다(CPU에서 bge-reranker-v2-m3 30건 약 5초). 줄이면 지연은 줄고 뒤쪽 후보 회수가 약해진다 |
| RERANKER_TOP_K | 15 | 재정렬 뒤 남기는 파편 수(1~100) |
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
| MEMENTO_TOOL_ARGS_VALIDATION | warn | tools/call 인자를 도구의 inputSchema와 대조하는 모드. `off`: 점검 생략, `warn`: 위반을 `[ToolArgs]` 경고 로그(호출자 표기 `key=`, `sid=` 앞 8자, `ua=` 앞 64자 포함)로만 남기고 통과, `enforce`: 위반 시 JSON-RPC `-32602`로 거부. 빈 문자열은 미설정과 같이 `warn`이지만 공백만 있는 값은 잘못된 값이며 `enforce`로 적용된다(`MEMENTO_CONFIG_STRICT=true`이면 기동 시 종료 코드 78). 호출 시점에 읽으므로 재시작 없이 바뀐다 |
| MEMENTO_TOOL_ARGS_ALLOW_UNKNOWN | false | `true`로 설정 시 스키마에 없는 필드를 위반으로 세지 않는다. `enforce` 모드에서 별칭 필드를 쓰는 클라이언트를 수용할 때 쓴다 |
| MEMENTO_LLM_CLI_ENV_PASSTHROUGH | (없음) | CLI provider(gemini-cli, codex-cli, copilot-cli, qwen-cli, agy-cli, opencode-cli) 자식 프로세스에 추가로 전달할 환경변수 이름(쉼표 구분). 기본으로는 PATH, HOME 등 기본 변수와 CLI별 인증 변수만 전달된다 |
| MEMENTO_LLM_CLI_TOOL_APPROVAL | none | gemini-cli, copilot-cli, opencode-cli의 도구 실행 승인 방식(`none`, `all`). 호출 시점에 읽으며 그 밖의 값은 `none`으로 처리하고 설정 문제로 기록한다. `none`: gemini는 `-y`를 붙이지 않고, copilot은 `--deny-tool=shell`, `--deny-tool=write`, `--deny-tool=url`, `--disable-builtin-mcps`, `--no-custom-instructions`를 더하며(비대화형 실행에 필요한 `--allow-all-tools`는 유지, 거부 규칙이 항상 우선), opencode는 `OPENCODE_PERMISSION={"*":"deny"}`를 넘기고, gemini는 임시 디렉터리를 신뢰 작업 공간으로 지정하는 `GEMINI_CLI_TRUST_WORKSPACE=true`를 자식 환경에 더한다. 세 CLI 모두 서버 작업 디렉터리가 아닌 빈 임시 디렉터리에서 실행한다(opencode의 `--dir`는 호출자가 지정한 `cwd`가 우선). `all`: gemini `-y`, copilot `--allow-all-tools`만 쓰고 opencode는 승인 관련 설정을 더하지 않으며 서버 작업 디렉터리에서 실행한다. gemini-cli, copilot-cli, opencode-cli를 쓰는 배포는 기본에서 제한된 호출을 받고, `all`로 설정하면 승인 제한이 없는 호출을 쓴다. codex-cli, qwen-cli, agy-cli에는 적용되지 않는다 |
| MEMENTO_REMEMBER_ATOMIC | false | true 시 remember()의 quota check + INSERT를 단일 트랜잭션으로 원자화. BEGIN → api_keys FOR UPDATE(quota 재검증) → INSERT → COMMIT 순서로 TOCTOU를 완전 차단. false(기본)는 선제 quota check만 수행하며 동시 요청이 드문 환경에 적합 |
| MEMENTO_REMEMBER_DUPLICATE_GUARD | false | `true`면 remember 중복 적중 시 기존 파편에 후처리, TTL 조정, 재색인을 하지 않고 `existing`, `duplicate`(same_scope, other_workspace, closed, unknown)로 알린다. 동일한 저장 두 건이 경합하면 먼저 들어간 행이 삽입의 충돌 경로에서 importance가 더 큰 값으로 올라가고 접근 시각이 갱신될 수 있다. 같은 범위(같은 workspace 또는 전역 파편) 적중은 이 값과 무관하게 응답에 `duplicate_of`(기존 파편 id)를 싣는다. `other_workspace`는 키 범위 판정(`MEMENTO_DEDUP_SCOPE=key` 또는 키 범위 색인이 남은 상태)에서만 나온다 |
| MEMENTO_API_KEY_DELETE_GUARD | true | API 키 삭제 전에 그 키의 파편과 재공고화 이력을 확인하고, 있으면 409로 거부한다. `false`면 확인 없이 삭제 |
| MEMENTO_CASE_BACKPROP_ENABLED | false | true 시 CaseRewardBackprop 활성화. case verification 이벤트마다 증거 파편 importance를 자동 역전파. 비활성 시 호출 자체가 no-op(DB·메트릭 영향 0). DAG 일관성 베이스라인 확보 후 활성화 권장 |
| MEMENTO_STORAGE | pgvector | 저장소 백엔드 이름. 현재 `pgvector` 하나이며 이 값은 동작에 영향을 주지 않는다. |
| MEMENTO_RANK_BEFORE_BUDGET | on | recall 예산 선택 스위치. `on`이면 검색 계층이 토큰 예산으로 자르지 않은 후보에 연결 파편을 합쳐 최종 점수(`computeRecallScore`)를 매긴 뒤 `tokenBudget` 안에서 고른다. 후보의 정확한 토큰 합이 예산 이하이면 상한 없이 전부 고른다(검색 순서대로 세다가 예산을 넘는 순간 멈추므로 예산이 묶이면 대략 예산만큼만 센다). 예산이 묶이면 후보는 검색 순서 상위 200건과 그 밖에서 검색 순서 절단이 고르는 파편이고, 선택은 토큰 추정값(이 요청에서 정확히 센 수, 저장된 `estimated_tokens`, 없으면 본문 길이 / 4 올림)으로 한다. 추정값은 요청의 입력만으로 정해지고 앞선 요청이 남긴 토큰 수 기억을 쓰지 않으므로 같은 요청은 페이지와 반복 호출에서 같은 결과를 낸다. 저장된 토큰 수는 예산이 묶인 recall마다 검색 순서 앞 600건까지의 id로 한 번 조회한다(`getStoredTokenCounts`, 기본 키 조회 한 번). 선택 방법: 구획(정확 일치, keywords 보조, 연결, 그 밖)마다 남은 예산에 들어가고 최종 점수가 0보다 큰 최고 점수 항목 하나를 먼저 고른 뒤 MMR 이득(관련성 0.7) 대비 토큰이 큰 순서로 채우며, 빈 집합에서 시작한 해와 같은 추정값으로 계산한 검색 순서 절단에서 시작한 해 가운데 최종 점수 합(id 순서 합산)이 큰 쪽을 쓴다. 후보가 210건(200 + 연결 파편 상한)을 넘으면 해를 만들지 않고 검색 순서 절단 결과를 그대로 쓴다(선택 함수 자체의 상한은 600건). 검색 순서 절단의 파편은 정확히 세어 예산에 맞춘 확인된 기준 집합을 만들고, 고른 파편도 정확히 세어 합이 예산을 넘으면 확인된 기준 집합 밖의 파편부터 최종 점수 / 토큰이 가장 작은 것을 뺀다(같으면 점수가 작은 쪽, 그다음 id가 큰 쪽). 고른 해의 정확한 최종 점수 합이 확인된 기준 집합보다 작으면 확인된 기준 집합을 쓴다. 보장은 질의 종류별로 다르다: 태그 없는 검색(keywords 정확 일치와 보조 태그가 없는 경우)은 절단 경계까지 superseded를 포함해 정확히 세므로 확인된 기준 집합이 `off`의 절단과 같고 최종 점수 합이 `off` 이상이다. 태그 검색은 확인된 기준 집합 이상만 보장하며, 저장 토큰 수가 섞인 시드 시험에서 `off` 절단보다 작은 경우가 약 1.2%(692건 중 8건, 모두 superseded 포함 조회)였다. 저장된 토큰 수는 선택에만 쓰고 응답에 싣지 않으며 `off` 경로는 읽지 않는다. 연결 파편은 검색 순서 절단이 고르는 후보를 기준으로 조회하고 예산 안에서 함께 고르며, 예산 선택에 들어간 후보 수와 고른 수를 `search_events.candidate_count`, `budget_kept`(마이그레이션 051)에 기록한다. `off`이면 검색 계층이 정확한 토큰 수로 검색 순서대로 예산을 자른 뒤 연결 파편을 예산 밖에서 더한다. 후보 전체가 예산 안이면 `on`과 `off`의 결과가 같고, 다른 경우는 다음과 같다: 예산이 묶일 때 검색 순서 200위 밖이면서 검색 순서 절단이 고르지 않는 후보는 선택 대상이 아니다, 연결 파편도 예산을 쓰므로 검색 후보만 예산 안이고 연결 파편까지는 넘으면 `on`은 일부를 빼고 `off`는 예산을 넘겨 돌려준다, 캐시를 거쳐 들어온 superseded 파편은 `on`의 `totalTokens`에 들어가지 않는다(`off`는 반환하지 않는 그 파편의 토큰도 센다), `MEMENTO_SYMBOLIC_CBR_FILTER`와 `caseId`를 함께 쓰면 연결 조회 기준이 CBR 필터 앞의 후보다(`off`는 필터 뒤). 마이그레이션 051은 코드보다 먼저 또는 함께 적용한다. 적용 전에는 검색 이벤트가 두 열 없이 기록되고(경고 한 번, 5분마다 열을 다시 확인) 적용하면 재시작 없이 두 열이 채워진다. 호출 시점에 읽는다 |
| MEMENTO_LEXICAL_CHANNEL | on | 본문 어휘 채널 스위치. `on`이면 본문을 쓰는 저장 경로(remember, batch_remember, 본문을 바꾸는 amend, reflect, 가져오기, 분할)가 본문의 형태소 토큰(MorphemeTokenizer의 한글 형태소, 영문 어간, 한자, 가나 토큰을 소문자로 정리하고 어미 조각을 뺀 것과 3자리 이상 숫자)을 공백으로 이어 `fragments.content_tokens`(마이그레이션 053, `to_tsvector('simple', ...)`)에 같은 문장으로 기록한다. 토큰화는 본문 앞 2000자만 하고, 공백 없이 200자를 넘게 이어진 한글, 한자, 가나 연속이 있는 본문은 토큰화하지 않고 NULL로 둔다(`memento_lexical_tokenize_skipped_total{reason="long_run"}`). 열 확인 질의가 실패하면 토큰 없이 저장한다(`reason="probe_error"`). batch_remember는 트랜잭션을 열기 전에 토큰화한다. 검색 쪽은 recall이 연 검색에서만 동작한다(충돌 탐지, 자동 링크 같은 저장 경로의 내부 검색은 부르지 않는다). 질의를 같은 방법으로 토큰화해 최대 32개 토큰의 OR tsquery(토큰마다 작은따옴표로 감싸고 작은따옴표와 역슬래시는 두 번 쓴다)를 만들고, 키, workspace, agent 범위와 검색 필터(type, topic, caseId, resolutionStatus, phase, affect, isAnchor, timeRange, superseded 포함 여부) 안에서 `content_tokens`가 일치하는 행을 400건까지 읽은 뒤 그 안에서 `ts_rank_cd` 순 상위 200건을 RRF의 `lexical` 계층(가중 `lexicalWeightFactor`)으로 더한다. 읽는 400건은 순서 없이 처음 찾은 행이므로 일치 행이 많으면 순위가 그 표본 안에서 정해진다. 전역 문서 빈도 통계는 쓰지 않으므로 다른 키의 자료가 순위에 영향을 주지 않는다. 질의 하나는 `MEMENTO_LEXICAL_TIMEOUT_MS`를 넘으면 취소되고 그 요청에서만 채널이 빠진다(`memento_lexical_channel_skipped_total{reason}`). 채널은 순위에 RRF 입력으로만 기여하며 recall 최종 점수는 바꾸지 않는다. 임베딩이 꺼진 설치에서는 다른 계층에 없는 어휘 후보만 결과 뒤에 붙는다. `content_tokens`가 NULL인 행(채우기 전의 기존 행)은 채널에서 빠지며 `scripts/backfill-content-tokens.mjs`로 채운다. 채널은 `content_tokens`의 유효한 GIN 색인(이름이 아니라 정의로 찾는다. 기본 이름 `idx_fragments_content_tokens`, `scripts/ops/online-index.mjs`가 만든다)이 있을 때만 참여하고, 열이 없거나 색인이 없거나 무효이면 참여하지 않는다(각 경고 한 번, 상태는 60초마다 다시 읽는다). 열이 있으면 저장 경로는 색인과 무관하게 토큰을 쓴다. garu-ko는 한 음절 형태소를 내지 않으므로 한 음절로만 나뉘는 낱말(예: 이어하기, 백필)은 토큰이 없어 이 채널로 찾지 못한다. 채움 비율은 `memento_lexical_tokens_coverage_ratio`와 `memento_lexical_tokens_missing`(라벨 없음)으로 본다. `off`이면 채널과 기록을 모두 끈다. `off` 동안 저장하거나 본문을 바꾼 행은 NULL이거나 이전 본문의 토큰으로 남으므로 다시 켤 때 백필을 `--restart`로 실행한다. 호출 시점에 읽는다 어휘 채널에서만 찾은 후보(다른 채널이 찾지 않은 후보)는 키워드 일치 항목을 비롯한 다른 채널 후보 뒤에서 순위와 토큰 예산을 받으므로 다른 채널의 상위 결과를 밀어내지 않고 남은 자리만 채운다. |
| MEMENTO_LEXICAL_TIMEOUT_MS | 120 | 본문 어휘 질의 하나의 시간 상한(ms, 질의 트랜잭션의 `statement_timeout`). 넘으면 그 요청에서 어휘 채널을 빼고 `memento_lexical_channel_skipped_total{reason="timeout"}`에 센다. 10 이상 10000 이하의 정수만 받고 그 밖은 기본값이다. 호출 시점에 읽는다 |
| MEMENTO_RANKING_FIX_V2 | on | `on`이면 RRF 중복 후보의 의미·어휘·리랭커 증거를 손실 없이 합치고 lexical-only 여부를 음수 점수 대신 별도 순위 계층으로 처리한다. `off`는 긴급 롤백용으로 기존 마지막 값 우선 병합과 감산 순위를 사용한다. 호출 시점에 읽는다 |
| MEMENTO_KEYWORD_SEMANTIC_FALLBACK | true | `false` 설정 시 text 없는 keywords-only recall의 L3 시맨틱 보조 경로를 비활성화. 활성 시 정규화된 keywords 합성 텍스트 임베딩 1회가 L2와 병렬 수행되어 저장 keywords에 없는 용어도 content 기반으로 회수된다 |
| MEMENTO_KEYWORD_FALLBACK_TIMEOUT_MS | 1500 | keywords 보조 L3 실행 상한(ms, 100~60000 클램프). 초과 시 빈 결과로 대체하고 searchPath에 `L3kw:timeout`을 남긴다 |
| MEMENTO_CONTEXT_ANCHOR_LIMIT | 20 | context 응답에 항상 포함되는 앵커(isAnchor) 파편의 전체 최대 개수. 종전 기본값 10에서 20으로 변경되었다. 1~30 범위로 클램프되며 파싱 실패 시 20. 앵커는 tokenBudget 절삭 대상이 아니므로 이 개수 상한이 유일한 주입량 제한이다. 종전 주입량이 필요하면 10으로 설정한다 |
| MEMENTO_CONTEXT_ANNOTATE | on | context 주입 줄 주석 스위치. `on`이면 `injectionText`의 기억 줄(앵커, core, learning, working) 끝에 ` (YYYY-MM-DD, assertion)`을 붙인다. 날짜는 UTC 기준 저장일(`created_at`, 작업 기억 항목은 추가 시각)이고 상대 날짜는 쓰지 않는다. assertion은 저장된 `assertion_status`가 `observed`, `inferred`, `verified`, `rejected` 중 하나일 때만 싣고, 없으면 날짜만 쓴다. 헤더 문자열(`[ANCHOR MEMORY]`, `[CORE MEMORY]` 등)과 줄 머리 `- `는 바뀌지 않는다. 날짜는 UTC 자정을 경계로 바뀌므로 한국 시각 00:00부터 08:59 사이에 저장한 기억은 전날 날짜로 표시된다(시간대 설정은 없다). `on`이면 비앵커 파편 선택이 기억 줄마다 주석 고정 비용 6(가장 긴 주석 23자를 문자 수 / 4로 올림한 값, `MEMENTO_PROVENANCE=on`이면 출처 꼬리 `, external_content` 18자를 더한 41자의 11)을 더해 `tokenBudget` 안에서 고르므로, 같은 예산에서 고르는 파편이 `off`보다 적을 수 있다. 앵커와 최소 보장 슬롯은 예산과 관계없이 들어간다. `totalTokens`는 본문만 센다. 앵커 응답 파편의 필드는 그대로다. `off`이면 줄이 본문으로 끝난다. 호출 시점에 읽는다 |
| MEMENTO_CONTEXT_WORKSPACE_ANCHOR_RESERVE | 10 | effective workspace가 있는 context에서 해당 workspace의 importance 상위 anchor에 먼저 예약할 슬롯 수. 미설정 시 total/2를 내림한 값(최대 10)으로 유도되므로 기본 total 20에서는 10, total 10에서는 5다. 명시값은 0 이상 total 이하여야 하며 잘못된 값은 서버 기동 검증에서 실패한다. workspace가 없으면 적용하지 않는다 |
| MEMENTO_RECALL_MIN_SIM_FLOOR | (없음) | `SearchParamAdaptor.getMinSimilarity`가 반환하는 적응형 임계값에 옵트인 하한을 강제. 예: `0.45` 설정 시 학습값이 0.45 미만이어도 0.45 반환. 미설정 시 기존 동작 그대로 |
| MEMENTO_RECALL_MIN_SIM_CEIL | (없음) | `SearchParamAdaptor.getMinSimilarity`가 반환하는 적응형 임계값에 옵트인 상한을 강제. 병합 결과 건수(L1/L2/L3/lexical) 평균이 8을 넘으면 학습값이 오르기만 해서 0.60 상한에 고착될 수 있고, 이때 시맨틱 계층에서 정답이 잘린다. 예: `0.40` 설정 시 반환값은 최대 0.40. 하한도 설정되어 있으면 하한이 우선. 미설정 시 기존 동작 그대로 |
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
| MEMENTO_SESSION_KEY_RECHECK_MS | 30000 | 세션 사용 시 API 키 상태를 다시 읽는 주기(ms). 비활성, 삭제, 폐기, 만료된 키의 세션, 키의 허용 대역(`allowed_cidrs`) 밖 주소에서 온 세션 요청, 키 회전의 겹침 종료 시각보다 먼저 만든 세션은 닫고(legacy SSE 세션 포함), 권한 변경은 열린 세션에 반영된다. `0`이면 재확인하지 않는다. 0 이상의 정수만 받고 그 밖은 기본값이다 |
| MEMENTO_KEY_ROTATION_GRACE_HOURS | 24 | 키 회전(`POST /keys/:id/rotate`)에서 요청 본문에 `graceHours`가 없을 때 이전 키가 계속 인증되는 시간. `0`이면 회전 즉시 이전 키를 거부한다. 호출 시점에 읽는다. 0 이상 720 이하의 정수, 그 밖의 값은 24 |
| MEMENTO_KEY_LAST_USED_INTERVAL_SEC | 60 | API 키의 `last_used_at`과 `last_used_ip_hash`(요청 주소의 HMAC 지문, 마스터 키를 비밀값으로 쓴다)를 키마다 이 간격(초)에 한 번만 쓴다. 일일 사용량(`api_key_usage`)은 요청마다 더한다. `0`이면 요청마다 쓴다. 프로세스마다 따로 센다. 호출 시점에 읽는다. 0 이상 86400 이하의 정수, 그 밖의 값은 60 |
| MEMENTO_SEGMENT_IDLE_MS | 2700000 | 세션 유휴 시간이 이 값(ms)을 초과하면 다음 도구 호출 시 세그먼트를 회전한다. 기본 45분 |
| MEMENTO_SEGMENT_MAX_AGE_MS | 43200000 | 세그먼트 시작 후 이 값(ms)을 초과하면 유휴 여부와 무관하게 세그먼트를 회전한다. 기본 12시간 |
| MEMENTO_SEGMENT_MIN_ACTIVITY | 3 | 세그먼트 회전 시 직전 세그먼트에 대한 AutoReflect 발동에 필요한 세그먼트당 최소 활동(파편+도구 호출) 수 |
| MEMENTO_WORKSPACE_GATE | false | `true` 시 `fragmentHasWorkspace` 위반(workspace가 명시값·키 default 어느 쪽으로도 해석되지 않음)을 hard gate 대상에 포함한다. 기본은 경고만 남기고 저장을 차단하지 않는다. `MEMENTO_SYMBOLIC_POLICY_RULES` 활성화 및 `api_keys.symbolic_hard_gate=true`인 키에서만 실제 차단으로 이어진다 |
| MEMENTO_WRITE_GATE | on | 의미 쓰기 관문 스위치. `on`이면 remember, amend, batch_remember, reflect 파생 쓰기, AutoReflect, admin 가져오기, CLI 가져오기, CLI remember 로컬 모드, 통합 분할 자식이 모두 같은 관문(정규화, 민감 정보 마스킹, 유형별 길이 상한, PolicyRules, workspace 허가, 앵커 권한)을 트랜잭션 밖에서 거친다. 위반은 `validation_warnings` 경고로 남고 `api_keys.symbolic_hard_gate=true` 키에서만 거부한다. `off`이면 진입점별 기본 단계만 적용한다(remember는 전체, amend는 수신 상한과 키워드 정규화, batch_remember와 reflect와 CLI remember는 정규화, 마스킹, 절삭, 가져오기와 통합 분할 자식은 없음). `off`도 가져오기와 CLI remember 로컬 모드의 기록 경로는 바꾸지 않는다(FragmentWriter 중복 판정, 유형별 importance 상한, 본문 전체 sha256 content_hash는 스위치와 무관하게 적용된다). 호출 시점에 읽는다 |
| MEMENTO_SENSITIVE_SCAN | mask | 쓰기 값의 비밀과 개인정보 탐지 방식. 대상은 content, topic, contextSummary, goal, outcome(갱신은 context_summary)과 keywords 배열이며 keywords는 소문자로 정규화하기 전의 값을 검사한다. `mask`이면 규칙 표(sk-ant-, sk-proj-, 일반 sk-, GitHub ghp_ gho_ github_pat_, AWS AKIA ASIA, Slack xox 토큰, JWT, PEM 개인 키 블록, mmcp_ 키, Bearer 토큰, 주민등록번호, 카드 번호, 이메일, 비밀번호 필드, 휴대전화 번호)에 일치한 값을 표식으로 바꿔 저장한다. 이메일과 휴대전화 번호는 가리기만 하고, 그 밖의 탐지는 규칙 이름과 필드 이름만 `validation_warnings`(`sensitive.<규칙>`)에 남긴다. 일치한 문자열은 기록하지 않으며 저장된 파편의 `validation_warnings` 열에도 규칙 이름만 저장된다. `sensitive.*` 경고는 알림이고 서버가 이미 가렸으므로 재시도하지 않는다. `api_keys.symbolic_hard_gate=true` 키는 고신뢰 규칙(이메일과 휴대전화 번호를 뺀 모든 규칙: 비밀번호 필드, API 키 패턴, 토큰, 개인 키, 주민등록번호, 카드 번호)의 탐지에서 쓰기를 거부한다(`-32003`). hard gate 키를 쓰는 배포는 업그레이드 전에 클라이언트가 `-32003`의 `sensitive.*` 위반을 처리하는지 확인하고, 가리기만 원하는 키는 `symbolic_hard_gate`를 끈다. 주민등록번호는 검증 자릿수가 맞는 값을 탐지하고, 검증 자릿수 요건의 예외로 하이픈 형식에서 성별 자리가 3 또는 4이며 생년월일이 2020-10-01부터 오늘까지인 값도 탐지한다(이 시점부터 발급된 번호는 임의 숫자라 검증 자릿수가 없다). 카드 번호는 발급사 앞자리와 Luhn을 통과한 13~19자리이고, 구분자 없는 연속 숫자는 앞뒤 24자 안에 카드 단어(card, 카드, visa, mastercard, amex, cvc, cvv, 신용)가 있어야 하며 13자리 바코드(880 시작 또는 EAN-13 검증 자릿수 일치)는 제외한다. PEM 개인 키는 머리말 뒤에 base64 40자 이상의 본문이 있을 때만 가리고(줄바꿈이 공백이나 이스케이프된 `\n`으로 바뀐 한 줄 키 포함), 닫는 표지가 없으면 머리말과 이어지는 base64 줄까지만 가린다. `reject`이면 모든 키(마스터 키 포함)가 같은 고신뢰 탐지에서 거부한다(dryRun은 거부하지 않고 규칙 이름만 돌려준다). `off`이면 새 규칙과 content 밖 필드 검사를 끄고 레거시 규칙(API 키, 이메일, 비밀번호 필드, 휴대전화 번호)만 content에 적용하며, 관문과 세션 범위 remember, reflect 항목, 분할 생성 경로가 모두 같다. `MEMENTO_WRITE_GATE=off`이면 이 값과 관계없이 `off`로 동작한다. 로그 마스킹은 같은 규칙 표의 로그용 항목을 쓴다. 호출 시점에 읽는다 |
| MEMENTO_PROVENANCE | on | 파편 출처와 신뢰 등급 스위치. `on`이면 의미 쓰기 관문이 생성 파편에 `origin`(클라이언트가 주장한 출처: `user_stated`, `agent_inferred`, `tool_output`, `external_content`, `consolidation`, `import`), `observed_client`(서버가 관측한 initialize `clientInfo.name`을 ASCII 영숫자, 공백, `. _ : + -`로 줄인 64자 이하 토큰과 쓰기 진입점 이름, 예: `claude-code/remember`), `trust_tier`(0 격리, 1 낮음, 2 보통, 3 높음)를 싣는다. 클라이언트 주장은 remember와 batch_remember 항목의 `origin` 인자로만 받고, 가져오기는 `import`, 통합 분할과 AutoReflect는 `consolidation`으로 서버가 정한다. 등급은 주장 출처의 등급(user_stated 3, external_content 1, 그 밖 2, 주장 없음 2)과 키 상한 중 작은 값이다. 키 상한은 키 권한 목록에 `trusted_origin`이 있거나 마스터 키이면 3, 그 밖은 2다. `assertionStatus`(verified 포함)는 등급에 쓰지 않고 amend는 등급을 바꾸지 않는다. 등급 1 이하 파편은 context의 ANCHOR와 CORE 주입에서 빠진다. recall 응답 파편에는 `origin`, `trust_tier`가, 답 꾸러미 여는 줄에는 `origin=`이, context 주입 줄 주석에는 출처 값이 붙는다(값이 있을 때만). core는 등급을 확인하지 못한 파편(조회 실패, 조회 결과에 없는 id)도 빼고 `_meta.coreSelection`과 `memento_context_core_trust_excluded_total{reason}`에 남긴다. 통합 분할 자식은 부모 등급을, 모순 감사 파편은 두 원본 중 낮은 등급(확인하지 못하면 1)을 키 상한으로 받는다. AutoReflect와 reflect 파생 파편의 상속은 하지 않는다. `trust_tier`가 NULL인 기존 행은 2로 해석하며 일괄 백필하지 않는다. 열은 migration-057이 더한다. `off`이면 세 열을 쓰지도 읽지도 않아 응답과 주입이 켜기 전과 같다. 호출 시점에 읽는다 |
| MEMENTO_REVIEW_QUEUE | on | 비차단 검토 대기열 스위치. `on`이면 의미 쓰기 관문이 remember, batch_remember, reflect, amend의 쓰기 중 검토 규칙에 걸린 것을 거부하지 않고 `review_state='pending'`, `review_reason`(사유 목록)으로 저장한다. 규칙은 응답 전에 판정되는 동기 규칙만이다: 본문, 맥락 요약, 목표, 결과, 토픽의 에이전트 지시 덮어쓰기 문구(이전 지시 무시, 시스템 프롬프트 재정의, 대화 형식 표지 같은 좁은 규칙. 일반 절차문은 대상 아님, `instruction_override`), 신뢰 등급 1 이하의 앵커와 preference와 procedure(`low_trust_directive`, 생성만), 앵커 권한 경고 기간에 일반 파편으로 낮춰 저장된 무권한 앵커 요청(`anchor_unauthorized`). 사유는 응답의 `validation_warnings`에 `review.<사유>`로도 실리며 hard gate 거부 대상이 아니다. 검토 대기 파편은 쓴 키의 recall에 `pending_review: true`, `low_trust: true` 표지와 함께 보이고, 다른 키(키 그룹 포함)와 마스터 키의 recall, id 조회, 대체 체인, 연결 확장, topic 제안, ANCHOR와 CORE와 작업 기억 주입, 앵커 자동 승격, 모순 해소에서는 빠진다. 거절 파편도 같은 규칙이라 `includeSuperseded` 조회에서도 쓴 키에게만 보인다(`review_rejected: true`). 키 권한 목록의 `review_off` 표지는 그 키의 표지를 끄고, `review_all`은 그 키의 모든 쓰기를 검토 대기로 둔다(`mode_all`). 표지가 없는 키와 마스터 키는 flagged 방식이다. 비밀과 개인정보는 검토 대상이 아니며 민감 정보 단계에서 먼저 가려지거나 거부되므로 검토 대기 파편에 원문이 남지 않는다. 관리 API `/review`에서 승인(`approved`)하거나 거절(`rejected`, `valid_to` 설정)하며 결정은 `memory_review_decisions`와 감사 기록에 남는다. 승인은 보류한 앵커 요청을 결정 시점 판정(키 권한 목록에 `anchor` 또는 `admin`, 마스터 키는 허용)을 통과할 때만 적용하고, 무권한 앵커 요청(`anchor_unauthorized`)은 관리자가 `applyAnchor: true`를 명시할 때만 적용한다. 30일 동안 결정되지 않은 파편은 자동 거절된다. 열과 표는 migration-057, 058이 더한다. `off`는 새 쓰기에 표지를 다는 일만 멈춘다. 이미 검토 대기나 거절인 파편의 가시성 술어(review_state가 NULL인 행은 모두 통과)와 30일 자동 거절, 대기 파편의 앵커 보류는 그대로다. 완전한 되돌림은 코드 되돌림이며, 이전 판은 `review_off`, `review_all` 표지가 있는 키의 권한 편집을 거부하므로 되돌리기 전에 표지를 지운다. 호출 시점에 읽는다 |
| MEMENTO_ANCHOR_PERMISSION | warn | 앵커 권한 집행 방식. remember(`isAnchor=true`), batch_remember 항목(`isAnchor=true`), amend(앵커가 아닌 파편을 `isAnchor=true`로 바꾸는 경우)의 앵커 지정은 master 키와 `api_keys.permissions`에 `anchor`(또는 `admin`)가 있는 키만 할 수 있고, 키의 살아 있는 앵커 수가 `MEMENTO_ANCHOR_LIMIT_PER_KEY`에 이르면 더 지정할 수 없다. `warn`이면 그런 요청은 일반 파편으로 저장되고(amend는 is_anchor만 바꾸지 않고 나머지 변경은 반영한다) `validation_warnings`에 `anchorPermissionRequired`, `anchorLimitExceeded`, `anchorLookupFailed` 중 하나가 남으며 `memento_anchor_decision_total{outcome="downgraded"}`가 오른다. 이 경고는 hard gate 키에서도 거부 사유가 아니다. `enforce`이면 같은 요청을 거부한다(remember는 JSON-RPC `-32003`, `error.data.violations`에 같은 규칙 이름. amend는 `policy_violation: <규칙>` 도구 오류 응답. batch_remember는 그 항목만 실패로 돌려준다). 앵커 표시를 내리는 amend는 판정하지 않는다. 지정과 해제 판정은 감사 로그에 `anchor` 줄(진입점, 판정, 사유, 행위자 키)로 남는다. context의 `[ANCHOR MEMORY]` 줄에는 키 이름 대신 비식별 주체 표지(`[k:` + 키 id sha256 앞 4자 `]`, master 앵커는 `[master]`)를 붙이고 응답의 앵커 파편에 같은 값을 `principal`로 싣는다. `off`이면 write 권한만으로 앵커를 지정하고 상한, 경고, 감사 줄, 표지를 적용하지 않는다. `MEMENTO_WRITE_GATE=off`이면 쓰기 판정은 하지 않는다(표지는 이 값을 따른다). 가져오기(소유자 경로)와 서버 내부 경로(자동 앵커 승격, 분할)는 판정하지 않는다. 호출 시점에 읽는다 |
| MEMENTO_ANCHOR_LIMIT_PER_KEY | 1000 | 키별 살아 있는(`valid_to IS NULL`) 앵커 수 상한. 키의 앵커 수가 이 값에 이르면 그 키의 새 앵커 지정은 `MEMENTO_ANCHOR_PERMISSION`에 따라 일반 파편으로 저장되거나 거부된다. 쓰기 트랜잭션 안에서 키의 `api_keys` 행 잠금 아래 다시 세므로 동시 요청에서도 넘지 않는다. 자동 앵커 승격은 이 상한을 보지 않는다. master 앵커(key_id 없음)와 master 키의 지정에는 적용하지 않는다. 기본값은 출고 시점의 어느 키도 넘지 않도록 정한 값이다. 모든 키에 같은 값을 쓴다. 1 이상의 정수만 받고 그 밖은 기본값이다. 호출 시점에 읽는다 |
| MEMENTO_WM_PG_FALLBACK | on | 작업 기억 PostgreSQL 대체 경로 스위치. `on`이면 Redis가 준비되지 않았을 때 `remember(scope=session)`가 같은 의미 쓰기 관문을 거친 뒤 `fragments`의 작업 기억 행(`source=wm-fallback`, `ttl_tier=short`, `session_id` 지정, 조회 대상에서 빠진 상태)으로 저장된다. `context`의 WORKING 구획, 세션 종합(`reflect`의 `sessionId`), 소비된 항목 제거, 에이전트 삭제가 같은 행을 읽고 지운다. Redis가 준비되어 있어도 같은 세션의 행이 있으면 Redis 항목과 합쳐 읽는다(Redis 쓰기가 실패해 행으로 간 항목, Redis가 끊겼다 돌아온 뒤의 끊긴 동안 쓴 항목). 합칠 때 id가 같거나 같은 에이전트, 키의 같은 본문이면 한 번만 둔다. 이 읽기의 추가 비용은 `idx_fragments_session_id`를 타는 조회 한 번이며 행이 없으면 Redis만 쓴 때와 결과가 같다. 행은 `recall`(닫힌 파편 포함 조회 포함), 그래프 탐색, 통합, 할당량 집계, 관리 화면 집계와 목록, CLI `stats`, 내보내기, 기동 점검 수치에 나타나지 않고, 읽을 때 생성 24시간 이내만 보며, 정리 주기가 24시간 지난 행을 100행씩 별도 트랜잭션으로(잠금 대기 3초, 한 번에 최대 50묶음) 지운다. 정리가 실패해도 일반 파편 정리는 계속된다. 세션 종합(`reflect`의 `sessionId`)은 세션 ID가 같아도 호출한 키(키가 없으면 `key_id`가 없는 항목)와 에이전트(해당 agent와 default) 범위의 항목만 모으고 evict한다(Redis 항목도 같다). master 키도 같아서, `context`의 WORKING 구획은 master에게 세션의 모든 키 항목을 보여 주지만 세션 종합은 `key_id`가 없는 항목만 모은다. `memory_stats`와 원격 CLI `stats` 수치도 이 행을 세지 않는다. 세션 종료 때 지우는 호출자는 없다(Redis 경로와 같다): `reflect`가 소비한 항목은 제거되고 나머지는 24시간 뒤 정리된다. 세션당 보관량은 Redis 경로와 같은 토큰 상한(500)과 행 수 상한(100)으로 줄이고, 키별 상한은 `MEMENTO_WM_FALLBACK_MAX_ROWS`가 정하며 행 수를 먼저 세고 넘는 만큼만 오래된 행부터 지운다. 작업 기억은 DB에 있으므로 여러 서버 프로세스가 공유하고 재시작 뒤에도 남는다. 응답은 `working_memory`(`redis`, `postgres-fallback`, `none`)로 저장 경로를 알리고 대체 경로이면 `_meta.hints`에 `working_memory_fallback`을 싣는다. `off`이면 Redis가 준비되지 않은 동안 `scope=session` 쓰기를 저장하지 않고 `working_memory=none`과 `working_memory_unavailable` 힌트로 알린다. `on`이어도 DB 쓰기를 받지 못하면(풀 없음) 같은 `none`과 힌트로, 저장하지 못했다는 사유를 알린다. 호출 시점에 읽는다 |
| MEMENTO_WM_FALLBACK_MAX_ROWS | 2000 | 작업 기억 대체 경로의 키별 행 수 상한. 키 하나(키 없는 요청은 한 묶음)의 행이 이 값에 닿으면 새 행을 쓰기 전에 그 키의 가장 오래된 행부터 지운다(거부하지 않는다). 동시 쓰기에서는 잠시 몇 행 넘을 수 있다. 1 이상의 정수만 받고 그 밖은 기본값이다. 호출 시점에 읽는다 |
| MEMENTO_DEDUP_SCOPE | workspace | 같은 본문(content_hash) 중복 판정 범위. `workspace`이면 키(마스터는 키 없음)와 workspace 단위로 판정한다. 같은 키가 다른 workspace에 같은 본문을 쓰면 별도 파편으로 저장하고, 같은 workspace나 전역(workspace 없음) 파편에 같은 본문이 있으면 그 id를 돌려준다. `key`이면 키 단위로 판정해 다른 workspace의 기존 파편 id를 돌려준다. remember, amend, batch_remember, 가져오기에 함께 적용한다. 키 범위 유일 색인(`uq_frag_hash_per_key`, `uq_frag_hash_master`, 또는 같은 정의의 `fragments_new_key_id_content_hash_idx`, `fragments_new_content_hash_idx`)이 남아 있는 키 경로는(무효 상태 포함) 값과 무관하게 키 범위로 판정한다. 새 설치와 운영 DB 모두 `scripts/ops/finish-dedup-scope.mjs --confirm`으로 그 색인을 지워야 workspace 범위가 된다(전환 절차: [operations/online-migration.md](operations/online-migration.md#중복-판정-범위-전환)). 그 색인을 지운 뒤의 `key`는 사전 조회로만 판정하므로 두 workspace에 같은 본문을 동시에 쓰면 둘 다 저장될 수 있다. 호출 시점에 읽는다 |
| MEMENTO_FORGET_CASCADE | on | forget 삭제 연쇄 스위치. `on`이면 `forget`(id, topic)이 파편을 지우는 트랜잭션에서 대상(키 범위 안)과, 그 대상을 `linked_to`에 가진 서버 기록 모순 해소 파편(topic `contradiction_audit`, `key_id` 없음)을 id 오름차순으로 잠근 뒤 함께 지우고, 같은 문장에서 지운 파편을 `source_fragment_id`로 가진 `case_events`의 `summary`를 `[삭제됨]`으로 바꾼다. 이벤트 행, 유형, 순서, 엣지는 남는다. 커밋 뒤 지운 id 전체의 `fragment_links` 행과 다른 파편 `linked_to`의 참조를 지운다. 응답에는 `purged`(`case_summaries`: 바꾼 요약 수, `audit_fragments`: 함께 지운 해소 기록 수)가 실린다(삭제 단계까지 간 응답에만, 없음, 권한 없음, permanent 보호 응답에는 없다). 새 모순 해소 기록은 두 파편의 본문 대신 id를 담는다. 요약 조회는 `idx_ce_source_fragment_id`(migration-054)를 쓴다. `off`이면 `forget`이 파편 행과 링크만 지우고 요약과 해소 기록이 남으며, 해소 기록은 두 파편 본문의 앞 80자를 담고 응답에 `purged`가 없다. 원본 파편이 없는 요약(스위치가 꺼진 동안의 `forget`, 만료 정리, 병합이 남긴 요약)은 `scripts/purge-orphan-case-summaries.js`로 정리한다([cli.md](cli.md)). 해소 기록인 대상은 자기 행만 지우고, 해소 기록끼리의 `linked_to`(같은 topic 자동 연결)로는 번지지 않는다. 스위치가 꺼진 동안 기록된 해소 기록은 본문 앞 80자를 담고 가리키는 파편이 지워질 때 함께 지워지며, 가리키던 파편이 이미 지워진 해소 기록은 `linked_to`에서 그 id가 빠져 찾을 수 없으므로 사본이 남는다. 호출 시점에 읽는다 |
| MEMENTO_LOG_STDERR | false | `true`이면 콘솔 로그를 모든 수준에서 표준 오류로 보낸다. CLI(`bin/memento.js`)는 `serve`를 뺀 명령에서 이 값이 없으면 `true`로 정해 표준 출력을 명령 결과에만 쓴다. 로거가 처음 적재될 때 읽는다 |
| EPISODE_CONTINUITY_CACHE_TTL_MS | 5000 | EpisodeContinuityService가 스코프(`agentId:keyId:scopeType:scopeValue`)별 최근 milestone 이벤트 ID를 보관하는 in-memory 캐시의 TTL(ms). 삽입 순서 기반 LRU이며 최대 1000개 스코프까지 추적한다 |

#### CLI 원격 접속

| 변수 | 기본값 | 설명 |
|------|--------|------|
| MEMENTO_CLI_REMOTE | (없음) | CLI `--remote` 플래그 미지정 시 사용할 원격 MCP 서버 URL. 예: `https://memento.example.com/mcp` |
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

`api_keys.symbolic_hard_gate` 컬럼 (migration-033)으로 키 단위 hard gate 전환 가능. 기본 false. true로 설정 시 PolicyRules violations 또는 고신뢰 `sensitive.*` 탐지(`MEMENTO_SENSITIVE_SCAN`) 발생 시 저장이 거부되고 JSON-RPC **프로토콜 레벨** 에러 `-32003`으로 응답한다 (MCP 도구 에러 아님, `error.data.violations: string[]` 포함). 마스터 키(keyId=NULL) 제외. 캐시 TTL 30초. 값은 admin console 키 상세의 ACCESS POLICY 또는 `PATCH /v1/internal/model/nothing/keys/:id/policy`로 바꾸며, 변경은 이 프로세스의 캐시를 비우며, 진행 중이던 조회가 이전 값을 쓸 수 있어 늦어도 약 30초 안에 적용된다.

#### 앵커 권한 이관

앵커 지정은 `anchor` 권한으로 분리되어 있다(`MEMENTO_ANCHOR_PERMISSION`). 새 키의 기본 권한(`DEFAULT_PERMISSIONS`)에는 들어 있지 않다.

- 부여 대상 확인과 부여: `node scripts/grant-anchor-permission.js`는 기본이 dry-run이며, 최근 90일 동안 앵커 파편(`is_anchor`, `created_at`)을 만든 키 목록과 키별 앵커 수, 처리(grant, skip_has_permission, skip_inactive, skip_no_write)를 JSON으로 출력하고 쓰지 않는다. 기간 안의 앵커에는 정리 작업의 자동 앵커 승격으로 앵커가 된 파편도 들어간다. `--apply`를 주면 그 키 가운데 활성(`status=active`)이고 `write`가 있으며 `anchor`가 없는 키에만 한 트랜잭션으로 `anchor`를 덧붙이고 부여한 키를 출력한다. 접속 대상은 `--url` 또는 `PGHOST`, `PGDATABASE`(필요하면 `PGPORT`, `PGUSER`, `PGPASSWORD`)이며 환경 파일은 읽지 않는다. 대상이 명시되지 않으면 실행하지 않는다.
- 순서: 배포 전에 dry-run으로 목록을 확인하고 `scripts/grant-anchor-permission.js --apply`로 부여한다. 부여 시점의 서버는 권한 판정에 `anchor` 값을 쓰지 않으므로 동작이 바뀌지 않는다. 부여부터 배포까지는 `anchor`를 가진 키의 권한을 관리 콘솔에서 바꾸는 PUT이 400을 돌려주므로 그 사이에는 권한을 바꾸지 않는다. 배포 시점에 자동 부여는 하지 않는다. 배포 뒤 `warn`(출고 값)으로 14일을 운용하며, 비부여 키의 경고(`memento_anchor_decision_total{outcome="downgraded",reason="permission"}`)가 7일 연속 0건이거나 소유자가 대상 키 목록을 확인하면 `MEMENTO_ANCHOR_PERMISSION=enforce`로 바꾼다. 되돌리려면 `off`로 둔다.
- 키별 부여와 회수: admin console 키 상세의 PERMISSIONS에서 ANCHOR를 켜고 끄거나 `PUT /v1/internal/model/nothing/keys/:id/permissions`에 `{"permissions": ["read", "write", "anchor"]}`를 보낸다. 감사 로그에 변경 전후 권한이 `admin key_permissions` 줄로 남는다. 관문은 앵커 요청마다 키 권한과 앵커 수를 조회하므로 변경은 다음 요청부터 적용된다.
- 상한의 동시성: 관문의 판정은 쓰기 트랜잭션 밖이므로, 기록 경로(remember의 두 경로, amend, batch_remember)가 쓰기 트랜잭션 안에서 키의 `api_keys` 행을 `FOR NO KEY UPDATE`로 잠그고(외래키 검사의 키 공유 잠금과 충돌하지 않는다) 살아 있는 앵커 수를 다시 센다. 동시 요청에서도 키의 앵커 수는 상한을 넘지 않는다. 상한에 이른 요청은 warn이면 일반 파편으로 저장되고(감사 로그에는 관문의 granted 줄 뒤에 reason=limit의 downgraded 줄이 남는다) enforce이면 거부된다. batch_remember는 배치 안에서도 지정 수를 이어 센다.
- 자동 앵커 승격: 정리 작업의 자동 앵커 승격(`MEMENTO_AUTO_PROMOTE_ANCHORS`)은 이 상한을 보지 않는다. 승격으로 키의 앵커 수가 상한을 넘을 수 있고, 그동안 그 키의 명시 앵커 지정은 상한 초과로 처리된다.

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

##### 외부 전송 정책

기억 내용을 LLM 제공자로 보내는 모든 호출(모순 판정 상향 `contradiction`, AutoReflect `auto_reflect`, 품질 평가 `evaluate`, 긴 파편 분할 `split`, 합성 역질의 `synthetic_query`, LLM 형태소 분석 `morpheme`)은 `lib/llm/EgressGate.js`의 관문을 지난다. 관문은 호출 문맥(단계, 키, workspace)의 정책으로 제공자 체인을 거르고, 외부 제공자에게는 `SensitiveScanner`로 가린 프롬프트를 보내며, 보내기 전에 outbox에 감사 이벤트(`audit.llm.egress`: 키, 제공자, 단계, 바이트, 가린 규칙 수, workspace. 본문은 담지 않는다)를 남긴다. 감사 기록에 실패하면 그 제공자에게 보내지 않고 다음 제공자로 넘어간다.

| 변수 | 기본값 | 설명 |
|------|--------|------|
| MEMENTO_EGRESS_POLICY | on | `on`이면 위 관문이 동작한다. `off`이면 정책 조회, 제공자 거르기, 전송 전 마스킹, 감사 이벤트, 외부 전송 지표가 모두 빠지고 구성된 체인을 그대로 쓴다(되돌리기용). 호출 시점에 읽는다 |
| MEMENTO_EGRESS_UNKNOWN_KEY | configured | 키를 알 수 없는 호출(키 문맥 없음)의 판정. `configured`는 단계 기본값을 쓰고, `local_only`는 로컬 제공자만 쓴다. master 키 호출은 키를 아는 호출이라 영향이 없다. 호출 시점에 읽는다 |
| MEMENTO_EGRESS_LOCAL_HOSTS | (없음) | 로컬 제공자로 볼 호스트 이름(쉼표 구분, 대소문자 무시). 루프백 주소(`localhost`, `127.0.0.0/8`, `::1`)는 지정하지 않아도 로컬이다. 항목은 접속 주소의 호스트와 그대로 비교하므로 이름, IPv4, 대괄호로 감싼 IPv6(`[fd00::1]`)만 쓴다. 포트, 스킴, 경로가 붙은 값이나 대괄호 없는 IPv6는 맞을 수 없어 기동 시 설정 문제(`entry_never_matches`)로 한 번 기록하고 비교에서 뺀다. DNS 이름은 적힌 그대로 믿는다: 그 이름이 실제로 운영자 망 안을 가리키는지는 운영자 책임이다. 예: 같은 망의 Ollama 호스트 |

제공자 분류: HTTP 제공자는 접속 주소(`baseUrl`)의 호스트가 루프백이거나 `MEMENTO_EGRESS_LOCAL_HOSTS`에 있으면 로컬, 그 밖(주소 없음, 해석 불가 포함)은 외부다. CLI 제공자(`gemini-cli`, `agy-cli`, `codex-cli`, `copilot-cli`, `qwen-cli`, `opencode-cli`)는 항상 외부다. 분류는 이 프로세스가 접속하는 곳을 본다. 로컬 주소의 중계 서버가 외부로 다시 보내는 구성은 로컬로 분류된다.

정책 값은 `api_keys.egress_policy`(jsonb, migration-055)에 두고 `PATCH /v1/internal/model/nothing/keys/:id/policy`의 `egress_policy` 필드로 바꾼다.

```json
{
  "local_only": false,
  "approved_providers": ["codex-cli", "ollama"],
  "workspaces": { "private-notes": { "local_only": true } }
}
```

- 필드는 모두 생략할 수 있다. `null`은 정책 없음이다. 값은 workspace 재정의, 키 값, 단계 기본값 순으로 정한다.
- 단계 기본값: 위 6개 단계(`EXTERNAL_DEFAULT_STAGES`, 늘리지 않는 고정 목록)는 정책이 없으면 구성된 제공자를 그대로 쓴다(전송 감사만 더해진다). 새 외부 전송 기능은 `lib/llm/EgressPolicy.js`의 `KNOWN_STAGES`에 `local_only` 기본값으로 단계를 더한다. 그런 단계, 등록되지 않은 단계, 단계를 밝히지 않은 호출은 로컬만 쓴다. 키나 workspace에서 `local_only: false`를 명시하면 그런 단계도 외부 제공자를 쓴다.
- 판정: 로컬 제공자는 항상 허용한다. `local_only`가 참이면 외부 제공자는 모두 막는다. `approved_providers`가 `null`(생략)이면 구성된 외부 제공자를 모두, 목록이면 목록에 든 외부 제공자만 허용한다. 문맥에 workspace가 둘 이상이면(모순 판정의 두 파편) 하나라도 막으면 막는다.
- 실패 정책: 거른 뒤 남는 제공자가 없으면 외부로 대체하지 않고 그 단계를 건너뛴다(`EgressSkippedError`). 정책을 읽지 못했거나 저장된 값이 규칙에 맞지 않을 때도 건너뛴다. 로컬 제공자가 실패해도 외부로 넘어가지 않는다.
- 키 문맥: 호출 모듈은 처리하는 자료의 키를 넘긴다(파편의 `key_id`, 세션 키, 검색 요청의 키). AutoReflect는 세션 레코드가 없으면 세션 활동 기록에 남은 키를 쓴다. master 키 호출은 정책 없이 단계 기본값을 쓴다. 그래도 키를 알 수 없는 호출(LLM 형태소 분석의 topic 이름 비교, 활동 기록도 없는 세션의 관리 콘솔 reflect)은 `MEMENTO_EGRESS_UNKNOWN_KEY`를 따른다.
- 모순 판정에서 정책을 읽지 못한 경우(`policy_unavailable`)를 포함해 건너뛴 판정은 다른 LLM 실패와 같이 "모순 아님"으로 처리되고 탐지 워터마크가 전진한다. 그 쌍은 다음 주기에 다시 보지 않는다.
- 범위: 이 관문은 `lib/llm`의 생성형 LLM 호출만 다룬다. 임베딩(`EMBEDDING_*`), 재랭커(`MEMENTO_RERANKER_*`), NLI 분류기 전송은 관문 밖이며 `local_only`가 막지 않는다. 그 경로의 외부 전송은 각 설정의 주소로 정한다.
- `MEMENTO_OUTBOX=off`이면 감사 행 없이 보내며 지표 outcome은 `sent_unaudited`다.
- 정책 조회는 키별로 30초 캐시한다. 변경은 이 프로세스의 캐시를 바로 비우고, 다른 인스턴스에는 늦어도 약 30초 안에 적용된다.

지표: `memento_llm_egress_calls_total{stage,provider,provider_class,outcome}`(outcome: `sent`, `sent_unaudited`, `denied`, `audit_failed`), `memento_llm_egress_bytes_total{stage,provider_class}`, `memento_llm_egress_skipped_total{stage,reason}`(reason: `local_only`, `not_approved`, `policy_unavailable`, `policy_invalid`), `memento_llm_egress_masked_total{stage}`(호출마다 일치한 민감 정보 규칙 종류 수. 같은 규칙의 여러 일치는 1). 관문이 보내지 않은 제공자(감사 실패, 호출 직전 거부)는 `memento_llm_provider_calls_total`의 failure로 세지 않는다.

감사 이벤트 소비: `audit.llm.egress`의 기본 처리기(`lib/llm/egress-audit-handler.js`)가 기동 시 등록되어 이벤트마다 감사 로그 파일(`LOG_DIR/audit-<날짜>.log`)에 `llm_egress` 한 줄(키 id, 단계, 제공자, 분류, 바이트, 가린 규칙 수, workspace 수, 이벤트 id; 본문 없음)을 남긴다. 같은 프로세스에서 같은 이벤트가 다시 전달되면 줄을 다시 쓰지 않고, 다른 프로세스의 재전달은 이벤트 id로 구분한다.

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

### outbox

변경 트랜잭션 안에서 이벤트를 `agent_memory.outbox_events`(migration-052)에 기록하고, 작업자(`OutboxWorker`)가 topic별 처리기로 전달한다. 처리기는 소비자 모듈이 `registerOutboxHandler(topic, handler, { maxAttempts })`(`lib/outbox/OutboxHandlers.js`)로 등록하고, 작업자는 그 프로세스에 처리기가 등록된 topic만 점유한다. 생산자와 소비자의 계약은 [internals.md](internals.md#outbox-생산자와-소비자-계약)에 있다.

| 변수 | 기본값 | 설명 |
|-|-|-|
| MEMENTO_OUTBOX | on | 기능 전체 스위치. `on`이면 `enqueue(client, event)`가 호출자 트랜잭션 안에서 행을 기록하고 작업자가 기동한다. `off`이면 `enqueue`, `enqueueStandalone`, `enqueueAutocommit`이 행을 쓰지 않고 `null`을 돌려주며 작업자도 기동하지 않는다. `off`인 동안 생산된 이벤트는 나중에 기록되지 않고 영구히 사라진다. 이미 대기 중이던 행은 지워지지 않고 다시 `on`으로 켠 뒤 전달된다. 연결과 이벤트 검사는 스위치와 관계없이 하므로 생산자 계약 오류는 `off`에서도 드러난다. 호출 시점에 읽는다(작업자 기동 여부는 기동 시점) |
| MEMENTO_OUTBOX_WORKER | on | 이 프로세스에서 작업자를 돌릴지 정하는 프로세스별 스위치. `off`여도 이 프로세스의 기록은 계속된다. 여러 인스턴스가 같은 DB를 쓰면 작업자를 돌릴 인스턴스만 `on`으로 두고 나머지는 `off`로 둘 수 있고, 모두 `on`이어도 같은 이벤트를 동시에 처리하지 않는다. 모든 인스턴스가 `off`이면 대기 행은 어느 인스턴스가 다시 켜질 때까지 쌓인다. 대기, dead-letter, 지연 게이지는 작업자를 돌리는 프로세스만 갱신한다 |
| MEMENTO_OUTBOX_MAX_ATTEMPTS | 12 | 이벤트 하나의 점유 횟수 상한. 1 이상 100 이하의 정수, 그 밖의 값은 12. 처리기 등록의 `maxAttempts`가 있으면 그 값이 우선한다 |
| MEMENTO_OUTBOX_RETENTION_DAYS | 7 | 완료한 행의 보존 일수. 1 이상 3650 이하의 정수, 그 밖의 값은 7 |
| MEMENTO_OUTBOX_UNHANDLED_DAYS | 7 | 작업자 프로세스에 처리기가 등록되지 않은 topic의 대기 행 중 한 번도 점유되지 않은 행을 dead-letter(`last_error = 'no_handler'`)로 옮기기까지의 일수. 전달 예정 시각(`available_at`)부터 센다. 판정은 작업자 프로세스마다 그 프로세스의 등록 목록으로 한다. 1 이상 3650 이하의 정수, 그 밖의 값은 7 |

동작

- 기록: `enqueue(client, event)`는 `pool.connect()`로 빌리고 `BEGIN`을 실행한 연결만 받는다. 풀 객체, 트랜잭션 블록 밖의 연결, 실패한 트랜잭션의 연결은 질의 없이 `OutboxTransactionRequiredError`로 거부한다(pg 클라이언트의 `getTransactionStatus()`가 `T`여야 한다). 행은 호출자 트랜잭션과 함께 커밋되거나 사라진다. 업무 변경 없이 남길 이벤트(관문 차단, 인증 실패)는 `enqueueStandalone(pool, event)`가 짧은 독립 트랜잭션으로 기록하고, 응답 지연이 중요한 단일 이벤트(훅 접수)는 `enqueueAutocommit(pool, event)`가 INSERT 문장 하나(자동 커밋)로 기록한다. `event`는 `topic`(점으로 구분한 소문자 조각, 64자 이하), `aggregateId`(선택, 200자 이하), `payload`(일반 객체, 직렬화 131072바이트 이하. 기억 본문 대신 해시와 길이를 담는다. 훅 회고 topic `hook.reflect`만 민감 정보를 가린 1000자 이하의 요약 후보를 담는다), `delayMs`(선택, 최대 30일)다.
- 점유: 작업자는 1초 간격(일이 있으면 쉬지 않음)으로 대기 행을 50건까지 `(available_at, id)` 순으로 `FOR UPDATE SKIP LOCKED` 점유하고, 같은 문장에서 `attempts`를 1 늘리며 `available_at`을 임대 만료 시각(60초 뒤)으로 옮긴다. 처리기를 실행하는 동안 트랜잭션이나 행 잠금을 쥐지 않는다. 여러 프로세스가 동시에 작업자를 돌려도 임대가 유효한 동안 한 이벤트를 두 작업자가 처리하지 않는다.
- 전달 보장: 최소 한 번이다. 다음 경우에 같은 이벤트가 다시 전달된다. 작업자가 처리 중에 죽으면 임대가 끝난 뒤 다른 작업자가 같은 행을 다시 점유한다. 처리기는 15초 안에 끝나야 하고, 넘기면 `signal`을 중단하고 실패로 기록하는데 처리기 자체는 멈추지 않고 계속 돌 수 있어 그 재시도와 겹칠 수 있다. 완료와 실패 기록도 백그라운드 풀 관문을 거치므로 풀이 포화되면 `DB_BACKGROUND_WAIT_MAX_MS`까지 기다릴 수 있고, 그사이 임대가 끝나면 다른 작업자가 다시 전달한다(늦은 기록은 반영되지 않고 `memento_outbox_lease_lost_total`로 센다). 소비자는 처리기에 넘어오는 `idempotencyKey`(`topic:id`)로 중복을 흡수한다.
- 묶음 중단: 남은 임대가 20초(처리기 상한 15초와 여유 5초)보다 짧거나 종료 요청을 받으면 다음 이벤트를 시작하지 않고 나머지 점유를 반납한다. 완료나 실패 기록이 오류로 끝나도 아직 시작하지 않은 점유를 반납하고 회차를 실패로 마친다. 기록 중 오류가 난 이벤트는 결과를 알 수 없어 반납하지 않으며 임대가 끝난 뒤 다시 점유된다(그 점유는 `attempts`에 이미 세었다).
- 순서: 한 묶음은 점유 순서대로 하나씩 처리한다. 묶음 사이, 작업자 사이, 같은 aggregate의 이벤트 사이의 순서는 보장하지 않으며 실패한 이벤트는 나중 이벤트보다 늦게 전달될 수 있다.
- 재시도와 dead-letter: 실패는 1초에서 시작해 실패마다 두 배(상한 30분)인 간격의 절반에서 전체 사이 시각에 다시 점유한다. 점유 횟수가 상한에 이른 실패와 처리기가 던진 `OutboxPermanentError`는 dead-letter(`dead_at`)로 남고 다시 점유하지 않으며 자동으로 지우지 않는다.
- 처리기 없는 topic: 작업자는 자기 프로세스에 처리기가 있는 topic만 점유하므로, 그 밖의 topic 행은 점유되지 않고 매 점유 질의가 훑는다. 5분마다 작업자 프로세스는 자기 등록 목록에 없는 topic의 대기 행 중 한 번도 점유되지 않았고(`attempts = 0`) 전달 예정 시각이 `MEMENTO_OUTBOX_UNHANDLED_DAYS`일 넘게 지난 행을 500건 묶음으로, 한 번에 최대 5000건까지 dead-letter(`last_error = 'no_handler'`)로 옮기고 `memento_outbox_unhandled_total`로 센다. 판정은 작업자 프로세스별이다. 작업자를 돌리는 모든 인스턴스는 모든 소비자의 처리기를 등록해야 하며, 어느 인스턴스에서 빠진 topic의 행은 다른 인스턴스에 처리기가 있어도 그 인스턴스가 먼저 처리하지 않았다면 이 기간이 지나 `no_handler`로 옮겨질 수 있다. 처리기가 하나도 등록되지 않은 프로세스는 이 판정을 하지 않는다. `no_handler` 행은 아래 SQL로 다시 대기로 돌린다.
- 보존: 5분마다 보존 기간이 지난 완료 행을 500건 묶음으로, 한 번에 최대 5000건까지 지운다.
- 상태: 15초마다 대기와 dead-letter 건수, 전달 예정 시각이 지난 대기 행 중 가장 오래된 행의 지연 초(재시도 대기와 `delayMs`로 미룬 행처럼 예정 시각이 오지 않은 행과 점유 중인 행은 넣지 않는다)를 게이지(`memento_outbox_pending`, `memento_outbox_dead_letter`, `memento_outbox_lag_seconds`)와 관리 `/stats` 응답의 `schedulerJobs.outbox`에 반영하고, 갱신 시각을 `memento_outbox_stats_updated_seconds`(유닉스 초)에 남긴다. 계수기는 `memento_outbox_{enqueued,processed,failed,dead_letter}_total{topic}`, `memento_outbox_lease_lost_total`, `memento_outbox_cleaned_total`, `memento_outbox_unhandled_total`, 분포는 `memento_outbox_delivery_seconds{topic}`(점유 전 전달 예정 시각부터 완료 기록까지)이다. topic 라벨은 처리기가 등록된 topic이고 그 밖은 `other`다.

dead-letter 행(`no_handler` 포함)은 원인을 고친 뒤 다시 대기로 돌린다.

```sql
UPDATE agent_memory.outbox_events
   SET dead_at = NULL, attempts = 0, available_at = now(), last_error = NULL
 WHERE dead_at IS NOT NULL AND topic = '<topic>';
```

되돌리지 않고 버릴 행은 id로 지운다. 감사 이벤트처럼 기록 자체를 남겨야 하는 topic이면 지우기 전에 행을 내보내 보관한다(`COPY (SELECT ...) TO` 또는 `psql \copy`).

```sql
DELETE FROM agent_memory.outbox_events
 WHERE dead_at IS NOT NULL AND id IN (<id>, ...);
```

### 훅 엔드포인트

Claude Code와 Codex의 훅이 부르는 `POST /hooks/{client}/{event}`다. `client`는 `claude-code`, `codex`, `event`는 `SessionStart`, `Stop`, `SessionEnd`이고 그 밖의 경로는 404다. 설정 예시는 [getting-started/hooks.md](getting-started/hooks.md)에 있다.

| 변수 | 기본값 | 설명 |
|-|-|-|
| MEMENTO_HOOK_ENDPOINTS | on | 훅 엔드포인트 스위치. `off`이면 `/hooks/` 아래 요청에 인증 전에 404로 응답한다. 이미 outbox에 기록된 회고 이벤트는 `off`여도 소비자가 처리한다(소비자는 스위치와 관계없이 등록된다). 호출 시점에 읽는다 |

동작

- 인증과 권한: `Authorization: Bearer <키>`를 `/mcp`와 같은 인증 경로로 확인하고 실패는 `memento_auth_denied_total`에 같이 센다. 인증 실패는 401, 인증 저장소 장애는 `MEMENTO_AUTH_STORE_UNAVAILABLE_STATUS`가 503이면 503이다. `SessionStart`는 read, `Stop`과 `SessionEnd`는 write 권한이 필요하다(403). API 키로 인증한 결과는 `MEMENTO_SESSION_KEY_RECHECK_MS`(기본 30000, 0이면 캐시하지 않음) 동안 키 문자열의 해시로 재사용한다. 재사용할 때도 키 상태 캐시로 활성 여부와 권한을 확인하고 사용량은 매번 센다. 키 상태 캐시는 같은 프로세스의 관리 라우트가 키를 바꿀 때만 즉시 무효화된다. DB를 직접 고치거나 다른 프로세스의 관리 라우트로 키를 비활성화하면, 이 프로세스에서는 비활성화된 키가 최대 `MEMENTO_SESSION_KEY_RECHECK_MS`(기본 30초) 동안 훅을 계속 접수할 수 있다. MCP 세션의 키 재확인과 같은 범위이며, 회고 소비자는 reflect 전에 키를 다시 확인하므로 비활성 키의 이벤트는 기억을 쓰지 않고 dead-letter가 된다. 일일 한도(`daily_limit`) 판정은 전체 인증 때만 하므로 훅 경로에서는 이 주기만큼 늦게 반영된다.
- 요청 한도: 이 엔드포인트 전용 한도기를 쓰며 `/mcp`, `/token`, `/authorize`와 버킷을 나누지 않는다. 인증된 요청은 키별 버킷(`RATE_LIMIT_PER_KEY`, 마스터 키는 하나의 버킷)만 쓰고, IP 버킷(`RATE_LIMIT_PER_IP`)은 인증에 실패한 요청만 센다. 인증 실패가 한도에 이른 IP는 창이 지날 때까지 인증 전에 429다(`Retry-After`). IP 단위라서 같은 공인 IP(NAT, 사내 프록시) 뒤의 사용자들은 실패 버킷을 함께 쓴다. 그 IP에서 잘못된 키 요청이 `RATE_LIMIT_PER_IP`번 실패하면 같은 IP의 올바른 키 요청도 창(`RATE_LIMIT_WINDOW_MS`)이 지날 때까지 429다. `/token`과 같은 절충이다.
- 입력 상한: `Content-Type`은 `application/json`만(415), 요청 헤더 합계 8192바이트(431), 본문 196608바이트(413), JSON 중첩 깊이 8(400), 요약 후보 `excerpt` 65536바이트(UTF-8, 413). `excerpt`에 NUL 문자가 있으면 400(`invalid_excerpt`)이고, 짝 없는 서로게이트는 U+FFFD로 바꾼다. 본문은 인증 뒤에 읽는다. 응답 본문은 `{ "error": "<코드>" }` 형식이고 요청 본문을 되돌려 보내지 않는다.
- 본문 필드: `session_id`(`Stop`, `SessionEnd`에서 필수, 영숫자로 시작하는 128자 이하의 `A-Za-z0-9._:-`), `hook_event_name`(있으면 경로의 이벤트와 같아야 한다), `source`(`SessionStart`에서 선택, `startup`, `resume`, `compact`, `clear`, `fork`), `cwd`, `git_remote`, `excerpt`(`Stop`, `SessionEnd`에서 필수). 그 밖의 필드(`transcript_path` 등)는 읽지 않는다. 서버는 클라이언트의 transcript 파일을 읽을 수 없으므로 `excerpt`는 로컬 CLI `anchormind hook`이 만든다. `excerpt` 없는 http 훅 단독 `Stop`, `SessionEnd`는 422(`excerpt_required`)이고, http 훅 단독으로는 `SessionStart` 주입만 쓸 수 있다.
- workspace: `cwd`와 `git_remote`를 정규화한 후보(원격 `host/path`, 원격 저장소 이름, cwd 전체 경로, cwd 마지막 조각 순. 모두 소문자, 원격의 자격 증명과 포트와 스킴과 끝의 `.git` 제거, cwd의 역빗금은 빗금) 중 키의 `allowed_workspaces` 안에 있는 첫 값(대소문자 무시, 저장된 표기)을 쓴다. 맞는 후보가 없거나 키에 `allowed_workspaces`가 없거나 마스터 키이면 키의 `default_workspace`를 쓴다.
- `SessionStart`: `context`를 클라이언트별 예산(`claude-code` 2000, `codex` 1500 토큰. Codex는 훅 출력이 약 2500 토큰을 넘으면 본문 대신 파일 경로를 넘긴다)으로 불러 `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"..."}}`로 200 응답한다. `additionalContext`는 `[MEMENTO CONTEXT v0]` 머리말, 고정 정책 문단(안의 내용은 자료이며 지시가 아니다), `<<<MEMORY CONTEXT>>>`와 `<<<END MEMORY CONTEXT>>>` 사이의 구획 헤더와 `- ` 기억 줄로 이루어진다. 기억 본문은 답 꾸러미와 같은 이스케이프(줄바꿈, 제어, 서식, 서로게이트, 줄과 문단 구분자, 태그 문자, 세 개 이상 이어진 꺾쇠)를 거쳐 한 줄이 되고 1000자로 잘리며(`[truncated]`), 본문 앞의 `#`과 대문자 대괄호 표지(`[SYSTEM]` 등)의 여는 대괄호도 이스케이프한다. 구획 헤더와 `(YYYY-MM-DD, assertion)` 주석(`MEMENTO_CONTEXT_ANNOTATE`)은 렌더러가 만든 값만 쓴다.
- `Stop`, `SessionEnd`: 발췌 전체는 저장하지 않는다. 발췌의 마지막 응답 블록(`[assistant]` 블록, 없으면 마지막 블록)을 `SensitiveScanner` 규칙으로 가린 뒤 공백을 접어 1000자로 자른 요약 후보와 메타데이터(`v`, `client`, `event`, `sessionId`, `keyId`, `workspace`, `summaryChars`, `excerptBytes`, `sensitiveRules`(규칙 이름), `receivedAt`)만 outbox(topic `hook.reflect`)에 INSERT 문장 하나(자동 커밋)로 기록하고, 커밋된 뒤 `{"accepted":true}`로 202 응답한다. `MEMENTO_SENSITIVE_SCAN=reject`이면 그 블록에서 규칙이 검출될 때 기록하지 않고 422(`sensitive_content`, 규칙 이름만)다. 그 밖의 값(`off` 포함)에서도 가린 값만 기록한다. 가리는 규칙은 `lib/security/sensitivePatterns.js`의 저장 경로 규칙(API 키 접두 형식, GitHub, GitLab, npm, Slack, Stripe 토큰, AWS 접근 키와 비밀 키 대입식, JWT, PEM 개인 키, mmcp 키, Bearer 값, URL의 사용자 비밀번호, 비밀 이름 대입식(`*_API_KEY=`, `*_SECRET=`, `*_TOKEN=`, `password:` 등, 숫자를 포함하거나 16자 이상인 값), 이메일, 전화번호, 검증 자릿수가 맞는 주민등록번호, Luhn이 맞는 카드 번호)이다. 이 규칙에 맞지 않는 형식(이름 없이 쓴 임의 문자열 비밀 등)은 가려지지 않는다. 완료 행은 `MEMENTO_OUTBOX_RETENTION_DAYS` 동안 남는다. outbox가 꺼져 기록하지 못하면 503이다.
- 중복과 대기 상한: 같은 키, 세션 id, 이벤트는 한 번만 회고한다. 이 프로세스가 10분 안에 접수한 키이거나 `idempotency_records`에 선점 또는 완료 기록이 있으면 기록하지 않고 `{"accepted":true,"duplicate":true}`로 202 응답한다. 키별 대기 `hook.reflect` 이벤트가 500건이면 429(`queue_full`, `Retry-After: 60`)다. 회고하는 이벤트는 `SessionEnd`다. `Stop`은 Claude Code와 Codex에서 응답마다 실행되므로 세션의 첫 `Stop`만 기록되고 그 뒤 `Stop`은 중복으로 바로 끝난다. `Stop`은 `SessionEnd`가 오지 않는 경우를 위한 보조 경로다.
- 회고 소비자: 작업자가 `hook.reflect` 이벤트를 넘기면 키를 다시 확인하고(비활성 키나 write 권한이 없어진 키는 재시도 없이 dead-letter), 멱등 키(키, 클라이언트, 세션 id, 이벤트의 SHA-256)를 `idempotency_records`(tool `hook_reflect`)에 선점한 뒤 요약 후보로 만든 episode 서사 하나로 `reflect`를 수행하고 선점을 완료로 바꾼다. 완료 기록은 30일 동안 남아 그동안 같은 세션과 이벤트를 다시 회고하지 않는다. 회고가 실패하면 선점을 풀고 outbox 재시도로 넘긴다. reflect와 완료 기록은 한 트랜잭션이 아니어서, reflect 뒤 완료 기록 전에 프로세스가 끝나면 선점이 5분 동안 남고 그 뒤 다음 전달이 넘겨받아 reflect를 다시 수행한다(같은 서사는 content_hash로 접혀 episode가 늘지 않는다). 만료된 `idempotency_records` 행을 지우는 주기 작업은 아직 없다(`IdempotencyStore.purgeExpired`는 스케줄러에 등록되어 있지 않다). 훅 행은 세션당 많아야 두 건이다.
- 지표: `memento_hook_calls_total{client,event,outcome}`(client와 event는 허용 목록 밖이면 `other`, outcome은 `context`, `accepted`, `duplicate`, `queue_full`, `not_found`, `invalid`, `sensitive_rejected`, `unauthorized`, `forbidden`, `rate_limited`, `unavailable`, `error`), `memento_hook_reflect_total{outcome}`(`reflected`, `duplicate`, `busy`, `rejected`, `failed`).
- 로그: 클라이언트, 이벤트, 상태 코드, 오류 이름과 코드만 남기고 발췌, 요약 후보, 키, 세션 id는 남기지 않는다.
- 응답 시간: 일회용 시험 DB(풀 20 연결)에서 50개 동시 요청 10회(실제 키 인증, 접수 확인, 기록) 측정은 p50 53~59 ms, p95 78~91 ms, p99 80~93 ms, 순차 요청 p50 5 ms다(`scripts/measure-hook-latency.mjs`). 운영 DB와 풀 크기에 따라 달라진다.

#### 훅 실행체가 읽는 변수(서버 설정 아님)

`anchormind hook`은 하네스가 실행하는 로컬 명령이며 서버의 `.env`나 작업 중인 저장소(cwd)의 `.env`를 읽지 않는다. 서버 주소와 키는 명령 인자 `--remote`, `--key` 또는 아래 프로세스 환경 변수에서만 읽고, 주소와 키는 언제나 같은 출처의 한 쌍으로 고른다. 이 변수들은 `.env.example`에 두지 않는다.

| 변수 | 출처 | 설명 |
|-|-|-|
| CLAUDE_PLUGIN_OPTION_SERVER_URL, CLAUDE_PLUGIN_OPTION_API_KEY | Claude Code(하네스가 넣는다) | AnchorMind 플러그인의 userConfig `server_url`, `api_key`. Claude Code가 플러그인 훅 프로세스에만 넣는다. 사용자가 직접 설정하지 않는다. 둘 다 있을 때만 쓰며 MEMENTO_CLI_* 쌍보다 앞선다. 하나만 있으면 둘 다 버리고 경고한 뒤 MEMENTO_CLI_* 쌍을 쓴다 |
| MEMENTO_CLI_REMOTE, MEMENTO_CLI_KEY | 사용자 셸 환경 | 원격 CLI 공통 변수([cli.md](cli.md#원격-접속-환경변수)). 플러그인 쌍이 없을 때 훅이 쓴다 |

플러그인 설치는 [getting-started/plugins.md](getting-started/plugins.md)에 있다.

### 감사 표

감사 대상 행위는 topic `audit.record` 이벤트를 outbox에 남기고, 감사 승격 소비자(`lib/logging/audit-consumer.js`)가 `agent_memory.admin_audit_events`(migration-056)에 하나의 순차 해시 체인으로 옮긴다. 파일 감사 로그(`LOG_DIR/audit-YYYY-MM-DD.log`)는 그대로 계속 기록된다. 두 기록을 대조하는 기간은 30일을 권장하고, 파일 로그 파일은 자동으로 지우지 않는다.

| 변수 | 기본값 | 설명 |
|-|-|-|
| MEMENTO_AUDIT_DB | on | `on`이면 감사 이벤트를 outbox에 기록하고, outbox 작업자를 돌리는 프로세스가 감사 승격 처리기를 등록한다. `off`이면 기록하지 않고 처리기도 등록하지 않는다(파일 감사 로그는 계속된다). `off`인 동안 생긴 행위는 표에 남지 않는다. 이미 대기 중인 `audit.record` 행은 처리기가 없는 topic이 되어 `MEMENTO_OUTBOX_UNHANDLED_DAYS`가 지나면 `no_handler` dead-letter로 옮겨질 수 있고, 다시 `on`으로 켠 뒤 위 SQL로 대기로 돌린다. `MEMENTO_OUTBOX=off`이면 이 값과 관계없이 기록하지 않는다. 기록 여부는 호출 시점에, 처리기 등록은 기동 시점에 읽는다 |
| MEMENTO_AUDIT_RETENTION_DAYS | 400 | 감사 행의 보존 일수(`recorded_at` 기준). 6시간마다 이 기간이 지난 앞부분을 10000건 묶음으로, 한 번에 최대 50000건까지 지운다. 묶음마다 같은 트랜잭션에서 보존 기준점 행(`audit.retention.prune`)을 체인 끝에 남긴다. 마지막 행은 지우지 않는다. 1 이상 3650 이하의 정수, 그 밖의 값은 400 |

기록 범위(행위 이름)

| 행위 | 생산 위치 | 대상 | detail |
|-|-|-|-|
| `admin.*` | 관리 API의 GET이 아닌 요청과 내보내기 GET. 응답이 끝날 때 기록한다. 행위 이름은 `lib/admin/admin-audit-actions.js`의 선언을 따르고, 선언이 없는 요청은 `admin.request`다 | 경로의 첫 변수(키, 그룹, 파편 id, 세션 id 앞 8자) 또는 처리기가 알린 생성 자원 id | `method`, `path`(질의 문자열 없이 UUID 조각을 앞 8자로 줄인 경로), `status`, 처리기가 알린 변경 값(키 정책은 `changed`, `before`, `after`, 키 수치와 상태는 `after`) |
| `admin.auth` | 관리 로그인 성공(`success`)과 실패(`denied`) | 없음 | `channel`(form, bearer). 시도한 값은 남기지 않는다 |
| `memory.remember`, `memory.amend`, `memory.forget`, `memory.link` | 기억 도구 처리기. 실패도 `failure`로 남기고 dryRun은 남기지 않는다 | 파편 id(forget의 주제 지정은 `topic`) | 본문은 `contentSha256`과 `contentLength`만, 실패는 `errorCode`만(오류 메시지는 남기지 않는다) |
| `memory.anchor` | 앵커로 저장하거나 amend가 `isAnchor`를 바꿀 때 | 파편 id | `isAnchor` |
| `gate.block` | 쓰기 관문(`WriteGate`)이 거부할 때(hard gate, `MEMENTO_SENSITIVE_SCAN=reject`, hard gate 조회 실패) | 없음 | `entry`, `op`, `rule`, `fragmentType`. 행위자는 키(키 없는 사용자 진입점은 마스터, 서버 내부 작업은 system) |
| `memory.batch_remember` | batch_remember 한 번에 이벤트 하나. 실패도 남기고 dryRun은 남기지 않는다 | 없음 | `total`, `inserted`, `skipped`, `anchors`(앵커 지정 항목 수), `async`. 본문은 남기지 않는다 |
| `memory.reflect` | reflect | 없음 | `count` |
| `memory.consolidate` | memory_consolidate(마스터) | 없음 | 결과의 최상위 수치(`expiredDeleted` 등) |
| `review.approve`, `review.reject` | 관리 API `/review/:id/approve`, `/review/:id/reject`(라우트 표 선언, 응답이 끝날 때) | 파편 id | 처리기 감사 메모 |
| `review.auto_reject` | 30일 미결정 자동 거절 주기 작업(거절이 있을 때) | 없음 | `count`, `days` |
| `llm.egress` | 외부 LLM 제공자로 보내기 전(outbox topic `audit.llm.egress`를 같은 체인으로 옮긴다) | 제공자 이름 | `stage`, `providerClass`, `bytes`, `maskedRules`, `workspaceCount`. 본문과 workspace 이름은 남기지 않는다 |
| `system.update.apply` | apply_update의 실제 적용(dryRun 제외) | 없음 | `step`, `targetVersion`, `installType` |
| `llm.egress` | 외부 전송 감사 topic `audit.llm.egress`를 감사 승격 소비자가 옮긴다 | 제공자(`llm_provider`) | `stage`, `providerClass`, `bytes`, `maskedRules`, `workspaceCount`. workspace 이름은 남기지 않는다 |
| `audit.retention.prune` | 보존 정리(행위자 system) | 체인(`audit_chain`, 경계 seq) | `boundarySeq`, `boundaryHash`(지운 마지막 행의 seq와 `row_hash`), `deleted`, `retentionDays` |

쓰기 도구 중 `tool_feedback`(사용 신호만 기록)과 `session_rotate`(세션 ID 교체, `session-audit.log`에 남음)는 감사 이벤트를 남기지 않는다. 쓰기 도구마다 감사 행위나 제외 이유를 `lib/tools/memory-audit.js`의 `TOOL_AUDIT_COVERAGE`에 적고 `tests/structure/tool-audit-coverage.test.js`가 확인한다. 감사 조회(`GET /audit`)는 읽기라 기록하지 않고, 내보내기와 검증 요청은 기록한다. 검토 결정은 그 기능의 생산자가 같은 함수(`recordAudit`, 트랜잭션 안에서는 `enqueueAudit`)로 기록한다.

detail 규칙: 키 이름이 본문이나 비밀을 가리키면(`content`, `body`, `text`, `summary`, `token`, `secret`, `password`, `authorization`, `cookie`, `credential`, `api_key`, `private_key`, `raw`를 포함하거나 `code`, `otp`, `key`, `session`, `pin`과 같으면. `errorCode`, `keyId`처럼 포함하는 이름은 받는다) 이벤트를 만들지 않는다. 단 `Sha256`, `Length`로 끝나는 키는 16진 64자와 0 이상의 정수일 때만 받는다. 문자열 값은 비밀 형식을 표식으로 바꾸고(`SensitiveScanner`) 코드 포인트 200개로 자른다. 대상 id와 workspace도 비밀 형식을 표식으로 바꾼다. 모든 문자열 값(행위자, 대상, workspace, detail)은 홀로 남은 서로게이트를 U+FFFD로 바꾼 올바른 유니코드로 만든 뒤 코드 포인트 단위로 자르므로 서로게이트 쌍이 갈리지 않고, 해시한 값과 DB에 저장된 값이 같다. 규칙을 어긴 이벤트와 outbox 기록 실패는 업무 응답을 막지 않고 경고 로그와 `memento_audit_enqueue_failed_total`로 남는다.

체인

- 행 해시: `row_hash = sha256(prev_hash + "\n" + 행 값의 정규 JSON)`. 첫 행의 `prev_hash`는 0 64개다. 정규 JSON은 키를 사전순으로 정렬하고, seq는 10진 문자열, 시각은 밀리초 ISO 문자열로 넣는다(`lib/logging/audit-chain.js`).
- 순번: 소비자는 표를 `SHARE ROW EXCLUSIVE`로 잠근 트랜잭션 안에서 마지막 행을 읽고 `seq = 마지막 + 1`로 기록한다(잠금 대기 상한 10초). 작업자가 여럿이어도 체인은 갈라지지 않는다. `source_event`(outbox 멱등 키)가 이미 있으면 새 행을 만들지 않는다. seq는 기록(커밋) 순서이고 `occurred_at`(발생 시각) 순서와 다를 수 있다. 발생 순서로 볼 때는 `occurred_at`으로 정렬한다.
- 검증: seq 연속성, `prev_hash` 연결, `row_hash` 재계산을 차례로 본다. 행 값이 바뀌면 `row_hash_mismatch`, 행이 빠지면 `seq_gap`, 이어지지 않으면 `prev_hash_mismatch`를 첫 끊긴 seq와 함께 보고한다. seq 1부터 남은 체인은 0 64개(`genesis`)를 기준점으로 삼는다. 앞부분이 지워진 체인은 남은 첫 행 바로 앞 seq를 `boundarySeq`로 가진 보존 기준점 행이 있고 그 `boundaryHash`가 남은 첫 행의 `prev_hash`와 같을 때만 그 해시를 기준점(`checkpoint`)으로 삼고, 기준점 행 자신도 체인에서 확인한다. 기준점 없이 앞부분이 사라졌거나 정리 뒤 경계 다음 행이 사라졌으면 `prefix_mismatch`다. `fromSeq`를 주었는데 바로 앞 행이 없으면 `seq_gap`이다. 마지막 행 뒤를 지운 경우는 체인만으로 알 수 없으므로 검증 결과의 `headHash`를 밖에 따로 보관해 대조한다.

조회와 검증

- 관리 API: `GET /v1/internal/model/nothing/audit`(조건 `action`, `actor`, `target_type`, `target_id`, `outcome`, `workspace`, `from`, `to`, `before`, `limit`), `GET .../audit/export?format=jsonl`(같은 조건, seq 오름차순, 줄마다 `prevHash`, `rowHash`), `POST .../audit/verify`(본문 선택 `{ "fromSeq": n, "maxRows": n }`). 자세한 형식은 [api-reference.md](api-reference.md#감사)에 있다.
- 콘솔: 사이드바의 감사 로그 화면이 조건 조회, 이어 보기, JSONL 내보내기, 체인 검증을 부른다.
- CLI: `memento-mcp audit verify [--from-seq N] [--max-rows N] [--json]`. 체인이 끊겼으면 종료 코드 1이다.
- 지표: `memento_audit_enqueue_failed_total`, `memento_audit_recorded_total`(새로 기록한 행), `memento_audit_cleaned_total`. 승격 지연과 실패는 `memento_outbox_*{topic="audit.record"}`로 본다.

### 관리자 계정

관리자 계정(로컬 계정, 비밀번호와 TOTP, DB 세션)은 `MEMENTO_ADMIN_USERS=on`(기본)이고 계정이 하나 이상 있을 때 동작한다. 계정이 없거나 `off`이면 관리면은 마스터 키(`MEMENTO_ACCESS_KEY`)만 받고 동작은 그대로다. 마스터 키 로그인은 계정이 있어도 계속 owner로 동작한다(비상 경로).

| 변수 | 기본값 | 설명 |
|-|-|-|
| MEMENTO_ADMIN_USERS | on | `on`이면 계정 로그인(`POST /auth`의 `{ username, password, totp \| recoveryCode }`), TOTP 등록(`POST /auth/totp`), 로그아웃, 계정 관리 API(`/admin-users`)를 연다. `off`이면 계정 관리 라우트는 404이고 계정 세션 쿠키를 받지 않는다. 호출 시점에 읽는다 |
| MEMENTO_ADMIN_SEAL_KEY | (없음) | TOTP 비밀 봉인 키 목록. 쉼표로 나눈 `id:키`이고 키는 32바이트(base64 또는 64자 hex), 첫 항목이 현재 키다. id 없이 키 하나만 주면 id는 `v1`이다. 봉인은 AES-256-GCM(12바이트 난수 nonce, 계정 id를 담은 AAD)이고 저장 값에 키 id가 붙는다. 미설정이면 TOTP 등록을 시작하지 않고(503 `totp_seal_key_missing`) 등록된 계정의 TOTP도 확인하지 못한다. 형식이 틀리면 값 없이 설정 문제 목록에 오르고 미설정으로 동작한다. 로그에 남기지 않는다 |

- 비밀번호: 12자 이상 256자 이하(코드 포인트), 공백만 있거나 제어 문자가 있으면 거부한다. scrypt(N=2^15, r=8, p=1, salt 16바이트, 출력 32바이트) 해시 문자열에 매개변수를 행마다 담는다. 기본값이 바뀌면 로그인 성공 때 다시 해시한다. 해시는 비동기로 돌고 프로세스 전체 동시 실행은 2, 대기열은 32이며 넘치면 503이다.
- TOTP: RFC 6238, HMAC-SHA1, 30초, 6자리, 앞뒤 한 단계까지 받는다. 받은 단계보다 큰 단계만 받아 같은 코드의 재사용을 막는다. owner와 admin 역할은 TOTP가 필수이고, 등록 전에는 로그인 응답이 등록 토큰(10분)과 비밀, otpauth URI다. 등록을 마치면 복구 코드 10개를 한 번만 보여 주고 해시만 저장한다. 복구 코드는 한 번씩만 쓴다.
- 키 회전: 새 키를 앞에 두고 옛 키를 뒤에 남긴다(`MEMENTO_ADMIN_SEAL_KEY=v2:<새 키>,v1:<옛 키>`). 옛 키로 봉인된 값은 그 계정의 다음 TOTP 로그인에서 현재 키로 다시 봉인된다. 모든 계정이 다시 로그인한 뒤 옛 키를 뺀다. 봉인 키는 서버 환경 변수와 오프라인 사본에 둔다.
- 세션: 쿠키 `mmcp_admin`(HttpOnly, SameSite=Strict, Path=관리 경로, TLS 뒤에서 Secure)과 `mmcp_csrf`. 저장소에는 토큰 해시만 둔다. 절대 만료 12시간(계열 기준), 유휴 만료 30분. 로그인은 새 계열을 만들고 요청에 있던 이전 계열을 폐기한다. 역할 변경, 비활성화, 비밀번호 변경, TOTP 초기화는 그 계정의 세션을 폐기하고, 자기 계정의 역할이나 비밀번호를 바꾸면 자기 세션은 같은 계열로 회전한다. 회전으로 폐기된 토큰이 다시 오면 그 계열 전체를 폐기한다.
- CSRF: 계정 세션의 GET, HEAD, OPTIONS 밖 요청은 `Origin`이 반드시 있어야 하고 자기 출처(Host와 프로토콜) 또는 `ADMIN_ALLOWED_ORIGINS`여야 한다. 그리고 `X-CSRF-Token` 헤더가 `mmcp_csrf` 쿠키와 같고 세션에 묶인 값이어야 한다. 마스터 키 Bearer 요청은 대상이 아니다.
- 실패 지연: 계정(이름 해시)별 연속 5회, 클라이언트 주소별 연속 20회 실패 뒤 1, 2, 4초...(최대 60초) 지연하고 그동안 429다. 없는 계정도 같은 계수와 같은 비용의 scrypt를 쓰고 같은 401 본문을 받는다. 이 지연은 `MEMENTO_ADMIN_AUTH_BACKOFF`와 관계없이 동작하며 상태는 프로세스 메모리에 있다.
- 마지막 owner: 활성 owner(전역 owner 바인딩)가 하나뿐이면 그 계정의 삭제, 비활성화, owner 제거는 409 `last_owner`다. 계정 변경은 advisory 잠금과 행 잠금 아래에서 판정한다.
- 부트스트랩: 계정이 0개일 때 마스터 키로 `POST /admin-users/bootstrap`을 불러 첫 owner를 만든다. 동시에 여러 번 불러도 하나만 성공한다(409 `already_bootstrapped`).
- 비상 복구: `anchormind admin recover [--user NAME] --confirm`이 모든 계정 세션을 폐기하고 지정한 계정의 TOTP와 복구 코드를 초기화한다. 접속 대상은 `--url` 또는 `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`로만 받고 `.env`는 읽지 않는다. 감사 이벤트 `admin.recover`(detail `priority: high`)를 같은 트랜잭션에서 outbox에 남긴다. 자세한 사용법은 [cli.md](cli.md)에 있다.
- 감사: 계정 로그인과 등록(`admin.auth`, `admin.auth.totp_enroll`), 로그아웃, 계정 관리 라우트가 감사 이벤트를 남긴다. 계정 행위자는 `actor_kind = admin`, `actor_key_id = 계정 id`이고 파일 감사 로그는 `key=admin:<계정 id>`다.
- OIDC: `admin_identities` 표(issuer, subject, user_id)가 확장 지점이며 로그인 경로는 아직 쓰지 않는다.

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
    maxDeletePerCycle      : 50,     // MEMENTO_GC_THROUGHPUT=off일 때의 1회 삭제 건수
    chunkSize              : 100,    // 만료 삭제 청크 하나의 건수
    factDecisionPolicy     : {
      importanceThreshold  : 0.2,    // fact/decision GC 기준 중요도
      orphanAgeDays        : 30      // 고립 fact/decision 삭제 기준 (일)
    },
    errorResolvedPolicy    : {
      maxAgeDays           : 30,     // [해결됨] error 파편 삭제 기준 (일)
      maxImportance        : 0.3     // 이 값 미만이면 삭제 대상
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
| `lexicalWeightFactor` | RRF에서 본문 어휘 채널(`lexical`) 레이어 가중 배수(`MEMENTO_LEXICAL_CHANNEL`) |
| `minSimilarityDelta` | 시맨틱 임계값 보정치. 적용 후 0.10~0.60으로 클램프된다 |
| `morphemeFallbackThreshold` | 형태소 보조 프로브 채택 조건(기본 L3 결과 수 상한) |
| `exactKeywordBoost` | 키워드 정확 일치 가산 |
| `lexicalWeightReranked` / `lexicalWeightFallback` | 최종 재정렬의 lexical 가중치 |

기본값은 다음과 같다.

| 프로파일 | 판정 기준 | l2 | l3 | lexical | minSimilarityDelta |
|-|-|-|-|-|-|
| `EXACT_SYMBOL` | 코드 식별자, 경로, 환경변수, 3자리 이상 수치 포함 | 1.6 | 0.9 | 1.4 | 0.0 |
| `CONCEPT_INTENT` | 의문사, 원인·방법·절차 표현, 식별자 부재 | 0.9 | 1.5 | 0.8 | -0.20 |
| `HYBRID` | 혼재 또는 판정 불가 | 1.0 | 1.1 | 1.0 | -0.06 |

`CONCEPT_INTENT`의 임계값 보정이 큰 이유는 임베딩 모델의 실제 유사도 분포 때문이다. text-embedding-3-small에서 한국어 질의와 영문 기술용어가 섞인 저장문의 패러프레이즈 쌍 코사인이 0.26 부근으로 측정되었고, 임의 파편 대비 분포는 p50 0.228 / p95 0.335였다. 기본 임계값 0.40을 그대로 쓰면 정답 파편이 후보에 진입하지 못한다.

`ranking`의 `importanceWeight` / `recencyWeight` / `semanticWeight`는 합계 1.0을 기동 게이트가 강제하므로 프로파일 조정 대상이 아니다.

효과는 `benchmark` 서브명령으로 계측한다. 100문항 골드셋 격리 모드 기준 Recall@5는 프로파일 비활성 64%에서 활성 86%로, 운영 코퍼스 경쟁 모드에서는 50%에서 76%로 측정되었다.

### syntheticQuery (합성 역질의 증강)

파편 저장 시 회상 시점에 던져질 만한 질문을 생성해 보조 벡터로 색인한다. 본문 임베딩만으로는 저장 표기와 회상 표기가 어긋날 때 후보 진입에 실패하는데, 이 경로가 그 격차를 메운다. 생성은 기존 LLM 체인(`LLM_PRIMARY` + `LLM_FALLBACKS`)에 위임하며 별도 provider나 키를 두지 않는다.

| 키 | ENV | 기본값 | 설명 |
|-|-|-|-|
| `enabled` | `MEMENTO_SYNTHETIC_QUERY_ENABLED` | `false` | 역질의 생성. 기본 비활성이며 `true`로 명시해야 워커가 기동한다 |
| `searchEnabled` | `MEMENTO_SYNTHETIC_QUERY_SEARCH` | `true` | 검색 반영. `false`면 이미 쌓인 보조 벡터를 조회하지 않는다 |
| `freshnessEnforce` | `MEMENTO_DERIVED_FRESHNESS_ENFORCE` | `true` | 현재 본문 해시와 같은 버전에서 만든 합성 질의만 검색. `false`는 긴급 롤백용 |
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

### segmentEmbedding (구간 임베딩)

최대 1000자인 파편 본문 하나를 벡터 하나로 만들면 곁다리 언급("그런데 방금 smoker를 샀어")이 본문의 주된 화제에 희석되어 질문과 멀어진다. 400자를 넘는 파편을 300자 창(150자 간격)으로 나눠 구간별 벡터를 `fragment_segment` 표에 두고, 시맨틱 검색(L3)에서 조각별 최대 유사도를 본문 후보에 합친다. 구간 유사도에는 감쇠 계수를 곱하고, 구간이 순위에 영향을 주는 조각 수에 상한을 둔다. 기본은 꺼짐이다. 켜기 전에 `npm run migrate`로 표를 만들고, 기존 파편은 `scripts/backfill-fragment-segments.js`로 채운다.

| 키 | 환경변수 | 기본값 | 설명 |
|-|-|-|-|
| `enabled` | `MEMENTO_SEGMENT_EMBEDDING_ENABLED` | `false` | 구간 생성. `true`면 워커를 시작하고 임베딩 완료 이벤트마다 큐에 올린다 |
| `searchEnabled` | `MEMENTO_SEGMENT_SEARCH` | `false` | 검색 반영. 생성 스위치와 독립이며 효과를 보려면 둘 다 `true`로 켠다 |
| `minChars` | `MEMENTO_SEGMENT_MIN_CHARS` | `400` | 구간 생성 대상의 최소 길이(코드 포인트). 이하는 본문 벡터로 충분하다 |
| `similarityDecay` | `MEMENTO_SEGMENT_DECAY` | `0.95` | 구간 유사도 감쇠. 짧은 구간 벡터는 코사인이 높게 나오는 경향이 있다 |
| `adoptLimit` | `MEMENTO_SEGMENT_ADOPT` | `10` | 구간이 순위에 영향을 줄 수 있는 조각(상승 + 신규)의 최대 수 |
| `searchTimeoutMs` | `MEMENTO_SEGMENT_SEARCH_TIMEOUT_MS` | `1500` | 구간 프로브 시간 예산. 초과하면 본 검색 결과만 쓴다 |
| `maxSegmentsPerMinute` | `MEMENTO_SEGMENT_RPM` | `600` | 분당 구간 임베딩 상한 |
| `intervalMs` / `batchSize` | `MEMENTO_SEGMENT_INTERVAL_MS` / `MEMENTO_SEGMENT_BATCH` | `3000` / `10` | 워커 폴링 간격과 회차당 처리 파편 수 |
| `concurrency` | `MEMENTO_SEGMENT_CONCURRENCY` | `4` | 한 회차 안에서 동시에 임베딩하는 파편 수(1~32) |
| `recoveryIntervalMs` | `MEMENTO_SEGMENT_RECOVERY_MS` | `600000` | 큐 유실과 정지 구간을 회수하는 복구 스캔 주기(최근 48시간 생성분만 본다) |

구간 표에는 키/에이전트/워크스페이스 열이 없다. 격리는 JOIN한 부모 `fragments`의 열로만 판정한다. 롤백은 두 스위치를 끄는 것이고, 표는 파생 자료라 `DROP TABLE agent_memory.fragment_segment`로 지울 수 있다. 임베딩 차원을 바꾸면 `scripts/post-migrate-flexible-embedding-dims.js`가 이 표도 함께 다룬다.

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
- `embeddingWorker.batchSize`, `embeddingWorker.intervalMs`, `pagination.defaultPageSize`, `pagination.maxPageSize`, `gc.maxDeletePerCycle`, `gc.chunkSize`는 양의 정수

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
| 050 | migration-050-dedup-scope-workspace.sql | 키와 workspace 단위 content_hash 유일 색인 `uq_frag_hash_ws_per_key`, `uq_frag_hash_ws_master` 추가. 운영 DB는 `scripts/ops/online-index.mjs`로 먼저 만들고, 키 범위 색인은 운영 단계로 지운다([operations/online-migration.md](operations/online-migration.md#중복-판정-범위-전환)) |
| 051 | migration-051-search-events-budget.sql | `search_events.candidate_count`, `budget_kept`(recall 예산 선택의 후보 수와 선택 수, nullable). 예산 선택을 거치지 않은 검색은 NULL |
| 052 | migration-052-outbox-events.sql | `outbox_events` 표(트랜잭션 outbox: topic, aggregate_id, payload, available_at, attempts, processed_at, last_error, dead_at, claim_token)와 대기, 완료, dead-letter 부분 색인 |
| 053 | migration-053-content-tokens.sql | `fragments.content_tokens tsvector`(nullable, 본문 어휘 채널). 열만 더한다. GIN 색인 `idx_fragments_content_tokens`는 `scripts/ops/online-index.mjs`로 만들고 기존 행은 `scripts/backfill-content-tokens.mjs`로 채운다(`MEMENTO_LEXICAL_CHANNEL`) |
| 054 | migration-054-case-events-source-fragment.sql | `case_events(source_fragment_id)` 부분 색인 `idx_ce_source_fragment_id`(forget 삭제 연쇄와 고아 요약 정리의 조회). 운영 DB는 `scripts/ops/online-index.mjs`로 먼저 만든다([operations/online-migration.md](operations/online-migration.md)) |
| 055 | migration-055-api-keys-egress-policy.sql | `api_keys.egress_policy JSONB`(LLM 외부 전송 정책, NULL은 정책 없음). `PATCH /v1/internal/model/nothing/keys/:id/policy`의 `egress_policy`로 편집. 판정은 「외부 전송 정책」 |
| 056 | migration-056-admin-audit-events.sql | `admin_audit_events` 표(감사 해시 체인: seq, source_event, occurred_at, recorded_at, action, outcome, 행위자, 대상, workspace, detail, prev_hash, row_hash)와 기간, 행위, 행위자, 대상 색인 |
| 057 | migration-057-fragment-provenance.sql | `fragments.origin`, `observed_client`, `trust_tier`(smallint), `review_state`, `review_reason`(모두 기본값 없는 nullable, 표 재작성 없음)과 `origin`, `trust_tier` CHECK 제약(NOT VALID, 새로 쓰는 행에만 적용). 기존 행은 백필하지 않으며 NULL `trust_tier`는 코드에서 2로 해석한다(`MEMENTO_PROVENANCE`). `origin`은 클라이언트 주장 출처로 `source`(라벨), `assertion_status`(검증 상태)와 역할이 다르다 |
| 058 | migration-058-review-decisions.sql | `memory_review_decisions` 표(검토 결정 기록: `fragment_id`, `decision`(approve, reject, auto_reject), `reviewer`, `note`, `idempotency_key`(부분 고유 색인), `key_id`, `review_reason`, `decided_at`. 파편 본문 없음)와 `fragments_review_state_check` 제약(`review_state`는 NULL, pending, approved, rejected. NOT VALID, 새로 쓰는 행에만 적용). 키의 검토 방식은 api_keys 열이 아니라 권한 목록 표지(`review_off`, `review_all`)다(`MEMENTO_REVIEW_QUEUE`) |
| 059 | migration-059-api-key-lifecycle.sql | `api_keys` 수명 열(`expires_at`, `description`, `owner`, `kind`, `allowed_cidrs`, `last_used_ip_hash`, `revoked_at`, `revoked_by`, `revoke_reason`, `access_reviewed_at`, `access_reviewed_by`, 모두 NULL 허용)과 `api_key_secrets` 표(키 해시별 비밀 행, 회전 겹침의 `valid_until`). 배포 뒤 `scripts/ops/backfill-key-secrets.mjs --confirm`으로 현재 키 해시를 옮긴다([operations/online-migration.md](operations/online-migration.md)의 「키 비밀 이관」) |
| 060 | migration-060-admin-users.sql | `admin_users`, `admin_role_bindings`, `admin_sessions`, `admin_recovery_codes`, `admin_identities` 표(관리자 계정, 역할 바인딩, DB 세션, 복구 코드 해시, OIDC 확장 지점)와 `admin_audit_events.actor_kind`에 `admin` 추가 |
| 061 | migration-061-synthetic-query-source-version.sql | `fragment_synthetic_query.source_content_hash` 추가. 본문 수정 전 생성된 합성 질의를 검색에서 제외하고 백필로 교체 |

---

## Mode Preset 설정

세션 동작 범위를 preset으로 고정한다. 3가지 경로로 설정할 수 있으며, 우선순위는 아래와 같다.

1. **요청별 헤더** (최우선): `X-Memento-Mode: <preset>`
2. **initialize 파라미터**: `{ "method": "initialize", "params": { "mode": "<preset>" } }`
3. **키 단위 기본값** (admin console 키 상세의 ACCESS POLICY 또는 `PATCH /v1/internal/model/nothing/keys/:id/policy`): `api_keys.default_mode` 컬럼 (migration-034). 마스터 전용 preset(`audit`)은 API 키에 지정할 수 없다. 변경 이후 열린 세션부터 적용된다

master가 아닌 세션이 세 경로 어디로든 master 전용 preset을 요청하면 `MEMENTO_WORKSPACE_READ_AUTHZ`가 판정한다. `warn`(기본)은 preset을 무시해 전체 도구를 노출하고 `memento_workspace_read_authz_total{surface="mode_preset",outcome="would_deny"}`와 경고 로그(키 id, preset, 출처)를 남긴다. `enforce`는 세션을 만들지 않고 HTTP 403과 `-32001`로 거부한다.

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
