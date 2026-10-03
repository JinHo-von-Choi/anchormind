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
|link.createLinks|`LinkStore.createLinks` (`lib/memory/link/LinkStore.js`)|쌍마다 `pg_advisory_xact_lock`(sortedKey 순) + multi-row INSERT. 이어서 양방향 `linked_to` 갱신은 대상 파편 행을 id 오름차순으로 `FOR NO KEY UPDATE` 잠그는 문장과 잠근 행만 갱신하는 문장을 한 트랜잭션으로 수행|링크 INSERT는 단일 트랜잭션(`lock_timeout=5s`). `linked_to` 갱신은 별도 트랜잭션이며 실패하면 경고 로그만 남기고 링크 삽입 결과는 유지|advisory 획득 실패 시 단건 fallback|`(from_id, to_id)` UNIQUE로 중복 차단. `linked_to`는 쌍의 상대 id만 받는다|`tests/unit/session-linker-batch.test.js`, `tests/unit/linkstore-create-links-sql.test.js`, `tests/unit/linkstore-create-links-linked-to.test.js`, `tests/db-concurrency/linked-to-pairs.test.js`|
|forget (linked_to 정리, 일괄 삭제)|`FragmentWriter.delete`, `deleteMany`, `deleteByAgent`|`linked_to` 정리는 대상 행을 id 오름차순으로 `FOR NO KEY UPDATE` 잠근 뒤 다음 문장에서 `array_remove`. 여러 행 삭제는 id 오름차순 `FOR UPDATE` 잠금 뒤 삭제. `MEMENTO_SCORE_UPDATE_BATCH`와 무관하게 항상 id 순|잠금 문장과 쓰기 문장을 한 트랜잭션으로|잠금 충돌은 `MEMENTO_DB_LOCK_RETRY_MAX`까지 트랜잭션 재실행|잠금 순서를 recall 부수효과(`incrementAccess`, `touchLinked`)와 같은 id 오름차순으로 맞춰 교착을 막는다|`tests/db-concurrency/lock-order.test.js`|
|consolidate.importance_decay, utility_score_update|`FragmentGC.decayImportance`, `MemoryConsolidator._updateUtilityScores` (`lib/memory/consolidate/idOrderedUpdate.js`)|`MEMENTO_SCORE_UPDATE_BATCH`(기본 200) 크기의 id 오름차순 묶음마다 `FOR NO KEY UPDATE` 잠금 문장 뒤 잠근 행만 갱신. 0이면 단일 UPDATE 문장|묶음마다 커밋하며 모든 묶음이 첫 조회의 기준 시각 하나를 사용|묶음 단위 잠금 충돌 재실행. 그 밖은 호출자 책임이며 다음 consolidate 주기가 다시 처리|저장값이 바뀌는 행만 갱신. 감쇠와 utility는 `MEMENTO_DECAY_MIN_DELTA`, `MEMENTO_UTILITY_MIN_DELTA` 미만 변화 행을 건너뜀|`tests/unit/id-ordered-update.test.js`, `tests/db-concurrency/score-update-lock-order.test.js`, `tests/db-concurrency/score-update-noop.test.js`, `tests/db-concurrency/score-update-min-delta.test.js`|
|link.autoLinkSessionFragments|`SessionLinker.autoLinkSessionFragments`|sortedKey 사전식 정렬로 deadlock 방지|개별 쿼리|`wouldCreateCycle` 캐시로 동일 cycle 내 재계산 회피|cycle detection 사전 검사|`tests/integration/session-linker-deadlock.test.js`|
|reflect|`MemoryReflector.reflect` → `BatchRememberProcessor.process`|상속(batchRemember)|상속|상속|상속 + idempotencyKey 권장|`tests/integration/reflect-large-payload.test.js`|
|remember (scope=session, Redis 미준비)|`MemoryRememberer` → `FragmentWriter.insert`(작업 기억 행 `source=wm-fallback`), `WorkingMemoryRows`|기록은 일반 INSERT. 키별 상한 정리는 행 수를 센 뒤 오래된 초과분을 DELETE. 만료 정리는 묶음마다 별도 트랜잭션에서 `FOR UPDATE SKIP LOCKED`(`lock_timeout=3s`)|개별 문장. 만료 정리는 묶음 단위 트랜잭션|정리 실패는 경고만 남기고 다음 주기에 이어감|동시 쓰기에서 키별 상한을 잠시 몇 행 넘을 수 있다. 행은 `valid_to`가 채워져 조회와 집계에서 빠진다|`tests/db-concurrency/working-memory-rows.test.js`, `tests/db-concurrency/working-memory-exclusion.test.js`|
|outbox|`enqueue(client, event)`, `enqueueStandalone` (`lib/outbox/Outbox.js`), `OutboxWorker`, `OutboxStore`|점유는 `(available_at, id)` 순 `FOR UPDATE SKIP LOCKED`와 같은 문장의 임대(`available_at` 연장, `claim_token`)|기록은 호출자 트랜잭션 안. 점유, 완료, 실패, 반납은 문장마다 자동 커밋이며 처리기 실행 중에는 잠금을 쥐지 않음|지수 간격 재시도, `MEMENTO_OUTBOX_MAX_ATTEMPTS` 뒤 dead-letter|완료, 실패, 반납은 `claim_token`이 같고 대기 상태인 행에만 반영. 임대를 잃은 작업자의 늦은 기록은 0행|`tests/db-concurrency/outbox-worker.test.js`|
|LLM dispatch|`dispatchChain` (`lib/llm/index.js`)|`getSemaphore(chainKey, limit, waitMs)` per provider chainKey|단일 fetch|429 / semaphore timeout 시 다음 fallback provider로|`provider|baseUrl|model|apiKeyHash` 단위 독립 sem|`tests/unit/llm-dispatcher-concurrency.test.js`, `tests/unit/llm-dispatcher-no-inline-mirror.test.js`|

## 격리 수준 약식

- DB 수준 격리(RLS)는 활성 상태가 아니다. 격리는 각 질의의 `key_id` 조건과 `lib/memory/keyScope.js`가 담당한다. atomic·consolidate 경로는 `app.current_agent_id='system'`을 설정해 에이전트 범위를 해제하므로, 키 범위(`WHERE key_id = $X`)를 질의에 명시해야 하며 `_mergeDuplicates`가 이 조건을 적용한다.
- master 키(`key_id IS NULL`)는 자동 병합·hard gate 대상에서 제외된다. cross-tenant 데이터 유실 경로를 차단하기 위함.

## 행 잠금 순서

파편 행을 여러 개 갱신하거나 지우는 경로는 모두 같은 규칙을 따른다.

1. 대상 행은 `SELECT id FROM fragments WHERE <대상 조건> ORDER BY id FOR NO KEY UPDATE`(삭제는 `FOR UPDATE`) 문장 하나로 id 오름차순으로 잠근다.
2. 쓰기는 같은 트랜잭션의 다음 문장에서 잠근 id 배열(`$1`)만 대상으로 한다(`WHERE id = ANY($1)`).
3. 1과 2는 `queryWithAgentVector(agentId, 쓰기 문장, params, { lock })`로 실행한다(`lib/tools/db.js`). 잠금 문장은 `fragmentRowLock`(`lib/memory/write/rowLock.js`)으로 만든다. 잠근 행이 없으면 쓰기 문장을 보내지 않는다.
4. 트랜잭션이 교착(40P01)이나 잠금 대기 상한(55P03)으로 끝나면 `withLockRetry`(`lib/tools/lock-retry.js`)가 트랜잭션 전체를 처음부터 다시 실행한다. 상한은 `MEMENTO_DB_LOCK_RETRY_MAX`(기본 3), 대기는 25ms에서 두 배씩 늘어 400ms를 넘지 않으며 그 절반에서 상한 사이 임의 값이다. 재실행마다 `memento_db_deadlock_retries_total{operation}`이 오른다.

잠금과 쓰기를 한 문장(`WITH locked AS (... FOR NO KEY UPDATE) UPDATE ... FROM locked`)으로 합치지 않는다. 그 문장은 행을 id 순으로 잠그더라도 갱신 단계가 문장 시작 시점 스냅숏이 보는 행 버전을 다시 건드린다. 그 사이 다른 트랜잭션이 행을 갱신해 잠금 단계가 새 버전을 잠갔고, 이전 버전의 xmax가 커밋된 갱신과 살아 있는 키 공유 잠금(외래키 검사, `FOR KEY SHARE`)을 담은 multixact이면 갱신 단계는 이전 버전의 튜플 잠금을 기다린다. 같은 이전 버전의 튜플 잠금을 쥔 채 새 버전을 기다리는 다른 트랜잭션이 있으면 두 트랜잭션이 서로를 기다린다. 튜플 잠금 대기열은 행이 아니라 행 버전의 물리 위치마다 있으므로 id 순서로는 이 순환을 막을 수 없다. 쓰기를 다음 문장으로 나누면 그 문장의 스냅숏은 이미 잠근 최신 버전을 보고, 쓰기 단계는 자기 잠금만 확인하므로 어떤 잠금도 기다리지 않는다. 대기는 모두 id 순 잠금 문장 안에서만 일어난다.

|경로|진입점|잠금 문장의 대상 조건|강도|쓰기 문장|operation|
|-|-|-|-|-|-|
|접근 기록(EMA, noEma)|`FragmentWriter.incrementAccess`|`id = ANY(ids)`|NO KEY UPDATE|access_count, accessed_at, EMA|access|
|연결 파편 접근 기록|`FragmentWriter.touchLinked`|co_retrieved 이웃, 키와 workspace 범위|NO KEY UPDATE|accessed_at|touch_linked|
|임베딩 일괄 저장|`EmbeddingWorker._embedChunk`|묶음의 id|NO KEY UPDATE|embedding(VALUES 대응)|embedding|
|링크 일괄 생성의 linked_to|`LinkStore.createLinks`|쌍의 양 끝 id|NO KEY UPDATE|linked_to 합집합|link_sync|
|forget의 linked_to 정리|`FragmentWriter.delete`, `deleteMany`|linked_to에 지울 id를 가진 행|NO KEY UPDATE|linked_to 제거|unlink|
|일괄 삭제|`FragmentWriter.deleteMany`, `deleteByAgent`|id 목록(키 범위), agent_id|UPDATE|DELETE|delete|
|GC 삭제|`FragmentGC.deleteExpired`, `FragmentWriter`의 GC 경로, `ConsolidatorGC.purgeStaleReflections`|후보 CTE의 id|UPDATE|DELETE ... RETURNING|gc_delete|
|감쇠, utility 묶음|`idOrderedUpdate.updateOneBatch`|조건 + `id > 마지막 id` + LIMIT 묶음 크기|NO KEY UPDATE|호출자가 넘긴 SET|score_batch|
|활성화 확산|`SpreadingActivation` 큐 처리|`id = ANY(ids)`, 키와 workspace 범위|NO KEY UPDATE|EMA, accessed_at, access_count|activation|
|tool_feedback EMA|`MemoryRecaller.toolFeedback`|`id = ANY(fragment_ids)`, 키 범위|NO KEY UPDATE|EMA|feedback|
|case 보상 역전파|`CaseRewardBackprop.backprop`|case 증거 파편, 키 범위|NO KEY UPDATE|importance, quality_verified|case_reward|
|병합의 linked_to 교체|`MemoryConsolidator._mergeDuplicates`|linked_to에 제거 id를 가진 같은 키의 행|NO KEY UPDATE|array_replace|merge_links|
|TTL 계층 전환|`FragmentGC.transitionTTL`(5문장)|각 전환 조건|NO KEY UPDATE|ttl_tier|tier|
|EMA 감쇠|`FragmentGC.decayEmaActivation`(2문장)|미접근 기간 조건|NO KEY UPDATE|ema_activation|ema_decay|
|앵커 승격|`MemoryConsolidator._promoteAnchors`|접근 수와 중요도 조건|NO KEY UPDATE|is_anchor|anchor_promotion|
|stale 중요도 하향|`ConsolidatorGC.calibrateByFeedback`|피드백 없는 오래된 행|NO KEY UPDATE|importance|stale_importance|

한 트랜잭션에서 여러 문장을 쓰는 병합(`MemoryConsolidator`의 semantic_dedup 병합)은 첫 문장에서 두 행을 id 순으로 `FOR NO KEY UPDATE` 잠근 뒤 같은 두 행만 쓴다. 행 하나만 다루는 문장(amend의 `FOR UPDATE` 재조회와 갱신, supersede의 `valid_to` 설정, 단건 링크와 단건 `linked_to` 갱신, 분할 원본 닫기)은 기다리는 동안 다른 행 잠금을 쥐지 않으므로 순환에 들 수 없다.

남는 경우: 단건 링크 INSERT(`LinkStore.createLink`, `GraphLinker`의 co_retrieved)와 일괄 링크 INSERT(`LinkStore.createLinks`의 여러 행 INSERT)는 외래키 검사로 끝 파편들에 키 공유 잠금을 행의 순서대로 건다. 키 공유 잠금은 위 표의 NO KEY UPDATE 잠금과 충돌하지 않고 삭제의 UPDATE 잠금과만 충돌하므로, 같은 파편을 동시에 지우는 일괄 삭제와만 겹칠 수 있다. `MEMENTO_SCORE_UPDATE_BATCH=0`의 단일 UPDATE 문장 경로는 되돌림용으로 남아 있으며 id 순 잠금을 쓰지 않는다.

이 규칙은 `npm run test:db`의 `tests/db-concurrency/`가 실제 PostgreSQL에서 확인한다. `tuple-lock-cycle.test.js`는 위 순환을 세션 순서를 고정해 재현하고, `lock-order.test.js`와 `writer-mix.test.js`는 쓰기 경로를 겹쳐 실행해 서버 교착 집계가 0인지 본다. 이 레인은 실행마다 전용 데이터베이스를 만들고 지우며 `npm test`에는 포함되지 않는다.

## 재시도 정책 정리

|상황|동작|
|-|-|
|HTTP 429 (LLM provider)|`memento_llm_provider_429_total` 증가. 쿨다운은 500~2000ms 랜덤 지터와 서버 힌트 중 큰 값이며 상한 60초(`computeCooldown`). 체인 스킵 후 재진입|
|chain deadline 초과|`getRemainingChainMs(startedAt)`이 <=0이면 chain 종료. `LLM_CHAIN_TIMEOUT_MS` 기준|
|semaphore wait timeout|해당 provider 실패로 기록 후 다음 fallback. `LLM_CONCURRENCY_WAIT_MS` (기본 30000ms)|
|policy violation (hard gate)|`SymbolicPolicyViolationError` throw. 호출자가 처리. atomic 경로에서도 트랜잭션 시작 전에 throw|
|fragment_limit exceeded|`atomic` 경로에서 ROLLBACK 후 `code: "fragment_limit_exceeded"` Error throw|
|교착(40P01), 잠금 대기 상한(55P03)|잠금 문장을 앞세운 쓰기 트랜잭션 전체를 `MEMENTO_DB_LOCK_RETRY_MAX`(기본 3)까지 다시 실행. `memento_db_deadlock_retries_total{operation}` 증가와 경고 로그. 상한을 넘으면 마지막 오류를 던진다|

## 새 경로 추가 규약

1. 코드 본문에 동시성 가드를 명시적으로 작성한다. 에이전트 범위 해제(`agent_id='system'`)가 필요하면 키 scope(`WHERE key_id = $X`)를 같은 함수 안에 강제한다.
2. 본 문서 매트릭스에 행을 추가한다. 회귀 테스트 파일을 같은 PR에서 신설·등재한다.
3. deadlock·TOCTOU 가드가 의심되는 경우 통합 테스트로 박제한다(`tests/integration/<topic>-concurrency.test.js`).
4. 여러 파편 행을 쓰는 경로는 `queryWithAgentVector`의 `lock` 옵션으로 대상을 id 오름차순으로 먼저 잠그고 다음 문장에서 잠근 행만 쓴다. `operation` 이름을 `LOCK_RETRY_OPERATIONS`에 더하고 위 표에 행을 추가하며, 교착 시험을 `tests/db-concurrency/`에 등재한다.
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
|`MEMENTO_DB_LOCK_RETRY_MAX`|`3`|잠금 충돌로 끝난 여러 행 쓰기 트랜잭션의 재실행 상한. 0이면 재시도하지 않음. 0~10 밖은 3|
|`MEMENTO_SCORE_UPDATE_BATCH`|`200`|감쇠와 utility 갱신의 id 오름차순 묶음 크기. 0이면 단일 UPDATE 문장. 10000을 넘으면 10000|
|`MEMENTO_DECAY_MIN_DELTA`|`0`|감쇠량이 이 값보다 작은 행을 건너뜀(마지막 감쇠 후 24시간이 지난 행은 항상 갱신)|
|`MEMENTO_UTILITY_MIN_DELTA`|`0`|저장된 utility_score와의 차이가 이 값 이하인 행을 다시 쓰지 않음|
|`MEMENTO_METRICS_DEFAULT`|(없음)|`off`이면 prom-client 기본 프로세스 지표(CPU, 메모리 등) 수집을 생략 (테스트 환경 권장). 직접 등록한 카운터는 영향받지 않음|
