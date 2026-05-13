# Features Ledger

memento-mcp의 주요 모듈을 한 페이지로 정리한 ledger. 새 모듈 추가·deprecation 시 본 표에 행을 추가하거나 갱신한다. 운영 디버깅에서 "이 ENV는 어디에 쓰이지? 이 메트릭은 어느 모듈 거지?" 질문에 한 곳에서 답을 찾을 수 있도록 한다.

본 문서는 권위 출처가 아니라 운영 ledger다. 코드 본문과 어긋날 경우 코드를 신뢰하고 본 표를 갱신한다.

## 모듈 ledger

|모듈|입력|출력|주된 실패 모드|관련 ENV|관련 메트릭|관련 migration|
|-|-|-|-|-|-|-|
|`MemoryRememberer` (`lib/memory/processors/MemoryRememberer.js`)|remember params (content/type/topic/keywords/importance 등)|`{id, keywords, ttl_tier, scope, conflicts, validation_warnings?}`|quota 초과(`fragment_limit_exceeded`), hard gate `SymbolicPolicyViolationError`, idempotency 충돌|`MEMENTO_REMEMBER_ATOMIC`, `MEMENTO_POLICY_RULES`|`memento_policy_warning_total`, `memento_policy_gate_block_total`|migration-031 (per-key content_hash), migration-034 (idempotency tenant/master unique)|
|`BatchRememberProcessor`|fragment 배열 + keyId|`{insertedIds, skipped, conflicts}`|quota Phase B 초과 시 ROLLBACK, 256KB/500행 chunk 한도|`BATCH_DATABASE_URL`|batch pool active/idle/waiting|migration-035 (morpheme_indexed)|
|`FragmentSearch` (`lib/memory/FragmentSearch.js`)|`recall` params (text/keywords/topic/type/timeRange/contextText)|`{fragments[], searchPath, _meta:{searchEventId,hints,suggestion}}`|empty results, similarity 임계 미달, NLI 실패 (soft fallback)|`ENABLE_SPREADING_ACTIVATION`, `MEMENTO_SYMBOLIC_EXPLAIN`|`memento_recall_*`, `memento_search_event_total`|migration-027 (reconsolidation/episode/spreading)|
|`FragmentWriter` (`lib/memory/FragmentWriter.js`)|fragment 객체|insert/update id|RLS 거부, content_hash 충돌, `validation_warnings` 누적 후 INSERT|`MEMENTO_SCHEMA`|`memento_fragment_writes_total`|core schema|
|`MemoryConsolidator` (`lib/memory/MemoryConsolidator.js`)|cycle trigger|stage 결과 22항목 + per-stage timing|stage별 query error는 stage 결과에 잡힘, 다음 stage 진행|`MEMENTO_CONSOLIDATE_*`, `MEMENTO_CONSOLIDATE_TIMEOUT_MS`|`memento_consolidation_stage_ms`|미사용 (논리 변경만)|
|`ReconsolidationEngine` (`lib/memory/ReconsolidationEngine.js`)|tool_feedback 누적|link weight 갱신|fragment_links 부재, search_event_id 무효|`MEMENTO_RECONSOLIDATION_ENABLED`|`memento_link_weight_*`|migration-027|
|`SpreadingActivation` (`lib/memory/SpreadingActivation.js`)|contextText + 시드 파편|ema_activation boost|graph 부재 시 noop|`ENABLE_SPREADING_ACTIVATION`|`memento_spreading_activation_total`|migration-027|
|`CaseRewardBackprop` (`lib/memory/CaseRewardBackprop.js`)|case_event outcome|case_events DAG 보상|case_id 없는 fragment는 skip|`MEMENTO_CASE_BACKPROP_ENABLED`|`memento_case_reward_total`|migration-027|
|`EmbeddingWorker` (`lib/memory/EmbeddingWorker.js`)|orphan fragment 배치|embedding INSERT, morpheme INSERT|external embedding provider 장애 시 row 단위 dead-letter|`EMBEDDING_PROVIDER`, `EMBEDDING_DIMENSIONS`, `BATCH_DATABASE_URL`|`memento_embedding_jobs_total`, batch pool|`scripts/post-migrate-flexible-embedding-dims.js`|
|`EmbeddingCache` (`lib/memory/EmbeddingCache.js`)|텍스트 hash|cache hit/miss|Redis 장애 시 noop|`CACHE_ENABLED`, `CACHE_DB_TTL`|`memento_embedding_cache_*`|—|
|`MorphemeIndex` (`lib/memory/MorphemeIndex.js`)|fragment 텍스트|morpheme 토큰 + 임베딩|형태소 분석 실패 시 fragment의 `morpheme_indexed=false` 유지|`MORPHEME_PROVIDER`, `MORPHEME_TIMEOUT_MS`|`memento_morpheme_index_*`|migration-035|
|`NLIClassifier` (`lib/memory/NLIClassifier.js`)|premise/hypothesis 텍스트 쌍|entail / contradict / neutral 라벨|NLI 서비스 미도달 시 LLM fallback 또는 soft skip|`NLI_SERVICE_URL`, `NLI_TIMEOUT_MS`|`memento_nli_total`|—|
|`AutoReflect` (`lib/memory/AutoReflect.js`)|long session events|reflect 파편 자동 생성|LLM 응답 파싱 실패 시 skip|`GEMINI_TIMEOUT_MS`, `AUTOREFLECT_ENABLED`|`memento_autoreflect_total`|—|
|`RecallSuggestionEngine` (`lib/memory/RecallSuggestionEngine.js`)|recall 응답 메타|`_meta.suggestion.recommendedTool` 권고|graph 신호 부재 시 suggestion 미발행|—|`memento_recall_suggestion_total`|—|
|`MemoryLinker` (`lib/memory/processors/MemoryLinker.js`)|fromId/toId/relationType|link 생성/모순 격리|cycle detection 거부, RLS 거부|—|`memento_link_create_total`|core schema|
|`MemoryReflector` (`lib/memory/processors/MemoryReflector.js`)|session reflect params|batchRemember 결과 + episode 생성|상속 (batch)|—|상속|—|
|`dispatchChain` (`lib/llm/index.js`)|provider chain + prompt + options + deps|첫 성공 provider 응답|429 cooldown, semaphore timeout, chain deadline|`LLM_PRIMARY`, `LLM_FALLBACKS`, `LLM_CHAIN_TIMEOUT_MS`, `LLM_CONCURRENCY_*`|`llm_provider_calls_total`, `llm_provider_latency_ms`, `llm_provider_concurrency_*`, `llm_provider_429_total`, `llm_fallback_triggered_total`|—|
|`SessionLinker` (`lib/memory/processors/MemoryLinker.js` 또는 별도)|session_id + 시간 인접 파편|temporal 링크|deadlock 회피 위해 sortedKey 정렬|`SESSION_LINKER_ENABLED`|`memento_session_link_total`|—|
|`SearchScope` (`lib/memory/read/SearchScope.js`)|sq (검색 쿼리 파라미터 객체)|검색 레이어별 scope 정합 객체 `(workspace, caseId, resolutionStatus, phase, affect, keyId)`|없음 (순수 변환)|—|—|—|
|`SearchSideEffects` (`lib/memory/read/SearchSideEffects.js`)|검색 결과 배열 + ctx|searchEventId, co_retrieved 업데이트, EMA 갱신|DB 장애 시 soft fail|—|`memento_search_event_total`|migration-027|
|`PgVectorStore` / `SqliteVecStore` (`lib/storage/`)|SQL 문 + 파라미터|rows 배열|연결 오류 시 throw; SqliteVecStore는 v4.1 본격 구현 예정 stub|`MEMENTO_STORAGE`|—|—|

## 실험적 기능 플래그

다음 기능은 기본 off이며 ENV 토글로 활성화한다. 운영 신뢰가 확보되면 기본 on으로 승급할 후보다.

|기능|ENV|기본|분기 위치|비고|
|-|-|-|-|-|
|SpreadingActivation|`ENABLE_SPREADING_ACTIVATION=true`|off|`lib/memory/processors/MemoryRecaller.js`|recall 시 contextText 기반 graph 부스트. recall precision 개선치 확보 후 기본 on 승급 검토|
|CaseRewardBackprop|`MEMENTO_CASE_BACKPROP_ENABLED=true`|off|`lib/memory/CaseRewardBackprop.js` (호출 시점 매번 평가, 런타임 토글 가능)|case verification 결과를 증거 파편 importance에 역전파. 비활성 시 호출 자체가 no-op (DB·메트릭 영향 0). DAG 일관성 베이스라인 확보 후 승급 검토|

## 실험 플래그 아닌 dual-mode·항상 활성 기능

다음 기능은 ENV로 on/off 토글되는 실험이 아니라 운영 기본 흐름의 일부다. ENV는 동작 모드 분기에 사용된다.

|기능|ENV|동작|
|-|-|-|
|NLIClassifier|`NLI_SERVICE_URL`|설정 시 외부 HTTP 서비스 호출, 미설정 시 in-process ONNX 모델로 동일 분류를 수행. 항상 활성|
|AutoReflect|—|`sessions.js`의 세션 종료/회전 흐름에서 자동 호출. 비활성화하면 세션 학습이 손실되므로 운영에서 항상 활성|
|ReconsolidationEngine|—|`tools/memory.js`의 `tool_feedback`이 직접 호출하는 핵심 경로. ENV 게이트로 막지 않는다|
|storage 어댑터|`MEMENTO_STORAGE`|`pgvector`(기본) → `PgVectorStore` / `sqlite-vec` → `SqliteVecStore`. `getStorage()` 팩토리가 반환 타입을 결정. 호출 사이트 마이그레이션은 v4.1에서 점진 수행|
|recall 적응형 임계값 하한|`MEMENTO_RECALL_MIN_SIM_FLOOR`|미설정 시 `SearchParamAdaptor.getMinSimilarity`의 반환값을 그대로 사용. 설정 시 `Math.max(floor, learned)`로 하한 강제. 한국어 long-tail query에서 노이즈 fragment 통과를 차단|

## 새 모듈 추가 규약

1. 모듈을 `lib/memory/` 또는 적절한 도메인 디렉토리에 신설한다.
2. 본 표에 행을 추가한다. 컬럼 7개 모두 채운다(없으면 `—`).
3. 새 ENV가 도입되면 `docs/configuration.md`에도 반영한다.
4. 새 메트릭이 도입되면 `lib/metrics.js`에 등록되었는지 확인하고 본 표에 메트릭 이름을 적는다.
5. migration이 따라오면 `lib/memory/migration-*.sql` 번호와 본 표 행을 연결한다.
6. PR 템플릿(있다면)의 features ledger 체크박스에 체크한다.
