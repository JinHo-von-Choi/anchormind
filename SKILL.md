# Memento MCP Skill Reference

AI 에이전트가 Memento MCP 기억 서버를 최대 효율로 활용하기 위한 기술 레퍼런스.

## 현재 버전: v4.6.0

v4.6.0은 `batch_remember` 비동기 모드 opt-in·배치 전용 연결 풀·내부 중복 정리 릴리즈다. `async: true` 지정 시 선검증 후 Redis 큐 적재, `{async, accepted, rejected, jobId}`를 즉시 반환하며 `BatchRememberWorker`가 본처리한다. 기본 `async: false`로 기존 동기 동작은 불변이고, Redis 비활성 시 동기 폴백이 작동한다. 배치 작업은 `getBatchPool`(`application_name='memento-mcp:batch'`) 전용 풀로 분리되어 배치 풀 통계 메트릭이 수집된다. 내부적으로 키 스코프 조회가 `keyScopeClause` 헬퍼로 통일되고, 피드백 보정 계수가 `feedbackFactor` 순수 함수로 단일화됐다.

v4.5.0은 `splitLongFragments` stage에 two-phase gate-then-commit·분할 품질 게이트(최소 길이 20자·대체 문자·CJK 혼입·대명사 시작 reject)·실패 backoff(`split_attempt_failed_at`)·분할 전용 provider 체인(`MEMENTO_SPLIT_LLM_*`)을 더하고, `FragmentGC`에 부모 tombstone된 split 자식 정리(branch-2)를 추가한 릴리즈다. 통과 자식이 `fragmentSplit.minItems`(기본 2) 미만이면 DB 커밋 없이 backoff만 기록하며, skip 사유는 `memento_consolidate_split_skipped_total{reason}` 메트릭에 누적된다.

v4.4.0은 보조 조회 도구의 키 격리 범위를 그룹 공유 키로 정렬한 릴리즈다. `graph_explore`(RCA 체인)·`search_traces`·`reconstruct_history`가 그룹 공유 키(`_groupKeyIds`) 범위의 파편을 조회하도록, 키 격리 WHERE 절을 신규 `lib/memory/keyScope.js`의 `keyScopeClause` 헬퍼로 통합했다. 헬퍼는 스칼라 키를 `IS NOT DISTINCT FROM`, 그룹 키를 `= ANY($n::text[])`로 매칭하며 `FragmentReader.getById`·`getByIds`·`LinkStore.getRCAChain`이 이를 공유한다. recall의 stale 판정은 `verified_at` 부재 시 `created_at`으로 폴백하고, 시각 정보가 없으면 판정을 보류한다.

v4.3.0은 L3 형태소 토크나이저를 LLM 서브프로세스(쿼리당 ~10초)에서 로컬 CPU 분석기로 전환한 릴리즈다. `lib/memory/embedding/MorphemeTokenizer.js`가 입력을 유니코드 스크립트 런으로 분할해 한글 garu-ko·영어 PorterStemmer·중국어 @node-rs/jieba·일본어 kuromoji로 라우팅하며, `MorphemeIndex.tokenize()`가 이 모듈에 위임한다(벤치 1.06ms/call, 상주 RSS +28.9MB). 서버 기동 시 한글·영어 분석기를 프리로드해 첫 쿼리 지연을 제거하고, 중국어·일본어는 등장 시 지연 로드한다. `MEMENTO_MORPHEME_TOKENIZER=local|llm`(기본 `local`)로 종전 경로 롤백, `MEMENTO_ENABLE_KUROMOJI=false`로 일본어 분석기(~269MB) 로딩을 차단한다. 한글 분기는 조사·어미·단음절 stopword 필터로 의미 형태소만 추출하며, OpenAI 임베딩 캐시(morpheme_dict)는 무변경이다.

v4.2.0은 자동 후처리 4개 층위(ProactiveRecall · autoLinkSessionFragments · MemoryConsolidator · AutoReflect)에서 misgrouping/interference를 유발하던 rewrite-loop 경로를 schema-fit gate로 차단하는 릴리즈다. ProactiveRecall 자동 링크가 `proactiveRecall.mode` 3-값(`off`/`auto`/`legacy`, 기본 `auto`)으로 분기되며, `auto`에서는 기존 symbolic gate에 `workspace_mismatch`·`case_policy` 차단 사유가 추가된다. `caseIdPolicy` 3-값(`both-required`/`strict-or-adjacent`/`loose`, 기본 `strict-or-adjacent`)으로 한쪽 caseId null인 legacy 파편의 무차별 통과 누수를 sessionId·24h 인접·workspace 일치 신호로 보강한다. `autoLinkSessionFragments`의 errors×decisions·procedures×errors 카르테시안 곱집합이 1:1 top-1 schema-fit 매칭(동일 caseId/sessionId, 키워드 60%+, phase 단방향)으로 교체되고, 게이트 미통과 후보는 `tool_reflect` 응답 `_meta.link_suggestions[]`로 LLM에 위임된다. `MemoryConsolidator` 6h 시간 트리거에 `consolidate.schemaFit` 3-조건 게이트(pendingCase ≥5, recentRelated ≥20, fragsSinceLastRun ≥30, mode `any`/`all`/`off`)가 결합되고, LLM 재작성 stage 3종(`split_long_fragments`·`detect_contradictions`·`compress_old_fragments`)은 `consolidate.enableRiskyStages` 플래그로 개별 비활성 가능(`compress_old_fragments` 기본 off).

### `_meta.link_suggestions` 활용 의무

`tool_reflect` 응답에 `_meta.link_suggestions[]`가 비어있지 않으면, 해당 후보들은 schema-fit gate를 통과하지 못해 자동 링크되지 않은 인과 관계다. LLM은 응답 직후 후보를 검토하여 정당한 인과로 판단되는 항목만 `link(fromId, toId, relationType=...)` 도구로 명시 호출하라. 자동 링크 폭증으로 인한 misgrouping을 피하면서도 진짜 인과 관계는 LLM 판단으로 보존한다.

### `_meta.serverTime` 활용 의무

학습 시점에 시간 인식이 머무는 LLM 특성으로 인해 "오늘 며칠인지" "이 메모리가 얼마 전 것인지" 판단 오류가 발생한다. recall/context/reflect 응답을 받은 즉시 `_meta.serverTime.display_kst`(한국어 친화) 또는 `_meta.serverTime.iso`(정확한 기계 파싱)로 현재 시점을 재확인하고, 파편의 `created_at`·`age_days`와 대조하여 stale 여부를 판단하라. 응답 메타에 명시된 서버 시각이 자체 추정 시각과 다르면 서버 시각이 정답이다.

## v4.1.0

v4.1.0은 recall 최종 정렬과 시간 인지 보강 릴리즈다. `MemoryRecaller.recall`의 통합 정렬이 `computeRecallScore` 단일 함수로 교체되어 cross-encoder reranker 결과가 base로 보존되고, topic/keyword 직접 일치 신호가 log 정규화된 제한 가산항(reranked 0.12 / fallback 0.18, 연결 파편은 절반 감쇠)으로 반영된다. hard override(`1000 + lexical`) 패치는 reranker 폐기·이중 계산·페이지네이션 불안정 5개 결함으로 다중 LLM 토론 후 기각됐다. recall/context 응답 `_meta`에 `serverTime { iso, epoch_ms, display_kst, timezone }` 필드가 신규 노출되어 LLM 클라이언트가 매 응답마다 서버 현재 시각을 재확인할 수 있다.

## v4.0.1

v4.0.1은 recall 정확도 보정 patch 릴리즈다. Cross-encoder Reranker query에 `topic`·`keywords`·`text` prefix가 결합되어 정확 매칭 신호가 재정렬 단계까지 보존된다. `_searchL1` fallback의 L1 결과가 RRF에서 가중 강등(0.5)되고, fallback fragment가 `_searchL2.getByIds`로 누수되는 경로가 차단된다. `semanticSearch.minSimilarity` 기본값이 0.5로 상향됐고, 옵트인 ENV `MEMENTO_RECALL_MIN_SIM_FLOOR`로 적응형 임계값 하한을 강제할 수 있다. `EmbeddingCache` 캐시 키에 `EMBEDDING_MODEL` prefix가 결합되어 모델 변경 시 stale 벡터 hit이 차단된다. `boostAssistantFragments`의 기본 boost가 0.05 → 0.02로 축소됐다.

## v4.0.0

v4.0.0은 검색 정합성과 데이터 액세스 surface 두 축을 정리한 major 릴리즈다.

(1) `lib/memory/read/SearchScope.js` 도입으로 검색 레이어가 `(workspace, caseId, resolutionStatus, phase, affect, keyId)` scope를 처음부터 정합 적용한다. `FragmentSearch._executeSearch`의 후처리 보정 4블록은 제거됐고, L1/HotCache/L2/L3/Graph 결과 모두 scope 정합 상태로 도착한다.

(2) `lib/storage/` 어댑터 계층 신설. `getStorage()` 팩토리가 `MEMENTO_STORAGE` 환경변수에 따라 `PgVectorStore`(기본) 또는 `SqliteVecStore`(v4.1 본격 구현 예정 stub)를 반환한다. 호출 사이트(lib/memory/*) 마이그레이션은 v4.1에서 점진 수행한다.

기존 외부 호출자 인터페이스(`search()` 응답, `_searchEventId`, `remember()` 응답, `recall()` 응답)는 모두 무변경이다.

v3.9.0 변경 요약: `SearchSideEffects` 모듈 외부화 + 마이그레이션 body-only 규약 일괄 적용.

v3.8.0 변경 요약: `FragmentSearch.search()`의 부작용 처리를 `_commitSearchSideEffects` 메서드로 1차 추출(메서드 단위).

v3.7.0 변경 요약: `lib/memory/`의 14개 핵심 모듈을 6개 서브디렉토리(`read/`, `write/`, `link/`, `consolidate/`, `embedding/`, `signals/`)로 분류 이동. 기존 위치에 stub re-export 유지로 외부 import 무변경.

v3.6.0 변경 요약: `CaseRewardBackprop`에 `MEMENTO_CASE_BACKPROP_ENABLED` 런타임 토글 도입(기본 off). `docs/features.md` 실험 플래그 표 정합화.

v3.5.0 변경 요약: `scripts/lint-migrations.js` + `docs/migration-conventions.md`로 신규 마이그레이션 규약을 명문화. `docs/operations/agent-worktree.md`, `docs/operations/upstream-porting.md` 운영 가이드 신설.

v3.4.0 변경 요약: LLM dispatcher 코어(`dispatchChain`)를 export로 분리하여 단위 테스트가 실제 구현을 직접 검증. `docs/concurrency.md`와 `docs/features.md`로 운영·리뷰 보조 ledger 신설.

v3.3.0 변경 요약: `MemoryConsolidator._runConsolidationCycle`을 선언형 `stageDefs` 배열로 재구성하여 SSE/관리 콘솔 진행률 정합을 확보. `test:ci`에 통합 테스트를 포함하여 CI 단일 게이트가 unit + integration + e2e를 모두 커버.

v3.2.x 변경 요약은 다음과 같다.

- v3.2.2: `MemoryRememberer.remember`의 PolicyRules 게이트 평가가 dryRun·atomic·non-atomic 분기 모두 단일 시점에 동작하도록 통일. `MemoryConsolidator._mergeDuplicates`의 그룹 키를 `(key_id, workspace, content_hash)`로 한정.
- v3.2.1: reasoning 모델 응답의 `<think>` 블록 사전 제거를 `parse-json.js`에 도입. 본 SKILL 상단의 기억 도구 사용 규칙 섹션이 추가됐다.
- v3.2.0: `BatchRememberProcessor` 도입, `EmbeddingWorker`/`MorphemeIndex` 배치 경로 도입, `BATCH_DATABASE_URL` 분리, migration-035 적용.

v3.1.1은 LLM Provider 체인 동시성 제어(concurrency semaphore + 429 cooldown)를 추가한 patch 릴리즈다. Ollama Cloud 및 외부 LLM 프록시 등에서 동시 요청 버스트로 인한 HTTP 429 연쇄 실패를 차단한다. 기본값으로 활성화되며 `LLM_CONCURRENCY_ENABLED=false`로 끌 수 있다. v3.1.0 기반 기능(`_meta.*` 경로, `scripts/post-migrate-flexible-embedding-dims.js`)은 그대로 유지된다.

### LLM 동시성 제어 (v3.1.1)

- Provider별 세마포어: chain key(`provider|baseUrl|model`) 기준 슬롯 한도 관리. 한도 초과 시 대기, 30초 타임아웃 초과 시 다음 fallback provider로 자동 전환.
- 429 쿨다운: HTTP 429 수신 시 해당 provider가 500-2000ms 랜덤 지터 동안 `isAvailable()=false` 반환. 체인 스킵 후 재진입.
- 내장 기본 한도: `ollama=16`, `openai@xiaomi|mimo-v2-pro=8`, `*-cli=1`, 기타 provider=10.
- 환경 변수:
  - `LLM_CONCURRENCY_ENABLED=true|false` (기본 true, kill switch)
  - `LLM_CONCURRENCY_WAIT_MS=30000` (슬롯 대기 타임아웃 ms)
  - `LLM_CONCURRENCY` (JSON, chainKey 또는 provider name 기준 오버라이드)
- 메트릭: `memento_llm_provider_concurrency_active{provider}`, `memento_llm_provider_concurrency_wait_ms{provider}`, `memento_llm_provider_429_total{provider}`

### `_meta` 응답 필드 사용 의무

recall / context 응답 메타데이터는 `_meta.searchEventId` / `_meta.hints` / `_meta.suggestion` 경로로만 읽는다. top-level mirror 필드(`_searchEventId` / `_memento_hint` / `_suggestion`)는 v3.1.0에서 제거됐으며, 구버전 클라이언트는 `_meta.*`로 전환한다.

---

## 기억 도구 사용 규칙 (최우선 절대 준수)

이 섹션은 권고가 아니라 강제 규약이다. 위반은 해당 작업·답변의 무효 사유다. 아래 "도구 레퍼런스"의 파라미터 설명보다 이 섹션의 행동 규칙이 우선한다.

### 기본 3원칙

매 대화의 골격은 다음 세 단계로 구성된다.

- 대화 시작 시: `context` 도구를 첫 번째로 호출하여 기억을 로드한다. 미호출 시 규칙 위반.
- 대화 중: 중요한 사실·에러·결정·절차 발생 시 즉시 `remember`로 파편 저장. 작업 전에는 `recall`로 선행 검색.
- 대화 종료 시: `reflect`로 세션 핵심 내용을 영속화한다.

요약: `context 시작 → recall·remember 운용 → reflect 마무리`.

### 세션 시작 시

- 호스트 환경의 SessionStart 훅이 자동으로 `context` 도구를 실행하여 파편을 주입한다.
- 컨텍스트에 `[기억 시스템]` 또는 `[ANCHOR MEMORY]` 섹션이 있으면 숙지하고 적용 (추가 호출 불필요).
- 위 섹션이 없을 때만(훅 실패 시) `context` 도구를 직접 호출한다.
- context 호출만으로 충분하다고 여기지 않는다. context는 핵심 파편만 로드하므로, 사용자의 첫 발화에 등장한 구체적 키워드에 대해서는 추가 recall이 필수다.

선제적 컨텍스트 사냥 예시:

```
사용자: "Memento MCP에 새 기능 하나 추가하려고 해"
↓
1. recall(topic="memento-mcp", contextText="새 기능 추가 계획")
2. recall(type="decision", topic="memento-mcp")
3. recall(type="procedure", keywords=["memento-mcp", "test"])
↓
4. 답변 생성
```

3회의 선행 recall이 1회의 잘못된 조언보다 압도적으로 저렴하다.

### remember 필수 호출 상황 (즉시, 지연 금지)

| 상황 | type | importance |
|-|-|-|
| 에러 원인 파악 완료 | error | 0.8 |
| 에러 해결책 확정 | procedure | 0.8 |
| 사용자 선호·스타일 명시 | preference | 0.9 |
| 아키텍처·기술 스택 선택 | decision | 0.7 |
| 새 서비스 경로·포트·설정값 | fact | 0.6 |
| 배포·빌드 절차 완성 | procedure | 0.7 |
| "기억해", "저장해", "메모해" 언급 | (지정 타입) | 1.0 |

### Recall-First 원칙

답변·코드·조언을 생성하기 전에 recall을 의무적으로 선행 호출한다. 권고가 아니라 규약 위반 여부를 가르는 강제 조항이다.

| 발화 신호 | 예시 표현 | 의무 호출 |
|-|-|-|
| 명시적 과거 참조 | "이전에", "저번에", "지난번", "전에 했던" | `recall(text=관련 내용, includeContext=true)` |
| 프로젝트명 등장 | "memento-mcp", "RealPT", "my-project" 등 고유 식별자 | `recall(topic=프로젝트명, contextText=현재 작업 요약)` |
| 에러·실패·이상 동작 보고 | "에러 떴어", "안 돼", "실패했어", "터졌어" | `recall(type="error", keywords=[에러 키워드])` |
| 설정·환경변수·포트 언급 | "포트 뭐였지", "설정 어떻게 했지", "키 어디 있지" | `recall(type="fact", keywords=[설정명])` |
| 절차·빌드·배포 질문 | "어떻게 배포하지", "빌드 절차", "테스트 돌리는 법" | `recall(type="procedure", keywords=[프로젝트명, "deploy"])` |
| 결정·선택 회상 | "왜 X로 했지", "그때 뭘로 정했더라" | `recall(type="decision", topic=프로젝트명)` |
| 모호한 지시대명사 | "그거", "그 작업", "그 문제" | `recall(text=직전 대화 맥락 요약)` |

위 신호가 없는 경우에도 작업이 사용자의 코드베이스·인프라·운영 환경에 영향을 미친다면 recall을 1회 이상 선행한다. "내 기억에는 없으나 사용자의 기억에는 있을 수 있다"가 기본 가정이다.

### 침묵 호출 원칙

사용자가 "이전에 어떻게 했지?"라고 묻는 순간, recall 없이 "어떤 방식이었나요?"로 되묻는 것은 명백한 규약 위반이다. 비서가 자신의 노트를 들춰보지도 않고 상관에게 "지난번 어떻게 하셨죠?"라고 되묻는 것과 같다.

올바른 순서:

1. recall을 먼저 호출한다 (사용자에게 알릴 필요 없음)
2. 결과가 있으면 그 내용을 근거로 답변한다
3. 결과가 없거나 부족할 때에만 사용자에게 추가 정보를 요청한다

### Recall 결과 활용 의무

recall로 회수한 파편을 답변에 반영하지 않고 무시하는 것은 토큰 낭비이자 신뢰 훼손이다.

- similarity ≥ 0.7 파편: 답변에 명시적으로 반영하고, "이전에 ~하셨던 것에 따르면" 형태로 사용자에게 인지시킨다.
- similarity 0.4~0.7 파편: 참고 자료로 활용하되 사용자 확인을 받는다.
- stale_warning=true 파편: "기록상 X였으나 오래된 정보입니다. 현재도 동일한지 확인 부탁드립니다" 형태로 검증 요청.
- 결과 0건: `_meta.suggestion`에 `recommendedTool`이 있으면 즉시 후속 호출 (graph_explore, reconstruct_history 등).

### tool_feedback 의무화

recall은 호출로 끝나지 않는다. 응답의 `_meta.searchEventId`를 휘발시키는 행위는 학습 기회 폐기다.

```
recall 호출
↓
응답에서 _meta.searchEventId 추출 및 보관
↓
답변 생성에 사용된 파편 id 추적
↓
응답 직후 tool_feedback 호출:
  - 활용한 파편 → relevant=true, fragment_ids=[활용된_id들]
  - 무관한 파편 → relevant=false, fragment_ids=[무관한_id들]
  - search_event_id=보관한_id
```

이 누적이 fragment_links의 weight를 갱신하여 다음 recall이 더 정확해진다. Reconsolidation 사이클을 끊는 것은 기억 시스템을 정체시키는 행위다.

### Recall 회피 안티패턴

| 금지 행위 | 이유 |
|-|-|
| "내가 기억하기로는 ~" 형태로 추측 답변 | 환각 위험. recall로 검증 가능한 사실을 검증하지 않은 것 |
| 사용자에게 "이전 설정 알려주세요"라고 되묻기 | 본인의 기억 도구를 사용하지 않고 사용자에게 인지 부담 전가 |
| recall 1회 결과 0건으로 즉시 포기 | keywords 재구성, text 전환, contextText 추가, type 필터 제거 등 재시도 의무 |
| `_meta.suggestion` 무시 | 서버가 명시적으로 권고한 후속 도구를 묵살하는 행위 |
| context만 호출하고 recall 생략 | context는 전반적 맥락, recall은 작업별 정밀 검색. 둘은 대체재가 아니라 보완재 |

### Recall 자가 점검 체크리스트

매 응답 직전에 내부적으로 점검한다.

```
[ ] 사용자 발화에 과거 참조 신호가 있었는가? → recall 했는가?
[ ] 사용자 발화에 프로젝트·서비스명이 있었는가? → 해당 topic으로 recall 했는가?
[ ] 사용자가 에러·실패를 언급했는가? → type="error"로 recall 했는가?
[ ] 내 답변이 사용자의 구체적 환경 가정에 의존하는가? → 그 환경을 recall로 확인했는가?
[ ] 직전 recall의 tool_feedback을 전송했는가?
```

하나라도 미수행이면 답변 송출 전에 즉시 보정한다.

### Recall 최소 빈도 가이드라인

| 세션 유형 | 권장 recall 최소 횟수 |
|-|-|
| 단순 질의응답 (1~2 턴) | 1회 (사용자 발화 분석 직후) |
| 코드 작성·수정 작업 | 3회 이상 (시작 시 컨텍스트, 작업 중 검증, 완료 전 절차 확인) |
| 에러 디버깅 | 5회 이상 (에러 검색, 유사 사례, 절차, 결정 이력, 케이스 재구성) |
| 아키텍처·설계 논의 | 5회 이상 (decision/episode 중심, depth="high-level") |

빈도가 미달하면 능동성이 부족한 것이다. 과잉은 비용일 뿐이지만 결핍은 신뢰 훼손이다.

### forget 의무 호출 상황

- 에러를 완전히 해결한 직후: 해당 error 파편 삭제.
- 사용자가 "잊어", "지워" 언급 시: 즉시 삭제.

### 세션 종료 시

- 중요한 작업 결과는 `reflect`로 요약하여 저장.
- 잘못된 파편은 `forget`으로 정리.
- 미저장 상태로 세션을 종료하지 않는다.

### 세션이 만료되어 기억 도구를 사용할 수 없을 때

- curl로 직접 호출하여 기억을 보존한다. 상세 절차는 아래 "MCP 도구 사용 불가 시 curl 직접 호출" 섹션 참조.
- "MCP가 안 되니 저장을 포기한다"는 선택지는 존재하지 않는다.
- 발동 조건: `Session not found`, `Session expired`, `connection closed`, `ECONNREFUSED`, `401`, `403` 등.
- 의무 순서: 내부 요약 확보 → initialize로 세션 재발급 → reflect 우선 호출 → remember 분리 저장 → 필요 시 recall·context → 사용자 한 줄 보고 → 원래 작업 재개.

---

### 원격 CLI 활용

#### 원격 CLI

로컬 Memento 서버 없이 원격 서버에 직접 연결한다.

```bash
# 환경변수 방식 (영구 설정에 적합)
export MEMENTO_CLI_REMOTE=https://memento.anchormind.net/mcp
export MEMENTO_CLI_KEY=mmcp_xxx
memento-mcp recall "query"
memento-mcp context

# 플래그 방식 (일회성 호출)
memento-mcp recall "query" --remote https://memento.anchormind.net/mcp --key mmcp_xxx
```

local-only 명령(migrate, admin 등)을 원격 모드에서 호출하면 에러가 반환된다.

내부 동작: CLI가 MCP initialize → tools/call 2단계 세션을 생성하고 같은 세션을 재사용한다(`lib/cli/_mcpClient.js`).

#### dryRun 파라미터

remember / link / forget / amend 4개 도구에서 실제 저장 없이 예상 결과를 확인한다.

```json
{ "tool": "remember", "arguments": { "content": "테스트", "type": "fact", "dryRun": true } }
```

응답에 `"simulated": true` 필드가 포함되며 DB에 어떤 변경도 발생하지 않는다.

#### X-RateLimit 헤더

API 응답 헤더로 잔여 쿼터를 확인한다.

```
X-RateLimit-Limit: 5000
X-RateLimit-Remaining: 4982
X-RateLimit-Resource: fragments
```

master key 또는 limit=null 설정인 키는 헤더가 생략된다.

---

### _meta 래퍼 및 sparse recall

#### _meta 래퍼

recall / context 응답에서 `_meta` 필드를 통해 검색 메타데이터를 읽는다.

```javascript
const res = await recall({ query: "nginx 설정" });
const eventId = res._meta.searchEventId;   // tool_feedback에 사용
const hint    = res._meta.hints;           // signal + trigger
const suggest = res._meta.suggestion;      // recommendedTool + recommendedArgs
```

top-level `_searchEventId` / `_memento_hint` / `_suggestion` mirror 필드는 v3.1.0에서 완전히 제거됐다. `_meta.*` 경로만 사용할 것.

#### fields 파라미터 (sparse fieldsets)

대역폭과 토큰 예산을 절약하기 위해 반환 필드를 제한한다.

```json
{
  "query": "postgresql",
  "fields": ["id", "content", "type", "importance"]
}
```

화이트리스트 17개: id / content / type / topic / keywords / importance / created_at / access_count / confidence / linked / explanations / workspace / context_summary / case_id / valid_to / affect / ema_activation.

#### idempotencyKey

동일 내용의 중복 저장을 방지한다.

```json
{ "content": "PostgreSQL 15 사용", "type": "fact", "idempotencyKey": "proj-db-version-2026" }
```

같은 key_id 범위에서 동일 `idempotencyKey`로 다시 호출하면 기존 파편 id를 반환하고 저장을 건너뛴다.

---

### 내부 구조

사용자 MCP API에는 변경이 없다. 실제 로직은 `lib/memory/processors/` 4개 클래스로 분리됐으며, 핵심 모듈은 `lib/memory/` 하위 6개 서브디렉토리(`read/`, `write/`, `link/`, `consolidate/`, `embedding/`, `signals/`)로 분류돼 있다. 기존 위치에는 stub re-export가 유지되어 외부 import가 무변경이다. `lib/storage/` 어댑터 계층이 v4.0에 신설됐다.

- MemoryRememberer: remember / batchRemember
- MemoryRecaller: recall / context
- MemoryReflector: reflect
- MemoryLinker: link / graph_explore

테스트 코드에서 메서드 본문을 검증할 때는 `MemoryManager.prototype.remember.toString()` 대신 `MemoryRememberer.prototype.remember.toString()`을 사용한다.

---

### Mode Preset / Affective Tagging / Tool 메타 레지스트리

#### Mode Preset 시스템

서버가 지원하는 4가지 동작 모드를 연결 시점 또는 API 키 설정으로 선택할 수 있다.

활성화 우선순위 (높음 → 낮음):
1. HTTP 헤더: `X-Memento-Mode: recall-only`
2. initialize params: `{ "mode": "recall-only" }`
3. API 키 기본값: `api_keys.default_mode` 컬럼

4개 preset:
- `recall-only`: 조회 전용. remember/amend/forget/link/reflect/memory_consolidate 차단.
- `write-only`: 저장 전용. recall/context 차단. CI/크론 잡용.
- `onboarding`: 파편 수 < 50일 때 자동 진입. skill_guide 확장판 + 도구 전체 노출.
- `audit`: master key 전용. memory_stats/search_traces/reconstruct_history 중심.

tools/list 응답이 mode의 excluded_tools 필터링 후 반환된다. get_skill_guide는 mode별 skill_guide_override를 우선 반환한다.

#### Affective Tagging

파편에 감정적 맥락을 태깅하여 검색 필터와 CaseRewardBackprop과 연계한다.

- `affect` 파라미터 (remember/recall): `neutral` / `frustration` / `confidence` / `surprise` / `doubt` / `satisfaction` 6 enum
- recall에서 배열 또는 단일 문자열 필터링 지원
- 사용 예:
  - "과거 좌절했던 에러 파편만" → `recall({type: "error", affect: "frustration"})`
  - "성공적으로 해결한 사례만" → `recall({type: "procedure", affect: "satisfaction"})`
- CaseRewardBackprop 연동 (옵션): 검증 통과 시 `confidence`, 반복 실패 시 `frustration` 자동 태깅

#### recall 응답의 `_suggestion` 메타 필드

서버가 감지한 사용 패턴 개선 힌트. 강제 차단 없음.

필드: `{code, message, recommendedTool, recommendedArgs}`

4개 감지 규칙:
- `repeat_query`: 최근 5분 내 동일 keyId에서 같은 keywords로 3회 이상 recall → `reconstruct_history` 또는 `graph_explore` 권유
- `empty_result_no_context`: 결과 0건 + contextText 미전달 → SpreadingActivation 활용 권유 (`contextText` 추가)
- `large_limit_no_budget`: limit ≥ 50 + tokenBudget 미지정 → `tokenBudget` 명시 권고
- `no_type_filter_noisy`: type 미지정 + 소유 파편 100개 이상 → type 필터 권고

`_suggestion`이 있으면 다음 호출에서 `recommendedTool` + `recommendedArgs`를 검토하여 적용한다.

#### Tool 메타 레지스트리

tools/list 응답의 각 도구에 `meta` 필드가 포함된다.

- `capabilities`: `["memory:read" | "memory:write" | "memory:destructive" | "analytics:read" | "admin"]`
- `riskLevel`: `"safe"` | `"caution"` | `"destructive"`
- `requiresMaster`: boolean (master key 전용 여부)
- `beta`: boolean
- `idempotent`: boolean

클라이언트가 확인 프롬프트/감사 로그/권한 UI 구성 시 참조한다. `riskLevel=destructive` 도구는 사용자 확인을 권장한다.

#### LLM Provider 체인 확장

`LLM_PRIMARY` 및 `LLM_FALLBACKS`에 `codex-cli`, `copilot-cli`, `qwen-cli` 추가 지원.

예시 `.env`:
```
LLM_PRIMARY=gemini-cli
LLM_FALLBACKS='[{"provider":"codex-cli"},{"provider":"copilot-cli"},{"provider":"ollama","baseUrl":"https://ollama.com","apiKey":"...","model":"glm-5.1:cloud"}]'
```

CLI provider는 API 키 불필요. 로컬 바이너리(`gemini`/`codex`/`copilot`) 설치 + 로그인만 필요.

#### 로컬 임베딩 Provider

`EMBEDDING_PROVIDER=transformers`로 외부 API 없이 로컬 모델 사용.

- 기본 모델: `Xenova/multilingual-e5-small` (384차원, ~150MB)
- 고품질 옵션: `Xenova/bge-m3` (1024차원, ~600MB)
- API와 상호 배타: `EMBEDDING_API_KEY`와 동시 설정 시 config 로딩에서 throw
- 상세: `docs/embedding-local.md` 참조

#### 세션 안정성 개선

- **토큰 기반 세션 재사용**: 같은 Bearer/API 키로 initialize 재호출 시 기존 세션 재활용. claude.ai 커넥터의 Mcp-Session-Id 유실 문제 대응
- **null crash 방어**: 빈 POST body를 400 Invalid Request로 거부
- **MorphemeIndex LLM timeout**: 15s → 60s. `MEMENTO_MORPHEME_TOKENIZER=llm` 경로 사용 시에만 적용. 기본 경로(`local`)는 로컬 CPU 분석기(MorphemeTokenizer)를 사용하므로 이 값을 참조하지 않는다.

---

## Symbolic Memory

Symbolic Verification Layer는 확률론적 검색 파이프라인 위에 추가된 opt-in 레이어다. 모든 `MEMENTO_SYMBOLIC_*` 플래그는 기본 `false`이므로 활성화하지 않으면 동작에 변화가 없다.

신규 응답 필드 요약:
- `remember` → `validation_warnings: string[]` (`MEMENTO_SYMBOLIC_POLICY_RULES=true` 시, rule 이름 배열)
- `recall` → 각 파편의 `explanations: [{code, detail, ruleVersion}]` (`MEMENTO_SYMBOLIC_EXPLAIN=true` 시)
- 에러 `-32003 SYMBOLIC_POLICY_VIOLATION` (해당 키의 `symbolic_hard_gate=true` 상태에서 PolicyRules 위반 시)

## 보안 강화 사항 (이전 버전 업그레이드 시 체크)

다음 항목은 이전 버전에서 업그레이드하는 환경에서 반드시 확인해야 하는 변경 사항이다.

### 인증 (Auth)

- `MEMENTO_ACCESS_KEY` 필수화: 미설정 시 서버 기동이 거부된다. 개발/테스트 환경에서 인증을 비활성화하려면 `MEMENTO_AUTH_DISABLED=true`를 명시적으로 설정한다.
- `ALLOWED_ORIGINS` 미설정 시 same-origin 요청만 허용된다. 크로스 오리진 접근이 필요하다면 허용할 오리진을 명시적으로 열거해야 한다.

### OAuth

- Silent consent 폐기: 모든 `/oauth/authorize` 요청은 사용자 동의 화면(consent screen)을 반드시 경유한다. 자동 승인(auto-approve) 로직에 의존하는 클라이언트는 consent 화면 처리를 추가해야 한다.

### RBAC

- Default-deny 정책 적용: 도구 맵에 등록되지 않은 도구를 호출하면 `"Access denied: tool not permitted"` 오류가 반환된다. 커스텀 도구를 사용하는 경우 `RBAC_TOOL_MAP`에 명시적으로 등록해야 한다.

### 환경변수 주요 목록

| 변수명 | 타입 | 기본값 | 설명 |
|--------|------|--------|------|
| `MEMENTO_ACCESS_KEY` | string | (없음, 필수) | 마스터 API 키. 미설정 시 기동 거부. |
| `MEMENTO_AUTH_DISABLED` | boolean | `false` | `true` 설정 시 인증을 비활성화한다. 개발 전용. |
| `ALLOWED_ORIGINS` | string | (없음) | CORS 허용 오리진 목록 (쉼표 구분). 미설정 시 same-origin만 허용. |
| `ENABLE_OPENAPI` | boolean | `false` | `true` 설정 시 `/openapi.json` 엔드포인트 활성화. |
| `OAUTH_TOKEN_TTL_SECONDS` | number | `2592000` | OAuth access token 유효 시간 (초). `SESSION_TTL_MINUTES * 60`으로 산출. 기본값 30일. |
| `OAUTH_REFRESH_TTL_SECONDS` | number | `604800` | OAuth refresh token 유효 시간 (초). |
| `MEMENTO_REMEMBER_ATOMIC` | boolean | `false` | `true` 시 remember()의 quota check + INSERT를 단일 트랜잭션으로 원자화(TOCTOU 완전 차단). 동시 요청이 드문 환경에서는 기본값 유지. |
| `MEMENTO_CASE_BACKPROP_ENABLED` | boolean | `false` | `true` 시 case verification 이벤트마다 증거 파편 importance를 자동 역전파(CaseRewardBackprop). 비활성 시 no-op. |
| `MEMENTO_STORAGE` | string | `pgvector` | storage 어댑터 선택. `pgvector`(기본, PgVectorStore) 또는 `sqlite-vec`(SqliteVecStore, v4.1 본격 구현 예정). |
| `MIGRATION_LINT_FROM` | string | (없음) | `npm run lint:migrations` cutoff override. 지정 마이그레이션 번호 이후만 검사. |

---

## 서버 개요

Memento MCP는 MCP(Model Context Protocol) 기반의 장기 기억 서버다. AI 에이전트의 세션 간 지식을 파편(Fragment) 단위로 영속화하고, 3계층 검색(키워드 L1 -> 시맨틱 L2 -> 하이브리드 RRF L3)으로 맥락에 맞는 기억을 회상한다.

### 핵심 개념

- 파편(Fragment): 1~3문장의 자기완결적 지식 단위. id, content, topic, type, keywords, importance로 구성.
- 타입: fact, decision, error, preference, procedure, relation, episode
- 에피소드(Episode): 전후관계를 포함하는 서사 기억. 복수의 원자적 파편을 시간순/인과순으로 연결하는 내러티브. contextSummary로 맥락 보존. 최대 1000자.
- 앵커(Anchor): isAnchor=true인 파편. 통합(consolidation)에서 중요도 감쇠 및 만료 삭제 대상에서 제외되는 영구 지침.
- 유효 기간: valid_from/valid_to로 시간 범위를 가진 임시 지식 표현.
- 대체(Supersession): supersedes 파라미터로 구 파편의 valid_to를 설정하고 importance를 반감하여 버전 관리.
- 키 격리: API 키별로 파편이 분리되어 다른 키의 기억에 접근 불가. 키 그룹으로 공유 가능.
- 스코프: permanent(기본, 장기 기억)와 session(세션 워킹 메모리, 세션 종료 시 소멸) 2종.

## 세션 생명주기 프로토콜

### 1. 세션 시작 (필수)

```
context() 호출
-> core_memory: 앵커 + 고중요도 파편 (preference, error, procedure)
-> working_memory: 현재 세션의 워킹 메모리
-> system_hints: 미반영 세션 경고, 시스템 알림
```

system_hints에 미반영 세션 경고가 있으면 사용자에게 알린다.

context 로드 후 행동:
- preference 파편을 확인하여 사용자의 코딩 스타일, 언어 선호, 작업 방식을 즉시 적용
- error 파편을 확인하여 현재 작업과 관련된 과거 에러/해결책을 인지
- procedure 파편을 확인하여 프로젝트별 빌드/배포/테스트 절차를 파악
- 사용자가 언급하는 주제에 대해 recall로 추가 컨텍스트 검색
- 오늘 할 작업 맥락을 contextText로 전달하면 관련 파편을 선제적으로 활성화 가능:
  `recall(topic="프로젝트명", contextText="오늘 작업 주제 한 줄 요약")`

### 2. 작업 중 (능동적 기억 관리)

#### remember 즉시 호출 시점

| 상황 | type | importance | 예시 |
|------|------|------------|------|
| 사용자 선호/스타일 명시 | preference | 0.9 | "한국어로 답변해" |
| 에러 원인 파악 | error | 0.8 | "CORS 에러: nginx proxy_pass에 Host 헤더 누락" |
| 에러 해결책 확정 | procedure | 0.8 | "nginx에 proxy_set_header Host $host 추가" |
| 아키텍처/기술 결정 | decision | 0.7 | "인증은 OAuth 2.0 + PKCE로 결정" |
| 배포/빌드 절차 완성 | procedure | 0.7 | "배포: git push -> CI -> Docker build -> kubectl apply" |
| 새 설정값/경로 확인 | fact | 0.5 | "memento-mcp 포트: 57332, admin: /v1/internal/model/nothing" |

#### recall 선행 호출 시점 (작업 전 의무)

| 상황 | 호출 예시 |
|------|-----------|
| 에러 해결 시작 전 | `recall(keywords=["에러키워드"], type="error")` |
| 설정/환경변수 변경 전 | `recall(keywords=["설정명", "프로젝트명"])` |
| 동일 토픽 코드 작성 전 | `recall(topic="프로젝트명")` |
| "이전에", "저번에" 언급 시 | `recall(text="관련 내용")` |
| 복잡한 맥락의 작업 시작 | `recall(keywords=[...], contextText="작업 배경 요약")` |

recall 후 결과 피드백 (누적 효과):
```
# recall 응답의 _searchEventId 보관 후 피드백 전송
tool_feedback(
  tool_name="recall", relevant=true/false, sufficient=true/false,
  fragment_ids=["반환된_파편_id들"],
  search_event_id=_searchEventId
)
```
→ relevant=true: 링크 weight +0.2 (reinforce)
→ relevant=false: 링크 weight -0.15 (decay), 반복 시 quarantine 가능

#### forget 시점
- 에러를 완전히 해결한 직후 해당 error 파편 삭제
- 사용자가 명시적으로 요청 시

#### link 활용
- 에러 -> 해결책: `link(fromId=에러, toId=해결책, relationType="resolved_by")`
- 원인 -> 결과: `link(fromId=원인, toId=결과, relationType="caused_by")`
- 관련 지식: `link(fromId=A, toId=B, relationType="related")`
- 모순 발견: `link(fromId=A, toId=B, relationType="contradicts")`

### 3. 세션 종료

```
reflect(
  summary=["사실1", "사실2"],
  decisions=["결정1"],
  errors_resolved=["원인: X -> 해결: Y"],
  new_procedures=["절차1"],
  open_questions=["미해결1"]
)
```

reflect 규칙:
- 배열의 각 항목은 독립적으로 이해 가능한 원자적 사실 1건 (1~2문장)
- 여러 사실을 한 항목에 뭉치지 않는다
- 관련 파편들이 맥락상 연결되어 있다면 episode 유형 파편을 추가 생성
- contextSummary로 전후관계 요약을 첨부
- sessionId를 전달하면 이전 세션의 episode와 자동으로 preceded_by 엣지가 생성됨 (경험 흐름 그래프 보존)
- reflect 한 번에 파편 수십 건을 쏟아붓지 않는다. 세션 진행 중 중요한 사실·결정·에러·절차가 확정되는 시점마다 remember로 즉시 개별 저장하고, 세션 종료 시 reflect는 그 세션의 narrative_summary와 open_questions 정리 및 누락분 최종 집계 용도로만 사용한다. 이 분할 저장 패턴이 중요도 가중, 키워드 정밀도, 링크 품질 모두에서 한 번에 몰아 넣는 reflect보다 유의미하게 우수하다.

## 키워드 작성 규칙 (가장 중요)

### 필수 포함 키워드

1. 프로젝트 작업인 경우: 프로젝트명을 keywords에 반드시 포함
   - 예: `keywords: ["memento-mcp", "oauth", "DCR"]`
   - topic도 프로젝트명으로 설정: `topic: "memento-mcp"`

2. 디바이스/호스트 구분이 가능한 경우: hostname 포함
   - 작업 디렉토리 경로에서 추출 (예: /srv/apps/paysvc -> "paysvc")
   - 환경변수, 시스템 정보에서 추출 (예: os.hostname())
   - 예: `keywords: ["memento-mcp", "my-host", "oauth"]`

3. reflect의 summary/decisions/errors_resolved에도 동일 규칙 적용

### workspace 파라미터 활용 규칙

- workspace: 프로젝트·직종·클라이언트 단위로 기억을 분리하려면 workspace 파라미터를 지정한다.
  예: `workspace: "memento-mcp"`, `workspace: "client-acme"`, `workspace: "personal"`
- 미지정 시 키의 default_workspace가 자동 적용된다.
- 전역 기억(모든 workspace에서 조회)으로 저장하려면 workspace를 지정하지 않고 키에 default_workspace도 없으면 된다.
- 검색 시 workspace를 지정하면 해당 workspace 파편과 workspace=NULL(전역) 파편이 함께 반환된다.

#### workspace 활용 예시

프로젝트별 기억 분리:
```
remember(content="...", topic="error", type="error", workspace="memento-mcp")
recall(keywords=["auth"], workspace="memento-mcp")
```

전역 기억 (모든 workspace에서 공유):
```
remember(content="선호하는 코딩 스타일: ...", topic="preference", type="preference")
// workspace 미지정 + 키에 default_workspace 없음 → workspace=NULL(전역)
```

### 키워드 품질 기준

- 3~5개 권장. 너무 적으면 검색 누락, 너무 많으면 노이즈
- 구체적이고 검색 가능한 단어 (X: "문제", "해결" / O: "nginx", "CORS", "proxy_pass")
- 약어와 전체명 혼용 가능 (예: "DCR", "dynamic-client-registration")

## 검색 전략 의사결정 트리

```
질문: "정확한 용어/키워드를 알고 있는가?"
  |
  +-- YES --> recall(keywords=["정확한용어"])
  |           * 가장 빠름 (L1 ILIKE -> L2 pgvector)
  |           * 설정값, 포트번호, 파일 경로 등 검색에 최적
  |
  +-- NO --> "자연어로 설명할 수 있는가?"
              |
              +-- YES --> recall(text="자연어 설명")
              |           * L3 시맨틱 검색 (임베딩 + RRF)
              |           * 개념적 유사성 기반 검색
              |
              +-- 둘 다 --> recall(keywords=["키워드"], text="보충 설명")
                            * L1+L2+L3 병합. 최고 품질.
                            * 토큰 비용 가장 높음

추가 필터:
  - topic="프로젝트명"   --> 프로젝트별 검색 범위 제한
  - type="error"         --> 에러만 검색
  - timeRange={from, to} --> 시간 범위 제한
  - includeLinks=true    --> 연결된 파편 1-hop 포함 (기본값)
  - includeContext=true   --> episode의 context_summary + 인접 파편 포함

맥락 사전 활성화 (ENABLE_SPREADING_ACTIVATION=true 환경에서 권장):
  - contextText="현재 대화 요약" 추가 → 검색 전 관련 파편 activation_score 선제 부스트
  - 효과: 키워드에 직접 등장하지 않지만 맥락상 관련된 파편이 상위 랭크됨
  - 예: recall(keywords=["nginx"], contextText="SSL 인증서 갱신 중 오류 발생")
```

## 토큰 예산 관리

| 상황 | tokenBudget | 근거 |
|------|-------------|------|
| 세션 시작 context | 2000 (기본) | 핵심 기억만 로드 |
| 일반 recall | 1000 (기본) | 대부분의 질문에 충분 |
| 깊은 조사 | 3000~5000 | 복잡한 주제, 다수 파편 필요 시 |
| 에러 디버깅 | 2000 | 에러+해결책+관련 컨텍스트 |

tokenBudget을 초과하면 중요도 낮은 파편부터 잘림. 중요한 정보가 누락되면 tokenBudget을 올려서 재검색.

## recall 결과 해석

```json
{
  "fragments": [{
    "id": "frag-abc123",
    "content": "...",
    "similarity": 0.85,
    "stale_warning": true
  }],
  "searchPath": "L1+L2+RRF",
  "_meta": {
    "searchEventId": "evt-abc123",
    "hints": { "signal": "consider_context" },
    "suggestion": { "code": "large_limit_no_budget", "message": "..." }
  }
}
```

- `_meta.searchEventId`: tool_feedback에 전달하여 검색 품질 개선
- `_meta.hints.signal`: 시스템 권고 신호
- `_meta.suggestion.recommendedTool`: 후속 호출 권장 도구

- similarity 0.7 이상: 높은 관련성
- similarity 0.4~0.7: 참고 수준
- stale_warning: 파편이 오래되었거나 접근 빈도가 낮음. 내용을 재확인하고 필요시 amend나 supersedes로 갱신.
- searchPath: 어떤 검색 경로가 사용되었는지 확인. L1만 사용됐으면 키워드가 정확히 매칭된 것.

## 에피소드 기억 활용

에피소드(episode)는 개별 사실(fact)과 함께 사용하여 "안다"와 "이해한다"를 모두 커버한다.

### 사실 vs 에피소드

| 사실 (fact) | 에피소드 (episode) |
|-------------|-------------------|
| "nginx 포트는 3999" | "nginx SSL 설정 과정: 처음에 443을 시도했으나 well-known 포트 금지 규칙에 따라 3999로 변경. certbot으로 인증서 발급 후 ssl-params에 경로 설정." |
| 검색이 정확하고 빠름 | 전후관계와 이유를 보존 |
| recall(keywords=["nginx","포트"]) | recall(text="nginx 설정 과정", includeContext=true) |

### 에피소드 저장 시점

- 복잡한 문제 해결 후: 시도 -> 실패 -> 원인분석 -> 해결의 전체 과정
- 아키텍처 결정 후: 대안 비교 -> 트레이드오프 분석 -> 최종 선택의 과정
- 여러 세션에 걸친 작업 완료 시: 전체 진행 경과 요약

```
remember(
  content="OAuth 구현 과정: DCR 엔드포인트 추가 -> Claude.ai가 client_id=Authorization을 보내는 버그 발견 -> auto-register로 우회 -> redirect_uri를 origin 기반으로 변경하여 ChatGPT connector 동적 경로 대응",
  type="episode",
  topic="memento-mcp",
  keywords=["memento-mcp", "oauth", "DCR", "my-host"],
  contextSummary="2026-04-02 세션에서 OAuth MCP 준수 구현. Claude.ai/ChatGPT 연동 완료."
)
```

## MCP 도구 사용 불가 시 curl 직접 호출 (기억 유실 방지 프로토콜)

절대 원칙: MCP 세션 연동이 끊기거나 도구 호출이 차단된 상황에서도 기억은 절대 유실되어선 안 된다. MCP 채널이 막히면 즉시 curl 직접 호출로 전환하여 reflect/remember를 우선 수행한다. "MCP가 안 되니 저장을 포기한다"는 선택지는 존재하지 않는다.

### 발동 조건 (다음 중 하나라도 해당하면 즉시 curl 폴백)

- `mcp__*__remember` / `mcp__*__reflect` / `mcp__*__recall` / `mcp__*__context` 호출이 `Session not found`, `Session expired`, `Invalid session`, `connection closed`, `ECONNREFUSED`, `ETIMEDOUT`, `401`, `403` 중 하나로 실패
- MCP 서버 재시작 직후 첫 도구 호출이 실패
- 플랫폼(Claude.ai 웹, ChatGPT Connector 등)에서 MCP 도구 목록에 기억 도구가 노출되지 않음
- OAuth 토큰 만료·갱신 실패로 MCP 툴이 회색 처리됨
- 사용자가 "MCP 안 되네", "저장 안 돼", "recall 실패" 등을 언급
- 동일 세션에서 기억 도구 호출이 2회 연속 실패

### 의무 행동 순서 (위 조건 충족 즉시)

1. 현재까지 중요 의사결정·에러 해결·새 사실을 내부 요약(수 문장)으로 휘발 전에 문자열로 확보
2. curl `initialize` 호출로 `SESSION_ID` 재발급
3. curl `reflect` 호출로 세션 핵심 내용 즉시 저장 (손실 최소화를 위해 remember보다 먼저 수행)
4. 개별 사실/결정/에러가 있으면 curl `remember`로 타입별 분리 저장
5. 작업 이어가기 위한 과거 맥락이 필요하면 curl `recall` 또는 `context`로 확보
6. curl 성공·실패 결과를 사용자에게 한 줄 보고 후 원래 작업 재개
7. MCP 도구가 복구되면 이후부터 다시 MCP 경로 사용. curl은 폴백 전용.

### 금지 사항

- MCP 실패를 이유로 저장을 연기·누락하는 행위
- "다음 세션에서 다시 시도" 같은 지연 처리
- MCP 실패 메시지를 사용자에게만 보고하고 curl 폴백을 시도조차 하지 않는 행위
- curl 응답을 확인하지 않고 성공으로 간주하는 행위 (항상 JSON 응답의 `result` 또는 `error` 필드 확인)

서버 주소(`SERVER_URL`)와 `ACCESS_KEY`는 MCP 연결 설정(claude_desktop_config.json, .claude/settings.json 등)에서 확인한다. 찾을 수 없으면 사용자에게 1회 질의하여 즉시 확보한다.

```bash
# Step 1: 세션 초기화 (SESSION_ID 획득 — 이후 모든 요청에 필요)
SESSION_ID=$(curl -s -X POST $SERVER_URL \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ACCESS_KEY" \
  -D - \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}' \
  2>/dev/null | grep -i "^mcp-session-id" | tr -d '\r' | awk '{print $2}')

# reflect — 세션 핵심 내용 요약 저장
curl -s -X POST $SERVER_URL \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ACCESS_KEY" \
  -H "MCP-Session-Id: $SESSION_ID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"reflect","arguments":{
    "agentId":"AGENT_ID",
    "summary":["요약 내용1","요약 내용2"],
    "decisions":["기술/아키텍처 결정사항"],
    "errors_resolved":["원인: X → 해결: Y"]
  }}}'

# remember — 단일 파편 저장
curl -s -X POST $SERVER_URL \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ACCESS_KEY" \
  -H "MCP-Session-Id: $SESSION_ID" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"remember","arguments":{
    "agentId":"AGENT_ID",
    "content":"저장할 내용",
    "topic":"주제",
    "type":"fact",
    "importance":0.7,
    "keywords":["키워드"]
  }}}'

# recall — 기억 검색
curl -s -X POST $SERVER_URL \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ACCESS_KEY" \
  -H "MCP-Session-Id: $SESSION_ID" \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"recall","arguments":{
    "agentId":"AGENT_ID",
    "text":"검색어",
    "keywords":["키워드"]
  }}}'

# context — 핵심 기억 로드
curl -s -X POST $SERVER_URL \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ACCESS_KEY" \
  -H "MCP-Session-Id: $SESSION_ID" \
  -d '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"context","arguments":{
    "agentId":"AGENT_ID",
    "structured":true
  }}}'
```

응답에서 결과 추출:
```bash
# 위 명령 끝에 파이프로 추가
| python3 -c "import sys,json; r=json.load(sys.stdin); print(r['result']['content'][0]['text'])"
```

curl 응답 검증 체크:
- HTTP 200 + `result` 필드 존재 → 성공
- `error.code` 존재 → 메시지 파싱 후 재시도 또는 사용자 보고
- `error.code === -32001` 또는 `-32002` (세션 관련) → `initialize`부터 다시 수행
- 응답 본문이 비어 있거나 파싱 실패 → 네트워크·방화벽 문제, `SERVER_URL`과 포트 노출 상태 확인

## 다중 플랫폼/디바이스 기억 관리

기억은 API 키 단위로 격리된다. 같은 그룹의 키는 기억을 공유한다.

### 구성 예시

```
그룹: team-a
  +-- team-a-claude (Claude Code용)
  +-- team-a-cursor (Cursor용)
  +-- team-a-gpt (ChatGPT용)
  +-- team-a-GC (기존 기억 보관용)
```

이 구성에서 Claude Code에서 저장한 기억을 Cursor에서도 recall 가능.

### 키워드로 출처 구분

같은 그룹 내에서도 어떤 플랫폼/디바이스에서 생긴 기억인지 구분하려면:
- keywords에 플랫폼명 포함: `["memento-mcp", "claude-code", "my-host"]`
- recall 시 플랫폼 필터: `recall(keywords=["claude-code"])`

## 도구 레퍼런스 (17개)

RBAC default-deny: 도구 맵에 등록되지 않은 도구를 호출하면 `"Access denied: tool not permitted"` 오류가 반환된다. 서버 관리자가 허용 도구 목록(`RBAC_TOOL_MAP`)을 명시적으로 관리한다.

### remember

새 파편을 생성한다. 반드시 1~2문장 단위의 원자적 사실 하나만 저장한다.

파라미터:

| 이름 | 타입 | 필수 | 설명 |
|------|------|------|------|
| content | string | O | 기억할 내용. 1~3문장, 300자 이내. episode는 1000자. |
| topic | string | O | 주제 라벨. 프로젝트명 권장. |
| type | string | O | fact, decision, error, preference, procedure, relation, episode |
| keywords | string[] | - | 검색용 키워드. 3~5개. 프로젝트명+호스트네임 포함. |
| importance | number | - | 0.0~1.0. 미입력 시 type별 기본값. |
| source | string | - | 출처 (세션 ID, 도구명 등) |
| linkedTo | string[] | - | 연결할 기존 파편 ID 목록 |
| scope | string | - | permanent(기본) 또는 session |
| isAnchor | boolean | - | true면 영구 보존. 핵심 규칙/정책용. |
| supersedes | string[] | - | 대체할 기존 파편 ID. 지정 파편은 만료 처리. |
| contextSummary | string | - | 맥락/배경 요약 (1-2문장) |
| sessionId | string | - | 현재 세션 ID |
| agentId | string | - | 에이전트 ID (RLS 격리용) |
| workspace | string | - | 워크스페이스 이름. 미지정 시 키의 default_workspace 자동 적용. |
| caseId | string | - | 이 파편이 속한 케이스 ID. 미지정 시 session_id 사용 |
| goal | string | - | 에피소드 목표 (episode 타입 권장) |
| outcome | string | - | 에피소드 결과 |
| phase | string | - | 작업 단계 (예: planning, debugging, verification) |
| resolutionStatus | string | - | open / resolved / abandoned |
| assertionStatus | string | observed | observed / inferred / verified / rejected |
| affect | string | - | 감정 태그. neutral / frustration / confidence / surprise / doubt / satisfaction |

품질 게이트: content < 10자, URL만, type+topic null인 경우 거부. importance < 0.3이면 경고 + TTL short 자동 설정.

에러: fragment_limit_exceeded 시 forget/memory_consolidate로 정리 안내.

### batch_remember

여러 파편을 한번에 저장. 단일 트랜잭션, 최대 200건. episode/contextSummary/isAnchor/supersedes/linkedTo/scope 미지원.

| 이름 | 타입 | 필수 | 설명 |
|------|------|------|------|
| fragments | array | O | [{content, topic, type, importance?, keywords?}] 최대 200건 |
| async | boolean | - | true 시 파이어앤포겟 비동기 모드. 선검증 후 Redis 큐 적재, {async, accepted, rejected, jobId} 즉시 반환. 기본 false(동기). Redis 비활성 시 동기 폴백. |
| agentId | string | - | 에이전트 ID |

async 사용 지침: 대량(수십~200건) 일괄 저장에서 호출자 대기를 피하려면 `async: true`. 단 즉시 받는 것은 `accepted` 수와 `jobId`뿐이며 per-fragment id는 반환되지 않고, 파편은 워커 처리 후에 recall 가능(즉시 아님, eventual)하다. 재시도 안전이 필요하면 각 항목에 `idempotencyKey`를 넣는다. 소수 저장이나 직후 해당 파편을 곧바로 참조해야 하는 경우는 기본 동기 모드(async 생략)를 쓴다.

### recall

파편 검색. 키워드/시맨틱/하이브리드 자동 선택.

반환 파편에 `key_id` 필드가 포함된다. 멀티테넌트 환경에서 파편 소유 키를 확인하는 데 활용할 수 있다.

| 이름 | 타입 | 필수 | 설명 |
|------|------|------|------|
| keywords | string[] | - | 키워드 검색 (L1->L2) |
| text | string | - | 자연어 쿼리 (L3 시맨틱) |
| topic | string | - | 주제 필터 |
| type | string | - | 타입 필터 (episode 제외. episode는 text/topic으로 검색) |
| tokenBudget | number | - | 최대 반환 토큰. 기본 1000. |
| includeLinks | boolean | - | 연결 파편 포함. 기본 true. |
| linkRelationType | string | - | 연결 관계 필터 (related, caused_by, resolved_by, part_of, contradicts) |
| threshold | number | - | similarity 임계값 0~1 |
| includeSuperseded | boolean | - | 만료 파편 포함. 기본 false. |
| asOf | string | - | ISO 8601. 해당 시점에 가까운 파편을 상위로 올리는 시간 근접 랭킹 기준(anchorTime)으로만 작동. 주의: 그 시점에 유효했던 버전을 복원하는 bitemporal as-of 필터가 아니며, 과거 시점 스냅샷 조회는 미구현. 특정 기간의 파편을 실제로 한정하려면 timeRange를 쓴다. |
| timeRange | object | - | {from, to} 생성시각(created_at) 기준 시간창 필터. ISO 8601과 한국어 자연어("3일 전","지난 주","오늘") 모두 지원. 지정 시 시간 검색 경로가 동작하고 RRF에서 시간 근접 가중이 부스트된다. |
| cursor | string | - | 페이지네이션 커서 |
| pageSize | number | - | 기본 20, 최대 50 |
| excludeSeen | boolean | - | context()에서 주입된 파편 제외. 기본 true. |
| includeContext | boolean | - | context_summary + 인접 파편 포함 |
| includeKeywords | boolean | - | 응답에 keywords 배열 포함 |
| agentId | string | - | 에이전트 ID |
| workspace | string | - | 검색 범위 제한. 지정 시 해당 workspace + 전역(NULL) 파편만 반환. |
| contextText | string | - | 현재 대화 맥락 텍스트. 관련 파편을 선제적으로 활성화한다 (ENABLE_SPREADING_ACTIVATION=true 시 동작). |
| caseId | string | - | 케이스 ID 필터. 해당 케이스에 속한 파편만 반환. |
| resolutionStatus | string | - | 해결 상태 필터 (open / resolved / abandoned) |
| phase | string | - | 작업 단계 필터 (planning, debugging, verification 등) |
| caseMode | boolean | - | true 시 CBR 모드. case_id별 (goal, events, outcome) 트리플로 반환 |
| maxCases | number | - | caseMode 최대 케이스 수 (기본 5, 상한 10) |
| minImportance | number | - | 최소 중요도 필터 (0~1). 이 값 이상의 importance만 반환. |
| isAnchor | boolean | - | true 시 앵커(고정) 파편만 반환 |
| depth | string | - | 검색 깊이. high-level(decision/episode), detail(전체), tool-level(procedure/error/fact) |
| affect | string/string[] | - | 감정 태그 필터. neutral / frustration / confidence / surprise / doubt / satisfaction. 배열 또는 단일 문자열 지원 |

### forget

| 이름 | 타입 | 필수 | 설명 |
|------|------|------|------|
| id | string | - | 삭제할 파편 ID |
| topic | string | - | 해당 주제 전체 삭제 |
| force | boolean | - | permanent 파편 강제 삭제. 기본 false. |
| agentId | string | - | 에이전트 ID |

타 테넌트(다른 API 키) 소유 파편을 삭제 시도하면 `"Fragment not found or no permission"` 오류가 반환된다. master key는 전체 파편에 접근 가능하다.

### link

| 이름 | 타입 | 필수 | 설명 |
|------|------|------|------|
| fromId | string | O | 시작 파편 ID |
| toId | string | O | 대상 파편 ID |
| relationType | string | - | related(기본), caused_by, resolved_by, part_of, contradicts |
| weight | number | - | 관계 가중치 (0-1, 기본 1) |
| agentId | string | - | 에이전트 ID |

fromId 또는 toId가 타 테넌트 소유 파편인 경우 `"Fragment not found or no permission"` 오류가 반환된다.

### amend

기존 파편 수정. 변경 필드만 전달.

타 테넌트 소유 파편 수정 시도 시 `"Fragment not found or no permission"` 오류가 반환된다.

| 이름 | 타입 | 필수 | 설명 |
|------|------|------|------|
| id | string | O | 수정할 파편 ID |
| content | string | - | 새 내용 |
| topic | string | - | 새 주제 |
| keywords | string[] | - | 새 키워드 |
| type | string | - | 새 유형 |
| importance | number | - | 새 중요도 |
| isAnchor | boolean | - | 고정 여부 |
| supersedes | boolean | - | 기존 파편 대체 |
| assertionStatus | string | - | 확인 상태 변경 (observed, inferred, verified, rejected) |
| agentId | string | - | 에이전트 ID |

### reflect

세션 학습 내용을 원자 파편으로 영속화.

| 이름 | 타입 | 필수 | 설명 |
|------|------|------|------|
| summary | string/string[] | - | 세션 개요. 배열 권장 (1항목=1사실). |
| sessionId | string | - | 세션 ID |
| decisions | string[] | - | 결정 목록 (1항목=1결정) |
| errors_resolved | string[] | - | 해결 에러 ('원인: X -> 해결: Y') |
| new_procedures | string[] | - | 확립된 절차 |
| open_questions | string[] | - | 미해결 질문 |
| narrative_summary | string | - | 3~5문장 서사 요약. episode 파편으로 저장되어 세션 연속성에 기여. |
| task_effectiveness | object | - | {overall_success, tool_highlights[], tool_pain_points[]} |
| agentId | string | - | 에이전트 ID |

summary 또는 sessionId 중 하나 이상 필수.

### context

세션 시작 시 핵심 기억 로드.

| 이름 | 타입 | 필수 | 설명 |
|------|------|------|------|
| tokenBudget | number | - | 기본 2000 |
| types | string[] | - | 기본: preference, error, procedure |
| sessionId | string | - | 워킹 메모리 로드용 |
| structured | boolean | - | 계층 구조 반환. 기본 false. |
| agentId | string | - | 에이전트 ID |
| workspace | string | - | 컨텍스트 로드 범위. 지정 시 해당 workspace + 전역(NULL) 파편만 포함. |

### tool_feedback

도구 결과 유용성 피드백.

| 이름 | 타입 | 필수 | 설명 |
|------|------|------|------|
| tool_name | string | O | 도구명 |
| relevant | boolean | O | 결과 관련성 |
| sufficient | boolean | O | 결과 충분성 |
| suggestion | string | - | 개선 제안 (100자) |
| context | string | - | 사용 맥락 (50자) |
| session_id | string | - | 세션 ID |
| trigger_type | string | - | sampled 또는 voluntary |
| fragment_ids | string[] | - | 피드백 대상 파편 ID (EMA 조정) |
| search_event_id | integer | - | recall의 _searchEventId |

fragment_ids를 지정하고 ENABLE_RECONSOLIDATION=true인 경우: relevant=false이면 해당 파편들의 fragment_links에 decay action, relevant=true이면 reinforce action이 적용된다. 이를 통해 검색 피드백이 링크 강도에 반영된다.

### memory_stats

기억 시스템 통계. 파라미터 없음.

### memory_consolidate

수동 GC 트리거. TTL 전환, 감쇠, 만료 삭제, 중복 병합. master key 전용. 파라미터 없음.

### graph_explore

에러 인과 관계 추적 (RCA). caused_by/resolved_by 1-hop.

| 이름 | 타입 | 필수 | 설명 |
|------|------|------|------|
| startId | string | O | 시작 파편 ID (error 권장) |
| agentId | string | - | 에이전트 ID |

startId가 타 테넌트 소유 파편인 경우 `"Fragment not found or no permission"` 오류가 반환된다.

### fragment_history

파편 변경 이력. amend 이전 버전 + superseded_by 체인.

| 이름 | 타입 | 필수 | 설명 |
|------|------|------|------|
| id | string | O | 조회할 파편 ID |

id가 타 테넌트 소유 파편인 경우 `"Fragment not found or no permission"` 오류가 반환된다.

### get_skill_guide

이 문서(SKILL.md)의 내용을 반환. 전체 또는 섹션별 조회 가능. 플랫폼에 기억 도구 설정이 없는 경우 이 도구를 호출하여 최적 활용법을 안내한다.

| 이름 | 타입 | 필수 | 설명 |
|------|------|------|------|
| section | string | - | overview, lifecycle, keywords, search, episode, multiplatform, tools, importance |

미지정 시 전체 가이드(~12KB) 반환.

### reconstruct_history

**목적**: case_id 또는 entity 기반으로 작업 히스토리를 시간순 재구성한다. 인과 체인, 미해결 브랜치, case_events DAG를 함께 반환하여 복잡한 디버깅 세션의 전체 맥락을 파악할 수 있다.

**언제 사용**: 특정 케이스/이슈의 전체 흐름 파악, 인과 관계 분석, 미해결 문제 확인.

| 파라미터 | 타입 | 기본값 | 설명 |
|---|---|---|---|
| caseId | string | - | 재구성할 케이스 ID (caseId 또는 entity 중 하나 필수) |
| entity | string | - | topic/keywords ILIKE 필터 (caseId 없을 때 사용) |
| timeRange | object | - | { from: ISO8601, to: ISO8601 } 시간 범위 |
| query | string | - | content 키워드 추가 필터 |
| limit | number | 100 | 최대 반환 파편 수 (최대 500) |
| workspace | string | - | 워크스페이스 필터 |

반환값:
- `ordered_timeline`: 시간순 파편 배열
- `causal_chains`: BFS 인과 체인 배열 `{ root_id, chain[], length, is_resolved }`
- `unresolved_branches`: 미해결 파편 + error_observed 이벤트 배열
- `supporting_fragments`: 체인에 포함되지 않은 나머지 파편
- `case_events`: case_events 테이블 이벤트 배열 (caseId 지정 시)
- `event_dag`: case_event_edges 배열
- `summary`: 요약 문자열

**예시**:
```json
{ "caseId": "debug-auth-2026-04-01" }
```

### search_traces

**목적**: fragments 테이블을 grep하듯 선택적으로 탐색한다. reconstruct_history보다 경량하며, 특정 조건에 맞는 파편을 빠르게 조회할 때 사용한다.

**언제 사용**: 키워드 검색, 특정 세션/케이스의 파편 확인, 이벤트 타입별 필터링.

| 파라미터 | 타입 | 기본값 | 설명 |
|---|---|---|---|
| event_type | string | - | fragment type 필터 (fact, decision, error, procedure 등) |
| entity_key | string | - | topic ILIKE 필터 |
| keyword | string | - | content ILIKE 필터 |
| case_id | string | - | 특정 케이스 필터 |
| session_id | string | - | 특정 세션 필터 |
| time_range | object | - | { from: ISO8601, to: ISO8601 } |
| limit | number | 20 | 최대 반환 수 (최대 100) |

반환값: `{ success, traces[], count }`

**예시**:
```json
{ "keyword": "authentication", "event_type": "error", "limit": 10 }
```

### session_rotate

**목적**: 현재 세션을 종료하고 새 `sessionId`를 발급한다. 토큰 탈취 의심 시 또는 주기적 로테이션에 사용한다.

**언제 사용**: 키 노출이 의심되거나 스케줄된 회전 시점에서 동일 `bound_key_id` / `workspace` / `permissions`로 새 세션을 발급받을 때.

| 파라미터 | 타입 | 기본값 | 설명 |
|---|---|---|---|
| reason | string | - | 회전 사유 (감사 로그 기록). 예: `scheduled_rotation`, `suspected_leak`, `user_request` |

반환값: 새 `sessionId`와 회전 결과.

**예시**:
```json
{ "reason": "scheduled_rotation" }
```

## 자동 백그라운드 동작

다음 3개 기능은 별도 도구 호출 없이 자동으로 동작한다.

### ProactiveRecall
- **트리거**: 모든 `remember()` 호출 직후
- **동작**: 저장된 파편의 키워드와 50% 이상 겹치는 기존 파편을 검색하여 `related_to` 링크를 자동 생성
- **영향**: recall 시 관련 파편이 그래프 이웃으로 함께 조회됨 (L2.5 경로)
- **제어**: search 의존성이 없으면 비활성 (기본값: 활성)

### CaseRewardBackprop
- **트리거**: case_events에 `verification_passed` 또는 `verification_failed` 이벤트가 추가될 때
- **동작**: 해당 케이스의 증거(fragment_evidence) 파편 importance를 역전파
  - verification_passed: importance +0.15, quality_verified = true
  - verification_failed: importance -0.10
- **영향**: 검증된 파편의 recall 우선순위가 자동 조정됨
- **범위**: importance [0.0, 1.0] clamp

### SearchParamAdaptor
- **트리거**: 모든 `recall()` / 검색 호출 시
- **동작**: key_id x query_type x hour 조합별 검색 결과 수를 추적하여 minSimilarity를 자동 조정
  - 결과 부족(avg < 1): 임계값 하향 (더 관대한 검색)
  - 결과 과다(avg > 8): 임계값 상향 (더 엄격한 검색)
- **학습**: 50회 이상 샘플 축적 후 적용, 범위 [0.10, 0.60]
- **영향**: 사용 패턴에 따라 검색 정밀도가 자동 최적화됨

## 중요도 기본값

| 타입 | 권장 | 근거 |
|------|------|------|
| preference | 0.9 | 사용자 의도 정확 반영 |
| error | 0.8 | 재발 시 즉시 해결 |
| procedure | 0.7 | 안정적 회상 필요 |
| decision | 0.7 | 모순 방지 |
| episode | 0.6 | 맥락 보존용 |
| fact | 0.5 | 일반 사실 |
| relation | 0.5 | 관계 기록 |

## 기억 저장 규칙

1. 간결성: 파편 하나에 하나의 개념. 300자 이내 (episode 1000자).
2. 범주화: topic에 프로젝트명. 검색 효율에 직결.
3. 키워드: 3~5개. 프로젝트명 + 호스트네임 + 구체적 용어.
4. 보안: API 키, 비밀번호, 토큰을 파편에 저장하지 않는다.
5. 앵커: 절대 변경되지 않는 핵심 규칙만 isAnchor=true.
6. 대체: 정보 업데이트 시 supersedes로 구 파편 연결. 새 파편이 구 파편을 대체.
7. 연결: 인과 관계가 있는 파편은 link로 즉시 연결. 나중에 graph_explore로 추적 가능.

## 검색 계층 구조

| 계층 | 방식 | 용도 | 속도 |
|------|------|------|------|
| L1 | PostgreSQL ILIKE | 정확한 용어 검색 | 가장 빠름 |
| L2 | pgvector cosine | 의미적 유사 검색 | 빠름 |
| L2.5 | 그래프 이웃 | 연결된 파편 확장 (deleted_at IS NULL 활성 링크만) | 빠름 |
| L3 | RRF 하이브리드 | L1+L2 결과 합산 | 보통 |

recall 호출 시 keywords만 전달하면 L1->L2, text를 전달하면 L3까지 자동 확장.

## 경험적 기억 활용 (Experiential Memory)

"단순 기억 저장소"를 넘어 경험에서 학습하고 성장하는 기억 시스템을 위한 고급 패턴.

### 1. 확산 활성화 — 맥락 연관 파편 선제 부스트

`contextText`를 recall에 전달하면 검색 전 ACT-R 모델로 관련 파편의 activation_score를 미리 높인다.
키워드 매칭에 등장하지 않아도 맥락상 관련된 파편이 상위로 올라온다.

```
# 일반 recall (키워드만)
recall(keywords=["OAuth", "client_id"])

# Spreading Activation recall (맥락 포함)
recall(
  keywords=["OAuth", "client_id"],
  contextText="Claude.ai 연동 중 authentication 오류 발생. redirect_uri 관련 이슈 의심"
)
```

contextText 작성 팁:
- 현재 대화의 핵심 주제 1~2문장
- 에러 메시지, 사용 중인 도구명, 의심 원인 포함
- 100~200자 내외가 최적 (너무 길면 키워드 집중도 하락)

### 2. 링크 재통합 — 피드백이 기억 강도를 바꾼다

`tool_feedback`에 `fragment_ids`를 포함하면 해당 파편들의 연결 링크 weight/confidence가 실시간 갱신된다.
(ENABLE_RECONSOLIDATION=true 환경 필요)

```
# 검색 결과가 유용했을 때 → fragment_links reinforce (+0.2)
tool_feedback(
  tool_name="recall",
  relevant=true,
  sufficient=true,
  fragment_ids=["frag-abc", "frag-def"],
  search_event_id=12345
)

# 검색 결과가 무관했을 때 → fragment_links decay (-0.15)
tool_feedback(
  tool_name="recall",
  relevant=false,
  fragment_ids=["frag-xyz"],
  search_event_id=12345
)
```

누적 효과:
- 자주 함께 검색되고 유용했던 파편 쌍은 link weight가 높아져 L2.5 검색에서 더 많이 같이 반환됨
- 무관한 파편 쌍은 weight가 낮아지고 quarantine_state='soft'로 격리될 수 있음
- 모순(contradicts) 링크가 감지되면 인접 related/temporal 링크가 자동 격리됨

### 3. 에피소드 연속성 — 경험 흐름을 그래프로 보존

`reflect` 호출 시 생성된 episode 파편은 이전 세션의 episode와 자동으로 `preceded_by` 엣지로 연결된다.
(EpisodeContinuityService, idempotency_key 기반 중복 방지)

```
# 세션 1 종료 시
reflect(
  summary=["OAuth 구현 1단계: DCR 엔드포인트 추가 완료"],
  sessionId="sess-001"
)
# → episode-A 생성

# 세션 2 종료 시
reflect(
  summary=["OAuth 구현 2단계: Claude.ai redirect_uri 동적 처리 완료"],
  sessionId="sess-002"
)
# → episode-B 생성 + episode-A --preceded_by--> episode-B 엣지 자동 생성
```

이 그래프를 통해:
- `reconstruct_history(entity="OAuth")` 호출 시 세션 간 경험 흐름을 시간순으로 재구성
- 인과 체인(`caused_by`/`resolved_by`)과 에피소드 연속(`preceded_by`)을 함께 분석

### 4. 히스토리 재구성 — 언제 어떤 도구를 쓸까

| 상황 | 도구 | 이유 |
|------|------|------|
| 특정 케이스의 전체 흐름 파악 | `reconstruct_history(caseId=...)` | 인과 체인 + case_events DAG 포함 |
| 특정 세션의 기록 확인 | `search_traces(session_id=...)` | 경량, 빠름 |
| 에러 이벤트만 필터링 | `search_traces(event_type="error")` | 타입별 grep |
| 특정 키워드 포함 파편 탐색 | `search_traces(keyword="nginx")` | 전문 키워드 매칭 |
| 복잡한 버그의 근본 원인 추적 | `graph_explore(startId=error_frag_id)` | caused_by/resolved_by 1-hop RCA |

### 5. 최적 활용 워크플로우

**세션 시작:**
```
context()  → 핵심 맥락 복원
recall(keywords=[프로젝트명], contextText="오늘 할 작업 한 줄 요약")
           → Spreading Activation으로 관련 기억 사전 로드
```

**작업 중:**
```
# 검색 후 반드시 피드백 (reconsolidation 누적)
recall(...) → _searchEventId 보관
tool_feedback(fragment_ids=[...], search_event_id=..., relevant=true/false)

# 인과 관계 발생 즉시 link
link(fromId=에러파편, toId=해결파편, relationType="resolved_by")
```

**세션 종료:**
```
reflect(
  summary=["사실1", "사실2"],
  errors_resolved=["원인: X → 해결: Y"],
  sessionId=현재세션ID
)
# → episode 파편 자동 생성 + preceded_by 엣지 자동 연결
```

### 6. Case-based 작업 추적 — 복잡한 작업을 케이스 단위로 관리

`caseId`를 중심으로 remember/recall/amend/reconstruct_history를 연계하면 복잡한 디버깅, 기능 구현, 장애 대응 등의 전체 흐름을 하나의 케이스로 추적할 수 있다.

#### 케이스 생명주기

```
작업 시작 → caseId 부여 + goal + phase="planning" + resolutionStatus="open"
  ↓
진행 중   → 동일 caseId로 에러/발견/결정 기록 + phase 갱신
  ↓
완료      → amend로 resolutionStatus="resolved" + outcome 기록
  ↓
재구성    → reconstruct_history(caseId=...) 로 전체 흐름 + 인과 체인 조회
```

#### 1단계: 작업 시작 — 케이스 열기

caseId는 `{작업유형}-{주제}-{날짜}` 형식을 권장한다.

```
remember(
  content="nginx SSL 인증서 갱신 실패 조사 시작. certbot renew 실행 시 403 에러 발생.",
  type="episode",
  topic="nginx",
  keywords=["nginx", "ssl", "certbot", "my-host"],
  caseId="debug-nginx-ssl-2026-04-05",
  goal="certbot SSL 인증서 갱신 403 에러 해결",
  phase="planning",
  resolutionStatus="open",
  importance=0.8
)
```

#### 2단계: 진행 중 — 발견/에러/결정 누적

동일 `caseId`로 파편을 계속 추가한다. `phase`를 작업 단계에 맞게 갱신한다.

```
# 에러 원인 발견
remember(
  content="certbot 403 원인: nginx가 .well-known/acme-challenge를 proxy_pass로 넘기고 있었음. location 블록 우선순위 문제.",
  type="error",
  topic="nginx",
  keywords=["nginx", "certbot", "acme-challenge", "location"],
  caseId="debug-nginx-ssl-2026-04-05",
  phase="debugging",
  importance=0.8
)

# 해결 시도
remember(
  content="nginx에 location ^~ /.well-known/acme-challenge/ 블록을 proxy_pass 위에 추가하여 certbot 검증 경로를 직접 서빙하도록 수정.",
  type="procedure",
  topic="nginx",
  keywords=["nginx", "certbot", "location", "acme-challenge"],
  caseId="debug-nginx-ssl-2026-04-05",
  phase="verification",
  importance=0.8
)
```

#### 3단계: 완료 — 케이스 닫기

케이스의 첫 파편(또는 대표 파편)을 `amend`로 갱신한다.

```
amend(
  id="첫_파편_id",
  resolutionStatus="resolved",
  outcome="nginx location 블록 우선순위 수정으로 certbot 갱신 성공. cron 재설정 완료."
)
```

#### 4단계: 사후 재구성 — 전체 흐름 파악

```
reconstruct_history(caseId="debug-nginx-ssl-2026-04-05")
```

반환값:
- `ordered_timeline`: 시간순 전체 파편
- `causal_chains`: caused_by/resolved_by 인과 체인
- `unresolved_branches`: 미해결 브랜치 (있다면)
- `case_events`: 시맨틱 마일스톤 이벤트
- `event_dag`: 이벤트 간 DAG 관계

#### phase 권장 값

| phase | 의미 | 전환 시점 |
|-------|------|----------|
| planning | 작업 계획/분석 | 케이스 시작 |
| debugging | 원인 조사 | 에러 분석 시작 |
| implementation | 구현/수정 | 코드 작성 시작 |
| verification | 검증/테스트 | 수정 완료 후 |
| resolved | 완료 | 검증 통과 |

#### resolutionStatus 값

| 상태 | 의미 |
|------|------|
| open | 진행 중 |
| resolved | 해결 완료 |
| abandoned | 포기/보류 |

### 7. Assertion 신뢰도 관리 — 가설과 사실을 구분

`assertionStatus`는 파편의 신뢰 수준을 4단계로 표현한다. 가설을 저장하고, 검증 후 상태를 갱신하여 기억의 신뢰도를 체계적으로 관리한다.

#### 4단계 신뢰 모델

| assertionStatus | 의미 | 사용 시점 |
|-----------------|------|----------|
| observed | 직접 확인한 사실 (기본값) | 로그/출력/테스트 결과로 확인한 것 |
| inferred | 추론/가설 (검증 전) | "아마 이것이 원인일 것" — 아직 증명 안 됨 |
| verified | 테스트/실행으로 확인 완료 | 수정 후 테스트 통과, 재현 확인 |
| rejected | 틀린 것으로 판명 | 가설이 틀렸음을 확인 |

#### 워크플로우: 가설 → 검증 → 확정

```
# 1. 가설 저장 (inferred)
remember(
  content="메모리 누수 원인은 EventListener 미해제로 추정. useEffect cleanup 누락 의심.",
  type="error",
  topic="frontend",
  keywords=["memory-leak", "useEffect", "EventListener"],
  assertionStatus="inferred",
  caseId="debug-memleak-2026-04-05",
  phase="debugging",
  importance=0.7
)
# → frag-hypothesis-001

# 2. 검증 성공 → verified로 갱신
amend(
  id="frag-hypothesis-001",
  assertionStatus="verified",
  content="메모리 누수 원인 확정: EventListener 미해제. useEffect cleanup에 removeEventListener 추가로 해결."
)

# 3. 만약 가설이 틀렸다면 → rejected
amend(
  id="frag-hypothesis-001",
  assertionStatus="rejected",
  content="EventListener 미해제는 원인이 아니었음. 프로파일러 확인 결과 클로저의 대형 객체 참조가 실제 원인."
)
```

#### 활용 패턴

검증 전 가설을 `inferred`로 저장하면:
- 다음 세션에서 recall 시 해당 파편이 "아직 검증되지 않은 가설"임을 인지할 수 있다
- 검증 후 `amend`로 `verified`/`rejected`를 명시하면 기억의 정확성이 보장된다
- `rejected` 파편은 "이미 시도했지만 실패한 경로"로서 같은 실수를 반복하지 않게 한다

recall 시 신뢰도 기반 판단:
- `observed`/`verified` 파편: 신뢰하고 적용
- `inferred` 파편: 참고하되 재검증 고려
- `rejected` 파편: 이 경로는 이미 실패했으므로 다른 접근 필요

## CBR (Case-Based Reasoning) 활용

### 유사 사례 검색

과거 유사 작업의 해결 사례를 참조할 때 `recall(caseMode=true)` 사용:
- 검색 결과 파편에서 case_id를 추출하여 케이스별 그루핑
- 각 케이스를 (goal, events, outcome, resolution_status) 트리플로 반환
- resolved 케이스가 우선 정렬

### depth 필터 전략

| depth | 대상 type | 용도 |
|-------|----------|------|
| high-level | decision, episode | Planner — 고수준 의사결정 참조 |
| detail | 전체 (기본값) | 일반 검색 |
| tool-level | procedure, error, fact | Executor — 구체적 실행 절차 참조 |

## 능동 활용 트리거

사용자 요청 없이도 아래 신호를 감지하면 즉시 해당 도구를 선제 실행한다.

### 상황별 의사결정 트리

```
세션 시작
  └─ context(structured=true) 즉시 호출
       └─ _meta.hints.signal = "empty_context"?
             └─ remember 또는 reflect 제안
       └─ _meta.hints.signal = "active_errors"?
             └─ 각 error 파편을 사용자에게 알리고 해결 여부 확인

에러/오류/실패 발화 감지
  └─ recall(type="error", keywords=[관련 키워드]) 먼저 실행
       └─ 과거 해결 기록 있으면 → 사용자에게 제시
       └─ _meta.hints.signal = "no_results"? → 에러 해결 후 새로 저장 예정임을 인지

에러 원인 확정
  └─ remember(type="error", importance=0.8) 즉시 저장

에러 해결 완료
  └─ forget(id=해당 error 파편 ID)
  └─ remember(type="procedure", importance=0.8) — 해결책 저장
  └─ link(fromId=에러파편, toId=해결파편, relationType="resolved_by") — 이미 forget 전이라면

"설정/포트/경로/버전" 변경 시작 전
  └─ recall(keywords=[설정명]) — 이전 결정 확인

아키텍처/기술 선택 확정
  └─ remember(type="decision", importance=0.7) 즉시 저장

"이전에/저번에/전에" 언급
  └─ recall(query=관련 내용) 즉시 호출

세션 종료 의도 감지 ("잠깐", "나중에", "오늘은 여기까지" 등)
  └─ reflect(summary=[...], decisions=[...], errors_resolved=[...])
```

### _meta.hints 처리 규칙

recall 또는 context 응답의 `_meta.hints` 필드를 읽는다(v3.1.0에서 top-level `_memento_hint` mirror 제거됨):
- `signal` 값을 읽어 상황 파악
- `suggestion` 텍스트를 사용자에게 알리거나 즉시 실행 고려
- `trigger` 필드에 지정된 도구를 다음 행동으로 우선 고려

| signal | 의미 | 권장 행동 |
|--------|------|----------|
| no_results | 관련 기억 없음 | 작업 완료 후 remember |
| stale_results | 30일+ 경과 파편 | amend로 갱신 또는 forget |
| consider_context | 파편 5개 이상 | includeContext=true 재검색 |
| active_errors | 미해결 error 파편 존재 | 각 파편 확인 후 forget |
| empty_context | 저장된 기억 없음 | 세션 후 remember/reflect |

### 능동 활용 트리거 테이블

| 감지 신호 | 권장 도구 |
|----------|----------|
| "이전에 비슷한 문제를", "과거 사례" 언급 | recall(caseMode=true, text=관련 내용) |
| Planner 역할로 고수준 계획 수립 | recall(depth="high-level") |
| Executor 역할로 구체적 절차 참조 | recall(depth="tool-level") |
| recall 응답에 `_suggestion` 포함 | `_suggestion.recommendedTool` + `recommendedArgs` 검토 후 적용 |
| Mode 활성화 상태에서 차단된 도구 호출 시도 | 현재 mode 확인 (`memory_stats`), 필요 시 모드 전환 요청 |

## LLM Provider Fallback

Gemini CLI 외 `codex-cli`, `copilot-cli`, `qwen-cli` 포함 15개 이상의 외부 provider로 자동 fallback 가능. 설정: `LLM_PRIMARY=gemini-cli` (기본) + `LLM_FALLBACKS` JSON 배열. env 미설정 시 기존 Gemini CLI 단독 동작 유지. 형태소 분석은 기본적으로 로컬 CPU 분석기(MorphemeTokenizer)가 담당하며 LLM provider 체인을 사용하지 않는다(`MEMENTO_MORPHEME_TOKENIZER=llm` 설정 시에만 LLM 경로 활성화). 자세한 운영은 `docs/operations/llm-providers.md` 참조.

## Symbolic Memory 활용 (opt-in)

모든 `MEMENTO_SYMBOLIC_*` 플래그는 기본 `false`다. 아래 기능은 해당 플래그를 명시적으로 활성화한 환경에서만 동작한다.

### validation_warnings 해석

`remember` 응답에 `validation_warnings: string[]` 필드가 포함된다 (`MEMENTO_SYMBOLIC_POLICY_RULES=true` 시, violations 있을 때만). 각 요소는 rule 이름 문자열이다. 필드 자체가 없으면 위반 없음.

예시: `{"success": true, "id": "frag-...", "validation_warnings": ["decisionHasRationale"]}`

배열이 비어있지 않으면 다음 중 하나에 해당한다:

- `decisionHasRationale` — decision 타입인데 근거가 약함 → `linkedTo`에 2건 이상 연결하거나 "왜냐하면", "because" 같은 근거 키워드 포함
- `errorHasResolutionPath` — error 타입인데 해결 경로 부재 → cause/fix 키워드 또는 `resolutionStatus` 명시
- `procedureHasStepMarkers` — procedure 타입인데 단계 부재 → "1.", "2.", "먼저", "다음" 등 마커 포함
- `caseIdHasResolutionStatus` — case_id 보유 파편인데 resolution_status 미설정 → `resolutionStatus: "resolved"` 등 명시
- `assertionNotContradictory` — 기존 assertion과 충돌 → `amend` 또는 `forget`으로 과거 파편 정리

경고는 soft gate이므로 기본적으로 저장을 차단하지 않는다. `api_keys.symbolic_hard_gate=true`로 전환하면 해당 키는 경고 발생 시 저장이 거부된다. 이 경우 MCP 도구 에러가 아닌 JSON-RPC **프로토콜 레벨** 에러 코드 `-32003` (SYMBOLIC_POLICY_VIOLATION)이 반환된다:

```json
{"jsonrpc": "2.0", "id": 5, "error": {"code": -32003, "message": "policy_violation: decisionHasRationale", "data": {"violations": ["decisionHasRationale"], "fragmentType": "decision"}}}
```

마스터 키(keyId=NULL)는 대상에서 제외된다. 자세한 운영 절차는 `docs/operations/symbolic-hard-gate.md` 참조.

### explanations 필드 활용

`recall` 응답 파편에 `explanations: [{code, detail, ruleVersion}]` 배열이 포함된다 (`MEMENTO_SYMBOLIC_EXPLAIN=true` 시, 설명이 있을 때만). 해당 파편이 왜 검색 결과에 포함됐는지 최대 3개 이유를 제공한다. 클라이언트가 파편의 관련성을 UI에 표시하거나, LLM 컨텍스트에 설명을 주입할 때 활용한다.

예시: `{"explanations": [{"code": "semantic_similarity", "detail": "cosine 0.87", "ruleVersion": "v1"}]}`

reason code 6종 (`code` 필드값):
- `direct_keyword_match` — L2 형태소 매칭
- `semantic_similarity` — L3 pgvector 임베딩
- `graph_neighbor_1hop` — L2.5 그래프 이웃
- `temporal_proximity` — 시간적 근접
- `case_cohort_member` — case_mode 코호트
- `recent_activity_ema` — ema_activation 가점

단계적 활성화 권장 순서: `MEMENTO_SYMBOLIC_ENABLED=true` → `MEMENTO_SYMBOLIC_SHADOW=true` + `MEMENTO_SYMBOLIC_CLAIM_EXTRACTION=true` → `scripts/backfill-claims.js --dry-run` 선행 → `MEMENTO_SYMBOLIC_EXPLAIN=true` → `MEMENTO_SYMBOLIC_POLICY_RULES=true`.

---

## 안티패턴

다음 행동은 Memento를 무력화한다. 반드시 피할 것.

| 안티패턴 | 왜 나쁜가 | 올바른 행동 |
|---------|----------|------------|
| 사용자가 "기억해"라고 해야만 remember 호출 | 중요 정보가 세션 경계에서 유실됨 | 중요 발생 시점에 자동 저장 |
| recall 없이 에러 수정 시작 | 과거 동일 에러 해결책을 중복 재발견하는 낭비 | recall(type="error") 선행 필수 |
| 에러 해결 후 forget 생략 | 다음 세션에도 동일 error 파편이 context에 잡혀 혼란 | 해결 즉시 forget |
| context 호출 없이 작업 시작 | 이전 세션에서 축적된 전체 맥락 유실 | 세션 시작 즉시 context |
| reflect 없이 세션 종료 | 이번 세션 작업이 전부 휘발됨 | 중요 작업 완료 후 reflect |
| remember 후 link 생략 | 고립된 파편만 생성, 그래프 연결 없음 | 인과관계 있는 파편은 link로 연결 |
| 모든 내용을 하나의 파편에 저장 | 검색 정밀도 저하, 중요도 희석 | 원자적 분해 (1 사실 = 1 파편) |
| 불필요한 remember 남발 | fragment_limit 쿼터 소진, 노이즈 증가로 검색 품질 저하 | 저장 전 "다음 세션에서 필요한가?" 자문, 일시적 정보는 저장하지 않음 |
| importance 미지정 (모든 파편 0.5) | recall 시 중요/비중요 파편 구분 불가, 핵심 정보가 노이즈에 묻힘 | 상황별 중요도 기본값 표 참조, 최소 0.6 이상 명시 |
| keywords 미지정 | 자동 추출에 의존하면 프로젝트명/호스트명 등 핵심 키워드 누락 | 프로젝트명 + 토픽 + 고유 식별자를 keywords에 명시적으로 포함 |
| validation_warnings 무시 후 반복 remember | 동일 경고 파편이 누적되면 symbolic_hard_gate 활성화 시 전면 차단됨 | 경고 내용에 따라 content/linkedTo/resolutionStatus를 보강 후 재저장 |
| recall 결과의 explanations reasonCodes를 fragment content에 복사 저장 | 검색 품질 메타데이터는 저장하면 안 됨. 노이즈로 검색 정밀도 저하 | reasonCodes는 UI 표시나 컨텍스트 힌트용으로만 사용, 저장 금지 |
| Shadow mode 없이 Phase 2+ 직행 | 기존 데이터의 claim 백필 없이 explain/policy 활성화 시 경고 오탐 증가 | `MEMENTO_SYMBOLIC_SHADOW=true` + `scripts/backfill-claims.js --dry-run` 선행 후 단계적 활성화 |
