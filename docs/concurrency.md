# Concurrency Matrix

write 경로별 lock 종류·격리 수준·재시도 정책을 한 페이지로 정리한다. 새 write 경로를 추가할 때 이 표에 행을 추가하고, 회귀 테스트 파일을 같이 등재한다.

본 문서는 운영·리뷰 보조용 ledger이며, 실제 구현 변경은 코드 본문이 권위 출처다. 표와 코드가 어긋날 경우 코드를 신뢰하고 본 문서를 갱신한다.

## Write 경로 매트릭스

|경로|진입점|lock 종류|격리/트랜잭션|재시도 정책|TOCTOU 가드|회귀 테스트|
|-|-|-|-|-|-|-|
|remember (atomic)|`MemoryRememberer._rememberAtomic` (`lib/memory/processors/MemoryRememberer.js`)|`SELECT … api_keys FOR UPDATE` (row lock) → INSERT|단일 트랜잭션 BEGIN/COMMIT, `app.current_agent_id='system'`|호출자가 idempotencyKey로 안전 재시도. 트랜잭션 자체 자동 재시도 없음|quota 재검증을 동일 트랜잭션 안에서 수행. PolicyRules hard gate는 진입 직전 `_runPolicyGate`로 통일됨|`tests/unit/atomic-remember-policy-gate.test.js`, `tests/integration/toctou-remember-concurrency.test.js`|
|remember (non-atomic)|`MemoryRememberer.remember` 본문|`QuotaChecker.check` 선제 검사 + INSERT|개별 쿼리. RLS는 호출자 agent_id 적용|호출자 책임|동시 요청이 드문 환경 전용. 다중 인스턴스에서는 atomic 사용 권고|`tests/unit/memory-manager-remember-tdz.test.js`|
|batchRemember|`MemoryRememberer.batchRemember` → `BatchRememberProcessor`|`api_keys FOR UPDATE`로 quota Phase B 검증 → 24컬럼 × N행 multi-row INSERT|단일 트랜잭션. `ON CONFLICT (idempotency_key) DO NOTHING` 유지|chunk 단위 256KB 또는 500행 분할. chunk별 트랜잭션|Phase A 사전 quota check + Phase B 동일 트랜잭션 재검증|`tests/integration/batch-remember.test.js`|
|consolidate.merge_duplicates|`MemoryConsolidator._mergeDuplicates`|advisory 없음. `queryWithAgentVector("system", …)`로 RLS 우회|개별 UPDATE/DELETE. `WHERE key_id = $X`로 키 범위 강제|cycle 단위 LIMIT 50으로 1회 실행, 미처리분은 다음 cycle에서 처리|GROUP BY (key_id, workspace, content_hash) + scope mismatch 어설션 + key_id 조건부 UPDATE/DELETE|`tests/unit/consolidator-merge-tenant-scope.test.js`|
|consolidate.semantic_dedup|`MemoryConsolidator._semanticDedup`|advisory 없음|개별 쿼리|cycle 단위 LIMIT|topic·key_id 범위 안 KNN cos>=0.92|`tests/unit/semantic-dedup.test.js`|
|consolidate.detect_contradictions|`MemoryConsolidator._detectContradictions`|advisory 없음|개별 쿼리|`resetCheckedPairs()`로 cycle 시작 시 추적 초기화|NLI + LLM 하이브리드. `pending_contradictions` 큐로 후처리 분리|`tests/unit/detect-supersessions.test.js`|
|link.createLinks|`LinkStore.createLinks` (`lib/memory/link/LinkStore.js`)|`pg_advisory_xact_lock` 1개 + multi-row INSERT|단일 트랜잭션|advisory 획득 실패 시 단건 fallback|`(from_id, to_id, relation_type)` UNIQUE로 중복 차단|`tests/unit/link-store.test.js`|
|link.autoLinkSessionFragments|`SessionLinker.autoLinkSessionFragments`|sortedKey 사전식 정렬로 deadlock 방지|개별 쿼리|`wouldCreateCycle` 캐시로 동일 cycle 내 재계산 회피|cycle detection 사전 검사|`tests/integration/session-linker-deadlock.test.js`|
|reflect|`MemoryReflector.reflect` → `BatchRememberProcessor.process`|상속(batchRemember)|상속|상속|상속 + idempotencyKey 권장|`tests/integration/reflect-large-payload.test.js`|
|LLM dispatch|`dispatchChain` (`lib/llm/index.js`)|`getSemaphore(chainKey, limit, waitMs)` per provider chainKey|단일 fetch|429 / semaphore timeout 시 다음 fallback provider로|`provider|baseUrl|model|apiKeyHash` 단위 독립 sem|`tests/unit/llm-dispatcher-concurrency.test.js`, `tests/unit/llm-dispatcher-no-inline-mirror.test.js`|

## 격리 수준 약식

- 모든 RLS 정책은 `app.current_agent_id` 세션 변수로 enforce된다. atomic·consolidate 경로가 `app.current_agent_id='system'`을 설정하면 RLS를 우회한다. 의도된 우회는 키 범위(`WHERE key_id = $X`)로 명시 가드되어야 하며, `_mergeDuplicates`가 이 가드를 적용한다.
- master 키(`key_id IS NULL`)는 자동 병합·hard gate 대상에서 제외된다. cross-tenant 데이터 유실 경로를 차단하기 위함.

## 재시도 정책 정리

|상황|동작|
|-|-|
|HTTP 429 (LLM provider)|`llm_provider_429_total` 증가, 해당 chainKey의 sem이 500-2000ms 랜덤 지터 cooldown. 체인 스킵 후 재진입|
|chain deadline 초과|`getRemainingChainMs(startedAt)`이 <=0이면 chain 종료. `LLM_CHAIN_TIMEOUT_MS` 기준|
|semaphore wait timeout|해당 provider 실패로 기록 후 다음 fallback. `LLM_CONCURRENCY_WAIT_MS` (기본 30000ms)|
|policy violation (hard gate)|`SymbolicPolicyViolationError` throw. 호출자가 처리. atomic 경로에서도 트랜잭션 시작 전에 throw|
|fragment_limit exceeded|`atomic` 경로에서 ROLLBACK 후 `code: "fragment_limit_exceeded"` Error throw|

## 새 경로 추가 규약

1. 코드 본문에 동시성 가드를 명시적으로 작성한다. RLS 우회(`agent_id='system'`)가 필요하면 키 scope(`WHERE key_id = $X`)를 같은 함수 안에 강제한다.
2. 본 문서 매트릭스에 행을 추가한다. 회귀 테스트 파일을 같은 PR에서 신설·등재한다.
3. deadlock·TOCTOU 가드가 의심되는 경우 통합 테스트로 박제한다(`tests/integration/<topic>-concurrency.test.js`).
4. `docs/features.md`의 관련 모듈 행이 영향받으면 함께 갱신한다.

## Read 경로 매트릭스

read 경로는 write 경로와 달리 row-level lock을 사용하지 않는다. 대신 `SearchScope` 계약 객체가 레이어별 필터 일관성을 보장한다.

|경로|진입점|필터 계약|격리 특성|비고|
|-|-|-|-|-|
|recall (HotCache)|`FragmentSearch._searchHotCache`|`SearchScope.applyTo(fragment)`|읽기 전용. RLS는 호출자 agent_id 적용|L1 캐시 히트. workspace/caseId/phase/affect 5개 필드를 단일 `applyTo` 호출로 판정|
|recall (L3 semantic)|`FragmentSearch._searchL3`|`SearchScope.applyTo(fragment)` post-filter|읽기 전용|pgvector KNN 후 `SearchScope`로 2차 필터. `_executeSearch`는 별도의 후처리 보정을 수행하지 않는다|
|recall (graph)|`FragmentSearch._searchGraph`|호출 사이트에서 `SearchScope.applyTo` 직접 적용|읽기 전용|GraphExplorer가 반환한 fragment 각각에 applyTo 체크|
|recall (side effects)|`commitSearchSideEffects` (`lib/memory/read/SearchSideEffects.js`)|없음 (결과 확정 후 별도 실행)|fire-and-forget `recordOutcome` + await `recordSearchEvent`|`searchEventId` 반환. tool_feedback FK 계약에 사용됨|

`SearchScope` 객체는 `SearchScope.fromQuery(sq)`로 생성되며, `applyTo(fragment)` 호출이 `false`를 반환하면 해당 fragment를 결과에서 제외한다. workspace가 `null`인 scope는 전역 fragment(workspace=null)를 포함한다. `isNoop()`이 `true`인 경우 filter 루프를 건너뛸 수 있다.

## 스토리지 어댑터 트랜잭션

`lib/storage/index.js`의 `transaction(fn)` 인터페이스는 어댑터 종류에 관계없이 원자적 블록을 실행한다. `fn(client)`가 반환하는 Promise가 reject되면 자동 ROLLBACK된다. write 경로가 어댑터를 직접 교체해도 트랜잭션 시맨틱이 보존된다.

## 관련 환경 변수

|변수|기본|영향|
|-|-|-|
|`MEMENTO_REMEMBER_ATOMIC`|`false`|`true`이면 remember 경로가 atomic 트랜잭션 사용|
|`MEMENTO_STORAGE`|`pgvector`|스토리지 어댑터 선택. `pgvector`(기본, 프로덕션) 또는 `sqlite-vec`(미구현 스텁)|
|`LLM_CONCURRENCY_ENABLED`|`true`|`false`이면 dispatcher가 semaphore 없이 chain 호출|
|`LLM_CONCURRENCY_WAIT_MS`|`30000`|semaphore 슬롯 대기 timeout|
|`LLM_CONCURRENCY`|JSON|chainKey 또는 provider name 기준 limit override|
|`LLM_CHAIN_TIMEOUT_MS`|—|chain deadline. `0`이면 무제한|
|`MEMENTO_METRICS_DEFAULT`|`on`|`off`이면 prom-client 카운터 noop (테스트 환경 권장)|
