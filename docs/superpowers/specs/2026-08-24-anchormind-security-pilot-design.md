# AnchorMind 5.7.0 보안 수정 및 로컬 파일럿 설계

## 1. 문서 목적과 판정 범위

이 문서는 AnchorMind 5.7.0의 보안 수정과 가짜 데이터 로컬 파일럿을 구현하기 위한 설계 기준이다. 이 작업에서는 실제 소스 코드, 실제 기억, 개인 정보, Ballast/Codex memory, 외부 서비스에 접근하거나 변경하지 않는다. AnchorMind는 원본 기억의 소유자가 아니라 검색용 projection(검색에 필요한 복사본)만 보유한다.

기준 커밋은 `ab45989 docs: 5.7.0 문서 현행화`이다. 이 문서의 acceptance 결과는 구현 후 별도로 기록하며, 아래 baseline은 변경 전 기록이지 현재 변경이 검증되었다는 뜻이 아니다.

### 승인된 제약

- 서버와 파일럿 클라이언트는 `127.0.0.1`에서만 통신한다.
- 파일럿 DB는 개발/테스트 DB와 분리된 전용 PostgreSQL + pgvector 인스턴스다.
- 입력은 저장소에 포함되는 가짜 fixture뿐이다. 실제 기억, 개인 정보, 원본 memory 디렉터리는 입력으로 사용하지 않는다.
- 네트워크 외부 전송은 0건이다. OpenAI/Gemini/NLI/Reranker 외부 endpoint와 원격 모델 다운로드를 허용하지 않는다.
- 자동 병합, 정리, 삭제, consolidation, AutoReflect를 끈다.
- Ballast/Codex memory는 authoritative source(권위 있는 원본)로 유지하고 AnchorMind는 그 원본을 수정하지 않는다.
- 이번 산출물은 설계 문서만 작성한다. 구현, 마이그레이션, 테스트 실행, 커밋, 배포는 다음 작업이다.

### 변경 전 baseline

- 테스트 기록: `2472 passed`, `7 failed`, `7 cancelled`.
- 의존성 감사 기록: `npm audit` 결과 `1 moderate`, `1 high`.
- 위 수치는 보안 수정 완료를 의미하지 않으며, 구현 후 같은 명령과 새 acceptance 테스트를 다시 실행해 차이를 설명해야 한다.

## 2. 문제 정의와 보안 목표

현재 코드에는 다음 세 종류의 위험이 확인된다.

1. 인증 키가 비어 있을 때 실제 요청 진입점이 인증을 통과시키는 fail-open 경로가 있다.
2. graph/session/temporal/contradiction 자동 연결과 background worker가 key와 workspace를 함께 강제하지 않아 다른 작업 공간의 fragment가 후보가 될 수 있다.
3. AutoReflect, 임베딩, NLI, reranker가 외부 provider 또는 Transformers.js 원격 모델 다운로드로 이어질 수 있다.

파일럿의 보안 목표는 다음과 같다.

- 인증 실패는 항상 거부로 끝난다. 인증 비활성화는 명시적인 개발 전용 opt-in에서만 가능하다.
- 모든 검색/연결 후보는 `(key_id, workspace)` scope(데이터 경계)를 동일하게 만족해야 한다. scope가 없거나 확인할 수 없으면 후보를 버린다.
- 로컬에 캐시된 모델만 사용한다. 캐시가 없으면 다운로드나 외부 fallback 없이 명확히 실패한다.
- AnchorMind의 DB에는 fixture로부터 만든 검색 projection만 쌓인다. 원본의 수정, 자동 정리, 외부 전송, 자동 병합은 발생하지 않는다.

## 3. 구성요소 경계

```text
fake fixture (NDJSON)
        |
        v
pilot importer -- scope/key/workspace 검증 --> dedicated PostgreSQL + pgvector
        |                                              |
        +--> local Transformers embedding --------------+
                                                       v
                                        AnchorMind search projection
                                                       |
                         localhost + valid access key + recall only
```

### 경계별 책임

| 구성요소 | 허용 책임 | 금지 책임 | 근거 |
| --- | --- | --- | --- |
| Ballast/Codex memory | 원본 기억의 권위 유지 | 파일럿 입력, 수정, 삭제, export | 승인된 제품 경계 |
| fake fixture/importer | 합성 데이터 생성과 scope 형식 검증 | 실제 파일 탐색, 원본 memory 읽기 | 새 파일럿 harness |
| AnchorMind ingest/projection | fixture fragment 저장, 로컬 임베딩 생성 | 원본 기억의 권위 주장, cross-scope 후보 사용 | `lib/memory/processors/MemoryRememberer.js`, `lib/tools/embedding.js` |
| AnchorMind read/search | 인증된 scope의 검색 결과 반환 | 다른 key/workspace 결과 반환 | `lib/memory/read/*`, `lib/tools/memory.js` |
| AutoReflect/LLM | 파일럿에서는 비활성화 | 외부 모델 호출, 자동 기억 생성 | `lib/memory/processors/AutoReflect.js`, `lib/llm/index.js` |
| Scheduler/maintenance | 파일럿에서는 health와 명시적 projection 작업만 | link/merge/consolidate/gc/reflect 자동 실행 | `lib/scheduler.js`, `config/memory.js` |
| Dedicated DB | AnchorMind projection과 검증 ledger 저장 | 개발 DB, 테스트 DB, Ballast/Codex DB 공유 | `lib/config.js:341-350`, 기존 compose |

## 4. 데이터 흐름과 불변식

### 정상 흐름

1. `tests/fixtures/security-pilot.ndjson`의 합성 레코드를 importer가 읽는다.
2. importer는 모든 레코드에 `key_id`와 `workspace`를 요구하고, 허용된 pilot key/workspace 목록 외의 값을 거부한다.
3. AnchorMind는 전용 DB에 fragment와 로컬 임베딩을 기록한다. 이 DB는 기존 `memento_dev`/`memento_test`와 다른 이름과 포트를 사용한다.
4. 검색 요청은 유효한 access key를 인증하고, 요청 scope를 DB 검색의 필수 조건으로 넘긴다.
5. 검색 결과는 `key_id`와 workspace가 요청과 정확히 같은 projection만 반환한다.
6. 파일럿 종료 시 fixture/import/search 결과와 외부 전송 차단 증거를 검사한다. Ballast/Codex memory는 read/write 대상에 포함되지 않는다.

### 반드시 지킬 불변식

- `scope = (key_id, workspace)`이며 두 필드 중 하나라도 확인되지 않으면 검색/연결하지 않는다.
- `NULL` workspace를 전역 공유 후보로 취급하지 않는다. pilot scope가 명시된 요청에서는 exact equality 또는 명시적인 `IS NOT DISTINCT FROM` 정책만 사용한다.
- background에서 `"system"` agent를 사용하더라도 scope 검사를 우회할 수 없다.
- cross-scope 후보는 결과에서 제거하며, link row, `valid_to`, merge, delete를 자동으로 만들지 않는다.
- 임베딩 provider가 `transformers`가 아니거나 local-only 정책을 입증할 수 없으면 시작 단계에서 중단한다.
- AutoReflect는 호출자가 누구인지와 무관하게 pilot에서 no-op/skip한다.

## 5. 설정 envelope

아래는 파일럿용 `.env.security-pilot.example`에 둘 설정 이름과 기대값이다. `MEMENTO_BIND_HOST`, `MEMENTO_LOCAL_MODEL_ONLY`, `MEMENTO_AUTO_REFLECT`, `MEMENTO_CONSOLIDATE_ENABLED`, `MEMENTO_GC_ENABLED`는 구현 시 중앙 설정으로 추가할 pilot guard다. 기존 설정 이름은 현재 코드의 환경변수 계약을 따른다.

```dotenv
MEMENTO_PILOT_MODE=true
MEMENTO_BIND_HOST=127.0.0.1
MEMENTO_ACCESS_KEY=<synthetic-local-key>
MEMENTO_AUTH_DISABLED=false
ALLOWED_ORIGINS=http://127.0.0.1:<pilot-port>

POSTGRES_HOST=127.0.0.1
POSTGRES_PORT=<dedicated-pilot-postgres-port>
POSTGRES_DB=anchormind_pilot
POSTGRES_USER=anchormind_pilot
POSTGRES_PASSWORD=<local-only-password>
REDIS_ENABLED=false

EMBEDDING_PROVIDER=transformers
EMBEDDING_MODEL=Xenova/multilingual-e5-small
EMBEDDING_DIMENSIONS=384
MEMENTO_LOCAL_MODEL_ONLY=true
TRANSFORMERS_CACHE_DIR=<local-cached-model-dir>
LLM_PRIMARY=none
LLM_FALLBACKS=[]
RERANKER_URL=
NLI_SERVICE_URL=

MEMENTO_AUTO_REFLECT=false
MEMENTO_PROACTIVE_RECALL_MODE=off
MEMENTO_CONSOLIDATE_ENABLED=false
MEMENTO_GC_ENABLED=false
MCP_STRICT_ORIGIN=true
MCP_ALLOW_AUTO_DCR_REGISTER=false
MCP_REJECT_NONAPIKEY_OAUTH=true
```

설정 검증은 startup에서 수행한다. `MEMENTO_PILOT_MODE=true`인데 access key가 비어 있거나, bind host가 `127.0.0.1`이 아니거나, embedding provider가 local Transformers가 아니거나, 모델 cache가 없거나, maintenance guard가 꺼져 있지 않으면 서버를 시작하지 않는다.

## 6. 세 구현 slice

### Slice 1 — 인증 + loopback + offline envelope

#### 설계

- `validateAuthentication()`의 빈 key 분기를 `AUTH_DISABLED`의 명시적 opt-in과 분리한다. 기본값은 401 fail-closed이며, `AUTH_DISABLED=true`는 local 개발/테스트에서만 허용한다.
- server listen host를 `MEMENTO_BIND_HOST`로 명시하고 pilot에서는 `127.0.0.1`만 허용한다.
- origin allowlist를 pilot port 하나로 제한하고 자동 OAuth/DCR 등록과 비-API-key 인증 fallback을 차단한다.
- `EMBEDDING_PROVIDER=transformers`와 offline Transformers 환경(`allowRemoteModels=false`, local model path/cache)을 startup에서 확인한다.
- AutoReflect, LLM chain, 외부 NLI/reranker를 호출하지 않으며, preload도 pilot guard 뒤에서만 실행한다.

#### 실패 처리

- access key 없음/불일치/잘못된 형식: 401, DB 조회 금지, audit event 기록.
- offline model cache 없음: startup 실패. 원격 다운로드나 provider fallback 금지.
- bind/origin 정책 위반: startup 실패.
- 외부 endpoint 설정이 남아 있음: startup 실패.

#### acceptance criteria

- key 없는 요청과 임의 key 요청이 모두 401이다.
- 유일한 synthetic key로만 health/read/search entrypoint가 통과한다.
- `AUTH_DISABLED=true`가 없으면 빈 key 상태에서 master 권한이 생기지 않는다.
- listener가 `127.0.0.1:<pilot-port>`에만 열리고 다른 interface에 bind되지 않는다.
- 모델 cache가 있으면 외부 DNS/HTTP 없이 embedding이 완료되고, cache를 숨기면 다운로드 없이 실패한다.
- AutoReflect/NLI/reranker/LLM provider 호출 카운터가 0이다.

### Slice 2 — key + workspace 무결성

#### 설계

- GraphLinker, SessionLinker, TemporalLinker, ContradictionDetector, ConflictResolver, proactive recall의 SQL과 호출 계약에 `(key_id, workspace)`를 필수 scope로 포함한다.
- `"system"` 또는 null key를 cross-scope 허용 토큰으로 사용하지 않는다. background 작업은 명시적인 pilot scope를 받아 그 범위만 처리한다.
- ReflectProcessor의 batch/fallback 결과에 `key_id`, `workspace`를 보존한다.
- source와 candidate의 key/workspace가 exact match가 아니면 link/recall/contradiction/merge 후보에서 제외한다.
- workspace 비교 실패, DB allow-list 조회 실패, scope metadata 누락은 fail-closed로 처리한다.
- proactive recall, auto-link, scheduler link worker를 pilot에서는 off하거나 명시적 scope가 있는 호출만 허용한다.
- merge/cleanup/consolidate/gc는 모두 off이며 자동 `valid_to`, fragment link, delete가 발생하지 않아야 한다.

#### 실패 처리

- scope 누락: 해당 작업만 거부하고 후보를 반환하지 않는다.
- 서로 다른 key 또는 workspace: 후보를 버리고 링크/수정 이벤트를 만들지 않는다.
- scope 확인용 DB 오류: fail-open하지 않고 검색/자동처리를 거부한다.
- scope를 전달하지 않는 legacy/background 호출: pilot에서는 명시적인 오류 또는 skip으로 종료한다.

#### acceptance criteria

- 같은 내용/같은 embedding을 가진 fixture를 두 workspace와 두 key에 넣어도 검색 결과는 요청 tuple과 같은 행만 포함한다.
- cross-workspace, cross-key graph/session/temporal/contradiction 자동 연결 수가 0이다.
- scope 누락/DB 오류 테스트가 403 또는 안전한 empty result로 끝나며 link/merge mutation이 없다.
- fixture를 두 번 읽어도 자동 dedup/merge/cleanup이 발생하지 않는다.
- pilot 전후 DB에서 자동 `valid_to`, `fragment_links` 추가, 삭제, consolidate 결과가 0이다.

### Slice 3 — fake-data 로컬 E2E pilot

#### 설계

- 전용 `docker-compose.security-pilot.yml`로 `anchormind_pilot` PostgreSQL/pgvector를 띄운다. 기존 dev/test compose와 volume, port, DB name을 공유하지 않는다.
- importer는 합성 NDJSON만 읽고 source provenance를 `synthetic-pilot`으로 표시한다.
- 최소 fixture는 `key-a/workspace-red`, `key-a/workspace-blue`, `key-b/workspace-red`를 포함하고, 일부는 의미적으로 유사하지만 scope가 다른 문장을 사용한다.
- E2E는 `127.0.0.1` HTTP entrypoint에서 synthetic key로 ingest projection과 recall을 수행한다.
- DB readback으로 projection row, scope, embedding dimension, mutation ledger를 확인하고, no-egress sentinel/log로 외부 전송 0건을 확인한다.
- 파일럿 결과는 원본 memory 파일이나 Ballast/Codex memory의 해시/내용을 읽거나 기록하지 않는다.

#### acceptance criteria

- 전용 DB가 준비되고 dev/test DB와 연결 정보가 다르다.
- fixture의 합성 레코드만 projection으로 존재한다.
- 인증된 각 scope가 자기 fixture만 검색한다.
- 외부 DNS/HTTP 호출, provider request, 모델 다운로드가 0건이다.
- AutoReflect, consolidation, cleanup, merge, delete가 0건이다.
- 파일럿 실패 시 결과를 `UNRESOLVED`로 남기고 자동 재시도/외부 전송/데이터 정리를 하지 않는다.

## 7. 실패 처리와 stop conditions

### 공통 실패 원칙

- 보안 경계 실패는 빈 결과로 조용히 통과시키지 않고 요청 거부 또는 startup 중단으로 처리한다.
- 불확실한 scope, provider, network state는 허용하지 않는다.
- 모든 자동 처리 실패는 원인과 scope를 local log에 남기되 실제 fragment 내용이나 secret은 기록하지 않는다.
- 외부 전송이 한 번이라도 관찰되면 파일럿을 즉시 중단하고 projection DB를 보존한 채 결과를 `BLOCKED`로 판정한다. 자동 삭제는 하지 않는다.

### 즉시 중단 조건

1. access key 없이 200/도구 실행/master 권한이 관찰됨.
2. listener가 loopback 이외 interface에 열림.
3. workspace 또는 key mismatch 후보가 recall/link 결과에 노출됨.
4. scope 확인 오류가 allow로 처리됨.
5. OpenAI/Gemini/NLI/Reranker endpoint, DNS, HTTP 또는 원격 model fetch가 관찰됨.
6. AutoReflect, merge, cleanup, consolidate, gc, delete가 pilot flag와 무관하게 실행됨.
7. 전용 DB가 아닌 dev/test 또는 Ballast/Codex 저장소에 쓰기가 발생함.
8. fixture 외 실제 기억/개인정보가 입력되었거나 로그에 기록됨.
9. baseline의 7 failed/7 cancelled를 분류하지 않은 채 전체 회귀 통과로 보고하려 함.

## 8. 구현 시 건드릴 정확한 파일과 근거 라인

아래 목록은 다음 구현 작업의 allowlist다. 이번 문서 작성에서는 이 파일들을 수정하지 않는다.

### 필수 런타임 변경

| 파일 | 근거 라인 | 계획된 변경 |
| --- | ---: | --- |
| `lib/auth.js` | 108-110, 208-218 | 실제 `validateAuthentication` fail-open 제거; 명시적 `AUTH_DISABLED`만 예외로 인정 |
| `lib/config.js` | 50-70, 93-171, 341-350 | pilot/bind/offline/DB 설정과 startup validation의 중앙 계약 |
| `server.js` | 254-258, 296-305, 328-329, 388-395 | loopback bind, 인증 로그 의미 수정, NLI/reranker preload 및 shutdown AutoReflect guard |
| `lib/memory/processors/AutoReflect.js` | 38-121 | pilot no-op 및 외부 LLM 호출 차단 |
| `lib/memory/processors/ReflectProcessor.js` | 326-359 | batch/fallback 결과에 scope 보존 |
| `lib/sessions.js` | 263-275, 408-417, 654-689 | background AutoReflect 호출 제거/guard 및 scope 전달 |
| `lib/admin/admin-sessions.js` | 49-90 | 수동 reflect도 pilot에서 차단하고 scope 없는 호출 금지 |
| `lib/scheduler.js` | 126-174, 227-249, 256 | consolidate, embedding event link, NLI preload guard |
| `config/memory.js` | 184-235 | proactive recall와 consolidation/maintenance의 pilot default/guard |
| `lib/tools/embedding.js` | 124-150, 165-214 | transformers 외 provider 및 network fallback 차단 |
| `lib/embeddings/LocalTransformersEmbedder.js` | 9-35 | local model path/cache와 remote model 금지 적용 |
| `lib/memory/signals/NLIClassifier.js` | 25-29, 84-119, 245-262 | 외부 URL 및 자동 다운로드 preload 차단 |
| `lib/memory/read/Reranker.js` | 20-29, 105-137, 283-300 | 외부 URL 및 자동 다운로드 preload 차단 |
| `lib/llm/index.js` | 82-118 | `none` chain이 외부 호출로 fallback하지 않도록 fail-closed |
| `lib/memory/link/GraphLinker.js` | 38-67, 96-108, 161-183 | seed/candidate/retro link에 key/workspace exact scope 강제 |
| `lib/memory/link/SessionLinker.js` | 156-217 | session auto-link scope equality gate |
| `lib/memory/link/TemporalLinker.js` | 48-53 | `workspace IS NULL OR ...` 전역 후보 허용 제거 |
| `lib/memory/write/RememberPostProcessor.js` | 191-210, 326-410 | temporal/proactive recall scope 전달과 workspace 필드명 정합성 |
| `lib/memory/write/ConflictResolver.js` | 120-139 | topic auto-link에 workspace 필터 추가 |
| `lib/memory/link/ContradictionDetector.js` | 87-132 | key와 workspace 동시 필터 및 system 우회 제거 |
| `lib/memory/keyScope.js` | 15-25 | null key를 unrestricted scope로 해석하지 않는 pilot 정책 연결 |

### 파일럿 harness와 회귀 검증

| 파일 | 계획된 역할 |
| --- | --- |
| `docker-compose.security-pilot.yml` | 전용 PostgreSQL/pgvector와 별도 port/volume 정의 |
| `.env.security-pilot.example` | 위의 local-only 설정 envelope 예시(비밀값 없음) |
| `tests/fixtures/security-pilot.ndjson` | 합성 key/workspace 경계 fixture |
| `scripts/run-security-pilot.sh` | 설정 검증, 전용 DB 기동, fixture import, E2E 실행의 local wrapper |
| `tests/integration/security-pilot.test.js` | auth, loopback contract, offline provider, projection-only E2E acceptance |
| `tests/unit/auth-fail-closed.test.js` | pure helper뿐 아니라 실제 `validateAuthentication` entrypoint 회귀 추가 |
| `tests/unit/graph-linker.test.js` | workspace와 key 동시 격리 회귀 추가 |
| `tests/unit/fragment-isolation.test.js` | cross-scope 후보 차단 회귀 추가 |
| `tests/unit/auto-link-session-gate.test.js` | workspace mismatch/missing fail-closed 회귀 추가 |
| `tests/unit/temporal-linker-group-isolation.test.js` | 기존 NULL workspace 허용 기대를 pilot strict 정책으로 재정의 |
| `tests/unit/workspace-allowed-gate.test.js` | DB 오류 fail-open 기대를 fail-closed로 재정의 |
| `tests/unit/symbolic-hard-gate.test.js` | allow-list/API key 오류 fail-open 기대를 fail-closed로 재정의 |
| `tests/unit/auto-reflect.test.js` | pilot no-op와 provider 미호출 회귀 추가 |
| `tests/unit/session-idle-reflect.test.js` | idle/close/current segment의 AutoReflect 차단 회귀 추가 |
| `tests/unit/local-transformers-embedder.test.js` | cache-only, remote fetch 금지 회귀 추가 |
| `tests/integration/local-embedding.test.js` | 실제 local embedding 경로 확인 |
| `tests/unit/reranker-external-fallback.test.js` | pilot external fallback 차단 회귀 추가 |

## 9. 검증 순서와 보고 형식

1. Slice 1을 구현하고 auth, listener, offline network guard를 먼저 검증한다.
2. Slice 2를 구현하고 scope matrix를 단위 테스트와 DB readback으로 검증한다.
3. Slice 3에서 synthetic fixture만으로 E2E를 실행한다.
4. baseline `2472 passed / 7 failed / 7 cancelled`와 비교해 기존 14개 비통과 항목을 각각 `기대되는 계약 변경`, `회귀`, `환경 문제`로 분류한다.
5. `npm audit`의 `1 moderate / 1 high`는 보안 수정의 성공으로 간주하지 않는다. advisory의 패키지, 도달 가능성, 조치 여부를 별도로 기록한다.
6. 최종 보고에는 실제 실행 명령, 통과/실패 수, 외부 호출 관찰 결과, 전용 DB 이름/port, projection row와 mutation row readback을 포함한다.

성공 판정은 “테스트가 통과했다” 하나로 끝내지 않는다. 인증된 대표 검색 흐름이 실제 entrypoint를 거쳤고, 결과가 동일 scope로 제한되었으며, local model만 사용했고, source memory와 외부 네트워크에 효과가 없었다는 네 가지 증거가 모두 있어야 한다.

## 10. 구현 전 금지사항

- 이 문서의 acceptance를 만족시키기 위해 테스트를 삭제하거나 baseline 실패를 숨기지 않는다.
- `MEMENTO_AUTH_DISABLED=true`를 기본 설정, CI 공용 설정, 파일럿 예시의 유효값으로 쓰지 않는다.
- `"system"`, null key, null workspace를 전역 검색/연결 권한으로 재사용하지 않는다.
- 외부 endpoint가 실패할 때 다른 외부 provider 또는 원격 model로 fallback하지 않는다.
- 실제 memory 파일을 fixture로 복사하거나, fixture 결과를 Ballast/Codex memory에 다시 쓰지 않는다.
- 자동 merge/cleanup을 “검증 편의”라는 이유로 켜지 않는다.
