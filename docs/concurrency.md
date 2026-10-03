# Concurrency Matrix

write 경로별 lock 종류·격리 수준·재시도 정책을 한 페이지로 정리한다. 새 write 경로를 추가할 때 이 표에 행을 추가하고, 회귀 테스트 파일을 같이 등재한다.

본 문서는 운영·리뷰 보조용 ledger이며, 실제 구현 변경은 코드 본문이 권위 출처다. 표와 코드가 어긋날 경우 코드를 신뢰하고 본 문서를 갱신한다.

## Write 경로 매트릭스

|경로|진입점|lock 종류|격리/트랜잭션|재시도 정책|TOCTOU 가드|회귀 테스트|
|-|-|-|-|-|-|-|
|remember (atomic)|`MemoryRememberer._rememberAtomic` (`lib/memory/processors/MemoryRememberer.js`)|`SELECT … api_keys FOR UPDATE` (row lock) → INSERT|단일 트랜잭션 BEGIN/COMMIT, `app.current_agent_id='system'`|호출자가 idempotencyKey로 안전 재시도. 트랜잭션 자체 자동 재시도 없음|quota 재검증을 동일 트랜잭션 안에서 수행. PolicyRules hard gate는 트랜잭션 진입 전 의미 쓰기 관문(`WriteGate.check`)에서 판정|`tests/unit/atomic-remember-policy-gate.test.js`, `tests/integration/toctou-remember-concurrency.test.js`|
|remember (non-atomic)|`MemoryRememberer.remember` 본문|`QuotaChecker.check` 선제 검사 + INSERT|개별 쿼리. 호출자 agent_id 기준 조건 적용|호출자 책임|동시 요청이 드문 환경 전용. 다중 인스턴스에서는 atomic 사용 권고|`tests/unit/memory-manager-remember-tdz.test.js`|
|batchRemember|`MemoryRememberer.batchRemember` → `BatchRememberProcessor`|`api_keys FOR UPDATE`로 quota Phase B 검증 → 24컬럼 × N행 multi-row INSERT|단일 트랜잭션. 같은 칸 중복은 유효 판정 색인(`DedupScope`: 키 범위 색인이 있으면 그 색인, 없으면 workspace 범위 색인)을 대상으로 한 `ON CONFLICT ... DO UPDATE`로 흡수하고, 그 색인이 잡지 못하는 범위(전역 파편, `MEMENTO_DEDUP_SCOPE=key`의 다른 workspace)는 사전 조회로 기존 id를 돌려준다. 판정 색인이 바뀐 직후나 다른 요청과 겹친 42P10, 판정 색인의 23505는 트랜잭션 전체를 최대 두 번 다시 실행한다|chunk 단위 256KB 또는 500행 분할. chunk별 트랜잭션|Phase A 사전 quota check + Phase B 동일 트랜잭션 재검증|`tests/unit/batch-remember-processor.test.js`, `tests/unit/batch-remember-total-gate.test.js`|
|consolidate.merge_duplicates|`MemoryConsolidator._mergeDuplicates`|advisory 없음. `queryWithAgentVector("system", …)`로 에이전트 범위 해제|개별 UPDATE/DELETE. `WHERE key_id = $X`로 키 범위 강제|cycle 단위 LIMIT 50으로 1회 실행, 미처리분은 다음 cycle에서 처리|GROUP BY (key_id, workspace, content_hash) + scope mismatch 어설션 + key_id 조건부 UPDATE/DELETE|`tests/unit/consolidator-merge-tenant-scope.test.js`|
|consolidate.semantic_dedup|`MemoryConsolidator._semanticDedup`|advisory 없음|개별 쿼리|cycle 단위 LIMIT|topic·key_id 범위 안 KNN cos>=0.92|`tests/unit/semantic-dedup.test.js`|
|consolidate.detect_contradictions|`MemoryConsolidator._detectContradictions`|advisory 없음|개별 쿼리|`resetCheckedPairs()`로 cycle 시작 시 추적 초기화|NLI + LLM 하이브리드. `pending_contradictions` 큐로 후처리 분리|`tests/unit/detect-supersessions.test.js`|
|link.createLinks|`LinkStore.createLinks` (`lib/memory/link/LinkStore.js`)|쌍마다 `pg_advisory_xact_lock`(sortedKey 순) + multi-row INSERT. 이어서 양방향 `linked_to` 갱신은 대상 파편 행을 id 오름차순으로 `FOR NO KEY UPDATE` 잠근 한 문장으로 수행|링크 INSERT는 단일 트랜잭션(`lock_timeout=5s`). `linked_to` 갱신은 별도 문장이며 실패하면 경고 로그만 남기고 링크 삽입 결과는 유지|advisory 획득 실패 시 단건 fallback|`(from_id, to_id)` UNIQUE로 중복 차단. `linked_to`는 쌍의 상대 id만 받는다|`tests/unit/session-linker-batch.test.js`, `tests/unit/linkstore-create-links-sql.test.js`, `tests/unit/linkstore-create-links-linked-to.test.js`, `tests/db-concurrency/linked-to-pairs.test.js`|
|forget (linked_to 정리)|`FragmentWriter`의 `linked_to` 제거 경로|대상 행을 id 오름차순으로 `FOR NO KEY UPDATE` 잠근 뒤 `array_remove`. `MEMENTO_SCORE_UPDATE_BATCH`와 무관하게 항상 id 순|단일 문장|호출자 책임|잠금 순서를 recall 부수효과(`incrementAccess`, `touchLinked`)와 같은 id 오름차순으로 맞춰 교착을 막는다|`tests/db-concurrency/lock-order.test.js`|
|consolidate.importance_decay, utility_score_update|`FragmentGC.decayImportance`, `MemoryConsolidator._updateUtilityScores` (`lib/memory/consolidate/idOrderedUpdate.js`)|`MEMENTO_SCORE_UPDATE_BATCH`(기본 200) 크기의 id 오름차순 묶음마다 `FOR NO KEY UPDATE` 잠금 후 갱신. 0이면 단일 UPDATE 문장|묶음마다 커밋하며 모든 묶음이 첫 조회의 기준 시각 하나를 사용|호출자 책임. 다음 consolidate 주기가 다시 처리|저장값이 바뀌는 행만 갱신. 감쇠와 utility는 `MEMENTO_DECAY_MIN_DELTA`, `MEMENTO_UTILITY_MIN_DELTA` 미만 변화 행을 건너뜀|`tests/unit/id-ordered-update.test.js`, `tests/db-concurrency/score-update-lock-order.test.js`, `tests/db-concurrency/score-update-noop.test.js`, `tests/db-concurrency/score-update-min-delta.test.js`|
|link.autoLinkSessionFragments|`SessionLinker.autoLinkSessionFragments`|sortedKey 사전식 정렬로 deadlock 방지|개별 쿼리|`wouldCreateCycle` 캐시로 동일 cycle 내 재계산 회피|cycle detection 사전 검사|`tests/integration/session-linker-deadlock.test.js`|
|reflect|`MemoryReflector.reflect` → `BatchRememberProcessor.process`|상속(batchRemember)|상속|상속|상속 + idempotencyKey 권장|`tests/integration/reflect-large-payload.test.js`|
|LLM dispatch|`dispatchChain` (`lib/llm/index.js`)|`getSemaphore(chainKey, limit, waitMs)` per provider chainKey|단일 fetch|429 / semaphore timeout 시 다음 fallback provider로|`provider|baseUrl|model|apiKeyHash` 단위 독립 sem|`tests/unit/llm-dispatcher-concurrency.test.js`, `tests/unit/llm-dispatcher-no-inline-mirror.test.js`|

## 격리 수준 약식

- DB 수준 격리(RLS)는 활성 상태가 아니다. 격리는 각 질의의 `key_id` 조건과 `lib/memory/keyScope.js`가 담당한다. atomic·consolidate 경로는 `app.current_agent_id='system'`을 설정해 에이전트 범위를 해제하므로, 키 범위(`WHERE key_id = $X`)를 질의에 명시해야 하며 `_mergeDuplicates`가 이 조건을 적용한다.
- master 키(`key_id IS NULL`)는 자동 병합·hard gate 대상에서 제외된다. cross-tenant 데이터 유실 경로를 차단하기 위함.

## 행 잠금 순서

파편 행을 여러 개 잠그는 경로는 모두 id 오름차순으로 잠근다. recall 부수효과(`incrementAccess`, `touchLinked`), 임베딩 일괄 갱신, 링크 일괄 생성의 `linked_to` 갱신, `forget`의 `linked_to` 정리, 감쇠와 utility 점수 갱신(`idOrderedUpdate.js`)이 같은 순서를 쓰므로 서로 다른 순서로 같은 파편 집합을 잠그다 생기는 교착이 없다. 점수 갱신은 묶음마다 커밋해 한 번에 잡는 행 잠금을 묶음 크기로 제한한다. 이 순서는 `npm run test:db`의 `tests/db-concurrency/`가 실제 PostgreSQL에서 확인한다. 이 레인은 실행마다 전용 데이터베이스를 만들고 지우며 `npm test`에는 포함되지 않는다.

## 재시도 정책 정리

|상황|동작|
|-|-|
|HTTP 429 (LLM provider)|`memento_llm_provider_429_total` 증가. 쿨다운은 500~2000ms 랜덤 지터와 서버 힌트 중 큰 값이며 상한 60초(`computeCooldown`). 체인 스킵 후 재진입|
|chain deadline 초과|`getRemainingChainMs(startedAt)`이 <=0이면 chain 종료. `LLM_CHAIN_TIMEOUT_MS` 기준|
|semaphore wait timeout|해당 provider 실패로 기록 후 다음 fallback. `LLM_CONCURRENCY_WAIT_MS` (기본 30000ms)|
|policy violation (hard gate)|`SymbolicPolicyViolationError` throw. 호출자가 처리. atomic 경로에서도 트랜잭션 시작 전에 throw|
|fragment_limit exceeded|`atomic` 경로에서 ROLLBACK 후 `code: "fragment_limit_exceeded"` Error throw|

## 새 경로 추가 규약

1. 코드 본문에 동시성 가드를 명시적으로 작성한다. 에이전트 범위 해제(`agent_id='system'`)가 필요하면 키 scope(`WHERE key_id = $X`)를 같은 함수 안에 강제한다.
2. 본 문서 매트릭스에 행을 추가한다. 회귀 테스트 파일을 같은 PR에서 신설·등재한다.
3. deadlock·TOCTOU 가드가 의심되는 경우 통합 테스트로 박제한다(`tests/integration/<topic>-concurrency.test.js`).
4. 여러 파편 행을 잠그는 경로는 대상을 id 오름차순으로 잠그고, 교착 시험을 `tests/db-concurrency/`에 등재한다.
5. `docs/features.md`의 관련 모듈 행이 영향받으면 함께 갱신한다.

## Read 경로 매트릭스

read 경로는 write 경로와 달리 row-level lock을 사용하지 않는다. 대신 `SearchScope` 계약 객체가 레이어별 필터 일관성을 보장한다.

|경로|진입점|필터 계약|격리 특성|비고|
|-|-|-|-|-|
|recall (HotCache)|`FragmentSearch._searchHotCache`|`SearchScope.applyTo(fragment)`|읽기 전용. 호출자 agent_id는 SearchScope가 적용|L1 캐시 히트. workspace/caseId/phase/affect/isAnchor를 단일 `applyTo` 호출로 판정|
|recall (L3 semantic)|`FragmentSearch._searchL3`|`SearchScope.applyTo(fragment)` post-filter|읽기 전용|pgvector KNN 후 `SearchScope`로 2차 필터하고 `search()` 최종 공통 필터로 다시 검증한다|
|recall (graph)|`FragmentSearch._searchGraph`|호출 사이트에서 `SearchScope.applyTo` 직접 적용|읽기 전용|GraphNeighborSearch가 반환한 fragment 각각에 applyTo 체크|
|recall (side effects)|`commitSearchSideEffects` (`lib/memory/read/SearchSideEffects.js`)|없음 (결과 확정 후 별도 실행)|fire-and-forget `recordOutcome` + await `recordSearchEvent`|`searchEventId` 반환. tool_feedback FK 계약에 사용됨|

`SearchScope` 객체는 `SearchScope.fromQuery(sq)`로 생성되며, `applyTo(fragment)` 호출이 `false`를 반환하면 해당 fragment를 결과에서 제외한다. workspace가 `null`인 scope는 전역 fragment(workspace=null)를 포함한다. `isNoop()`이 `true`인 경우 filter 루프를 건너뛸 수 있다.

## 저장소 트랜잭션

`lib/tools/db.js`의 `withTransaction(pool, fn)`이 원자적 블록을 실행한다. `fn(client)`가 반환하는 Promise가 reject되면 자동 ROLLBACK된다.

## 관련 환경 변수

|변수|기본|영향|
|-|-|-|
|`MEMENTO_REMEMBER_ATOMIC`|`false`|`true`이면 remember 경로가 atomic 트랜잭션 사용|
|`MEMENTO_STORAGE`|`pgvector`|저장소 백엔드 이름. 현재 `pgvector` 하나이며 이 값은 동작에 영향을 주지 않는다.|
|`LLM_CONCURRENCY_ENABLED`|`true`|`false`이면 dispatcher가 semaphore 없이 chain 호출|
|`LLM_CONCURRENCY_WAIT_MS`|`30000`|semaphore 슬롯 대기 timeout|
|`LLM_CONCURRENCY`|JSON|chainKey 또는 provider name 기준 limit override|
|`LLM_CHAIN_TIMEOUT_MS`|`0`|chain deadline. `0`이면 무제한|
|`MEMENTO_SCORE_UPDATE_BATCH`|`200`|감쇠와 utility 갱신의 id 오름차순 묶음 크기. 0이면 단일 UPDATE 문장. 10000을 넘으면 10000|
|`MEMENTO_DECAY_MIN_DELTA`|`0`|감쇠량이 이 값보다 작은 행을 건너뜀(마지막 감쇠 후 24시간이 지난 행은 항상 갱신)|
|`MEMENTO_UTILITY_MIN_DELTA`|`0`|저장된 utility_score와의 차이가 이 값 이하인 행을 다시 쓰지 않음|
|`MEMENTO_METRICS_DEFAULT`|(없음)|`off`이면 prom-client 기본 프로세스 지표(CPU, 메모리 등) 수집을 생략 (테스트 환경 권장). 직접 등록한 카운터는 영향받지 않음|
