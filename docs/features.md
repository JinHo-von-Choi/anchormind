# Features Ledger

AnchorMind의 주요 모듈을 한 페이지로 정리한 ledger. 새 모듈 추가·deprecation 시 본 표에 행을 추가하거나 갱신한다. 운영 디버깅에서 "이 ENV는 어디에 쓰이지? 이 메트릭은 어느 모듈 거지?" 질문에 한 곳에서 답을 찾을 수 있도록 한다.

본 문서는 권위 출처가 아니라 운영 ledger다. 코드 본문과 어긋날 경우 코드를 신뢰하고 본 표를 갱신한다.

## 모듈 ledger

|모듈|입력|출력|주된 실패 모드|관련 ENV|관련 메트릭|관련 migration|
|-|-|-|-|-|-|-|
|`MemoryRememberer` (`lib/memory/processors/MemoryRememberer.js`)|remember params (content/type/topic/keywords/importance 등)|`{id, keywords, ttl_tier, scope, conflicts, validation_warnings?}`|quota 초과(`fragment_limit_exceeded`), hard gate `SymbolicPolicyViolationError`, idempotency 충돌|`MEMENTO_REMEMBER_ATOMIC`, `MEMENTO_SYMBOLIC_POLICY_RULES`, `MEMENTO_REMEMBER_DUPLICATE_GUARD`|`memento_symbolic_warning_total`, `memento_symbolic_gate_blocked_total`, `mcp_remember_duplicate_total`|migration-031 (per-key content_hash), migration-034 (idempotency tenant/master unique)|
|`BatchRememberProcessor`|fragment 배열 + keyId (async=true 시 Redis 큐 적재 후 즉시 반환)|`{insertedIds, skipped, conflicts}` 또는 `{async:true, accepted, rejected, jobId}`|quota Phase B 초과 시 ROLLBACK, 256KB/500행 chunk 한도; async=true 시 Redis 미연결이면 동기 경로 폴백|`BATCH_DATABASE_URL`|`mcp_batch_pool_active_connections`, `mcp_batch_pool_idle_connections`, `mcp_batch_pool_waiting_count`|migration-035 (morpheme_indexed)|
|`FragmentSearch` (`lib/memory/read/FragmentSearch.js`)|`recall` params (text/keywords/topic/type/timeRange/contextText)|`{fragments[], searchPath, _meta:{searchEventId,hints,suggestion}}`|empty results, similarity 임계 미달, NLI 실패 (soft fallback)|`ENABLE_SPREADING_ACTIVATION`, `MEMENTO_SYMBOLIC_EXPLAIN`|`mcp_tool_executions_total{tool="recall"}`, `mcp_tool_execution_duration_seconds{tool="recall"}`|migration-027 (reconsolidation/episode/spreading)|
|`FragmentWriter` (`lib/memory/write/FragmentWriter.js`)|fragment 객체|insert/update id|content_hash 충돌, `validation_warnings` 누적 후 INSERT|-|-|core schema|
|`MemoryConsolidator` (`lib/memory/consolidate/MemoryConsolidator.js`)|cycle trigger|22개 stage의 결과 + stage별 소요 시간|stage별 query error는 stage 결과에 잡힘, 다음 stage 진행|`CONSOLIDATE_INTERVAL_MS`, `MEMENTO_CONSOLIDATE_*`(COMPRESS_OLD, DETECT_CONTRADICT, GATE_MODE, SPLIT_LONG), `MEMENTO_AUTO_PROMOTE_ANCHORS`, `MEMENTO_SCORE_UPDATE_BATCH`, `MEMENTO_DECAY_MIN_DELTA`, `MEMENTO_UTILITY_MIN_DELTA`|`memento_consolidate_gate_allowed_total`, `memento_consolidate_gate_blocked_total`, `memento_consolidate_split_skipped_total`, `memento_consolidate_split_step_failed_total`, `mcp_anchor_auto_promotion_enabled`|해당 없음 (로직 전용)|
|`ReconsolidationEngine` (`lib/memory/link/ReconsolidationEngine.js`)|tool_feedback 누적|link weight 갱신|fragment_links 부재, search_event_id 무효|`ENABLE_RECONSOLIDATION`|-|migration-027|
|`SpreadingActivation` (`lib/memory/signals/SpreadingActivation.js`)|contextText + 시드 파편|ema_activation boost|graph 부재 시 noop|`ENABLE_SPREADING_ACTIVATION`|-|migration-027|
|`CaseRewardBackprop` (`lib/memory/signals/CaseRewardBackprop.js`)|case_event outcome|case_events DAG 보상|case_id 없는 fragment는 skip|`MEMENTO_CASE_BACKPROP_ENABLED`|-|migration-027|
|`EmbeddingWorker` (`lib/memory/embedding/EmbeddingWorker.js`)|orphan fragment 배치|embedding INSERT, morpheme INSERT|external embedding provider 장애 시 row 단위 dead-letter|`EMBEDDING_PROVIDER`, `EMBEDDING_DIMENSIONS`, `BATCH_DATABASE_URL`|`mcp_embedding_semaphore_wait_exceeded_total`, `mcp_batch_pool_*`|`scripts/post-migrate-flexible-embedding-dims.js`|
|`EmbeddingCache` (`lib/memory/embedding/EmbeddingCache.js`)|텍스트 hash|cache hit/miss|Redis 장애 시 noop|`CACHE_ENABLED`, `CACHE_DB_TTL`|-|-|
|`MorphemeIndex` (`lib/memory/embedding/MorphemeIndex.js`)|fragment 텍스트|morpheme 토큰 + 임베딩|형태소 분석 실패 시 fragment의 `morpheme_indexed=false` 유지|`MEMENTO_MORPHEME_TOKENIZER`|-|migration-035|
|`NLIClassifier` (`lib/memory/signals/NLIClassifier.js`)|premise/hypothesis 텍스트 쌍|entail / contradict / neutral 라벨|NLI 서비스 미도달 시 LLM fallback 또는 soft skip|`NLI_SERVICE_URL`, `NLI_TIMEOUT_MS`|-|-|
|`AutoReflect` (`lib/memory/processors/AutoReflect.js`)|long session events|reflect 파편 자동 생성|LLM 응답 파싱 실패 시 skip|`GEMINI_TIMEOUT_MS`(코드 상수)|-|없음|
|`RecallSuggestionEngine` (`lib/memory/read/RecallSuggestionEngine.js`)|recall 응답 메타|`_meta.suggestion.recommendedTool` 권고|graph 신호 부재 시 suggestion 미발행|-|-|-|
|`MemoryLinker` (`lib/memory/processors/MemoryLinker.js`)|fromId/toId/relationType|link 생성/모순 격리|cycle detection 거부|-|-|core schema|
|`MemoryReflector` (`lib/memory/processors/MemoryReflector.js`)|session reflect params|batchRemember 결과 + episode 생성|상속 (batch)|—|상속|—|
|`dispatchChain` (`lib/llm/index.js`)|provider chain + prompt + options + deps|첫 성공 provider 응답|429 cooldown, semaphore timeout, chain deadline|`LLM_PRIMARY`, `LLM_FALLBACKS`, `LLM_CHAIN_TIMEOUT_MS`, `LLM_CONCURRENCY_*`|`memento_llm_provider_calls_total`, `memento_llm_provider_latency_ms`, `memento_llm_provider_concurrency_active`, `memento_llm_provider_concurrency_wait_ms`, `memento_llm_provider_429_total`, `memento_llm_fallback_triggered_total`, `memento_llm_token_usage_total`|-|
|`RememberDuplicate` (`lib/memory/processors/RememberDuplicate.js`)|store.insert가 돌려준 기존 파편 id와 요청 파편|중복 적중 분류(`same_scope`, `other_workspace`, `closed`, `unknown`), 같은 범위 적중의 `duplicate_of`, 확인 설정이 켜져 있으면 `existing`, `duplicate`를 담은 응답|상태 조회 실패는 기록 후 `unknown`으로 분류하며 호출은 실패시키지 않는다|`MEMENTO_REMEMBER_DUPLICATE_GUARD`|`mcp_remember_duplicate_total{kind}`|-|
|`key-state-cache` (`lib/admin/key-state-cache.js`)|keyId|`{exists, status, permissions}` 또는 null(재확인 꺼짐, 판정 불가)|조회 실패 시 5초 동안 같은 키의 조회를 건너뛰고 직전 값을 쓴다. null이면 세션의 저장된 identity를 그대로 쓴다|`MEMENTO_SESSION_KEY_RECHECK_MS`|`mcp_auth_store_errors_total{operation}`|-|
|`admin-login-guard` (`lib/admin/admin-login-guard.js`)|관리 인증 실패와 성공 기록|다음 시도 허용 여부와 `retryAfterSec`|`MEMENTO_ADMIN_AUTH_BACKOFF=on`일 때만 지연을 적용하고 그 밖에는 기록만 한다. 상태는 프로세스 메모리에 있다|`MEMENTO_ADMIN_AUTH_BACKOFF`|-|-|
|`AdminAuthz`, `ScopeFilter` (`lib/admin/`)|관리 요청 주체(마스터 키는 owner, `/me` 라우트의 API 키는 service), 라우트 표의 요구 능력과 범위 종류|허용이면 판정 범위를 요청에 묶고 관리 SQL에 범위 술어(`TRUE`, `workspace = ANY($n)`, `FALSE`)를 붙인다. 거부는 403과 멈춘 단계. `GET /me/explain`이 판정 근거를 돌려준다|라우트 표에 없는 경로는 owner 전용, 판정 범위가 없는 질의는 빈 결과, 메타만 판정(auditor)은 허용 목록 밖의 응답 값을 해시와 길이로 바꾼다. 관리 모듈 밖 기억 경로는 질의 범위가 전체일 때만 부른다. 집행은 항상 켜져 있다|-|-|-|
|`WorkspaceReadAuthz` (`lib/memory/read/WorkspaceReadAuthz.js`)|도구 이름 또는 `resources/read`, 서버가 주입한 키 id, master 여부, 키 기본 workspace와 요청의 `workspace`, `allWorkspaces`|허가 여부와 사유. `enforce`에서 범위 제한 키의 허가된 요청에는 허가 범위를 붙여 SearchScope가 파편 단위로 같은 판정을 적용한다|`warn`은 허가 밖 요청을 기록만 하고 처리하며, `enforce`는 처리기에 들어가기 전에 `-32001`로 거부한다. `allowed_workspaces` 조회 실패는 허가 밖이다. 같은 스위치로 master가 아닌 세션의 master 전용 preset 요청을 판정한다(`enforce`에서 initialize HTTP 403)|`MEMENTO_WORKSPACE_READ_AUTHZ`|`memento_workspace_read_authz_total{surface,reason,outcome}`|-|
|`session-id` (`lib/session-id.js`)|요청|세션 ID와 수신 경로(`header`, `query`), 서버 발급 형식(UUID) 여부|`MEMENTO_SESSION_ID_POLICY=enforce`면 쿼리 ID에 400, UUID가 아닌 ID의 복구에 404|`MEMENTO_SESSION_ID_POLICY`|`mcp_session_recovery_total`|-|
|`tool-error` (`lib/tools/tool-error.js`)|도구 처리기가 던진 예외와 도구 이름|`Internal error` 또는 업무 오류 문구. 열거형 인자 위반은 `Invalid arguments for <tool>: <param>: must be one of ...`와 `code: "INVALID_ARGUMENT"`|원문은 서버 로그와 감사 기록에만 남는다|-|-|-|
|`cli-approval` (`lib/llm/util/cli-approval.js`)|`MEMENTO_LLM_CLI_TOOL_APPROVAL`|CLI 공급자의 도구 승인 방식(`none`, `all`)과 빈 임시 작업 디렉터리|`none`에서 gemini-cli, copilot-cli, opencode-cli는 제한된 승인으로 임시 디렉터리에서 실행된다|`MEMENTO_LLM_CLI_TOOL_APPROVAL`|-|-|
|`lock-retry` (`lib/tools/lock-retry.js`)|잠금 문장을 앞세운 쓰기 트랜잭션(`queryWithAgentVector`의 `opts.lock`)|같은 결과. 교착(40P01)이나 잠금 대기 상한(55P03)이면 트랜잭션 전체를 지터 대기 후 다시 실행|상한을 넘으면 마지막 오류를 던진다|`MEMENTO_DB_LOCK_RETRY_MAX`|`memento_db_deadlock_retries_total`, `memento_db_write_failures_total`|-|
|`WriteGate` (`lib/memory/write/WriteGate.js`)|진입점 이름, 쓰기 값(생성 후보 또는 갱신 열), 키 정보|정규화, 마스킹, 절삭을 거친 쓰기 값과 `validation_warnings`|입력 형식 오류는 `WriteInputError`, hard gate 키의 정책과 고신뢰 민감 정보 위반, enforce의 앵커 위반은 `-32003`|`MEMENTO_WRITE_GATE`, `MEMENTO_SENSITIVE_SCAN`, `MEMENTO_WORKSPACE_GATE`, `MEMENTO_ANCHOR_PERMISSION`, `MEMENTO_ANCHOR_LIMIT_PER_KEY`|`memento_write_gate_total{entry,outcome}`, `memento_anchor_decision_total{outcome,reason}`|-|
|`ReviewQueue`, `ReviewVisibility`, `ReviewStore` (`lib/memory/write/ReviewQueue.js`, `lib/memory/read/ReviewVisibility.js`, `lib/admin/ReviewStore.js`)|remember, batch_remember, reflect, amend의 쓰기 값과 출처 등급, 앵커 권한 경고, 키 권한 목록의 검토 방식 표지|검토 규칙에 걸린 쓰기를 `review_state='pending'`으로 저장(거부 없음, `review.<사유>` 경고). 쓴 키의 recall에만 `pending_review`, `low_trust` 표지와 함께 보이고 다른 키, ANCHOR와 CORE 주입, 앵커 승격에서 제외. 관리 API `/review`의 승인, 거절, 30일 미결정 자동 거절|없는 파편 404, 검토 대기가 아닌 파편과 다른 결정의 멱등 키 409|`MEMENTO_REVIEW_QUEUE`|`memento_review_flag_total{entry,reason}`, `memento_review_decisions_total{decision}`|migration-057, 058|, `EgressPolicy`, `EgressGate` (`lib/llm/`)|LLM 호출 문맥(단계, 키, workspace), 제공자 체인, 프롬프트|허용 제공자 체인, 외부 제공자용 가린 프롬프트, outbox `audit.llm.egress` 이벤트(본문 없음)|남는 제공자가 없거나 정책을 읽지 못하면 `EgressSkippedError`(외부로 대체하지 않음), 감사 기록 실패는 그 제공자를 건너뜀(`EgressAuditError`), 저장 값 형식 오류는 `policy_invalid`로 건너뜀|`MEMENTO_EGRESS_POLICY`, `MEMENTO_EGRESS_LOCAL_HOSTS`|`memento_llm_egress_calls_total`, `memento_llm_egress_bytes_total`, `memento_llm_egress_skipped_total`, `memento_llm_egress_masked_total`|migration-055|
|`SensitiveScanner` (`lib/security/SensitiveScanner.js`)|content, topic, contextSummary, goal, outcome, keywords|표식으로 가린 값과 `sensitive.<규칙>` 이름|일치한 문자열은 기록하지 않는다. 규칙 표(`sensitivePatterns.js`)는 로그 마스킹과 공유|`MEMENTO_SENSITIVE_SCAN`|-|-|
|`DedupScope` (`lib/memory/write/DedupScope.js`)|키 경로(키 보유, 마스터), workspace, content_hash|판정 범위, `ON CONFLICT` 대상, 사전 조회 조건|색인 상태가 기억과 다르면(42P10, 23505) 다시 읽고 다시 판정한다|`MEMENTO_DEDUP_SCOPE`|`mcp_remember_duplicate_total{kind}`|migration-050|
|`BudgetSelector` (`lib/memory/read/BudgetSelector.js`)|최종 점수를 매긴 후보와 `tokenBudget`|예산 안에서 고른 파편|후보가 200건과 연결 파편 상한의 합(기본 210건)을 넘으면 검색 순서 절단 결과를 쓴다|`MEMENTO_RANK_BEFORE_BUDGET`|-|migration-051 (`search_events.candidate_count`, `budget_kept`)|
|`AnswerPack`, `AnswerPackLoader` (`lib/memory/read/AnswerPack.js`, `AnswerPackLoader.js`)|recall 결과 파편과 `format:"pack"`|`pack`(`text`, `items`, `groups`, `policy`)|출처와 대체 체인 조회 실패 시 체인 없이 `partial=true`|-|-|-|
|`ContextLines` (`lib/memory/read/ContextLines.js`)|context 구획(anchor, core, learning, working)|주입 줄. 줄 끝 ` (YYYY-MM-DD, assertion)` 주석, `MEMENTO_PROVENANCE=on`이면 출처 값도|-|`MEMENTO_CONTEXT_ANNOTATE`, `MEMENTO_PROVENANCE`|-|-|
|`provenance`, `ProvenanceLoader`, `ContextTrust` (`lib/memory/provenance.js`, `lib/memory/read/ProvenanceLoader.js`, `ContextTrust.js`)|생성 파편의 origin 주장, 관측 clientInfo 이름, 쓰기 진입점, 키 권한|`origin`, `observed_client`, `trust_tier` 기록. recall 응답과 꾸러미의 출처, context ANCHOR와 CORE에서 등급 1 이하 제외|허용 밖 origin은 `-32602`. 등급 조회 실패 시 recall은 출처 없이, context는 core 후보를 모두 빼고 `_meta.coreSelection.partial=true`. 분할 자식과 모순 감사 파편은 원본 등급을 상한으로 받는다|`MEMENTO_PROVENANCE`|`memento_context_core_trust_excluded_total{reason}`|migration-057|
|`ForgetCascade` (`lib/memory/write/ForgetCascade.js`)|forget 대상 id 목록과 키|대상과 서버 기록 모순 해소 파편 삭제, 지운 파편을 출처로 한 `case_events.summary`를 `[삭제됨]`으로 갱신, 응답 `purged`(`case_summaries`, `audit_fragments`)|삭제와 요약 갱신은 한 트랜잭션이라 함께 적용되거나 함께 되돌린다. 잠금 충돌은 `delete` 재시도|`MEMENTO_FORGET_CASCADE`|-|migration-054 (`idx_ce_source_fragment_id`)|
|`LexicalSearch` (`lib/memory/read/LexicalSearch.js`), `ContentTokens` (`lib/memory/write/ContentTokens.js`)|recall이 연 검색의 질의 text와 범위, 저장할 본문|일치 행 400건 안의 `ts_rank_cd` 순 후보 200건(RRF 입력), 저장 문장의 `content_tokens` 값|유효한 GIN 색인이 없거나 열이 없으면 채널이 참여하지 않는다(경고 한 번). 질의 시간 상한 초과나 조회 오류는 그 요청에서만 채널을 뺀다. 열 확인 실패나 공백 없는 긴 연속 본문은 토큰 없이(NULL) 저장한다. `content_tokens`가 NULL인 행은 찾지 못한다|`MEMENTO_LEXICAL_CHANNEL`, `MEMENTO_LEXICAL_TIMEOUT_MS`|`memento_lexical_tokens_coverage_ratio`, `memento_lexical_tokens_missing`, `memento_lexical_channel_skipped_total`, `memento_lexical_tokenize_skipped_total`|migration-053 (`fragments.content_tokens`)|
|`WorkingMemoryRows` (`lib/memory/WorkingMemoryRows.js`)|세션 ID, 키, 에이전트|작업 기억 행 읽기, 소비 항목 제거, 만료 정리, 키별 상한 정리|정리 실패는 경고 로그만 남기고 다음 주기에 이어간다|`MEMENTO_WM_PG_FALLBACK`, `MEMENTO_WM_FALLBACK_MAX_ROWS`|-|-|
|`AuditStore`, `audit-outbox`, `audit-consumer` (`lib/logging/`)|감사 이벤트(행위, 결과, 행위자, 대상, detail)|outbox topic `audit.record`를 거쳐 `admin_audit_events` 단일 해시 체인 행, 조회, JSONL 내보내기, 검증 결과|규칙 위반 이벤트와 outbox 기록 실패는 업무 응답을 막지 않고 경고와 지표로 남는다. 읽을 수 없는 payload는 dead-letter, 표 잠금 대기 초과는 재시도|`MEMENTO_AUDIT_DB`, `MEMENTO_AUDIT_RETENTION_DAYS`|`memento_audit_*`, `memento_outbox_*{topic="audit.record"}`|migration-056|
|`Outbox`, `OutboxWorker` (`lib/outbox/`)|호출자 트랜잭션의 연결과 이벤트(topic, payload)|topic별 처리기 실행, 완료, 재시도, dead-letter|트랜잭션 밖 기록은 `OutboxTransactionRequiredError`, 형식 오류는 `OutboxValidationError`, 처리기 없는 topic은 `no_handler` dead-letter|`MEMENTO_OUTBOX`, `MEMENTO_OUTBOX_WORKER`, `MEMENTO_OUTBOX_MAX_ATTEMPTS`, `MEMENTO_OUTBOX_RETENTION_DAYS`, `MEMENTO_OUTBOX_UNHANDLED_DAYS`|`memento_outbox_*`|migration-052|
|`FragmentExporter`, `ImportRunner` (`lib/memory/transfer/`)|내보내기 범위 또는 버전 1, 2 기록 스트림과 대상 키|형식 버전 2 JSONL, 가져오기 집계(`imported`, `duplicates`, `rejected`, `errors`)|알아볼 수 있는 기록이 없는 입력은 `no_valid_records`, 옵션 오류는 `ImportOptionError`|-|`memento_write_gate_total{entry,outcome}`|-|
|`idOrderedUpdate` (`lib/memory/consolidate/idOrderedUpdate.js`)|감쇠, utility 점수 갱신 대상|id 오름차순 묶음 갱신. 묶음마다 커밋|`MEMENTO_SCORE_UPDATE_BATCH=0`이면 단일 문장 경로|`MEMENTO_SCORE_UPDATE_BATCH`, `MEMENTO_DECAY_MIN_DELTA`, `MEMENTO_UTILITY_MIN_DELTA`|-|-|
|`SessionLinker` (`lib/memory/link/SessionLinker.js`)|session_id + 시간 인접 파편|temporal 링크|deadlock 회피 위해 sortedKey 정렬|-|-|-|
|`DeterministicRanking` (`lib/memory/read/DeterministicRanking.js`)|검색 결과와 기존 primary score|`created_at DESC, id ASC` 동점 정렬 및 offset cursor 페이지|동적 후보 집합에서는 페이지 간 snapshot을 보장하지 않음; ANN은 선택 후보 내부 동점만 정렬|—|—|—|
|`SearchScope` (`lib/memory/read/SearchScope.js`)|sq (검색 쿼리 파라미터 객체)|검색 레이어별 scope 정합 객체 `(workspace, caseId, resolutionStatus, phase, affect, type, topic, isAnchor, keyId)`|없음 (순수 변환)|—|—|—|
|`SearchSideEffects` (`lib/memory/read/SearchSideEffects.js`)|검색 결과 배열 + ctx|searchEventId, co_retrieved 업데이트, EMA 갱신|DB 장애 시 soft fail. topic 정확일치로 0건인 검색은 SearchParamAdaptor 학습에서 제외(search_events 기록은 유지)|-|-|migration-027|
|`TopicResolver` (`lib/memory/read/TopicResolver.js`)|store + 키 스코프 + 요청 topic|근접 topic 후보 `[{topic, count}]`. recall `_meta.hints`의 `topic_mismatch` 재료|후보 없으면 빈 배열 → 힌트 미발행|—|—|—|
|`FeedbackSampler` (`lib/memory/signals/FeedbackSampler.js`)|도구명 + sessionId|`feedback_sampled` 힌트 객체 또는 null|Redis 미가용 시 세션 상한·쿨다운 미적용(fail-open)|`MEMENTO_FEEDBACK_SAMPLING`|—|migration-039 (irrelevance_reason 수집처)|
|`HookHandler`, `hook-contract`, `hook-reflect-consumer` (`lib/handlers/hook-handler.js`, `lib/hooks/`)|`POST /hooks/{client}/{event}`의 경로, 헤더, 본문(Stop, SessionEnd는 요약 후보 발췌 64 KB 이하)|SessionStart는 구분자 블록의 맥락(`additionalContext`), Stop과 SessionEnd는 202와 outbox topic `hook.reflect` 이벤트|인증 실패 401, 형식 오류 400, 키별 대기 이벤트 상한 429, 같은 세션과 이벤트의 중복은 202(duplicate), 소비자 단계에서 키 비활성이면 dead-letter|`MEMENTO_HOOK_ENDPOINTS`, `MEMENTO_SESSION_KEY_RECHECK_MS`|`memento_hook_calls_total`, `memento_hook_reflect_total`|없음|
|`AdminUserStore`, `admin-user-auth`, `admin-seal` (`lib/admin/`)|계정 이름, 비밀번호, TOTP 또는 복구 코드, 관리 세션 쿠키와 CSRF 토큰|계정과 역할 바인딩, DB 세션, 관리 요청 주체|`MEMENTO_ADMIN_SEAL_KEY` 없음이면 TOTP 등록 503, 연속 실패 지연 429, 마지막 owner 변경 409|`MEMENTO_ADMIN_USERS`, `MEMENTO_ADMIN_SEAL_KEY`|없음|migration-060|
|`ApiKeyLifecycleStore`, `key-lifecycle` (`lib/admin/`)|키 id, 만료 시각, 허용 주소 대역, 회전 겹침 시간, 폐기 사유|새 원시 키(한 번), 키 수명 열, `api_key_secrets` 행|폐기된 키 활성화 409, 만료와 허용 대역 밖 주소는 인증 거부|`MEMENTO_KEY_ROTATION_GRACE_HOURS`, `MEMENTO_KEY_LAST_USED_INTERVAL_SEC`|없음|migration-059|
|`gcChunks` (`lib/memory/consolidate/gcChunks.js`)|만료 후보 조건, 주기당 삭제 상한, 시간 예산|청크(100건) 삭제 건수와 남은 후보 수|청크가 실패하면(잠금 대기 3초 초과 포함) 그 주기를 멈추고 다음 주기에 이어감|`MEMENTO_GC_THROUGHPUT`, `MEMENTO_GC_MAX_DELETE_PER_CYCLE`, `MEMENTO_GC_TIME_BUDGET_MS`|`memento_gc_backlog`|없음|

## 실험적 기능 플래그

다음 기능은 기본 off이며 ENV 토글로 활성화한다. 운영 신뢰가 확보되면 기본 on으로 승급할 후보다.

|기능|ENV|기본|분기 위치|비고|
|-|-|-|-|-|
|SpreadingActivation|`ENABLE_SPREADING_ACTIVATION=true`|off|`lib/memory/processors/MemoryRecaller.js`|recall 시 contextText 기반 graph 부스트. recall precision 개선치 확보 후 기본 on 승급 검토|
|CaseRewardBackprop|`MEMENTO_CASE_BACKPROP_ENABLED=true`|off|`lib/memory/signals/CaseRewardBackprop.js` (호출 시점 매번 평가, 런타임 토글 가능)|case verification 결과를 증거 파편 importance에 역전파. 비활성 시 호출 자체가 no-op (DB·메트릭 영향 0). DAG 일관성 베이스라인 확보 후 승급 검토|
|ReconsolidationEngine|`ENABLE_RECONSOLIDATION=true`|off|`lib/tools/memory.js` tool_feedback, `lib/memory/write/ConflictResolver.js`|tool_feedback의 fragment_ids 기반 링크 weight 갱신과 supersede 강등 시 재통합. 미설정 시 호출하지 않는다|

## 실험 플래그 아닌 dual-mode·항상 활성 기능

다음 기능은 ENV로 on/off 토글되는 실험이 아니라 운영 기본 흐름의 일부다. ENV는 동작 모드 분기에 사용된다.

|기능|ENV|동작|
|-|-|-|
|HNSW 인덱스 강제 검색|—|벡터 검색 트랜잭션 시작 시 `SET LOCAL enable_seqscan = off`, `SET LOCAL enable_bitmapscan = off`, `SET LOCAL hnsw.iterative_scan = relaxed_order` 적용. planner가 seqscan·bitmap scan으로 우회하는 것을 차단하여 HNSW index scan 경로를 강제하며, 필터 조건이 붙는 쿼리에서 308ms→7ms 단축 확인. `lib/tools/db.js` L3 검색 경로 고정|
|NLIClassifier|`NLI_SERVICE_URL`|설정 시 외부 HTTP 서비스 호출, 미설정 시 in-process ONNX 모델로 동일 분류를 수행. 항상 활성|
|AutoReflect|—|`sessions.js`의 세션 종료/회전 흐름에서 자동 호출. 비활성화하면 세션 학습이 손실되므로 운영에서 항상 활성|
|저장소 접근|`MEMENTO_STORAGE`|저장소 백엔드 이름. 현재 `pgvector` 하나이며 이 값은 동작에 영향을 주지 않는다. 저장소 접근은 `lib/tools/db.js`의 `getPrimaryPool`, `queryWithAgentVector`가 맡는다.|
|recall 적응형 임계값 하한|`MEMENTO_RECALL_MIN_SIM_FLOOR`|미설정 시 `SearchParamAdaptor.getMinSimilarity`의 반환값을 그대로 사용. 설정 시 `Math.max(floor, learned)`로 하한 강제. 한국어 long-tail query에서 노이즈 fragment 통과를 차단|

## 새 모듈 추가 규약

1. 모듈을 `lib/memory/` 또는 적절한 도메인 디렉토리에 신설한다.
2. 본 표에 행을 추가한다. 컬럼 7개 모두 채운다(없으면 `-`).
3. 새 ENV가 도입되면 `docs/configuration.md`에도 반영한다.
4. 새 메트릭이 도입되면 `lib/metrics.js`에 등록되었는지 확인하고 본 표에 메트릭 이름을 적는다.
5. migration이 따라오면 `lib/memory/migrations/migration-*.sql` 번호와 본 표 행을 연결한다.
6. PR 템플릿(있다면)의 features ledger 체크박스에 체크한다.
