# Changelog

## [Unreleased] - 2026-07-04

### Added
- content 입력 길이 상한 4000자 도입: `remember`·`batch_remember` 항목·`amend`의 `content`가 이를 초과하면 JSON-RPC -32602 에러로 거부한다. 파편 유형별 저장 절삭(episode 1000자, 그 외 300자)은 그 이전 단계로 그대로 유지되며, `batch_remember`는 초과 항목만 실패 처리하고 나머지 배치는 계속 진행한다.

### Changed
- 패턴 기반 캐시 무효화(`invalidateCacheByPattern`)를 `KEYS` 대신 Redis `SCAN` 커서 순회(`COUNT 500`, 순회 상한)로 전환.
- 로컬 임베딩(transformers provider) 초기화를 모델별 싱글톤으로 단일화해 동시 중복 로딩을 방지하고, 추론을 FIFO 큐로 직렬화. 배치 임베딩(`embedBatch`)은 청크 단위 텍스트 배열을 파이프라인에 1회 추론으로 전달한다.
- 마이그레이션 SQL 파일을 `lib/memory/migrations/` 디렉토리로 이동. `npm run migrate` 동작은 변경 없음.
- `lib/memory/` 하위를 `read/`·`write/`·`consolidate/`·`link/`·`signals/`·`processors/`·`embedding/` 서브디렉토리 체계로 재배치.

## [4.7.0] - 2026-06-20

### Added
- `batch_remember` 비동기 신뢰성 처리: 백그라운드 워커가 ack·재시도(최대 3회)·dead-letter·기동 복구(RPOPLPUSH reliable queue)로 at-least-once 배치 처리를 보장한다.
- `batch_status(jobId)` 도구 추가: `batch_remember(async: true)` 결과 `jobId`로 처리 상태(queued/processing/completed/dead)를 조회하는 읽기 전용 도구.
- Deferred tool discovery 클라이언트 가이드: Codex Desktop 등 lazy 로딩 클라이언트를 위한 `instructions` 초기화 지침·SKILL.md 섹션·README 가이드를 일관되게 정비.
- 코어 도구에 MCP `title` + `annotations`(readOnlyHint/idempotentHint/openWorldHint) 메타데이터 추가. `tools/list` 응답에서 `recall`이 `remember` 바로 다음에 노출된다.

### Changed
- `batch_remember`·`memory_consolidate`가 표준 단일 JSON-RPC 응답으로 반환된다. `stream` 파라미터는 deprecated(하위 호환 유지, 동작 없음).
- 총 도구 수 17 → 20(`batch_status`, `session_rotate`, `check_update`/`apply_update` 반영).

## [4.6.0] - 2026-06-16

### Added
- 벡터 검색 HNSW 인덱스 강제 옵션·토글: `ORDER BY embedding <=> v LIMIT` 트랜잭션에 `enable_seqscan=off`·`enable_bitmapscan=off`·`hnsw.iterative_scan` 힌트를 적용해 HNSW 인덱스 경로를 강제.
- `batch_remember` 비동기(파이어앤포겟) 모드 opt-in: `async: true` 지정 시 선검증 후 Redis 큐 적재, `{async, accepted, rejected, jobId}` 즉시 반환. `BatchRememberWorker`가 본처리. 기본 `async: false`로 기존 동기 동작 불변. Redis 비활성 환경에서는 동기 폴백.
- 배치 작업 전용 연결 풀(`getBatchPool`, `application_name='memento-mcp:batch'`) 및 배치 풀 통계 메트릭 수집.

### Changed
- HNSW 인덱스 정의의 `ef_construction` 정합화, L3 형태소 보강 검색 병렬 실행, RRF 병합 후보에 importance 하한 컷오프 적용.
- reflect 항목 자기완결성 게이트 및 한글 하한 강화.
- 키 스코프 조회를 `keyScopeClause` 공용 헬퍼로 통일: `getById`·`findCaseIdBySessionTopic`·`findErrorFragmentsBySessionTopic`·`GraphLinker` 공유. `GraphLinker` 키 필터를 파라미터 바인딩·`text` 타입 정합으로 정리.
- 피드백 importance 보정 계수를 `feedbackFactor` 순수 함수로 단일화(라이브 계수 0.85/1.1/0.95 유지).
- `tools/call` 메트릭 중복 집계 제거.
- 내부 중복 정리: 요청 컨텍스트 추출·키워드 정규화·도구 감사 래퍼·검색 SELECT 상수·affect 조건·Bearer 추출·환경변수 리스트 파싱·공통 파라미터 스키마 각각 단일 위치로 통합.
- 대형 메서드 분해: `remember`·`handleMcpPost`·`buildAdminPaths`·`dispatchJsonRpc`·`ContextBuilder.build`·검색 RRF·컨솔리데이션/분해/압축.

### Fixed
- `getUnreflectedSessions`의 Redis SCAN 순회에 상한(최대 20라운드)을 두어 대용량 keyspace에서 context 응답이 지연되던 문제 해결.

## [4.5.0] - 2026-06-09

### Added
- `lib/memory/consolidate/split-gate.js`: 분할 자식 품질 게이트 순수 함수 모듈. `isAcceptableSplitChild`(최소 길이 20자·대체 문자·CJK 혼입·대명사 시작 reject)와 `clampChildImportance`(부모×0.7 상한 클램프; fact 타입은 0.4 미만 시 `null` 반환)를 export한다.
- `lib/memory/consolidate/split-metrics.js`: `memento_consolidate_split_skipped_total{reason}` Prometheus 카운터 모듈. reason 라벨: `provider_error` · `llm_error` · `low_yield` · `insert_shortfall`.
- `scripts/cleanup-legacy-split-fragments.js`: `source LIKE 'split:%'` 자식 파편 일괄 정리 스크립트.
- `lib/memory/migration-036-split-attempt-failed-at.sql`: `fragments.split_attempt_failed_at TIMESTAMPTZ NULL` 컬럼 및 partial index 추가. 분할 실패 backoff 구현의 DB 기반.
- `config/memory.js` `gc.splitChildPolicy` 블록: `maxImportance`(0.3), `orphanAgeDays`(30), `tombstonedGraceDays`(7) 키 신설.
- `config/memory.js` `fragmentSplit` 블록에 `minChildLength`(20), `excludeMetaTopics`(`["session_reflect","consolidation","reflection"]`), `failureBackoffHours`(24) 키 신설.
- `lib/config.js` `resolveSplitChainConfig(env)`: `MEMENTO_SPLIT_LLM_PRIMARY` + `MEMENTO_SPLIT_LLM_FALLBACKS` 환경변수에서 split 전용 provider 체인을 파싱한다. 미설정 시 `null` 반환 → 전역 체인 재사용.

### Changed
- `splitLongFragments` two-phase gate-then-commit: Phase 1에서 모든 자식 후보를 `isAcceptableSplitChild`·`clampChildImportance`로 검증하고, 통과 수 < `minItems`이면 DB 커밋 없이 해당 파편의 `split_attempt_failed_at`만 갱신한다. Phase 2는 통과 후보만 일괄 insert한다.
- 분할 후 원본 파편 tombstone: `valid_to = NOW()`, `importance = GREATEST(0.2, importance × 0.3)`, `ttl_tier = 'cold'`.
- 분할 후보 SELECT 쿼리에 `source NOT LIKE 'split:%'`·메타 토픽 제외·`split_attempt_failed_at < NOW() - backoffHours` 필터 추가. `buildSplitCandidateQuery` 함수로 분리.
- `FragmentGC.deleteExpired`에 split 자식 branch-2 추가: 부모가 tombstone(`valid_to IS NOT NULL`)된 split 자식을 `tombstonedGraceDays`(7일) 후 삭제.

## [4.4.0] - 2026-06-09

### Added
- `lib/memory/keyScope.js`: 키 격리 WHERE 절 생성 공용 헬퍼 `keyScopeClause`. 스칼라 키는 `IS NOT DISTINCT FROM`, 그룹 키는 `= ANY($n::text[])`로 매칭한다.

### Changed
- `graph_explore`(getRCAChain)·`search_traces`·`reconstruct_history`가 그룹 공유 키(`_groupKeyIds`) 범위의 파편을 조회하도록 키 격리 절을 적용. `LinkStore.getRCAChain`·`_queryFragmentTraces`·`HistoryReconstructor._fetchTimelineParameterized`가 `keyScopeClause`를 공유한다.
- `FragmentReader.getByIds`에 `groupKeyIds` 인자 추가 (미전달 시 기존 단일 키 동작 유지).
- recall의 stale 판정에 `verified_at` 부재 시 `created_at` 폴백을 적용하고, 시각 정보가 없으면 판정을 보류.
- X-Forwarded-For 처리를 TRUST_PROXY_HOPS 기반 헬퍼로 통합 (미설정 시 기존 동작 유지).

### Removed
- 미사용 lib/tools/db-tools.js 모듈.

### Docs
- ALLOWED_ORIGINS, TRUST_PROXY_HOPS, ADMIN_ALLOWED_ORIGINS, OAUTH_TRUSTED_ORIGINS 운영 권장값 안내 추가.

## [4.3.0] - 2026-05-22

### Added

- `lib/memory/embedding/MorphemeTokenizer.js` 신규 모듈. 유니코드 스크립트 런 분할 후 언어별 분석기로 라우팅: 한글 garu-ko, 영어 natural PorterStemmer, 중국어 @node-rs/jieba, 일본어 kuromoji. `MorphemeIndex.tokenize()`가 이 모듈에 위임한다.
- 환경변수 `MEMENTO_MORPHEME_TOKENIZER=local|llm` (기본 `local`). `llm` 설정 시 종전 LLM 서브프로세스 경로로 롤백.
- 환경변수 `MEMENTO_ENABLE_KUROMOJI=true|false` (기본 `true`). `false` 설정 시 kuromoji 로딩 생략 (~269MB RSS 절감).
- `config/memory.js` `morphemeIndex` 블록에 `kanaMinChars`(기본 2), `enableKuromoji`(기본 true) 키 추가.
- 한글 형태소 stopword 필터 `filterHangulMorphemes`: 조사·어미·단음절을 제거하고 의미 형태소만 반환.

### Changed

- L3 형태소 토크나이저를 LLM 서브프로세스(쿼리당 ~10초)에서 로컬 CPU 분석기(MorphemeTokenizer)로 전환. 벤치마크: 1.06ms/call(약 9400배 개선), 상주 RSS +28.9MB.
- `MorphemeIndex._tokenize()` 내부가 `MEMENTO_MORPHEME_TOKENIZER=local`(기본)일 때 `MorphemeTokenizer.tokenize()`로 위임. `llm` 경로는 기존 `_tokenizeViaLLM()` 그대로 유지.
- OpenAI 임베딩 경로(`getOrRegisterEmbeddings`) 및 `morpheme_dict` DB 스키마 변경 없음.
- Docker 베이스 이미지를 `node:20-alpine`에서 `node:24-alpine`으로 상향. garu-ko(WASM)가 요구하는 WASM stringref를 컨테이너 런타임에서 지원하기 위함.
- reflect의 narrative episode 저장 경로에서 충돌 감지(`detectConflicts`)를 생략하는 `skipConflictDetection` 옵션 도입. episode 저장 지연을 약 1,100ms에서 약 150ms로 단축한다. 일반 `remember`는 기본값으로 충돌 감지를 유지하며, 정합성 자동 링크(related·temporal·preceded_by)는 그대로 수행된다.

### Removed
- jest, @jest/globals, babel-jest devDependencies
- jest.config.js
- tests/*.test.js 11개 (tests/unit/ 동명 파일로 시나리오 흡수, consolidator-metrics는 node:test mock.module로 재작성)
- npm scripts test:jest, test:unit:node

### Changed
- npm test가 node --experimental-test-module-mocks --test 단일 호출
- 동명 충돌 10건 통합 분석 결과 9건은 node:test 측이 완전 변환본, decay만 실질 분기로 jest 측 8건 흡수
- tests/unit의 hang 8건 cleanup 패턴 표준화 (disconnectRedis + getPrimaryPool().end())

### Fixed
- 8개 unit 테스트 파일의 Redis/Postgres 연결 미정리로 인한 30~90s hang 해소 (30~90s → 1~3s)

## [4.2.0] - 2026-05-19

자동 후처리 4개 층위(ProactiveRecall · autoLinkSessionFragments · MemoryConsolidator · AutoReflect)에서 misgrouping·interference·overfit을 유발하는 rewrite-loop 경로를 schema-fit gate로 차단한다. 기존 DB 스키마·외부 API 호환. `tool_reflect` 응답에 `_meta` 블록이 신설되어 `link_suggestions[]` 필드가 신규 노출된다.

### Added

- `config/memory.js` `proactiveRecall` 블록 신설: `mode`(env `MEMENTO_PROACTIVE_RECALL_MODE`, 기본 `auto`; 값 `off`/`auto`/`legacy`), `keywordOverlapMin`(env `MEMENTO_PROACTIVE_KW_OVERLAP_MIN`, 기본 0.5), `requireSameWorkspace`(true), `caseIdPolicy`(env `MEMENTO_PROACTIVE_CASE_POLICY`, 기본 `strict-or-adjacent`; 값 `both-required`/`strict-or-adjacent`/`loose`), `adjacencyWindowMs`(24h), `requireSameTopicOrType`(false).
- `config/memory.js` `consolidate.schemaFit` 블록: `pendingCaseFragmentsMin`(5), `recentRelatedLinksMin`(20), `fragmentsSinceLastRunMin`(30), `mode`(env `MEMENTO_CONSOLIDATE_GATE_MODE`, 기본 `any`; 값 `all`/`any`/`off`).
- `config/memory.js` `consolidate.enableRiskyStages` 블록: `splitLongFragments`(env `MEMENTO_CONSOLIDATE_SPLIT_LONG`, 기본 true), `detectContradictions`(env `MEMENTO_CONSOLIDATE_DETECT_CONTRADICT`, 기본 true), `compressOldFragments`(env `MEMENTO_CONSOLIDATE_COMPRESS_OLD`, 기본 false).
- `lib/symbolic/rules/v1/proactive-gate.js` `evaluateProactiveGate`에 `workspace_mismatch`·`case_policy` 차단 사유 추가. `caseIdPolicy` 3-값 분기 구현.
- `lib/scheduler.js` `evaluateSchemaFitGate(pool, cfg, lastRunTimestamp)` 함수. setInterval 콜백이 consolidate 호출 전 schema-fit gate를 평가하여 미충족 시 다음 tick으로 deferred. gate 오류 시 fail-open으로 안전 통과.
- 신규 unit 테스트: `tests/unit/proactive-recall-gate.test.js`(8), `tests/unit/auto-link-session-gate.test.js`(10), `tests/unit/consolidator-schema-fit-gate.test.js`(15), `tests/unit/reflect-meta-link-suggestions.test.js`(3).

### Changed

- `lib/memory/RememberPostProcessor.js` `_proactiveRecall`: 50% 키워드 오버랩 단일 기준의 자동 `related_to` 링크가 `proactiveRecall.mode` 분기로 wrap. `off`이면 자동 링크 0건, `auto`이면 기존 symbolic gate + workspace + caseIdPolicy 통과 시만, `legacy`이면 v4.1.0 이전 행동.
- `lib/memory/SessionLinker.js` `autoLinkSessionFragments`: errors×decisions(caused_by)·procedures×errors(resolved_by) 카르테시안 곱 이중 for문을 1:1 top-1 schema-fit 매칭으로 교체. 매칭 기준은 동일 caseId 또는 sessionId 인접 + 키워드 60% 오버랩 + phase 단방향 정합성(planning→debugging→verification). 게이트 미통과 후보는 `linkSuggestions[]`로 반환.
- `lib/memory/ReflectProcessor.js`: `autoLinkSessionFragments` 반환값에서 `linkSuggestions`를 받아 `_link_suggestions`로 전파.
- `lib/tools/memory.js` `tool_reflect` 응답: `_meta` 블록 신설. 구조는 `{ searchEventId, hints, suggestion, link_suggestions, serverTime }`로 recall/context와 동일. `link_suggestions[]`는 schema-fit 미통과로 자동 링크 안 된 후보를 LLM에게 위임하는 채널.
- `lib/scheduler.js`: `CONSOLIDATE_INTERVAL_MS` 직접 ENV 파싱을 `MEMORY_CONFIG.consolidateIntervalMs` 참조로 교체. ENV 처리 단일 진입점화.
- `lib/memory/consolidate/MemoryConsolidator.js`: `split_long_fragments`·`detect_contradictions`·`compress_old_fragments` 3개 stage에 `enableRiskyStages` 플래그 분기. 비활성 시 stage가 `status="skipped"`로 즉시 반환. `timedStage`가 `{status, affected}` 제어 객체를 처리.
- `config/memory.js` `consolidateIntervalMs` 기본값 `3600000`(1h, dead) → `21600000`(6h, scheduler 실제 동작값과 일치).

### Design notes

자동 통합 4개 층위 중 ProactiveRecall과 MemoryConsolidator는 schema-fit gate로 보수 전환하고, autoLinkSessionFragments는 곱집합을 제거하여 1:1 매칭 + LLM 위임으로 교체했다. AutoReflect는 별도 게이트 없이 P2 범위로 분리. 검토 단계에서 `requireSameCaseOrNone: true` 단일 플래그가 legacy caseId-null 파편의 무차별 통과 누수를 발생시킨다는 지적이 들어와 `caseIdPolicy` 3-값으로 확장하고 기본을 `strict-or-adjacent`로 두어 sessionId·24h 인접·workspace 신호로 보강했다. `compress_old_fragments`는 가장 공격적인 LLM 재작성 stage라 기본 off로 둔다. schema-fit gate 조건은 SQL 실현 가능 형태(`fragments.case_id` GROUP BY, `fragment_links.created_at` window, `lastConsolidation.timestamp` 이후 fragment count)로 설계됐다.

### Rationale

Zhang et al. 2026("Useful Memories Become Faulty When Continuously Updated by LLMs", arXiv 2605.12978)이 LLM 자동 메모리 재작성에서 misgrouping/interference/overfit 3대 실패 메커니즘을 보고했고, GPT-5.4가 ground-truth로 consolidation 후 ARC-AGI 19문제 중 54%를 회귀로 잃었다. 권고는 raw episode 1급 보존과 schema-fit gate 기반 명시 통합. SSGM(arXiv 2603.11768)·CraniMem(2603.15642)·Position-Episodic(2502.06975)·ArcMemo(2509.04439)가 같은 방향(gated consolidation, episodic 보존)으로 수렴하는 학계 흐름과 정합. 본 릴리즈는 P1 권고 3건만 범위에 포함하고, Episodic↔Abstract 분리(P2)와 A/B 평가 루프(P3)는 후속 플랜으로 둔다.

## [4.1.0] - 2026-05-15

recall 최종 정렬에서 cross-encoder reranker 결과를 보존하고, topic/keyword 직접 일치 신호를 제한된 가산항으로 반영한다. recall/context 응답 `_meta`에 서버 현재 시각을 일관되게 노출하여 LLM 클라이언트의 학습 시점 시간 고착을 방지한다. 기존 API·DB 스키마 호환, 응답 추가 필드(`_meta.serverTime`)만 신규 노출.

### Added

- `lib/memory/processors/MemoryRecaller.js` `computeRecallScore` export. recall 최종 정렬용 단일 점수 함수. `rerankerScore` 보유 시 그것을 base로 사용, 미보유 시 `(importance × 0.4 + proximity × 0.3 + similarity × 0.3) × unrerankedBaseDiscount(0.85)`. lexical 일치는 log 스케일 정규화 후 파편별 제한 가중치로 가산.
- `lib/memory/read/FragmentSearch.js` `deriveImplicitKeywords`, `lexicalMatchScore` export. text-only 짧은 질의의 보조 키워드 추출(최소 3자, 한국어/영어 stopword 확장)과 topic/keyword 직접 일치 점수 계산.
- `lib/tools/serverTime.js` (신규) `serverTimeMeta()`. `iso`(UTC ISO 8601), `epoch_ms`, `display_kst`(Asia/Seoul 한국어), `timezone` 4필드 반환.
- `config/memory.js` `ranking` 블록 신규 키 5종: `lexicalWeightReranked` 0.12, `lexicalWeightFallback` 0.18, `lexicalLinkedMultiplier` 0.5, `lexicalSaturation` 8, `unrerankedBaseDiscount` 0.85.
- 신규 unit 테스트: `tests/unit/lexical-match-score.test.js`(8), `tests/unit/recall-final-ranking.test.js`(8), `tests/unit/recall-ranking-integration.test.js`(4), `tests/unit/server-time-meta.test.js`(4).

### Changed

- `lib/memory/processors/MemoryRecaller.js` `recall`: includeLinks 병합 직후 수행하던 `importance/recency/similarity` 단일 재정렬을 `computeRecallScore` 기반 통합 정렬로 교체. 이전 코드는 `rerankerScore`를 참조하지 않아 cross-encoder 비용을 폐기하고 topic/keyword 직접 일치 신호도 누락했다. 새 정렬은 파편별 `rerankerScore` 유무로 `lexWeight`를 분기하며, includeLinks 파편을 `_source="linked"`로 태깅해 lexical 가중치를 절반으로 감쇠한 뒤 응답에서 제거한다.
- `lib/tools/memory.js` recall(caseMode+일반 두 분기) 및 context 응답의 `_meta` 객체에 `serverTime: serverTimeMeta()` 주입. 기존 필드(`searchEventId`, `hints`, `suggestion`) 구조 무변경.

### Design notes

검토 단계에서 lexical 일치를 `if (lexical > 0) return 1000 + lexical` 형태의 hard override로 부여하는 패치가 제안됐으나, 다중 LLM 토론(Oracle Pro / Claude / Gemini)을 거쳐 다음 5개 결함으로 기각했다: (a) reranker 결과 폐기 (b) reranker와 lexical의 이중 계산 (c) 직접/연결 파편 미구분 (d) `threshold` 필터 우회 (e) cursor 페이지네이션 불안정. 채택된 가산항 방식은 rerankerScore 격차를 lexical 보정이 무조건 뒤집지 않도록 lexWeight 상한을 0.12(reranked) / 0.18(fallback)로 제한하며, 정렬은 결정적이라 페이지 경계가 안정적이다.

## [4.0.1] - 2026-05-14

기존 API·DB 스키마 호환. 외부 호출자 응답 구조 무변경.

### Added

- `MEMENTO_RECALL_MIN_SIM_FLOOR` 환경변수. `SearchParamAdaptor.getMinSimilarity`가 반환하는 적응형 임계값에 옵트인 하한을 강제한다. 미설정 시 기존 동작 그대로.

### Changed

- `lib/memory/read/FragmentSearch.js` `_executeSearch`:
  - Cross-encoder Reranker 호출 시 `topic: <topic> keywords: <keywords> text: <text>` 형식의 query를 전달하여 정확 매칭 신호가 재정렬 단계까지 보존된다.
  - `l1MissIds`를 `l1IsFallback`에 따라 빈 배열로 강제. fallback fragment가 `_searchL2.getByIds`로 추가 조회되어 결과에 섞이는 경로를 차단.
  - RRF의 L1 layer 가중치를 `l1IsFallback ? 0.5 : MEMORY_CONFIG.rrfSearch.l1WeightFactor`로 분기. fallback 경로의 L1 결과가 정상 L2/L3보다 위로 올라오지 않게 강등.
- `config/memory.js` `semanticSearch.minSimilarity` 0.35 → 0.5.
- `lib/memory/embedding/EmbeddingCache._key`: 캐시 키에 `EMBEDDING_MODEL` prefix 결합. 모델 변경 시 stale 벡터 hit 방지.
- `lib/memory/assistant-query.js` `boostAssistantFragments` 기본 boost 0.05 → 0.02.

### Tests

- `tests/unit/fragment-search-fallback-guard.test.js` 신설. 정적 가드 3건 + 동적 가드 2건.
- 영향권 단위 테스트 114건 회귀 0.

---

## [4.0.0] - 2026-05-13

기존 API·DB 스키마 호환. 외부 호출자 인터페이스 무변경. major 표시는 storage 어댑터 계층 도입으로 데이터 액세스 surface가 추가됐기 때문이다.

### Added

- `lib/storage/` 어댑터 계층 신설.
  - `lib/storage/index.js`: `getStorage()` 팩토리. `MEMENTO_STORAGE` 환경변수로 어댑터 선택(기본 `pgvector`).
  - `lib/storage/PgVectorStore.js`: 기존 `lib/tools/db.js`의 `getPrimaryPool`·`queryWithAgentVector`를 위임 호출하는 어댑터. `engine='pgvector'`, `vectorSupport='native'`.
  - `lib/storage/SqliteVecStore.js`: v4.1 본격 구현 예정 stub. 모든 메서드가 not-implemented throw.
  - `lib/storage/README.md`: 어댑터 계층 가이드.
- `lib/memory/read/SearchScope.js` 신설.
  - `SearchScope` 값객체. 필드: `workspace`, `caseId`, `resolutionStatus`, `phase`, `affect`, `keyId`.
  - `applyTo(fragment)` / `fromQuery(sq)` 정적 팩토리.

### Changed

- `lib/memory/read/FragmentSearch.js`: `_executeSearch` 본문의 후처리 보정 4블록(workspace, caseId, resolutionStatus/phase, affect 필터링)을 제거. `_searchL3` WHERE 절에 동일 필드 추가, `_tryHotCache` 결과에 `SearchScope.applyTo` 적용, `fetchGraphNeighbors` 결과에도 호출 직후 동일 필터 적용. L1+HotCache+L2+L3+Graph 결과가 모두 SearchScope 정합 상태로 도착하므로 후처리 보정이 불필요해졌다.
- `_searchEventId` 동기 반환 계약과 `search()` 응답 구조는 무변경.

### Tests

- `tests/unit/search-scope-contract.test.js`: SearchScope contract 회귀 가드(정적 + 동적).
- `tests/unit/storage-adapter.test.js`: 어댑터 인터페이스·팩토리 동작·SqliteVecStore not-implemented throw 검증.
- 누적 185건 회귀 0.

### 향후

- v4.1: `SqliteVecStore` 본격 구현(sqlite-vec npm 의존 + 마이그레이션 SQLite 변환 + lite 모드 e2e). 기존 `lib/memory/*` 호출 사이트를 `getStorage()` 어댑터 경유로 마이그레이션.
- v4.x: `lib/memory/<File>.js` stub re-export 14개의 점진 제거(외부 호출 사이트를 서브디렉토리 경로로 직접 import 전환 후).

---

## [3.9.0] - 2026-05-13

기존 API·DB 스키마 호환. 외부 호출자 인터페이스 무변경.

### Added

- `lib/memory/read/SearchSideEffects.js`: 검색 파이프라인 직후의 부작용(`recordSearchEvent` + `SearchParamAdaptor.recordOutcome`)을 단일 모듈로 격리. `commitSearchSideEffects(query, sq, cleanResult, ctx) → searchEventId` 함수 export.

### Changed

- `lib/memory/read/FragmentSearch.js`: 내부 헬퍼 `_commitSearchSideEffects`를 제거하고 SearchSideEffects 모듈로 위임. FragmentSearch는 검색 파이프라인 자체에만 집중한다. `_searchEventId` 반환 계약 유지.
- `scripts/migrate.js`: 마이그레이션 SQL의 인라인 BEGIN/COMMIT 제거와 schema_migrations INSERT 제거를 위한 정규식 4줄을 삭제. 기존 14개 마이그레이션 파일을 일괄 normalize하여 body-only 규약(`docs/migration-conventions.md`)을 적용 완료. opclass placeholder 치환은 유지.
- `lib/memory/migration-*.sql`: 14개 파일에서 인라인 `BEGIN;`/`COMMIT;` 라인 제거, 4개 파일에서 `INSERT INTO agent_memory.schema_migrations ... ON CONFLICT ...;` 블록 제거. 신규 파일은 `scripts/lint-migrations.js`가 PR 시점에 동일 규약을 강제한다.

### Tests

- `tests/unit/fragment-search-side-effect-split.test.js`: 정적 가드를 모듈 외부화에 맞춰 갱신. SearchSideEffects 모듈 존재, `commitSearchSideEffects` export, FragmentSearch import, `_commitSearchSideEffects` 메서드 잔존 0, 인라인 `recordSearchEvent`/`recordOutcome` 호출 0 검증(총 8 케이스).
- 영향권 138건 회귀 0.

---

## [3.8.0] - 2026-05-13

기존 API·DB 스키마 호환. Breaking change 없음. 외부 호출자 `search()` 응답 구조 무변경.

### Changed

- `lib/memory/read/FragmentSearch.js`: `search()` 본문의 부작용 처리(검색 이벤트 영속화 `recordSearchEvent` + SearchParamAdaptor `recordOutcome`)를 `_commitSearchSideEffects` 메서드로 추출. 검색 파이프라인은 결과 자체 생성에 집중하고 부작용은 단일 단계로 격리된다. `_searchEventId` 동기 반환 계약 유지.

### Tests

- `tests/unit/fragment-search-side-effect-split.test.js`: 5 케이스 정적 회귀 가드. `_commitSearchSideEffects` 정의 존재, `search()` 호출, `recordSearchEvent`/`recordOutcome` 단일 호출 위치, `_searchEventId` 반환 계약을 검증.
- 영향권 단위 테스트 125건 + FragmentSearch 관련 111건 모두 회귀 0.

### 향후

- 후속 PR에서 `SearchSideEffects` 모듈로 외부화하여 `FragmentSearch`에서 완전히 분리할 수 있다(F10 2차).
- `SearchScope` contract 도입(F11)으로 L1/HotCache/Graph/L2/L3 검색 레이어가 동일 scope 객체를 받게 되면 `_executeSearch`의 후처리 보정 코드도 제거 가능.

---

## [3.7.0] - 2026-05-13

기존 API·DB 스키마 호환. 외부 import 경로 호환 (stub re-export).

### Changed

- `lib/memory/` 14개 핵심 모듈을 6개 서브디렉토리로 분류 이동:
  - `read/` (FragmentSearch, CaseRecall, LinkedFragmentLoader, RecallSuggestionEngine)
  - `write/` (FragmentWriter)
  - `link/` (ReconsolidationEngine)
  - `consolidate/` (MemoryConsolidator, FragmentGC)
  - `embedding/` (EmbeddingWorker, EmbeddingCache, MorphemeIndex)
  - `signals/` (SpreadingActivation, CaseRewardBackprop, NLIClassifier)
- 외부 호환을 위해 기존 위치(`lib/memory/<File>.js`)에 stub re-export 파일 14개 유지. 호출자 import 경로 무변경.
- 이동된 파일 내부 import는 stub 경로(`from "../<X>.js"`)를 통해 한 단계 위로 갱신.

### Tests

- `tests/unit/consolidator-stage-declarative.test.js`, `tests/unit/consolidator-merge-tenant-scope.test.js`: 정적 가드의 소스 경로를 `lib/memory/consolidate/MemoryConsolidator.js`로 갱신.
- 영향권 단위 테스트 125건 통과(회귀 0).

### 향후

- 외부 호출 사이트가 직접 서브디렉토리 경로(`lib/memory/<sub>/<File>.js`)를 import하도록 점진 전환하면 stub 14개를 후속 PR에서 제거할 수 있다.
- `lib/memory/` 직접 위치에 남은 다른 모듈들(약 25개)은 후속 PR에서 단계적으로 분류한다.

---

## [3.6.0] - 2026-05-13

기존 API·DB 스키마 호환. Breaking change 없음.

### Added

- `lib/config.js`에 `CASE_BACKPROP_ENABLED` export 추가 (외부 노출용 상수).
- `MEMENTO_CASE_BACKPROP_ENABLED` 환경변수: `CaseRewardBackprop.backprop`을 활성화한다. 기본 off. 미설정 또는 `false` 시 호출 자체가 즉시 반환되어 DB 쿼리·메트릭 영향이 없다.

### Changed

- `CaseRewardBackprop.backprop`이 매 호출 시 `process.env.MEMENTO_CASE_BACKPROP_ENABLED`를 평가한다(런타임 토글 가능).
- `docs/features.md` 실험 플래그 표를 사실 정정: NLIClassifier·AutoReflect·ReconsolidationEngine을 실험 표에서 제거하고 dual-mode/항상 활성 기능으로 별도 분류. 실제 ENV 토글이 동작하는 SpreadingActivation·CaseRewardBackprop만 실험 플래그로 유지.

### Tests

- `tests/unit/case-reward-backprop.test.js`: ENV 활성·미설정·`false` 명시 3축을 모두 검증하도록 케이스 2건 추가(총 7건 통과).

---

## [3.5.0] - 2026-05-13

기존 API·DB 스키마 호환. Breaking change 없음.

### Added

- `scripts/lint-migrations.js`: 신규 마이그레이션 파일이 body-only 규약(`BEGIN`/`COMMIT` 래퍼 금지, `INSERT INTO agent_memory.schema_migrations` 금지, 파일명 `migration-NNN-<slug>.sql`)을 따르는지 검증한다. cutoff는 환경변수 `MIGRATION_LINT_FROM` 또는 기존 파일 최대 번호+1로 자동 결정되어 기존 파일은 면제된다.
- `package.json` scripts: `lint:migrations` 항목.

### Docs

- `docs/migration-conventions.md`: 신규 마이그레이션 파일이 따라야 할 body-only 규약·멱등성 패턴·파일명 규약·추가 절차.
- `docs/operations/agent-worktree.md`: 에이전트 isolation 워크트리 적체 방지 운영 가이드. cleanup 훅·cron GC·상한 5개·일괄 정리 절차·트러블슈팅.
- `docs/operations/upstream-porting.md`: upstream remote 등록·port 브랜치 네이밍·cherry-pick 우선 정책·divergence 감지·fork 전용 패치 격리·충돌 해결 절차.

---

## [3.4.0] - 2026-05-13

기존 API·DB 스키마 호환. Breaking change 없음.

### Changed

- `lib/llm/index.js`: dispatcher 코어를 `dispatchChain(chain, prompt, options, deps)`로 추출하여 export. `llmJson`은 chain 빌드·redact만 담당한 뒤 `dispatchChain`에 위임한다. semaphore·deadline·timeout cap 분기는 모두 `dispatchChain` 안에서 동작하며 `deps`로 `getSemaphoreFn`/`getLimitFn`/`concurrencyEnabled`/`concurrencyWaitMs`/`startedAt`을 주입할 수 있어 단위 테스트가 실 구현을 검증한다.

### Tests

- `tests/unit/llm-dispatcher-concurrency.test.js`: 인라인 dispatcher mirror 70여 줄을 제거하고 `dispatchChain` 직접 호출 형태로 재작성. mock provider를 `callJson` 기반으로 통일.
- `tests/unit/llm-dispatcher-no-inline-mirror.test.js`: dispatcher export 존재, `llmJson` 본문의 chain for-loop 잔존 0, 테스트의 인라인 mirror 정의 0을 정적으로 가드.

### Docs

- `docs/concurrency.md`: write 경로별 lock·격리·재시도 매트릭스. 새 경로 추가 규약과 관련 ENV 정리.
- `docs/features.md`: 주요 모듈 ledger (입력/출력/실패 모드/ENV/메트릭/migration). 실험적 기능 플래그 표 + 새 모듈 추가 규약.

---

## [3.3.0] - 2026-05-13

기존 API·DB 스키마 호환. Breaking change 없음.

### Changed

- `MemoryConsolidator._runConsolidationCycle`: 21개 stage를 선언형 `stageDefs` 배열로 재구성. `TOTAL_STAGES`가 `stageDefs.length`로 산출되어 SSE/관리 콘솔 진행률이 실제 stage 수와 일치한다. 신규 stage 추가는 배열에 한 항목만 push하면 자동 반영.
- `package.json` scripts.test:ci: `npm test && npm run test:integration` 구조로 단순화. `test:integration`이 이미 e2e를 포함하므로 중복 `test:e2e` 호출을 제거하고 CI 단일 게이트에 통합 테스트가 누락되던 회귀를 차단한다.

### Tests

- `tests/unit/consolidator-stage-declarative.test.js`: 정적 가드(`TOTAL_STAGES = stageDefs.length`, 21개 stage 선언 존재, 리터럴 잔존 0) + 동적 가드(progress 이벤트의 total/processed 정합)로 4 케이스 회귀 가드.

### Docs

- `tests/README.md`: `npm run test:ci` 단일 게이트 항목 추가.

---

## [3.2.2] - 2026-05-13

기존 API·DB 스키마 호환. Breaking change 없음.

### Changed

- `MemoryRememberer.remember`: PolicyRules 게이트 평가를 `_runPolicyGate` 헬퍼로 통일. dryRun·atomic·non-atomic 분기 모두 동일 시점에 평가하며 `validation_warnings` 누적 형식을 일치시킨다. `apiKeyStore` 조회 실패 시 fail-open 동작 유지.
- `MemoryRememberer._finalizeRemember`: 응답에 `validation_warnings`를 노출하여 atomic·non-atomic 응답 구조를 정합화.
- `MemoryConsolidator._mergeDuplicates`: 그룹 키를 `(key_id, workspace, content_hash)`로 한정. `WHERE key_id IS NOT NULL`로 master 키는 자동 병합 대상에서 제외한다. linked_to UPDATE와 `store.delete`에 `key_id`를 함께 전달하고, 그룹 동질성 어설션을 추가한다.

### Tests

- `tests/unit/atomic-remember-policy-gate.test.js`: atomic 분기 + hard gate + dryRun 조합 5 케이스 회귀 가드.
- `tests/unit/consolidator-merge-tenant-scope.test.js`: `_mergeDuplicates` SQL 그룹 키·UPDATE/DELETE 키 조건·어설션 6 케이스 정적 회귀 가드.

---

## [3.2.1] - 2026-05-13

기존 API·DB 스키마 호환. Breaking change 없음.

### Changed

- `lib/llm/util/parse-json.js`: reasoning 모델(MiniMax-M2.7, DeepSeek-R1, Qwen-QwQ 등) 응답의 `<think>...</think>` 블록을 사전 제거 후 4단계 휴리스틱을 적용. 닫힘 태그만 남은 비대칭 응답도 처리한다.
- `SKILL.md`: 상단에 기억 도구 사용 규칙 섹션을 추가하여 context → recall·remember → reflect 흐름과 Recall-First 원칙을 명문화.

### Tests

- `tests/unit/llm-parse-json.test.js`: `<think>` 블록 5 케이스 추가.

---

## [3.2.0] - 2026-04-29

기존 API·DB 스키마 호환. Breaking change 없음.

### Added

- `BatchRememberProcessor`: multi-row INSERT (24컬럼 × N행 placeholder, `RETURNING id`, `ON CONFLICT` 유지, 누적 256KB 또는 500행 chunk).
- `ReflectProcessor`: 5카테고리(summary / decisions / errors_resolved / new_procedures / open_questions)를 `BatchRememberProcessor.process`에 단일 위임. 사전 validate 강화.
- `EmbeddingWorker._embedMany`: `generateBatchEmbeddings` 1회 + multi-row UPDATE 1회. row 단위 dead-letter, 단건 fallback.
- `MorphemeIndex.getOrRegisterEmbeddings`: batch 등록 (`generateBatchEmbeddings` 1회 + multi-row INSERT).
- `RememberPostProcessor`: morpheme 등록을 fire-and-forget으로 분리.
- `fragments.morpheme_indexed BOOLEAN` 컬럼 (migration-035, default NULL). 인덱스 미완료 파편을 L3 형태소 검색에서 자동 제외.
- `drainMorpheme` graceful shutdown 훅.
- `SessionLinker.autoLinkSessionFragments`: sortedKey 사전식 정렬 + `wouldCreateCycle` 캐시.
- `LinkStore.createLinks`: advisory lock + multi-row INSERT 단일 트랜잭션. 단건 fallback 유지.
- `FragmentStore.createLinks`: N개 링크 생성 통합.
- `db.js` `getBatchPool()`: `max = primaryMax × 0.3`, `application_name = 'memento-mcp:batch'`.
- `BATCH_DATABASE_URL` 환경변수: 배치 전용 DB 엔드포인트 분리 옵션.
- `GEMINI_TIMEOUT_MS` 환경변수: AutoReflect LLM timeout 오버라이드 (기본 30s).
- batchPool Prometheus Gauge 3개: `memento_batchpool_active`, `memento_batchpool_idle`, `memento_batchpool_waiting`.

### Migration

1. `npm run migrate` — migration-035 자동 적용 (ADD COLUMN, hot deploy 안전).
2. `npm install` — dependency 변화 없음.
3. 선택: `BATCH_DATABASE_URL`, `GEMINI_TIMEOUT_MS` 환경변수.
4. 서비스 재시작.

---

## [3.1.1] - 2026-04-24

LLM Provider 체인 동시성 제어를 추가해 Ollama Cloud 및 외부 LLM 프록시 등에서 동시 요청 버스트로 발생하던 HTTP 429 연쇄 실패를 차단한다. 실측상 ollama.com `gemma4:31b-cloud`는 20-24 동시 요청을 넘기면 429를 반환하고, 일부 외부 프록시는 동시 4까지만 허용한다. 33.3GB 메모리 피크 사건의 주요 원인이던 LLM 체인 폭주 루프를 완화한다.

### Added

- `lib/llm/util/semaphore.js` — Promise 기반 counting semaphore. `createSemaphore({ key, limit, waitTimeoutMs })`, `getSemaphore(key, limit, waitTimeoutMs)` (Map 캐시), `resetSemaphores()` (테스트용).
- 디스패처 세마포어 wrap: `lib/llm/index.js`의 `llmJson` 루프가 provider 호출을 `acquire()`/`release()`로 감싼다. `waitTimeoutMs` 초과 시 해당 provider를 실패로 처리하고 다음 fallback으로 즉시 전환.
- `_cooldownUntil` 필드 + `_setCooldown(ms)` 헬퍼를 `OllamaProvider` · `OpenAICompatibleProvider`에 추가. HTTP 429 수신 시 500-2000ms 랜덤 쿨다운 동안 `isAvailable()=false`.
- 3개 Prometheus 메트릭:
  - `memento_llm_provider_concurrency_active{provider}` — Gauge
  - `memento_llm_provider_concurrency_wait_ms{provider}` — Histogram (buckets 1 ~ 30000ms)
  - `memento_llm_provider_429_total{provider}` — Counter
- 환경 변수:
  - `LLM_CONCURRENCY_ENABLED` (default `true`, kill switch)
  - `LLM_CONCURRENCY_WAIT_MS` (default `30000`)
  - `LLM_CONCURRENCY` (JSON, chainKey 또는 provider name 기준 오버라이드)
- 내장 기본 한도 (`lib/config.js` `DEFAULT_LLM_CONCURRENCY`):
  - `ollama=16`
  - `openai|https://llm.example.com/v1|google/gemma-4-31B-it=3`
  - `openai|https://token-plan-sgp.xiaomimimo.com/v1|mimo-v2-pro=8`
  - `gemini-cli=1`, `copilot-cli=1`, `codex-cli=1`, `qwen-cli=1`
  - 기타 provider = 10
- 테스트 3종 추가 (총 20 케이스, 모두 통과):
  - `tests/unit/llm-semaphore.test.js` (8 케이스)
  - `tests/unit/llm-dispatcher-concurrency.test.js` (6 케이스)
  - `tests/unit/llm-provider-cooldown.test.js` (6 케이스)

### Changed

- `lib/llm/index.js` `buildChain` 내부 dedupe key 생성 로직을 `buildChainKey(config)` 헬퍼로 추출. 세마포어 키와 동일 규약 사용.
- `.env.example` LLM 섹션에 동시성 제어 env 3종 안내 블록 추가.

### 회귀 가드

- 기존 `llm-fallback-chain.test.js` (7) + `llm-circuit-breaker.test.js` (8) 15개 테스트 모두 그대로 통과
- `LLM_CONCURRENCY_ENABLED=false`로 세마포어 완전 우회 가능 — 문제 발생 시 즉시 비활성화
- 429 쿨다운은 기존 circuit breaker와 독립 메커니즘. circuit=장기 연속 실패 차단, 쿨다운=단기 동시성 완화

### Migration Guide (v3.1.0 → v3.1.1)

1. `npm install` — dependency 변화 없음, `package-lock.json`만 갱신
2. 신규 env 변수 설정은 선택사항. 미설정 시 내장 기본값 사용
3. `LLM_FALLBACKS` 내 provider chain key가 내장 기본값과 다르면 `LLM_CONCURRENCY='{...}'`로 명시
4. 서비스 재시작 후 `memento_llm_provider_429_total` 메트릭 감시

### 미해결 / 후속

- MorphemeIndex 팬아웃 축소(reflect 1회 → tokenize N회 병렬)는 별도 이슈로 분리. `tokenizeBatch()` 배치 API 추가 검토는 v3.2.0 후보.

---

## [3.1.0] - 2026-04-21

v3.0.0에서 예고된 deprecation 2건을 실제로 제거한다. v3.0.0으로 올라온 사용자 중 mirror 경로에 의존하던 클라이언트는 `_meta.*` 또는 신규 스크립트 경로로 전환이 필요하다.

### Breaking Changes

- **recall / context 응답 top-level mirror 필드 제거**: `_searchEventId`, `_memento_hint`, `_suggestion` 세 필드가 더 이상 응답 최상위에 포함되지 않는다. 동일 값은 v3.0.0부터 제공된 `_meta.searchEventId`, `_meta.hints`, `_meta.suggestion`에 그대로 존재. 클라이언트는 `_meta.*` 경로로 참조하도록 전환해야 한다.
- **`scripts/migration-007-flexible-embedding-dims.js` 심볼릭 링크 제거**: 2026-04-19 이후 유지되던 구 경로 하위 호환이 종료됐다. 외부 스크립트·CI에서 구 경로를 참조하는 경우 `scripts/post-migrate-flexible-embedding-dims.js`로 갱신해야 한다.

### Changed

- `lib/tools/memory.js` 3곳(`tool_recall` caseMode 분기, `tool_recall` 일반 분기, `tool_context`)의 응답 조립부에서 top-level mirror 필드 삭제. `tool_context`는 `{ _memento_hint, _searchEventId, _suggestion, ...rest }` destructure로 내부 전달용 필드를 응답 직전에 분리하고 `_meta`에만 담는다.
- `lib/openapi.js` info.version `3.0.0` → `3.1.0`

### Migration Guide (v3.0.0 → v3.1.0)

1. 클라이언트 코드에서 `response._searchEventId` → `response._meta.searchEventId`, `response._memento_hint` → `response._meta.hints[0]`, `response._suggestion` → `response._meta.suggestion`으로 교체
2. CI·스크립트에서 `scripts/migration-007-flexible-embedding-dims.js` 참조가 있다면 `scripts/post-migrate-flexible-embedding-dims.js`로 일괄 치환
3. `npm install` 후 `npm run migrate` — 신규 마이그레이션 없음. `package-lock.json`만 갱신

### 회귀 가드

기존 응답의 `_meta.*` 값은 v3.0.0 시점과 동일하게 생성되므로 `_meta` 경로만 사용하던 클라이언트는 영향이 없다.

---

## [3.0.0] - 2026-04-21

v2.8.0 태그 이후 누적된 un-tagged 빌드 11종(v2.8.1 ~ v2.16.0)을 umbrella 릴리즈로 통합한다. 개별 minor/patch 라벨은 CHANGELOG 하단 "Pre-3.0.0 incremental builds" 섹션에 상세 보존된다.

### Highlights

- **Admin Metrics Dashboard** (v2.16.0): Prometheus 8 카드(Active Sessions / Auth Denied / RBAC Denied / Tenant Blocked / RPC p50/p99 / Tool Errors / Symbolic Gate Blocked / OAuth Tokens) + 도구별 호출/에러 분포 테이블 + SVG sparkline 시계열. `/v1/internal/model/nothing/metrics-summary` 엔드포인트(master/admin 전용, TTL 10초 캐시, `?windowSec=N`)
- **CLI/API Enhancement L+M+H** (v2.11.0 ~ v2.12.0): 원격 CLI(`lib/cli/_mcpClient.js`, `--remote URL` / `--key KEY`), `_meta` 래퍼(`searchEventId` / `hints` / `suggestion`), sparse fields 17종 화이트리스트, `--help`/`--format table|json|csv`, idempotencyKey(maxLength 128, partial UNIQUE), X-RateLimit 헤더, dryRun 파라미터(remember/link/forget/amend), stdin / progress streaming / export·import, CLI session 관리 및 rotate / rate-limit / CSRF
- **MemoryManager 분해** (v2.10.0): 1252줄 → 259줄 facade. 비즈니스 로직을 `lib/memory/processors/` 4개 클래스로 분리(MemoryRememberer / MemoryRecaller / MemoryReflector / MemoryLinker). facade ↔ 프로세서 간 `_installSharedSync` setter 동기화 패턴
- **Mode preset / Affective tagging / Local Embedding** (v2.9.0): recall-only / write-only / onboarding / audit 4개 JSON preset(`X-Memento-Mode` 헤더 / `initialize.params.mode` / `api_keys.default_mode`). fragments.affect 컬럼(6 enum: neutral / frustration / confidence / surprise / doubt / satisfaction). `@huggingface/transformers` 로컬 임베딩 provider(`EMBEDDING_PROVIDER=transformers`, Xenova/multilingual-e5-small / bge-m3). Codex CLI / GitHub Copilot CLI LLM provider 추가. RecallSuggestionEngine 비침습적 힌트 필드. 토큰 기반 세션 재사용(sha256 + keyId 네임스페이스)
- **Session 안정화 + OAuth 호환성** (v2.8.1 ~ v2.8.7): claude.ai / ChatGPT / Copilot / Gemini OAuth DCR-less 커넥터 완전 호환. name-based DCR client_id(`<name>_<keyIdHex8>`) + `client_name="apikey:<keyId>"` 내부 바인딩, `client_secret` API 키 바인딩, bound_key_id 경로. 세션 ID 보존 복구 + keyId 교차 검증(403). RFC 8707 `resource` 파라미터. `token_endpoint_auth_methods_supported` 확장. MCP 2025-06-18 Protocol-Version 헤더 검증. `MCP_REJECT_NONAPIKEY_OAUTH` / `MCP_ALLOW_AUTO_DCR_REGISTER` / `MCP_STRICT_ORIGIN` 보안 기본값. FragmentReader keyId ANY() 래핑 일괄 수정(v2.8.7)
- **Symbolic Memory Layer hard gate** (v2.8.0): 이미 v2.8.0에서 도입(본 릴리즈는 hard gate 이후 후속 수정 및 문서 동기화 포함). `fragment_claims` + `api_keys.symbolic_hard_gate` BOOLEAN. 6 Phase(Foundation / Shadow / Explain / Link Integrity / Policy / CBR+Proactive) 전개. 기본값 전면 opt-out
- **Scripts rename** (un-tagged 2026-04-19): `scripts/migration-007-flexible-embedding-dims.js` → `scripts/post-migrate-flexible-embedding-dims.js`. 자동 마이그레이션 러너와 수동 dimension 재구성 스크립트 구분. 심볼릭 링크로 하위 호환
- **Test cleanup hang 근본 해결** (v2.16.1 scope): node:test runner "Promise resolution pending" 14초 잔여 제거. SSE heartbeat `.unref()`, cleanup 훅, lifecycle 회귀 가드

### Breaking Changes

코드 레벨 breaking 없음. 모든 신규 기능 opt-in. 기존 환경 변수·API 응답·DB 스키마 완전 호환.

Deprecation 예고(v3.1.0에서 제거): recall / context 응답의 top-level `_searchEventId` / `_memento_hint` / `_suggestion` 필드. v3.0.0은 `_meta.searchEventId` / `_meta.hints` / `_meta.suggestion`과 top-level mirror를 동시 제공. 호출부는 `_meta.*`로 전환 권고.

### Migration Guide (v2.8.0 → v3.0.0)

1. `npm install` — `@huggingface/transformers` 신규 의존성(로컬 임베딩 사용 시에만 실제 로드). 기존 lock 갱신
2. `npm run migrate` — migration-034(api_keys.default_mode ADD COLUMN) + migration-034-v2.16.0-bundle(fragments.affect / idempotency_key ADD COLUMN + partial unique 인덱스) 자동 적용. 모두 ADD COLUMN이므로 기존 행 변경 없음
3. 환경 변수 확인 — 기본값 유지 시 추가 작업 없음. 선택적 기능 활성화:
   - `EMBEDDING_PROVIDER=transformers` (로컬 임베딩)
   - `LLM_PRIMARY` / `LLM_FALLBACKS` (LLM 폴백 체인)
   - `MEMENTO_SYMBOLIC_*` (Symbolic 계층 단계적 활성화 — v2.8.0 Migration Guide 참조)
   - `MCP_REJECT_NONAPIKEY_OAUTH=false` (claude.ai 외 DCR-less 클라이언트에 대한 하위 호환 복원이 필요한 경우만)
4. EMBEDDING_PROVIDER 변경 시에만 `npm run backfill:embeddings` 수동 실행. 차원 불일치 시 서버 기동 단계에서 `scripts/check-embedding-consistency.js`가 즉시 중단
5. 기존 스크립트 경로 `scripts/migration-007-flexible-embedding-dims.js` 참조 시 `scripts/post-migrate-flexible-embedding-dims.js`로 전환 권고(심볼릭 링크는 v2.13.0 네임스페이스 하위 호환 유지)

### Known Limitations

- v2.8.0 이후 v2.9.0 ~ v2.16.0의 중간 빌드는 git tag가 존재하지 않는다. v3.0.0이 유일한 공식 릴리즈 태그이며, 하위 빌드 히스토리는 본 CHANGELOG로만 추적된다
- `MEMENTO_ACCESS_KEY` 미설정 상태에서 `MEMENTO_AUTH_DISABLED=true` 없이 서버를 기동하면 fail-closed로 거부된다(v2.7.0 정책 유지)

---

## Pre-3.0.0 incremental builds (un-tagged)

아래는 v2.8.0 태그 이후 누적된 11개 빌드의 원본 상세 이력이다. 모두 v3.0.0 릴리즈에 포함되며, 개별 git tag는 존재하지 않는다.

### v2.16.0 draft — Admin Metrics Dashboard (2026-04-20)

#### Added

- Admin Console: 메트릭 메뉴 추가 — Prometheus 8 카드(Active Sessions / Auth Denied / RBAC Denied / Tenant Blocked / RPC p50/p99 / Tool Errors / Symbolic Gate Blocked / OAuth Tokens) + 도구별 호출 통계 테이블 + 에러 타입별 분포 테이블. Admin UI 좌측 사이드바 메뉴 7개 → 8개.
- `/v1/internal/model/nothing/metrics-summary` 엔드포인트 (master/admin 전용): prom-client Registry에서 직접 산출, 응답 캐시 TTL 10초, `?windowSec=N` 파라미터 지원.

---

### v2.12.0 — CLI/API Enhancement Phase 2 (2026-04-20)

### Added

- M1 원격 CLI: `lib/cli/_mcpClient.js` 신설. `--remote URL` / `--key KEY` 전역 플래그 및 `MEMENTO_CLI_REMOTE` / `MEMENTO_CLI_KEY` 환경변수 fallback. initialize → tools/call 2단계 세션을 생성하고 재사용한다. local-only 명령(migrate, admin 등)을 원격 모드에서 호출하면 에러를 반환한다.
- M3 X-RateLimit HTTP 헤더: 모든 API 응답에 `X-RateLimit-Limit` / `X-RateLimit-Remaining` / `X-RateLimit-Resource` 헤더 포함. `QuotaChecker.getUsage` + 모듈 레벨 Map 캐시(TTL 10초, 상한 1000 엔트리). master key 또는 limit=null이면 헤더 생략.
- M5 dryRun 파라미터: remember / link / forget / amend 4개 MCP 도구에 `dryRun: boolean` 파라미터 추가. 기본값 false. true 시 `simulated: true` 응답 반환 + 모든 side-effect 스킵.

### v2.11.0 — CLI/API Enhancement Phase 1 (2026-04-20)

### Added

- H1 _meta 래퍼: recall / context 응답에 `_meta: { searchEventId, hints, suggestion }` 필드 추가. 기존 top-level 필드는 v2.12.x 마지막 릴리즈까지 동일 값으로 mirror 제공된다.
- H2 sparse fields: recall 파라미터에 `fields: string[]` 추가. 17개 화이트리스트(id / content / type / topic / keywords / importance / created_at / access_count / confidence / linked / explanations / workspace / context_summary / case_id / valid_to / affect / ema_activation). L1/L2/RRF 단계는 전체 필드 유지 후 응답 직전에 필터링.
- H3 CLI 서브명령별 `--help` / `-h`: 11개 모듈의 `usage` export 추가.
- H4 CLI `--format table|json|csv`: TTY 환경 자동 감지. `--json`은 `--format json` 별칭. `lib/cli/_format.js` 신설.
- H5 idempotencyKey: remember / batchRemember 스키마에 `idempotencyKey` 파라미터 추가(maxLength 128). 같은 key_id 범위 내 partial UNIQUE 보장. `FragmentReader.findByIdempotencyKey` 신설. migration-034-v2.16.0-bundle(tenant partial index + master partial index 2개).

### Deprecated

- recall / context 응답의 top-level `_searchEventId` / `_memento_hint` / `_suggestion` 필드: v2.12.x 마지막 릴리즈를 끝으로 v2.13.0에서 제거된다. `_meta.searchEventId` / `_meta.hints` / `_meta.suggestion`으로 전환할 것.

### v2.10.1 — TDZ 핫픽스 (2026-04-20)

### Fixed

- R12 TDZ 핫픽스: `remember()` 내부의 atomic 분기(`MEMENTO_REMEMBER_ATOMIC=true && keyId != null` 경로)가 `const fragment` 선언 이전에 위치하여 ReferenceError가 발생했다. atomic 분기를 fragment 생성 이후로 이동하고, `quotaChecker.check`를 `!(atomicRemember && keyId)` 가드로 조건부 호출하도록 수정했다. 원격 `memento.anchormind.net` 서버에서 동일 증상이 발생하던 문제도 함께 해소된다.

### Added

- 회귀 방지 단위 테스트 `tests/unit/memory-manager-remember-tdz.test.js`: atomic 분기의 TDZ 경로를 직접 재현하는 테스트 추가.

### v2.10.0 — MemoryManager 분해 (2026-04-20)

### Changed

- MemoryManager 1252줄 → 259줄 facade로 축소. 비즈니스 로직을 `lib/memory/processors/` 4개 클래스로 분리했다: MemoryRememberer(remember/batchRemember), MemoryRecaller(recall/context), MemoryReflector(reflect), MemoryLinker(link/graph_explore).
- facade ↔ 프로세서 간 공유 프로퍼티 setter를 `_installSharedSync` 패턴으로 동기화한다. 외부에서 `memoryManager.embedder = x`처럼 세터를 호출하면 모든 프로세서에 자동 전파된다.

### Tests

- `tests/unit/memory-manager-di.test.js`: DI 경로를 `MemoryManager.prototype.remember.toString()` → `MemoryRememberer.prototype.remember.toString()`으로 전환.
- `tests/unit/remember-processor.test.js`: MemoryRememberer 직접 DI 경로로 전환.

### Pre-2.10.0 — Scripts rename (2026-04-19)

#### Changed

- scripts/migration-007-flexible-embedding-dims.js 를 scripts/post-migrate-flexible-embedding-dims.js 로 이름 변경. 자동 마이그레이션 러너(lib/memory/migration-NNN-*.sql)와 수동 dimension 재구성 스크립트를 파일명으로 명확히 구분하기 위함.
- setup.sh, .env.example 내 구 경로 참조를 신 경로로 일괄 치환.

#### Deprecation Notice

- scripts/migration-007-flexible-embedding-dims.js 는 신 경로(post-migrate-flexible-embedding-dims.js)를 가리키는 심볼릭 링크로 v2.13.0까지 유지된다.
- 외부 스크립트나 CI에서 구 경로를 직접 참조하는 경우 scripts/post-migrate-flexible-embedding-dims.js 로 전환할 것을 권고한다.

### v2.9.0 — Mode preset / Affect / Local Embedding / LLM CLI Providers (2026-04-18)

### Added

- **Mode preset 시스템**: recall-only / write-only / onboarding / audit 4개 JSON preset. `X-Memento-Mode` 헤더, `initialize.params.mode`, `api_keys.default_mode` DB 컬럼 3경로로 활성화. tools/list 응답이 mode별로 필터링된다. (`lib/memory/ModeRegistry.js`, `lib/memory/modes/*.json`, migration-034-v2.16.0-bundle.sql)
- **RecallSuggestionEngine 비침습적 힌트 필드**: recall 응답에 `_suggestion: {code, message, recommendedTool, recommendedArgs}` 메타 필드 첨부. 4개 감지 규칙(repeat_query / empty_result_no_context / large_limit_no_budget / no_type_filter_noisy). 클라이언트가 무시해도 기존 동작 불변. (`lib/memory/RecallSuggestionEngine.js`)
- **Affective tagging**: fragments.affect 컬럼(neutral / frustration / confidence / surprise / doubt / satisfaction 6 enum). remember / recall 스키마에 affect 파라미터 노출. CHECK 제약 + partial index. (migration-034-v2.16.0-bundle.sql, FragmentWriter / Reader)
- **Tool 메타 레지스트리**: 16개 도구에 `meta: {capabilities[], riskLevel, requiresMaster, beta, idempotent}` 정적 필드 추가. 도구별 능력 디스커버리를 위한 Node.js 관용 메타데이터 레지스트리. (`lib/tool-registry.js`)
- **Codex CLI provider**: `LLM_PRIMARY` / `LLM_FALLBACKS`에 `codex-cli` 지정 시 `codex exec --skip-git-repo-check --full-auto -o FILE` 경로로 JSON 출력을 파싱한다. (`lib/codex.js`, `lib/llm/providers/CodexCliProvider.js`)
- **GitHub Copilot CLI provider**: `copilot-cli` 지정 시 `copilot -p "prompt" --allow-all-tools --output-format text` 호출 + `extractJsonBlock`으로 통계 꼬리를 제거한다. (`lib/copilot.js`, `lib/llm/providers/CopilotCliProvider.js`)
- **로컬 transformers.js 임베딩 provider**: `EMBEDDING_PROVIDER=transformers`로 `@huggingface/transformers` 파이프라인 기반 임베딩. 기본 `Xenova/multilingual-e5-small` (384d), 옵션 `Xenova/bge-m3` (1024d). OpenAI API와 상호 배타 (데이터 혼합 방지). (`lib/embeddings/LocalTransformersEmbedder.js`, docs/embedding-local.md)
- **Startup embedding consistency check**: fragments + morpheme_dict 두 테이블 차원이 config와 일치하는지 server.js 기동 시 검증, 불일치 시 기동 거부. (`scripts/check-embedding-consistency.js`)
- **토큰 기반 세션 재사용**: claude.ai 커넥터가 Mcp-Session-Id 유실 후 매 initialize마다 새 세션을 생성하던 문제 해결. sha256 해시 + keyId 네임스페이스로 Redis 역인덱스를 구성하여 동일 액세스 토큰에 기존 세션을 재사용한다. (`lib/handlers/mcp-handler.js` deriveTokenKey, `lib/redis.js` bindTokenToSession / getSessionIdByToken)
- **E2E 통합 테스트 4종**: llm-cli-smoke (CLI 바이너리 스모크), llm-chain-real (체인 실측 subprocess 기반), llm-timeout (latency / timeout 강제), morpheme-llm-real (MorphemeIndex end-to-end), local-embedding (transformers 모델 로드). 환경변수 가드(`E2E_LLM_CLI` 등)로 기본 SKIP. `npm run test:integration:llm` 스크립트 + `tests/integration/README.md` 실행 가이드. (tests/integration/)
- **`tests/integration/_cleanup.js` 공통 cleanup 모듈**: Redis / DB pool 핸들 명시 해제로 Node 이벤트 루프 자연 종료 보장.

### Changed

- **MorphemeIndex LLM timeout 상향**: 15_000ms → 60_000ms. Gemini CLI / Ollama Cloud 실제 응답(20-40s)에 맞게 조정하여 반복적인 "all LLM providers failed" 패턴을 해소한다. (`config/memory.js`)
- **migration-007 확장**: fragments + morpheme_dict 두 테이블을 루프로 처리하도록 flexible-embedding-dims 마이그레이션을 확장.
- **`.env` 샘플 갱신**: `LLM_FALLBACKS`에 `codex-cli` / `copilot-cli` 예시 포함.

### Fixed

- **FragmentReader / LinkStore 다중 경로의 keyId ANY() 래핑 누락**: scalar keyId를 `ANY($N)`에 그대로 push하여 "비정상적인 배열 문자" PG 오류를 발생시키던 버그. v2.8.7에서 `getByIds`만 수정한 패턴을 `searchByKeywords`, `searchByTopic`, `searchBySemantic`, `searchByTimeRange`, `searchAsOf`, `getLinkedFragments`(2곳), `getRCAChain`에 일괄 적용. `Array.isArray` 래핑. (`lib/memory/FragmentReader.js`, `lib/memory/LinkStore.js`)
- **TemporalLinker `::integer[]` 오캐스팅**: `fragments.key_id`가 TEXT 컬럼인데 `::integer[]` 캐스팅을 사용하여 "연산자 없음: text = integer" 에러가 발생하던 문제. `::text[]`로 교체. (`lib/memory/TemporalLinker.js`)
- **빈 POST body null crash**: `readJsonBody`가 빈 body를 받아 `JSON.parse(null)`을 반환할 때 발생하던 unhandledRejection. `handleMcpPost` 진입부에서 null을 400 Invalid Request로 거부. `injectSessionContext`에도 null 가드를 이중 방어로 추가.
- **`npm run test:integration:llm` 서브프로세스 경합**: `--test-concurrency=1` 플래그로 순차 실행을 강제하여 병렬 CLI 서브프로세스 간 경합을 제거.

### Upgrade from v2.8.x

1. `npm install` — package.json 의존성 갱신. `@huggingface/transformers` 패키지가 신규 추가된다.
2. `npm run migrate` — migration-034(api_keys.default_mode ADD COLUMN), migration-034-v2.16.0-bundle(fragments.affect ADD COLUMN) 실행. 두 마이그레이션 모두 ADD COLUMN이므로 기존 데이터를 변경하지 않는다.
3. `EMBEDDING_PROVIDER` 검토 — 기본값(`openai` 계열)을 유지하면 추가 작업 없음. 로컬 임베딩으로 전환할 경우 `EMBEDDING_PROVIDER=transformers`를 설정하고 기존 OpenAI 임베딩과 혼합하지 않도록 `scripts/backfill-embeddings.js`로 전체 재생성 후 서버를 기동한다.
4. backfill-embeddings (조건부) — `EMBEDDING_PROVIDER` 를 변경한 경우만 해당. `npm run backfill:embeddings`로 embedding IS NULL 파편을 일괄 처리한다.
5. 서버 재시작 — 기동 시 `scripts/check-embedding-consistency.js`가 DB 차원과 설정 차원의 일치를 자동 검증하며, 불일치 시 즉시 기동을 중단하고 오류를 출력한다.

### Breaking Changes

없음. 모든 신규 기능은 opt-in이다. Mode preset / affect / 로컬 임베딩은 기본값을 유지하면 기존 동작이 완전히 보존된다. migration-034(api_keys.default_mode), migration-034-v2.16.0-bundle(fragments.affect)는 ADD COLUMN이므로 기존 데이터에 영향 없다.

### v2.8.7 — FragmentReader keyId ANY() 일괄 fix (2026-04-17)

### Fixed

- **`FragmentReader.getByIds` PostgreSQL "malformed array literal" 에러**: `key_id = ANY($3)` SQL에 단일 UUID 문자열을 그대로 바인딩하여 PG가 배열 파싱 시 실패했다. 호출 측이 `keyId`를 문자열로 전달하는 경우 배열로 래핑(`[keyId]`)하도록 수정. 영향 경로: `FragmentSearch.fetch`(missing IDs 조회), `RememberPostProcessor.linkedTo 소유권 확인`, `SessionLinker.autoLinkSessionFragments` — 간헐적 recall/remember/link 실패 원인이었다. (`lib/memory/FragmentReader.js`)

### v2.8.6 — OAuth auto-register on trusted redirect_uri (2026-04-17)

### Changed

- **신뢰 redirect_uri에 한해 `/authorize` 자동 등록 허용**: `OAUTH_TRUSTED_ORIGINS` 기반 `isAllowedRedirectUri`가 true인 경우, `ALLOW_AUTO_DCR_REGISTER`와 무관하게 미등록 client_id도 `/authorize` 진입 시 자동 등록된다. 실질적 보안 경계는 v2.8.5의 `/token` `client_secret` 검증이므로 auto-register 자체는 안전하다. 바인딩되지 않은 토큰(API 키 미포함 시)은 `REJECT_NONAPIKEY_OAUTH=true` 정책에 의해 auth.js에서 거부된다. (`lib/handlers/oauth-handler.js`)
- **기본 신뢰 도메인 확인**: `claude.ai`, `chatgpt.com`, `platform.openai.com`, `copilot.microsoft.com`, `gemini.google.com` 5개 사전 내장. `OAUTH_TRUSTED_ORIGINS` env로 추가 가능. (`lib/config.js`)

### Impact

- claude.ai 외 ChatGPT/Copilot/Gemini 등 OAuth DCR-less 클라이언트도 사전 수동 등록 없이 즉시 연결 가능. 사용자가 client_id에 임의 문자열 + client_secret에 API 키를 입력하기만 하면 됨.
- 비신뢰 redirect_uri는 기존과 동일하게 `ALLOW_AUTO_DCR_REGISTER=false` 기본값에서 차단 (보안 유지).

### v2.8.5 — claude.ai OAuth MCP 2025-06-18 compliance (2026-04-17)

### Fixed

- **claude.ai OAuth 연결 실패 해결 (MCP 2025-06-18 spec 준수)**: claude.ai는 사용자가 connector UI에 입력한 `client_id`로 `/authorize`를 호출하고 `POST /token` body의 `client_secret`에 API 키를 전송한다. 다음 3개 수정으로 정상 tenant-격리된 OAuth 세션이 발급된다.

### Added

- **`/token#handleToken`의 `client_secret` → API 키 바인딩**: body의 `client_secret`을 `validateApiKeyFromDB`로 검증해 `tokenData.is_api_key=true` + `bound_key_id=keyId`를 주입. authorization_code와 refresh_token grant 모두 지원. 기존 auth.js의 bound_key_id 경로(v2.8.4)와 맞물려 keyId 격리 세션을 발급. (`lib/oauth.js`)
- **RFC 8707 `resource` 파라미터 저장**: `/authorize`와 `/token`에서 받은 `resource`를 codeData/tokenData에 보존하여 토큰 audience 추적. (`lib/oauth.js`, `lib/handlers/oauth-handler.js`)

### Changed

- **`token_endpoint_auth_methods_supported` 확장**: `["none"]` → `["none", "client_secret_post", "client_secret_basic"]`. claude.ai의 `client_secret_post` 호출과 AS metadata 일치. (`lib/oauth.js#getAuthServerMetadata`)
- **`bearer_methods_supported`에서 `query` 제거**: `["header", "query"]` → `["header"]`. MCP 스펙(2025-06-18 §249) "MUST NOT in URI query string" 준수. (`lib/oauth.js#getResourceMetadata`)
- **Protected Resource Metadata의 `resource` URI에 `/mcp` 경로 포함**: `${baseUrl}` → `${baseUrl}/mcp`. claude.ai가 `resource` 필드를 MCP 엔드포인트로 사용하여 이전에는 `/`(root)로 POST하다 404를 받던 문제 해결. (`lib/oauth.js#getResourceMetadata`)

### v2.8.4 — name-based DCR client_id + internal keyId binding (2026-04-17)

### Changed

- **`/register` Authorization Bearer 바인딩 전략 변경**: v2.8.3의 API 키 원문을 `client_id`로 사용하는 방식을 폐기. 원문 키가 URL·브라우저 히스토리·프록시 로그에 그대로 노출되는 문제를 해결. 이제 `client_id = "<name>_<keyIdHex8>"` (URL-safe 이름 + UUID 앞 8자 hex suffix)으로 등록한다. `validateRedirectUri` 엄격 검증이 기본 방어선이므로 보안 강도는 동일하게 유지된다. (`lib/handlers/oauth-handler.js`)

### Added

- **`client_name = "apikey:<keyId>"` 내부 바인딩 마커**: 스키마 변경 없이 `oauth_clients.client_name` 필드에 keyId UUID를 인코딩. `/authorize` 경로에서 이 마커를 파싱하여 `validateApiKeyById`로 tenant 격리 컨텍스트를 복원한다.
- **`validateApiKeyById(id)` 신규 함수** (`lib/admin/ApiKeyStore.js`): UUID 기반 API 키 조회. 원시 키 없이 keyId만으로 권한 정보(`keyId`, `name`, `groupKeyIds`, `permissions`, `defaultWorkspace`)를 반환.
- **`validateApiKeyFromDB` 반환 객체에 `name` 필드 추가**: 기존 반환 구조를 확장하여 `name` 필드를 포함. 하위 호환 유지.
- **`bound_key_id` 필드 전파**: `codeData` → `accessData`/`refreshData` → `validateAccessToken` 반환 객체까지 `bound_key_id`가 완전 전파. refresh_token 갱신 시에도 승계됨.
- **`validateAuthentication` bound_key_id 우선 경로** (`lib/auth.js`): OAuth 토큰의 `bound_key_id`가 있으면 `validateApiKeyById`로 1순위 처리. 기존 `is_api_key` 경로는 2순위로 유지 (v2.8.3 호환). non-API-key OAuth 거부는 3순위.
- **신규 메트릭** 3종:
  - `mcp_oauth_bound_client_registered_total`: name-based binding 등록 성공 횟수
  - `mcp_oauth_bound_client_authorized_total`: bound_key_id 경로로 /authorize 진입 횟수
  - `mcp_oauth_bound_client_authenticated_total`: bound_key_id 경로 인증 성공 횟수
- **신규 테스트** (`tests/unit/oauth-name-based-client-id.test.js`): 29개 케이스 (client_id 생성, client_name 마커, backward compat, bound_key_id 전파, refresh_token 승계, validateAuthentication 우선순위, 패턴 매칭 경계 케이스).

### Notes

- v2.8.3에서 전체 API 키 문자열을 `client_id`로 등록한 기존 Redis 토큰은 `bound_key_id=null`로 2순위 `is_api_key` 경로를 통해 정상 동작. backward compat 완전 보장.
- DB 스키마 변경 없음. migration 추가 불필요.

### v2.8.3 — DCR /register API key binding (2026-04-17)

### Fixed

- **DCR /register Authorization 헤더 기반 client_id 바인딩**: claude.ai 등 OAuth DCR 클라이언트가 `POST /register` 요청 시 `Authorization: Bearer <API 키>` 헤더로 보낸 API 키가 유효하면, 해당 API 키 문자열을 `client_id`로 사용하여 등록한다. 이후 `/authorize` 경로에서 `validateApiKeyFromDB`로 자연스럽게 `is_api_key=true` 경로를 타게 되어, Phase 2b의 non-API-key OAuth 거부 정책과 충돌 없이 정상 tenant 격리된 세션을 발급받는다. (`lib/handlers/oauth-handler.js`)

### Notes

- 별도 DB 스키마 변경 없음. 기존 `mmcp_*` 접두 client_id 플로우를 재활용한다.
- Authorization 헤더 없거나 유효하지 않은 토큰이면 기존 랜덤 client_id로 등록하되, 그 클라이언트가 발급받은 토큰은 auth.js의 `REJECT_NONAPIKEY_OAUTH=true` 정책에 의해 여전히 거부된다.

### v2.8.2 — MCP spec compliance + OAuth hardening (2026-04-17)

### Security

- **non-API-key OAuth 클라이언트의 master 권한 취약점 차단**: `is_api_key=false` OAuth 토큰으로 인증 시도 시 `keyId=null` 세션이 생성되어 모든 파편에 master 권한으로 접근할 수 있었던 취약점 차단. `MCP_REJECT_NONAPIKEY_OAUTH=false`로만 기존 동작 복원 가능. (`lib/auth.js`)
- **OAuth auto-registration 기본 비활성화**: `/authorize`에서 미등록 `client_id`가 유효한 `redirect_uri`만 있으면 자동 등록되던 경로 차단. RFC 7591 `POST /register` 엔드포인트 경유 강제. `MCP_ALLOW_AUTO_DCR_REGISTER=true`로만 기존 동작 복원 가능. (`lib/handlers/oauth-handler.js`)

### Added

- **Spec compliance (세션 404)**: `sessionId` 있으나 Redis에 없고 인증도 실패한 경우, 또는 세션 expired 상태인 경우 HTTP 404 Not Found + JSON-RPC `-32000 "Session not found"` 반환. MCP 2025-06-18 스펙 요구사항 준수.
- **Security (Origin 검증)**: `MCP_STRICT_ORIGIN=true` 설정 시 허용 목록(`OAUTH_TRUSTED_ORIGINS` + `ALLOWED_ORIGINS` + 기본 신뢰 도메인) 외 Origin에서 온 요청을 403으로 거부. DNS rebinding 공격 방어. 기본값 `false` (opt-in, 기존 동작 유지).
- **Spec compliance (Protocol-Version)**: initialize 이후 모든 요청에서 `MCP-Protocol-Version` 헤더 검증. 헤더 없으면 2025-03-26 fallback, 미지원 버전이면 400, 세션 negotiatedVersion과 불일치하면 400. initialize 요청은 검증 생략.
- **세션 `negotiatedVersion` 필드**: initialize 응답 완료 시 협상된 프로토콜 버전을 세션 데이터에 저장. 이후 요청의 MCP-Protocol-Version 대조에 활용.
- **`MCP_REJECT_NONAPIKEY_OAUTH` 환경변수** (기본 `true`): non-API-key OAuth 토큰 거부 제어. `false` 설정 시 하위 호환 모드.
- **`MCP_ALLOW_AUTO_DCR_REGISTER` 환경변수** (기본 `false`): OAuth 자동 클라이언트 등록 허용 제어. `true` 설정 시 기존 자동 등록 동작.
- **New env**: `MCP_STRICT_ORIGIN` (기본 `false`).
- **New metrics**: `mcp_session_404_total`, `mcp_origin_rejected_total` (label: `origin`), `mcp_protocol_version_rejected_total` (label: `version`), `mcp_oauth_nonapikey_rejected_total`, `mcp_oauth_auto_register_blocked_total`.

### v2.8.1 — Session integrity + recovery (2026-04-17)

### Added

- **세션 ID 보존 복구**: `lib/sessions.js`에 `createStreamableSessionWithId(sessionId, ...)` 추가. auto-recovery 경로에서 `crypto.randomUUID()` 대신 클라이언트가 보낸 원본 `sessionId`로 세션을 재생성하여 데이터 연속성 보장.
- **keyId 교차 검증 (403)**: 세션 복구 시 Redis의 기존 `keyId`와 재인증된 `keyId`가 불일치하면 403 Forbidden + JSON-RPC `-32000 "Forbidden"` 반환. `recordTenantIsolationBlocked("session_recover_keyid_mismatch")` 호출.
- **Redis 세션 저장 실패 메트릭** (`mcp_redis_session_save_failure_total`, label: `operation`): Redis saveSession catch 경로에서 자동 집계.
- **세션 복구 결과 메트릭** (`mcp_session_recovery_total`, label: `result` = `same_id_success` | `keyid_mismatch` | `not_found` | `new_session`): auto-recovery 분기 전체 관측.
- **세션 idle reflect 메트릭** (`mcp_session_idle_reflect_total`): 24h idle autoReflect 실행 시 카운트.
- **MCP_IDLE_REFLECT_HOURS 환경변수** (기본 24): `cleanupExpiredSessions`에서 이 시간 이상 비활성 세션에 중간 autoReflect 실행.
- **세션 객체 `lastReflectedAt` 필드**: 마지막 reflect 시각 추적. idle reflect 중복 실행 방지.

### Fixed

- **Heartbeat 연속 실패 경로 autoReflect 누락**: `lib/sessions.js`의 heartbeat interval에서 `hbFailures >= SSE_MAX_HEARTBEAT_FAILURES` 시 `session.close()` 직접 호출 대신 `closeStreamableSession(sessionId)`를 경유하도록 수정. 세션 종료 시 autoReflect가 반드시 실행됨.

---

## [2.8.0] - 2026-04-16

### Added — Symbolic Memory Layer (opt-in, 기본 전면 비활성)

v2.7.0 확률론적 검색(FragmentSearch/RRF/Reranker/SpreadingActivation) 위에 feature-flag 기반 심볼릭 검증 계층을 추가. 기존 경로 대체 없음. 검증/해설/advisory warning만 담당. 모든 `MEMENTO_SYMBOLIC_*` 플래그 기본 false → 프로덕션 경로 영향 0건.

**Phase 0: Foundation**
- `lib/symbolic/` 9개 core 모듈 + `lib/symbolic/rules/v1/` 5개 규칙 파일 (SymbolicOrchestrator, ClaimStore, ClaimExtractor, ClaimConflictDetector, LinkIntegrityChecker, ExplanationBuilder, CbrEligibility, PolicyRules, SymbolicMetrics)
- `config/symbolic.js`: Object.freeze 12개 환경변수 (9 boolean 플래그 + `MEMENTO_SYMBOLIC_RULE_VERSION` + `MEMENTO_SYMBOLIC_TIMEOUT_MS` + `MEMENTO_SYMBOLIC_MAX_CANDIDATES`)
- `migration-032-fragment-claims.sql`: `fragment_claims` 테이블 + v2.7.0 migration-031 content-hash 테넌트 격리 패턴 복제 (master NULL / tenant 분리 partial unique 2개) + `validation_warnings` JSONB
- `migration-033-symbolic-hard-gate.sql`: `api_keys.symbolic_hard_gate BOOLEAN DEFAULT false` — 키 단위 opt-in
- `scripts/benchmark-hot-path.js` + `scripts/baseline-v27.json` — 회귀 감시 baseline
- Rollback 파일은 `rollback-migration-NNN-*.sql` 네이밍 (migrate.js auto-pickup glob 회피)

**Phase 1: Shadow Mode + Claim Backfill**
- `RememberPostProcessor.run()` 8단계 `_extractSymbolicClaims`: fire-and-forget. TENANT_ISOLATION_VIOLATION catch 후 `recordGateBlock` + swallow
- `FragmentSearch.search` 라인 88 shadow hook (`observeLatency`)
- `scripts/backfill-claims.js`: 키셋 페이지네이션 + 8 CLI 옵션 (`--batch-size`, `--rate-limit-ms`, `--tenant-key`, `--limit`, `--min-confidence`, `--dry-run`, `--verbose` 등)

**Phase 2: Explainability (첫 사용자 가치)**
- `ExplanationBuilder.annotate(fragments, searchContext)` — 불변 복사 + 싱글톤/DI 양립
- `rules/v1/explain.js`: 6 reason codes (`direct_keyword_match`, `semantic_similarity`, `graph_neighbor_1hop`, `temporal_proximity`, `case_cohort_member`, `recent_activity_ema`), 각 fragment 최대 3개
- `FragmentSearch.search` hook chain: shadow → explain → CBR 순서

**Phase 3: Advisory Link Integrity + Polarity Conflict**
- `LinkIntegrityChecker.checkCycle`: `sessionLinker.wouldCreateCycle` 재사용 (Phase 0.5에서 4-arg 전파 완료). DIRECTIONAL_RELATIONS {caused_by, resolved_by, superseded_by, preceded_by} 외엔 early return
- Caller-side advisory guards 4곳: ConflictResolver.autoLinkOnRemember / .supersede, RememberPostProcessor linked_to Promise.all / _proactiveRecall
- `ClaimConflictDetector`: `ClaimStore.findPolarityConflicts` + severity heuristic (1→low, 2-3→medium, 4+→high) + `memento_symbolic_warning_total` 기록
- `ConflictResolver.checkAssertionConsistency`: 기존 Jaccard 파이프라인 보존 + symbolic polarity 병기. supersedeCandidates 병합 + `validationWarnings` 반환 필드 신설

**Phase 4: Policy Rules + Soft Gating**
- `PolicyRules` 5 predicate (순수 동기, AutoReflect 5원칙과 영역 분리):
  - `decisionHasRationale` (linked_to ≥ 2 OR 근거 키워드)
  - `errorHasResolutionPath` (cause/fix 키워드 OR resolution_status)
  - `procedureHasStepMarkers` (번호/단계 마커)
  - `caseIdHasResolutionStatus` (case_id 있으면 resolution_status 필수)
  - `assertionNotContradictory`
- `MemoryManager.remember` store.insert 직전 훅: violations → `fragment.validation_warnings` 누적, block 금지 (soft gate)
- `migration-033`: `api_keys.symbolic_hard_gate BOOLEAN DEFAULT false` — 키 단위 opt-in hard gate. true인 키에서 PolicyRules violations 발생 시 `SymbolicPolicyViolationError` throw, JSON-RPC 에러 코드 `-32003`, `data.violations` 배열로 위반 rule 이름 전달. 마스터 키(keyId=NULL)는 대상 제외. ApiKeyStore 30초 TTL 캐시 경유로 매 요청 SELECT 회피. DB 조회 실패 시 fail-open(false)으로 폴백

**Phase 5: CBR Constraint Filtering**
- `CbrEligibility` 4 제약 (`tenant_match`, `has_case_id`, `not_quarantine`, `resolved_state`). Prolog 미도입(옵션 A JS-only)
- FragmentSearch `case_mode` 경로 (`sq.caseId` 주입 시) 필터 적용
- SearchParamAdaptor 학습 신호 보호: `rawResultCount`는 pre-filter로 `recordOutcome`, post-filter 차단은 `memento_symbolic_gate_blocked_total{phase=cbr}`로 별도 기록

**Phase 6: ProactiveRecall Gating**
- `RememberPostProcessor._proactiveRecall` overlap ≥ 0.5 분기 내 `_proactiveGateCheck` 삽입
- `rules/v1/proactive-gate.js`: 비용 순 검사 (invalid_target → quarantine → cohort_mismatch → polarity_conflict). detector throw는 fail-open

**Observability**
- Prometheus 메트릭 4종: `memento_symbolic_claim_total`, `memento_symbolic_warning_total`, `memento_symbolic_gate_blocked_total`, `memento_symbolic_latency_seconds`

### Added — LLM Provider Abstraction + Fallback Chain

기존 Gemini CLI 단일 경로였던 5개 caller(AutoReflect, MorphemeIndex, ConsolidatorGC, ContradictionDetector, MemoryEvaluator)를 13 provider fallback chain으로 확장. Gemini CLI 실패/미설치 환경에서도 자동 fallback으로 기능 유지.

**지원 Provider 13종**
- Gemini CLI (기본, 로컬)
- Anthropic, OpenAI, Google Gemini API, Groq, OpenRouter, xAI, Ollama, vLLM, DeepSeek, Mistral, Cohere, ZAI (GLM)

**환경변수**
- `LLM_PRIMARY` — 주 provider 이름 (기본 `gemini-cli`)
- `LLM_FALLBACKS` — JSON 배열. 각 원소 `{provider, apiKey, model, baseUrl?, timeoutMs?, extraHeaders?}`
- `LLM_CB_FAILURE_THRESHOLD` / `LLM_CB_OPEN_DURATION_MS` / `LLM_CB_FAILURE_WINDOW_MS` — Circuit breaker 튜닝
- `LLM_TOKEN_BUDGET_INPUT` / `LLM_TOKEN_BUDGET_OUTPUT` — 선택적 token cap

**설정 예시**
```bash
LLM_PRIMARY=gemini-cli
LLM_FALLBACKS='[
  {"provider":"anthropic","apiKey":"sk-ant-...","model":"claude-opus-4-6"},
  {"provider":"openai","apiKey":"sk-...","model":"gpt-4o-mini"},
  {"provider":"groq","apiKey":"gsk_...","model":"llama-3.3-70b-versatile"}
]'
```

**핵심 동작**
- Fallback chain: primary → JSON 순서대로 순차 시도. 성공 시 즉시 반환
- Circuit breaker: 5회 연속 실패 시 해당 provider 60초 skip (Redis 또는 in-memory, REDIS_ENABLED 자동 분기)
- Prompt redaction: 모든 provider 호출 전 Winston REDACT_PATTERNS 재사용하여 API 키/토큰/세션 쿠키 자동 마스킹
- Token usage: Prometheus `memento_llm_token_usage_total{provider, direction}` 카운터로 집계
- Fatal error (사용자 취소, 명백한 설정 오류)는 즉시 throw. Timeout/429/5xx/parse error는 다음 provider 폴백

**Observability (Prometheus)**
- `memento_llm_provider_calls_total{provider, outcome}`
- `memento_llm_provider_latency_ms{provider}` histogram
- `memento_llm_fallback_triggered_total{primary, fallback}`
- `memento_llm_token_usage_total{provider, direction}`

**Backward compatibility**
- 기존 `geminiCLIJson`/`isGeminiCLIAvailable` API는 thin shim으로 유지 (5 caller 수정 0건)
- LLM env var 미설정 시 Gemini CLI legacy 경로 그대로 사용 (회귀 0건)
- 임베딩 provider(`EMBEDDING_PROVIDER`) 경로는 완전 별개로 유지
- `runGeminiCLI` 시그니처 불변 (GeminiCliProvider 내부에서 사용)

**보안 주의**
- 외부 LLM 사용 시 사용자 파편 content가 해당 업체 서버로 전송됨
- 패턴 기반 redaction 적용: `sk-...`, `sk-ant-...`, `gsk_...`, `Bearer ...`, `mmcp_...`, `mmcp_session=...` 등 자동 마스킹
- 도메인 특화 PII(이름, 주소 등)는 마스킹 대상 아님 — 운영자가 프롬프트 민감도 판단 필요
- 외부 provider 차단: `LLM_FALLBACKS`에 해당 provider를 포함하지 않으면 됨

### Security — Tenant Isolation Hardening

- **Phase 0.5: SessionLinker.wouldCreateCycle keyId 4-arg 전파**: v2.7.0 9260ff2 tenant isolation 14건 수정이 놓친 사각지대 봉인 — API 키 사용자 컨텍스트의 cycle 탐색이 cross-tenant fragment를 경유하던 결함 제거. `store.isReachable` 4-arg 시그니처 확장. `SessionLinker.autoLinkSessionFragments`, `ReflectProcessor:222`, `MemoryManager._autoLinkSessionFragments/_wouldCreateCycle` wrapper 전수 수정
- **회귀 가드**: `tests/unit/tenant-isolation.test.js` 신규 6건 (cross-tenant cycle 차단 grep 기반)

### Fixed

- `migration-032` `fragment_id` 타입 정정: UUID → TEXT (fragments.id 타입 일치, 4e1d003)
- dead indirection 정리: migration-033 rollback 파일 네이밍 회피 (9678392)
- **Phase 4 validation_warnings 응답 누락 수정**: `MemoryManager.remember()` return shape에 `validation_warnings: string[]` (rule 이름 배열) 추가. violations 없을 경우 필드 자체 생략 (e960baa)
- **fragments.validation_warnings DB 영속화 수정**: `FragmentWriter.insert` INSERT 컬럼 목록에 `validation_warnings` 추가, `$25::jsonb` 파라미터로 rule 이름 string[] JSON 저장. embedding placeholder $25 → $26 이동 (8a7efe9)
- **tool_recall explanations passthrough 수정**: `tool_recall` 응답 fragment shape에 `explanations` 필드 추가 (`Array.isArray && length > 0` 조건 선택적 포함). `FragmentSearch.search`가 `ExplanationBuilder.annotate`로 주입한 값 passthrough 완성 (aebd16e)
- **Hard gate 에러 경로 수정**: `tool_remember` catch 블록에 `SymbolicPolicyViolationError` 전파 분기 추가. JSON-RPC 최상위 catch가 `-32003` 프로토콜 에러로 매핑 (`data.violations: string[]` 포함). 기존 응답 `{success: false, code: SYMBOLIC_POLICY_VIOLATION}`은 도구 에러(MCP 에러)이며 프로토콜 에러 아님 — 수정으로 실측 동작이 CHANGELOG/SKILL.md 기술과 일치 (aebd16e)
- **tool_link advisory cycle check 배선**: `tool_link`에 `mgr.linkChecker.checkCycle` advisory 호출 추가. `hasCycle=true` 시 warn 로그 + `symbolicMetrics.recordWarning` 자동 발동. 링크 차단 없음 (fail-open) (aebd16e)
- **Prometheus /metrics auth 요구사항 문서화**: Bearer 헤더 없이 GET /metrics 호출 시 401 반환 — 의도된 보안 동작. 운영 문서(`docs/operations/symbolic-hard-gate.md`)에 한 줄 명시 (d6f52b0)

### Migration Guide (v2.7.0 → v2.8.0)

**기본 시나리오 (회귀 0건 보장)**
- `npm run migrate` 실행: migration-032, migration-033 적용 — 스키마 확장만 수행, 기본 플래그 false 상태 유지 → 기존 동작과 완전 동일

**Symbolic 계층 단계적 활성화 순서 (권장)**
1. `MEMENTO_SYMBOLIC_ENABLED=true` — 마스터 킬 스위치 해제
2. `MEMENTO_SYMBOLIC_SHADOW=true` + `MEMENTO_SYMBOLIC_CLAIM_EXTRACTION=true` — Phase 1 shadow mode로 claim 축적 확인
3. `scripts/backfill-claims.js` 실행으로 기존 파편 claim 백필 (옵션: `--dry-run` 선행)
4. `MEMENTO_SYMBOLIC_EXPLAIN=true` — Phase 2 recall 응답 explanation 필드 공개
5. `MEMENTO_SYMBOLIC_LINK_CHECK=true` + `MEMENTO_SYMBOLIC_POLARITY_CONFLICT=true` — Phase 3 advisory warning
6. `MEMENTO_SYMBOLIC_POLICY_RULES=true` — Phase 4 soft gating (validation_warnings 누적만, block 없음)
7. `MEMENTO_SYMBOLIC_CBR_FILTER=true` + `MEMENTO_SYMBOLIC_PROACTIVE_GATE=true` — Phase 5/6 제약 필터
8. 필요 시 개별 API 키에 `api_keys.symbolic_hard_gate=true` 설정으로 hard gate 전환
9. 필요 시 `UPDATE agent_memory.api_keys SET symbolic_hard_gate=true WHERE id=<uuid>`로 특정 키를 hard gate로 전환. 캐시 무효화는 최대 30초 후 자동 반영

**신규 응답 필드**
- `remember` 응답: `validation_warnings: string[]` — rule 이름 배열 (e.g. `["decisionHasRationale"]`). violations 없으면 필드 생략. hard gate 위반 시 필드 대신 JSON-RPC `-32003` 에러 반환.
- `recall` 응답 fragment: `explanations: [{code: string, detail: string, ruleVersion: string}]` — 파편이 검색된 이유 (MEMENTO_SYMBOLIC_EXPLAIN=true 시). 없으면 필드 생략.
- Hard gate 에러: `{"error": {"code": -32003, "message": "...", "data": {"violations": ["ruleName", ...], "fragmentType": "..."}}}` — MCP 도구 에러가 아닌 JSON-RPC 프로토콜 레벨 에러.

## [2.7.0] - 2026-04-10

### Security (Breaking Changes)
- **Fail-closed authentication**: `MEMENTO_ACCESS_KEY` 미설정 시 서버 기동 거부. `MEMENTO_AUTH_DISABLED=true` 명시 opt-in으로만 우회. (78e59d1)
- **OAuth silent consent 제거**: 모든 authorize 요청은 consent 화면 경유 필수. `OAUTH_TRUSTED_ORIGINS` 기본값 빈 배열. (bcef71b)
- **CORS fail-closed**: `ALLOWED_ORIGINS`/`ADMIN_ALLOWED_ORIGINS` 미설정 시 same-origin만 허용 (이전: 모든 origin 허용). (517c76a)
- **RBAC default-deny**: 알려지지 않은 도구는 `{ allowed: false }` 반환. 18개 도구 전체 맵핑 완료. (d97738a)
- **content_hash 테넌트 격리**: 전역 UNIQUE 인덱스 → `(key_id, content_hash)` partial unique 2개로 전환. cross-tenant ON CONFLICT 경로 차단. migration-031 필요. (83859fd, aed5a55)
- **_keyId 클라이언트 위조 방어**: tools/call 진입부에서 클라이언트 전송 `_keyId/_groupKeyIds` 무조건 delete 후 서버 인증값으로 재주입. (236c7d4)
- **FragmentReader.getById 시그니처 확장**: `(id, agentId)` → `(id, agentId, keyId, groupKeyIds)` SQL 레벨 key_id 필터 추가. 모든 호출부 전수 수정. (e1555ed)
- **GraphLinker/ContradictionDetector key_id 격리**: supersession/contradiction 쿼리에 cross-tenant 차단. (92589ad, aa48a24)
- **LinkStore/CaseEventStore/RememberPostProcessor key_id 필터**: traversal·소유권·증거 쿼리 격리. (9260ff2, fd8dbdc, bde6341)
- **GraphNeighborSearch**: `key_id IS NULL` master 노출 제거 + `::int[]` → `::text[]` 타입 수정. (1981331)
- **OAuth access token TTL**: `OAUTH_TOKEN_TTL_SECONDS` (기본 2592000 = SESSION_TTL_MINUTES*60, 30일) + `OAUTH_REFRESH_TTL_SECONDS` (기본 5184000, 60일). 세션 TTL과 연동. (24d38ce)
- **OAuth/Admin rate limit**: `/register`, `/token`, `/authorize`, `/admin/auth`, `/admin/keys`, `/admin/import`에 IP 기반 rate limit + body cap 적용. (fe009cd)
- **TemporalLinker groupKeyIds 수용**: cross-tenant temporal 링크 생성 차단. (2780860)

### Fixed
- **그룹 조회 실패 4건 수정**:
  - `FragmentReader.searchByKeywords/searchByTopic/searchBySemantic` SELECT 절에 `key_id` 컬럼 추가 (d65e656)
  - 세션 복원 시 `groupKeyIds` null 폴백 — `ApiKeyStore.getGroupKeyIds()` 재조회 (4117278, 5291b4f)
  - `FragmentIndex.keyNs` 배열 처리 — per-namespace SUNION으로 L1 캐시 회복 (ae3a6e6)
  - `search_param_thresholds.key_id` INTEGER → TEXT 마이그레이션 (2661394, 8f693b6)
- **admin-overview-render.test.js ESM 호환**: `AdminEsmLoadError` sentinel + `describe.skip` (0b85384)

### Added
- **OpenAPI 3.1.0**: `GET /openapi.json` — master=35 paths 전체, API key=권한 필터링. `ENABLE_OPENAPI=true`로 활성화. (dc39ca4)
- **AutoReflect 개선**: `_shouldSkipReflect` (명시적 파편 세션 skip), `_buildGeminiPrompt` (자기완결성 5원칙 주입), `_reflectMinimal` 제거. (7834f4e~d7fa815)
- **remember/reflect 스키마 강화**: 자기완결성 5대 기준(대명사 해소, 구체 엔티티/수치, 메타 금지, 원자성, 인과 결합 예외) + 6개월 판단 테스트. (eadcca1)
- **거부 경로 Prometheus 카운터 4종**: `memento_auth_denied_total`, `memento_cors_denied_total`, `memento_rbac_denied_total`, `memento_tenant_isolation_blocked_total`. (a35d185)
- **Winston 로그 redactor**: Authorization/API 키/세션 토큰/OAuth 코드/content 마스킹. (f589536)
- **SSE 연결 안정성 강화**:
  - Heartbeat failure detection: `SSE_MAX_HEARTBEAT_FAILURES`(기본 3) 연속 실패 시 세션 자동 종료. write backpressure 및 예외 감지
  - Proxy 호환성: `X-Accel-Buffering: no` 헤더로 nginx/reverse proxy SSE 버퍼링 방지
  - `sseWrite()` atomic write + boolean 반환으로 write 실패 graceful 처리
  - Server socket tuning: `keepAliveTimeout=0`, `headersTimeout=0`, TCP keep-alive 60s, `TCP_NODELAY`
  - 환경변수: `SSE_HEARTBEAT_INTERVAL_MS`(25000), `SSE_MAX_HEARTBEAT_FAILURES`(3), `SSE_RETRY_MS`(5000)

### Migration Guide (v2.6.0 → v2.7.0)
- `MEMENTO_ACCESS_KEY` 필수 — 미설정 시 서버 기동 거부. 개발용: `MEMENTO_AUTH_DISABLED=true`
- `ALLOWED_ORIGINS` 미설정 시 same-origin만 허용. 기존 cross-origin 클라이언트는 명시적 설정 필요
- OAuth 기존 토큰은 최대 30일 TTL까지 유효. 갱신 시 consent 화면 1회 경유
- `npm run migrate` 실행: migration-030 (search_param_thresholds 타입), migration-031 (content_hash 격리)
- `OAUTH_TOKEN_TTL_SECONDS` (기본 2592000, SESSION_TTL_MINUTES*60) / `OAUTH_REFRESH_TTL_SECONDS` (기본 5184000) 환경변수

## [2.6.0] - 2026-04-07

### Added
- **CBR (Case-Based Reasoning)**: `recall(caseMode=true)` — 유사 파편에서 case_id를 추출하여 (goal, events, outcome, resolution_status) 트리플로 반환. 과거 해결 사례 재활용. CaseRecall 모듈 신규 (`lib/memory/CaseRecall.js`)
  - 가드레일: HARD_MAX_CASES=10, MAX_EVENTS_PER_CASE=20, MAX_EVENT_SUMMARY_LEN=120 (~24KB 상한)
  - `maxCases` 파라미터 (기본 5, 상한 10)
- **depth 필터**: `recall(depth="high-level"|"detail"|"tool-level")` — Planner/Executor 역할별 검색 깊이 제어
  - high-level: decision/episode만 반환 (고수준 계획 참조)
  - tool-level: procedure/error/fact만 반환 (구체적 실행 절차)
- `get_skill_guide(section="cbr")`: SKILL.md CBR 섹션 매핑 추가

### Documentation
- SKILL.md: v2.5.7 현행화 — CBR 활용 가이드, depth 전략, recall 파라미터 3개, 트리거 3개 추가
- aiInstructions: caseMode/depth/maxCases 사용 예시 추가
- api-reference.md: recall 도구 섹션 + caseMode 응답 JSON 예시
- architecture.md: CBR/Reconsolidation/SpreadingActivation/Security/ESM/Graph 6개 섹션 추가
- README.md: v2.5.7 기능 목록 갱신

## [2.5.7] - 2026-04-07

### Security
- **Tenant Isolation**: `key_id IS NULL OR key_id = $N` 패턴 14건 전수 제거 — API 키 사용자가 마스터(key_id=NULL) 파편에 접근/수정/삭제 가능했던 취약점 수정
  - FragmentWriter: deleteMany, patchAssertion
  - MemoryManager: toolFeedback EMA 업데이트
  - CaseEventStore: getByCase, getBySession
  - HistoryReconstructor: _fetchTimelineParameterized
  - CaseRewardBackprop: backprop (TEXT 타입 불일치 동시 해결)
  - ConflictResolver, SpreadingActivation, reconstruct.js 추가 발견 3건
- **Cross-tenant write 차단**: findCaseIdBySessionTopic/findErrorFragmentsBySessionTopic/updateCaseId/touchLinked에 keyId 격리 필터 추가

### Added
- `tests/unit/tenant-isolation.test.js`: grep 기반 회귀 방지 가드 — `key_id IS NULL OR key_id` 패턴 자동 탐지

### Refactored
- **Admin UI ESM 모듈화**: admin.js 4,860줄 → 58줄 엔트리포인트 + 13개 도메인별 ESM 모듈 (번들러 없이 브라우저 네이티브 ESM)
  - modules/: state, api, ui, format, auth, layout, overview, keys, groups, sessions, graph, logs, memory
  - index.html: `<script type="module">` 전환

### Performance
- **Knowledge Graph 렌더링 최적화**:
  - 시뮬레이션/드래그 중 SVG blur 필터 비활성화, 안정화 후 복원 (~70% 프레임 비용 감소)
  - 인접맵(adjMap) 사전 구축: hover 시 O(L) → O(1) 링크 하이라이트
  - 위성 rAF 제어: 시뮬레이션 중 정지, document.hidden 시 중단
  - tick 핸들러 경량화: ring rotate 1회 적용, alphaDecay 0.05 수렴 가속
- **행성 크기 ±15% 결정적 난수**: fragRng 기반 nodeR jitter 적용

## [2.5.6] - 2026-04-07

### Added
- **ProactiveRecall**: remember() 호출 시 키워드 오버랩(>=50%) 기반 유사 파편 자동 `related_to` 링크 생성. RememberPostProcessor fire-and-forget 단계로 추가. (`b90cc83`)
- **CaseRewardBackprop**: `verification_passed` / `verification_failed` case 이벤트 시 증거 파편 importance를 DB 원자적 UPDATE로 역전파. +0.15(passed, quality_verified=true) / -0.10(failed). CaseEventStore.append() fire-and-forget 훅. (`c15a03c`, `75ef107`)
- **SearchParamAdaptor**: key_id x query_type x hour 조합별 minSimilarity 온라인 학습. 단일 원자적 UPSERT (TOCTOU-free). 대칭 학습률 -0.01/+0.01, 범위 [0.10, 0.60], MIN_SAMPLE=50. FragmentSearch._searchL3()에 통합. (`4271a3f`, `86bd4db`)
- **migration-029**: `agent_memory.search_param_thresholds` 테이블 (key_id NOT NULL DEFAULT -1, UNIQUE(key_id, query_type, hour_bucket))

### Fixed
- CaseRewardBackprop: fragments 테이블에 `updated_at` 컬럼 없음 -> SET 절에서 제거 (`75ef107`)

## [2.5.3] - 2026-04-06

### Fixed
- `search_events.session_id` 미기록: `MemoryManager.recall()` → `FragmentSearch.search()` 호출 시 sessionId 누락 수정
- `search_events` 빈 `search_path` 326건: non-text 검색 경로에서 L2 결과 0건일 때 searchPath 미기록 수정
- `SearchEventRecorder` INSERT에서 `used_rrf`/`rrf_used` 동일값 이중 삽입 수정

### Removed
- `search_events.rrf_used` 컬럼 제거 — `used_rrf`로 단일화 (migration-028)
- `fragments.superseded_by` dead 컬럼 제거 — `fragment_links` 기반으로 완전 대체 (migration-028)

### Changed
- migration-028+029+031 → `migration-028-v253-improvements.sql` 단일 파일로 통합

## [2.5.2] - 2026-04-05

### Refactored
- `MemoryManager.js` 1,790줄 → 904줄 (-49.5%):
  - `ContextBuilder` 추출 (context 330줄 → build() 위임)
  - `ReflectProcessor` 추출 (reflect 220줄 + _buildEpisodeContext + _saveTaskFeedback)
  - `BatchRememberProcessor` 추출 (batchRemember 247줄, Phase A/B/C 구조 유지)
  - `QuotaChecker` 추출 (API 키 파편 할당량 검사)
  - `RememberPostProcessor` 추출 (remember 후처리 파이프라인)
- `http-handlers.js` 864줄 → 21줄 re-export:
  - `lib/handlers/mcp-handler.js` (Streamable HTTP)
  - `lib/handlers/sse-handler.js` (Legacy SSE)
  - `lib/handlers/health-handler.js` (Health/Metrics)
  - `lib/handlers/oauth-handler.js` (OAuth 2.1)
  - `lib/handlers/_common.js` (공통 유틸리티)

### Added
- `EmbeddingCache`: 쿼리 임베딩 Redis 캐시 (키: `emb:q:{sha256}`, TTL 1h, Float32Array 바이너리)
- `migration-028`: 복합 인덱스 `(agent_id, topic, created_at DESC)` + `(key_id, agent_id, importance DESC) WHERE valid_to IS NULL`
- `config/validate-memory-config.js`: 메모리 설정 런타임 검증
- `tests/README.md`: 테스트 계층 규칙 문서

### Fixed
- `ReflectProcessor`: errors_resolved 파편에 `resolution_status='resolved'` 자동 세팅
- `ReflectProcessor`: open_questions 파편에 `resolution_status='open'` 자동 세팅
- `ReflectProcessor`: 모든 reflect 생성 파편에 `session_id` 전파

### Performance
- `ConsolidatorGC.compressOldFragments()`: KNN N+1 쿼리 → BATCH_SIZE=20 Promise.all 병렬
- `FragmentSearch._searchL3()`: EmbeddingCache 적용으로 반복 쿼리 임베딩 생성 제거

## [2.5.1] - 2026-04-04

### Added
- `context()`: `_memento_hint` 필드 추가 — AI 능동 행동 유도 (active_errors / empty_context signal)
- `context(structured=true)`: `rankedInjection` 필드 추가 — anchor 고정 + 복합 점수(importance×0.6 + ema_activation×0.4) 정렬 슬라이스
- `tool_recall`: `_memento_hint` 필드 추가 — no_results / stale_results / consider_context signal
- `config/memory.js`: `rankWeights` 설정 추가 (importance: 0.6, ema_activation: 0.4)
- `SKILL.md`: curl 직접 호출 섹션, 능동 활용 트리거 섹션, 안티패턴 섹션 추가
- `lib/tools/memory-schemas.js`: `get_skill_guide` section 옵션에 `triggers`, `antipatterns` 추가
- `lib/tools/memory.js`: SKILL_SECTIONS에 `triggers`, `antipatterns` regex 추가

### Fixed
- `oauth.js`: `issuer` 및 `authorization_servers` URL에서 `/oauth` 서픽스 제거 — RFC 8414 준수
- `oauth.js`: 등록되지 않은 client_id + trusted redirect_uri 조합 허용 (anonymous client) — claude.ai 등 DCR 없이 접근하는 클라이언트 지원
- `server.js`: `/.well-known/oauth-authorization-server` 경로 추가 (기존 `/oauth` 서픽스 경로 유지)
- `lib/tools/memory.js`: `experiential` SKILL_SECTIONS regex가 이후 섹션을 삼키는 버그 수정

## [2.5.0] - 2026-04-03

### Fixed (보안 / 정확성)
- `FragmentReader.getById/getByIds/searchBySource`: `valid_to IS NULL` 필터 누락 — superseded 파편이 조회에 노출되는 버그 수정
- `FragmentIndex.warmup()`: `valid_to IS NULL` 조건 추가, 만료 파편이 L1 캐시를 오염시키는 버그 수정
- `handleMcpDelete()`: session 삭제 시 소유자 검증 누락 수정 — 미인증 401, 타 키 삭제 시도 403 반환, master key bypass
- `GraphNeighborSearch`: keyId 타입 정규화 (`Array.isArray` guard), `key_id = ANY($4::int[])` 타입 안전성 수정
- `TemporalLinker`: `keyId = ANY($n)` → `keyId = $n` 단일 정수 등치로 수정
- `CaseEventStore.append()`: `sequence_no` 할당에 `FOR UPDATE` 잠금 추가, 동시 INSERT 경쟁 조건 방지
- `MemoryManager.toolFeedback()`: `keyId` 격리 추가, EMA 업데이트가 cross-key로 적용되는 버그 수정
- `MemoryManager.amend()`: `groupKeyIds` 소유권 검증 추가

### Fixed (데이터 정합성)
- `MemoryManager.batchRemember()`: INSERT SQL 8개 컬럼 누락 수정 (`context_summary`, `session_id`, `case_id`, `goal`, `outcome`, `phase`, `resolution_status`, `assertion_status`)
- `MemoryManager.batchRemember()` TOCTOU: quota 체크 트랜잭션과 INSERT 트랜잭션 분리로 인한 경쟁 조건 완화 — INSERT 트랜잭션 내 `FOR UPDATE` 재잠금 + 잔여 슬롯 재확인

### Fixed (성능 / N+1)
- `FragmentSearch._tryHotCache`: `for await` → `Promise.all`, Redis 직렬 호출 병렬화
- `FragmentSearch._cacheFragments`: `for await` → `Promise.all`
- `FragmentIndex.warmup()`: 순차 indexing → 50개 chunk `Promise.all` 병렬화
- `MemoryManager.reflect()`: `Promise.allSettled` 병렬 insert 도입
- `MemoryManager.context()`: `for await` → `Promise.all`
- `MemoryManager.forget(topic)`: Redis deindex `Promise.all` + 단일 `deleteMany()` 일괄 삭제
- `tool_recall includeContext`: O(N·K) 순차 `searchBySource` → 세션 ID dedup + `Promise.all` + Map 조회 O(K)

### Fixed (세션)
- `sessions.js validateStreamableSession()`: Redis 복원 시 TTL 갱신 및 `lastAccessedAt`/`expiresAt` 재설정 누락 수정 — 서버 재시작 후 복원된 세션이 즉시 만료되는 버그 수정

### Added
- `ReconsolidationEngine.js`: fragment_links weight/confidence 동적 갱신 엔진
  - `reconsolidate(linkId, action, opts)`: reinforce/decay/quarantine/restore/soft_delete 5종 action, 단일 트랜잭션
  - `quarantineAdjacentLinks(fromId, toId, keyId)`: contradicts 감지 시 인접 related/temporal 링크 soft quarantine
  - 동일 link 60초 내 재감쇠 방지 rate-limit (`lastDecayAt` Map)
- `EpisodeContinuityService.js`: reflect() 후 episode 파편 간 preceded_by 엣지 자동 생성
  - `linkEpisodeMilestone(episodeFragmentId, agentId, keyId, sessionId)`: idempotency_key 기반 중복 방지
  - `lastEventByAgent` in-memory 캐시로 직전 이벤트 조회 쿼리 절감
- `SpreadingActivation.js`: contextText 기반 비동기 활성화 전파 (ACT-R 모델)
  - `activateByContext(contextText, agentId, keyId, sessionId)`: 키워드 추출 → 1-hop 그래프 확장 → activation_score boost
  - `activationQueue` 비동기 큐 + `drainQueue()`: DB pool 과점유 방지
  - 10분 TTL 캐시(`ACTIVATION_CACHE`)로 세션 내 중복 활성화 방지
- migration-027-v25-reconsolidation-episode-spreading.sql (구 027~030 통합):
  - `fragment_links`: confidence NUMERIC(4,3), decay_rate NUMERIC(6,5), deleted_at, delete_reason, quarantine_state 컬럼 추가
  - `link_reconsolidations` 테이블: action별 weight/confidence 변경 이력
  - `case_events`: idempotency_key TEXT NULL 컬럼 + UNIQUE 인덱스
  - `idx_fragments_keywords_gin`: GIN 인덱스 (WHERE valid_to IS NULL), Spreading Activation 성능용
  - `idx_fragment_links_active`: (from_id, to_id, relation_type) WHERE deleted_at IS NULL
  - `idx_case_event_edges_preceded_by`: preceded_by 엣지 전용 인덱스
- `recall` 파라미터 `contextText` 추가: SpreadingActivation 사전 활성화 트리거 (ENABLE_SPREADING_ACTIVATION=true 시 동작)
- `tool_feedback` ENABLE_RECONSOLIDATION 연동: fragment_ids 지정 시 relevant=false → decay, relevant=true → reinforce action
- `ConflictResolver.checkAssertionConsistency()`: ENABLE_RECONSOLIDATION=true 시 `quarantineAdjacentLinks` 호출
- `GraphNeighborSearch`: fragment_links JOIN에 `AND fl.deleted_at IS NULL` 추가 — soft-deleted 링크 제외
- `MemoryManager.reflect()`: `EpisodeContinuityService.linkEpisodeMilestone()` fire-and-forget 호출
- `MemoryManager.recall()`: `SpreadingActivation.activateByContext()` fire-and-forget 사전 활성화
- feature flags: `ENABLE_RECONSOLIDATION` (기본 false), `ENABLE_SPREADING_ACTIVATION` (기본 false), `ENABLE_PATTERN_ABSTRACTION` (기본 false)
- `FragmentWriter.deleteMany(ids, agentId, keyId)`: fragment_links, linked_to 정리 후 일괄 삭제
- `FragmentStore.deleteMany()`: FragmentWriter.deleteMany 위임

## [2.4.0] - 2026-04-03

### Added
- `reconstruct_history` MCP tool: case_id/entity 기반 시간순 서사 재구성, BFS 인과 체인, case_events DAG 포함 반환 (HistoryReconstructor, migration-026 연동)
- `search_traces` MCP tool: fragments + search_events grep-like 탐색 (event_type/entity_key/keyword/case_id/session_id/time_range 필터, 기본 limit 20)
- `remember` 파라미터 6개 추가: `caseId`, `goal`, `outcome`, `phase`, `resolutionStatus`, `assertionStatus` (migration-025 연동)
- migration-025: fragments에 `case_id`, `goal`, `outcome`, `phase`, `resolution_status`, `assertion_status` 컬럼 추가 (`assertion_status` 기본값 `observed`)
- migration-026: `case_events`(semantic milestone) + `case_event_edges`(DAG, edge_type: caused_by/resolved_by/preceded_by/contradicts) + `fragment_evidence`(증거 조인) 테이블
- `CaseEventStore`: append/addEdge/addEvidence/getByCase/getBySession/deleteExpired 메서드
- `ConflictResolver.checkAssertionConsistency()`: Jaccard 유사도 기반 assertion 자동 분류 (비동기 fire-and-forget)
- `RERANKER_MODEL` 환경변수: `minilm`(기본) / `bge-m3` 선택 가능 (한국어 사용자 bge-m3 권장)
- Cloudflare Workers AI embedding provider 지원 (`CF_ACCOUNT_ID` + `CF_API_TOKEN`)

### Fixed
- workspace isolation: L1 HotCache bypass — `_executeSearch`에 RRF merge 후 workspace post-filter 추가 (cache miss fragments는 workspace 필드 미보장)
- workspace isolation: `FragmentReader.getByIds` SELECT에 workspace 컬럼 누락으로 모든 반환 파편의 workspace가 `undefined` → NULL 취급되는 버그 수정
- workspace isolation: `_searchL2` L1-miss 경로의 `getByIds` 결과에 workspace 후처리 필터 미적용 수정
- `recall` 응답 직렬화에 workspace 필드 누락 수정 (fragments 항목에 `workspace` 필드 추가)
- `reconstruct.js tool_reconstructHistory`: HistoryReconstructor 반환값에서 `case_events`, `event_dag` 필드 누락으로 MCP 응답에서 0/null 반환되던 버그 수정 (df2ebab)
- `HistoryReconstructor`: 임시 디버그 `logInfo` 제거, `logWarn`만 유지
- `_fetchTimelineParameterized` key_id isolation: `(f.key_id IS NULL OR f.key_id = $n)` → `($n::text IS NULL OR f.key_id = $n)` 수정 (master key null 전달 시 모든 파편 노출 방지)

### Changed
- Session TTL default 240min → 43200min (30일 슬라이딩 윈도우)
- Reranker: external 서비스 연속 3회 실패 시 in-process 모드 자동 전환
- TemporalLinker: API 키 격리 (keyId 기반 `key_id = ANY($n)` 필터), 링크 생성 `Promise.all` 병렬화
- server.js: 시작 시 `preloadReranker()` 비차단 호출 (fire-and-forget)

## [2.3.0] - 2026-04-02

### Added
- OAuth MCP compliance: RFC 7591 Dynamic Client Registration, auto-approve for trusted origins, consent screen
- API key usable as OAuth client_id for Claude.ai/ChatGPT Web Integration
- Trusted origin-based redirect_uri validation (claude.ai, chatgpt.com, platform.openai.com, copilot.microsoft.com, gemini.google.com)
- WWW-Authenticate header with resource_metadata on 401 responses
- Admin UI: daily-limit inline edit, permissions toggle, fragment_limit edit, group/status filters
- Knowledge graph: episode type (pink + glow), limit slider up to 10,000
- get_skill_guide tool: returns SKILL.md optimization guide (full or by section)
- Auto-update: check_update/apply_update tools, `memento update` CLI
- Session auto-recovery with keyId/groupKeyIds preservation
- Keyword rules in aiInstructions: project name + hostname
- migration-021-oauth-clients.sql, OAuthClientStore.js
- DEFAULT_DAILY_LIMIT, DEFAULT_PERMISSIONS, DEFAULT_FRAGMENT_LIMIT env vars
- OAUTH_TRUSTED_ORIGINS env var for origin-based redirect validation
- **Workspace isolation** (`migration-024`): `fragments.workspace` column partitions memories by project/role/client within the same API key. `api_keys.default_workspace` auto-tags on `remember` and auto-filters on `recall`/`context`. Search filter: `(workspace = $X OR workspace IS NULL)` — NULL fragments remain globally visible.
- Admin: `PATCH /keys/:id/workspace` endpoint to configure default workspace per key.
- MCP tools: `workspace` optional parameter added to `remember`, `recall`, `context`, `batch_remember`.
- DB: migration-024 — `fragments.workspace VARCHAR(255)`, `api_keys.default_workspace VARCHAR(255)`, composite index `(key_id, workspace)` and partial index `(workspace)`.

### Fixed
- Session TTL default 60min -> 240min
- Redis TTL sync: dynamic remaining time instead of fixed CACHE_SESSION_TTL
- SSE disconnect: preserve session (clear SSE response only)
- OAuth refresh_token: propagate is_api_key flag
- updateTtlTier: key_id isolation to prevent cross-key TTL modification
- Default API key permissions: read-only -> read+write
- Admin login: form POST + 302 redirect (SameSite=Lax)
- Static asset cache: Cloudflare CDN cache busting with timestamp query string
- recall schema: episode added to type enum
- memory-schema.sql CHECK constraints: episode, co_retrieved, short

### Documentation
- 13 docs synced: configuration, api-reference, INSTALL, architecture, admin-console-guide, internals, README (ko/en)
- SKILL.md rewritten: search decision tree, episode guide, multi-platform, token budget
- CHANGELOG.md synced with v2.3.0

## [2.2.1] - 2026-03-31

### Fixed
- migrate.js: pgvector 스키마 자동 감지 및 search_path 설정 추가. `nerdvana.vector_cosine_ops` 하드코딩 제거하여 표준 환경(public 스키마) 호환 복구
- migrate.js: dotenv로 .env 자동 로드. `POSTGRES_*` 변수로 `DATABASE_URL` 자동 구성하여 수동 지정 불필요

### Documentation
- README 한/영: 간소화된 업데이트 절차 추가 (`git pull → npm install → npm run migrate`)
- .env.example: `PGVECTOR_SCHEMA` 자동 감지 설명 강화

## [2.2.0] - 2026-03-31

### Added
- Consolidator per-stage duration metrics with `timedStage` wrapper (admin /stats `lastConsolidation`)
- Scheduler job registry for background task observability (`scheduler-registry.js`, admin /stats `schedulerJobs`)
- Per-layer search latency tracking: L1/L2/L3 ms recorded in search_events (admin /stats `pathPerformance`)
- Redis index warmup on server start (`FragmentIndex.warmup()`, eliminates cold-start L1 misses)
- API key fragment quota system (default 5000, `FRAGMENT_DEFAULT_LIMIT` env var)
- Episode fragment contextSummary auto-generation in reflect

### Fixed
- path-to-regexp ReDoS vulnerability (GHSA-j3q9, GHSA-27v5)
- L1 cache miss rate measurement: text-only queries no longer counted as L1 miss
- Quota check double-release bug
- migrate.js strips inner BEGIN/COMMIT for transactional safety
- migration-019: schema-qualified `nerdvana.vector_cosine_ops`

### Changed
- HNSW index: ef_construction 64→128, ef_search=80 session-level (migration-019)
- Added migration-020: search_events layer latency columns

### Documentation
- Tool count corrected 12→13 across all docs
- MCP instructions: recommend episode fragments with contextSummary in reflect

## [2.1.0] - 2026-03-29

### Added
- Episodic memory: episode type (1000자, 서사/맥락 기억), context_summary 선택 필드
- Episodic memory: session_id 기반 시간 인접 번들링 (includeContext=true)
- Episodic memory: reflect narrative_summary → episode 파편 자동 생성
- migration-017-episodic.sql: type CHECK 확장, context_summary/session_id 컬럼
- docs/architecture.md: 시스템 구조, DB 스키마, 3계층 검색, TTL 계층
- docs/configuration.md: 환경 변수, MEMORY_CONFIG, 임베딩 Provider, 테스트
- docs/api-reference.md: HTTP 엔드포인트, 프롬프트, 리소스, 사용 흐름
- docs/internals.md: MemoryEvaluator, MemoryConsolidator, 모순 탐지
- docs/cli.md: CLI 9개 명령어
- docs/benchmark.md: LongMemEval-S 벤치마크 상세 분석 리포트
- README/README.en: 벤치마크 성능 요약 섹션 (recall@5 88.3%, QA 45.4%)
- docs/*.en.md: 영문 분리 문서 6개 (architecture, configuration, api-reference, internals, cli, benchmark)
- docs/benchmark.md: 벤치마크 리포트 한국어 번역
- README: Memory vs Rules 섹션 추가

### Changed
- README.md: 1,486줄 → 166줄 입문 가이드로 재작성
- README.en.md: 한국어 README와 1:1 구조 동기화 재작성
- MCP serverInfo version 1.7.0 → 2.0.1, instructions에 episode type/includeContext 설명 추가
- Token budget: chars/4 추정 → js-tiktoken 정밀 계산으로 개선
- quickstart.md: memory-schema.sql → npm run migrate로 설치 안내 교체

### Fixed
- uuid[] → text[] 캐스팅 수정 (LinkedFragmentLoader, FragmentWriter)
- agent_id='default' 공유 파편이 다른 에이전트 SELECT에서 누락되던 문제 (OR 조건 추가)
- L1 Redis 검색에서 agentId 미지원 제한사항 문서화
- MemoryEvaluator 유형 제외 로직 명시, 프로덕션 인증 미설정 시 경고 로그 추가
- README 벤치마크 recall-QA gap 명시 및 알려진 제한사항 섹션 추가

### Changed (i18n)
- README.en.md: 영문 docs(.en.md)로 링크 변경

### Removed
- README.simple.md: 새 README가 이미 간결하므로 삭제

## [2.0.0] - 2026-03-28

### Added
- CLI tool: 9 subcommands via bin/memento.js (serve, migrate, cleanup, backfill, stats, health, recall, remember, inspect)
- CLI argument parser (lib/cli/parseArgs.js) with zero external dependencies
- Inline quality gate: FragmentFactory.validateContent() rejects content < 10 chars AND < 3 words, URL-only, null type+topic
- Semantic dedup gate in GraphLinker.linkFragment(): cos >= 0.95 soft delete, cos >= 0.90 warning
- Empty session reflect filter: skip AutoReflect when 0 tool calls, 0 fragments, or < 30s duration
- NLI contradiction recursion limit: MAX_CONTRADICTION_DEPTH=3 with pair tracking Set
- Semantic dedup in consolidate cycle: KNN cos >= 0.92 merge with anchor protection
- Memory compression layer: 30d+ inactive fragments grouped by cos >= 0.80, keep highest importance
- scripts/cleanup-noise.js: CLI tool for manual noise removal (--dry-run/--execute/--include-nli)
- Adaptive importance: computeAdaptiveImportance() with access boost + type-specific halfLife decay
- Low-importance warning: remember() returns warning + auto TTL short when importance < 0.3
- Recall metadata: created_at, age_days, access_count, confidence, linked[3] in recall response
- UtilityBaseline: anchor-average confidence scoring, refreshed per consolidate cycle
- L2.5 Graph search layer: 1-hop neighbor fragments injected into RRF pipeline (weight 1.5x)
- LinkedFragmentLoader: LATERAL JOIN for 1-hop linked fragment retrieval
- recall timeRange parameter: created_at BETWEEN filter for temporal queries
- context({structured:true}): hierarchical tree response (core/working/anchors/learning)
- Knowledge graph D3.js zoom/pan with auto-fit viewport
- migration-014: ttl_tier 'short' constraint
- migration-015: created_at DESC index for timeRange queries
- Config: DEDUP_BATCH_SIZE, DEDUP_MIN_FRAGMENTS, COMPRESS_AGE_DAYS, COMPRESS_MIN_GROUP, CONSOLIDATE_INTERVAL_MS

### Changed
- calibrateByFeedback: 24h -> 7d window, additive -> multiplicative (1.1x/0.85x)
- consolidate default interval: 6h (CONSOLIDATE_INTERVAL_MS, configurable)
- RRF weights: L1(2x) > L2.5Graph(1.5x) > L2(1x) = L3(1x)
- FragmentReader: utility_score included in all SELECT queries

### Security
- CORS origin whitelist via ALLOWED_ORIGINS env var (getAllowedOrigin helper)
- /metrics requires master key authentication
- /health returns minimal response for unauthenticated requests
- Admin panel blocked when MEMENTO_ACCESS_KEY unset
- Admin cookie: conditional Secure flag based on X-Forwarded-Proto
- Content-Security-Policy header on Admin UI
- db_query SQL validation: word-boundary regex, semicolon/comment/length/catalog/function blocking
- Gemini wiki prompt injection defense (XML tag delimiters)
- GitHub Actions pinned to SHA hashes

### Fixed
- CSP blocking Tailwind/D3/Google Fonts CDN resources
- Knowledge graph nodes overflowing viewport (no zoom/pan)

### Removed
- docs-mcp dead code from gemini.js (489 lines: generateContent, generateWikiContent, improveWikiContent, GEMINI_MODELS, braveSearch, generateWikiContentWithCLI, enhanceWikiContentWithCLI, checkGeminiStatus)

## [1.8.0] - 2026-03-28

### Added
- RBAC: tool-level permission enforcement (read/write/admin) via lib/rbac.js
- Fragment import/export API: GET /export (JSON Lines stream), POST /import
- Knowledge graph visualization: GET /memory/graph API + D3.js force-directed Admin tab
- Search quality dashboard: path distribution, latency percentiles (p50/p90/p99), top keywords, zero-result rate
- DB migration runner: scripts/migrate.js with transaction safety and schema_migrations tracking
- MemoryManager.create() static factory for dependency injection in tests
- MemoryEvaluator backpressure: queue size cap (EVALUATOR_MAX_QUEUE env, default 100)
- Sentiment-aware decay: tool_feedback fragment_ids parameter adjusts ema_activation
- Closed learning loop: searchPath tracking in SessionActivityTracker, learning extraction in AutoReflect, context() priority injection for learning fragments
- Temperature-weighted context sorting: warm window + access count + learning source boost
- FragmentReader.searchBySource() for source-based fragment queries

### Changed
- Admin routes split into 5 focused modules (admin-auth, admin-keys, admin-memory, admin-sessions, admin-logs)
- Admin authentication: QS ?key= replaced with opaque session token cookie (HttpOnly, SameSite=Strict)
- Gemini API key moved from URL query parameter to x-goog-api-key header
- ESLint config: browser globals added for assets/**/*.js
- Jest/node:test boundary: tests/unit/ excluded from Jest (node:test only), tests/*.test.js for Jest
- context() extras sorting uses temperature score (importance + warm boost + access count + learning boost)
- config/memory.js: added temperatureBoost, learning typeSlot

### Fixed
- npm audit vulnerabilities (flatted, picomatch, brace-expansion)
- ESLint 606 errors from missing browser globals
- Jest 34/42 suite failures from node:test module resolution
- Admin cookie auth: validateAdminAccess used instead of validateMasterKey in API dispatcher
- Export query: nonexistent updated_at column replaced with accessed_at

### Security
- Admin QS key exposure eliminated (cookie-based session tokens)
- Gemini API key no longer appears in URL query strings or logs
- RBAC prevents read-only API keys from executing write operations

## [1.7.0] - 2026-03-26

### Added
- Admin operations console with 6 management tabs (overview, API keys, groups, memory operations, sessions, system logs)
- Stitch-aligned UI design system (Tailwind CSS, Material Symbols, Space Grotesk + Plus Jakarta Sans)
- 12 new admin API endpoints: memory operations (4), session management (6), log viewer (3)
- Static asset serving with path traversal protection
- Session activity monitoring with Redis-based tracking
- Bulk session reflect for orphaned unreflected sessions
- Log file reverse-read for large file tail support
- Windowed pagination (10-page window centered on current)

### Changed
- Admin UI rewritten from 1928-line inline HTML to modular app shell (index.html + admin.css + admin.js)
- GET /stats expanded with searchMetrics, observability, queues, healthFlags
- Static assets served without auth (browser resource requests)

### Fixed
- URL ?key= parameter authentication for direct admin access
- Inline display:none preventing CSS class override
- Duplicate getSearchMetrics import from merge
- Memory fragments parsing (data.items vs data.fragments)
- Groups column rendering object instead of name
- Anomalies query using nonexistent updated_at column (-> accessed_at)
- Active sessions excluded from unreflected count
- Log file 50MB size limit replaced with reverse-read tail

## [1.6.1] - 2026-03-25

### Added
- Search observability infrastructure (searchPath persistence, tool_feedback FK)
- search_events table (migration-013) for query/result observability
- SearchEventRecorder for FragmentSearch.search() result logging
- SearchEventAnalyzer for search pattern analysis

### Fixed
- ESLint glob tests/*.test.js -> tests/**/*.test.js for nested test dirs

## [1.6.0] - 2026-03-19

### Added
- GC search_events older than 30 days in consolidation cycle
- Context seen-ids deduplication
- Quality improvements
