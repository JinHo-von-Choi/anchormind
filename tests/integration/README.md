# 통합 테스트 실행 가이드

작성자: 최진호
작성일: 2026-04-18
수정일: 2026-04-29 (v3.2.0 Phase 1~7 신규 통합 테스트 4건 추가)

---

## 개요

이 디렉터리의 LLM 관련 통합 테스트는 gemini-cli, codex-cli, copilot-cli 실제 바이너리 호출과
MorphemeIndex의 LLM 체인 관통 동작을 end-to-end로 검증한다.
각 테스트는 환경변수 가드로 기본 skip 처리되어 있으며, 명시적으로 활성화해야 실행된다.
CI에서 무조건 실행되지 않도록 의도적으로 설계된 구조다.

v3.2.0부터 Phase 1~7 구현 검증용 통합 테스트 4건이 추가되었다.
이 4건은 별도 활성화 변수 없이 DB/Redis 연결 가능 여부를 런타임에 자동 판단하여 skip 처리된다.

---

## 환경변수 가드

### 필수 DB 정합성 레인

GitHub Actions의 `db-correctness` job은 `MEMENTO_REQUIRE_TEST_DB=true`로 embedding/amend, synthetic-query/amend, case-event/forget 경합 시험을 순차 실행한다. 이 레인은 DB 연결이나 setup 실패를 skip하지 않고 실패로 처리하며 `continue-on-error`가 아니다. 로컬의 전체 DB 레인은 다음 명령으로 같은 일회용 PostgreSQL 포트(기본 35433)를 사용한다.

```bash
MEMENTO_REQUIRE_TEST_DB=true npm run test:db
```

### 기존 LLM E2E 테스트 (활성화 변수 필요)

이 디렉터리의 LLM E2E 통합 테스트는 환경변수 가드로 기본 skip 처리된다.
해당 변수가 미설정이거나 `"1"`이 아니면 describe/suite 전체가 skip으로 처리된다.

| 테스트 파일 | 활성화 변수 | 전제 조건 |
|---|---|---|
| `session-token-reuse.test.js` | `E2E_SESSION_REUSE=1` | 실행 중인 서버, Redis, DB |
| `llm-cli-smoke.test.js` | `E2E_LLM_CLI=1` | gemini/codex/copilot CLI 인증 |
| `llm-timeout.test.js` | `E2E_LLM_TIMEOUT=1` | gemini/codex/copilot CLI 인증 |
| `llm-chain-real.test.js` | `E2E_LLM_CHAIN=1` | LLM_PRIMARY, LLM_FALLBACKS |
| `morpheme-llm-real.test.js` | `E2E_MORPHEME=1` | LLM CLI 인증, PostgreSQL |
| `local-embedding.test.js` | `E2E_LOCAL_EMBED=1` | @huggingface/transformers 설치 |
| `toctou-remember-concurrency.test.js` | `MEMENTO_REMEMBER_ATOMIC=true` (결과 검증 분기) | PostgreSQL |

LLM provider 설정(LLM_PRIMARY, LLM_FALLBACKS, circuit breaker 등) 상세는
[docs/operations/llm-providers.md](../../docs/operations/llm-providers.md)를 참조한다.

### v3.2.0 신규 통합 테스트 (자동 skip 방식)

아래 4건은 활성화 변수 없이 런타임에 DB/서버 연결 가능 여부를 자동 판단한다.
DATABASE_URL이 미설정이거나 TCP 접속에 실패하면 케이스 전체가 조용히 skip된다.

| 테스트 파일 | DB 필요 | Redis 필요 | 비고 |
|---|---|---|---|
| `db-pool-isolation.test.js` | 부분 (DB 없으면 application_name SELECT skip) | 불필요 | Pool 인스턴스 구조 검증은 DB 없어도 실행 |
| `session-linker-deadlock.test.js` | 필수 | 불필요 | DATABASE_URL 미설정 시 전체 skip |
| `reflect-large-payload.test.js` | 불필요 | 불필요 | DB/Redis를 stub으로 대체. 항상 실행 가능 |
| `embedding-worker-batch.test.js` | 불필요 | 불필요 | DB/Redis를 stub으로 대체. 항상 실행 가능 |

`reflect-large-payload.test.js`와 `embedding-worker-batch.test.js`는
모든 의존성을 stub으로 격리하므로 DB/Redis 없이 항상 실행된다.
단, LLM 호출이 없는 순수 단위 테스트 성격이므로 `npm test`(단위 테스트 runner)로 실행해도 무방하다.

---

## DATABASE_URL 미설정 환경에서 자동 skip 확인 방법

`session-linker-deadlock.test.js`를 DATABASE_URL 없이 실행하면
`[session-linker-deadlock] DATABASE_URL 미설정 또는 DB 미연결 — 테스트 스킵` 경고 후
모든 케이스가 0건 실행(skip)으로 종료된다.

```bash
# DATABASE_URL 없이 실행 — skip 동작 확인
node --test tests/integration/session-linker-deadlock.test.js
```

출력에 `# tests 0` 또는 케이스 전체 pass 0 이 확인되면 정상 skip이다.

`db-pool-isolation.test.js`는 Pool 인스턴스 속성 검증 케이스(DB 연결 불필요)는 실행되고,
실제 DB 쿼리 케이스만 조용히 return으로 종료된다.

```bash
# DB 없는 환경: Pool 구조 케이스만 실행, application_name SELECT 케이스는 skip
node --test tests/integration/db-pool-isolation.test.js
```

---

## 전제 조건

### session-token-reuse.test.js
- memento-mcp 서버가 `127.0.0.1:${PORT}` (기본 57332)에서 실행 중이어야 한다.
- `MEMENTO_ACCESS_KEY` 환경변수가 설정되어 있어야 한다.
- Redis가 기동 중이고 `REDIS_ENABLED=true`여야 한다 (미연결 시 토큰 바인딩이 stub으로 동작하여 재사용 검증 불가).
- DB 연결은 서버 기동에 필요하지만 테스트 자체에서 직접 접근하지 않는다.

### LLM 관련 테스트 (llm-cli-smoke, llm-timeout, llm-chain-real, morpheme-llm-real)
- gemini-cli, codex-cli, copilot-cli 바이너리가 PATH에 설치되어 있고 각각 로그인 완료 상태여야 한다.
  - 미인증 CLI는 skip되지 않고 FAIL로 보고된다.
- PostgreSQL과 Redis가 기동 중이어야 한다.
  - `morpheme-llm-real.test.js`는 DB(PostgreSQL) 연결이 필수다.
  - `llm-cli-smoke.test.js`, `llm-timeout.test.js`, `llm-chain-real.test.js`는 Redis 없이도 실행 가능하다.
- 프로젝트 루트에 `.env` 파일이 존재하고 `LLM_PRIMARY`, `LLM_FALLBACKS` 등 LLM 설정이 반영되어 있어야 한다.

### session-linker-deadlock.test.js
- `DATABASE_URL`이 설정되어 있고 PostgreSQL에 TCP 접속 가능해야 한다.
- DB에 `agent_memory` 스키마와 `fragments`, `fragment_links` 테이블이 존재해야 한다 (`npm run migrate` 완료 상태).
- Redis 불필요.

### db-pool-isolation.test.js
- Pool 인스턴스 구조 검증(격리, 싱글톤, getPoolStats 키 포함 등) 케이스: DB 연결 불필요.
- `batchPool application_name SELECT` 케이스: PostgreSQL 연결 필요. DB 없으면 조용히 skip.
- Redis 불필요.

### reflect-large-payload.test.js
- DB, Redis, EMBEDDING_API_KEY 모두 불필요. 모든 외부 의존성을 stub으로 격리.
- v3.2.0 Phase 1+2 회귀 가드(R12 TDZ 버그). `MEMENTO_REMEMBER_ATOMIC=true` 경로 검증.

### embedding-worker-batch.test.js
- DB, Redis, EMBEDDING_API_KEY 불필요. EmbeddingWorker의 API 호출을 stub으로 대체.
- v3.2.0 Phase 3 배치 retry 4 시나리오 검증.

### 공통
- Node.js 22 이상 (`node:test` runner 사용).

---

## 병렬 실행 금지 (중요)

`llm-chain-real.test.js`는 내부에서 2단 spawn 구조로 동작한다.

```
테스트 프로세스
  └─ child_process.spawn(node, _llm-chain-runner.mjs)   ← 1단
        └─ spawn(gemini | codex | copilot CLI 바이너리)  ← 2단
```

이 구조는 Node.js ESM 모듈 캐시를 케이스마다 완전히 분리하기 위한 의도적 설계다.
`LLM_PRIMARY`, `LLM_FALLBACKS`는 config.js 평가 시점에 상수로 고정되므로,
런타임에 `process.env`를 변경해도 이미 로드된 모듈에는 반영되지 않는다.
케이스마다 독립 프로세스를 띄워 이 문제를 우회한다.

다른 테스트 파일과 동시에 실행하면 다음 문제가 발생한다.

- `~/.gemini/`, `~/.codex/`, `~/.copilot/` 등 CLI 설정 파일에 대한 잠금 경합
- provider별 API rate limit 초과
- 위 두 원인이 결합되어 180초 timeout 발생 → 100% 실패

에이전트 단독 실측에서는 4개 테스트 모두 9.8초 평균으로 PASS가 확인되었다.
병렬 실행 시 동일 테스트가 반드시 실패하는 것은 구현 결함이 아니라 환경 경합 문제다.

반드시 `--test-concurrency=1` 또는 파일 단위 순차 실행으로 처리해야 한다.

---

## 권장 실행 방법

```bash
# 세션 토큰 재사용 E2E 단독 실행
E2E_SESSION_REUSE=1 \
  MEMENTO_ACCESS_KEY=<key> \
  REDIS_ENABLED=true \
  node --test tests/integration/session-token-reuse.test.js
```

```bash
# LLM 관련 4개 파일 전부 순차 실행
E2E_LLM_CLI=1 E2E_LLM_TIMEOUT=1 E2E_LLM_CHAIN=1 E2E_MORPHEME=1 \
  node --test --test-concurrency=1 \
  tests/integration/llm-cli-smoke.test.js \
  tests/integration/llm-timeout.test.js \
  tests/integration/llm-chain-real.test.js \
  tests/integration/morpheme-llm-real.test.js
```

```bash
# 개별 파일 실행
E2E_LLM_CLI=1     node --test tests/integration/llm-cli-smoke.test.js
E2E_LLM_TIMEOUT=1 node --test tests/integration/llm-timeout.test.js
E2E_LLM_CHAIN=1   node --test tests/integration/llm-chain-real.test.js
E2E_MORPHEME=1    node --test tests/integration/morpheme-llm-real.test.js
```

```bash
# v3.2.0 신규 통합 테스트 (자동 skip 방식) — 개별 실행
node --test tests/integration/db-pool-isolation.test.js
node --test tests/integration/reflect-large-payload.test.js
node --test tests/integration/embedding-worker-batch.test.js

# session-linker-deadlock: DB 필요
DATABASE_URL=postgresql://user:pass@localhost:5432/bee_db \
  node --test tests/integration/session-linker-deadlock.test.js
```

`npm run test:integration`은 `tests/integration/*.test.js`를 glob으로 한 번에 실행하므로,
특정 E2E 테스트만 선택적으로 실행할 때는 위 개별 파일 실행 방식을 권장한다.

---

## 각 테스트 요약

### llm-cli-smoke.test.js (7 케이스)

gemini-cli, codex-cli, copilot-cli 세 가지 provider에 대해
`isAvailable()` 바이너리 탐지와 `callJson()` 기본 JSON 응답 반환을 검증한다.
각 provider당 isAvailable / callJson 정상 / callJson 빈 프롬프트 에러 케이스 구성.

### llm-timeout.test.js (7 케이스)

provider별 실제 응답 latency 측정과 `timeoutMs` 강제 kill 동작을 검증한다.
Ollama 로컬 provider 포함. `OLLAMA_BASE_URL`, `OLLAMA_MODEL` 환경변수로 대상 조정 가능.
circuit breaker 오염 방지를 위해 describe 실행 전 Redis 상태를 초기화한다.

### llm-chain-real.test.js (4 케이스)

`LLM_PRIMARY` + `LLM_FALLBACKS` 환경변수로 구성된 체인의 순차 폴백 동작을 검증한다.
케이스마다 독립 Node 프로세스(`_llm-chain-runner.mjs`)를 spawn하여
ESM 모듈 캐시를 완전히 격리한 상태에서 체인을 초기화한다.
각 케이스의 timeout은 180초다.

### morpheme-llm-real.test.js (4 케이스)

`MorphemeIndex.tokenize()`가 실제 LLM 체인을 통과하여 한국어/영어 형태소 배열을 반환하는지 검증한다.
PostgreSQL에 형태소 캐시가 저장되고 재조회 시 동일 결과를 반환하는지도 포함된다.
실제 LLM CLI 호출로 응답에 20~60초가 소요될 수 있다.

### db-pool-isolation.test.js (Phase 7)

`getBatchPool()`이 `getPrimaryPool()`과 별개 객체임을 검증한다.
batchPool의 `options.max`가 primaryPool 대비 30% 이하로 제한되는지,
`getPoolStats()`에 batch/primary 통계가 모두 포함되는지,
`BATCH_DATABASE_URL` 미설정 환경에서 `application_name`이 `'memento-mcp:batch'`인지,
`shutdownPool()` 호출 시 두 풀이 모두 종료되는지를 포함한다.
DB 연결 없이 Pool 인스턴스 속성만으로 검증 가능한 케이스는 DB 없는 환경에서도 실행된다.

### session-linker-deadlock.test.js (Phase 5)

10개 reflect 동시 호출 시 deadlock이 발생하지 않고 lock_timeout 5s 내 모두 완료되는지 검증한다.
SessionLinker의 `sortedKey` 오름차순 정렬로 lock ordering을 일관되게 유지하는 구현이 전제다.
DATABASE_URL 미설정 또는 DB TCP 접속 불가 시 전체 skip.

### reflect-large-payload.test.js (Phase 1+2)

R12 TDZ 회귀 가드 테스트. `MEMENTO_REMEMBER_ATOMIC=true` 경로에서
다건 summary와 긴 narrative_summary를 포함한 reflect 페이로드가 ReferenceError 없이
완료되는지 검증한다. DB/Redis/EMBEDDING_API_KEY 불필요. 항상 실행 가능.

### embedding-worker-batch.test.js (Phase 3)

EmbeddingWorker의 `_embedMany` 배치화 4 시나리오를 검증한다.
a) 정상 50건 — generateBatchEmbeddings 1회 + UPDATE 1회
b) 빈 content 1건 사전 차단 — 49건만 batch
c) HTTP 400 응답 input[37] — dead-letter 1건, 나머지 49건 재batch
d) 인덱스 미명시 에러 — 전체 단건 fallback(_embedOne)
DB/Redis 불필요. EmbeddingWorker API 호출을 stub으로 대체.

---

## 트러블슈팅

### 파일 레벨 `'Promise resolution is still pending'` 에러

과거에 테스트 프로세스 종료 후 pending Promise로 인해 발생하던 이슈.
`_cleanup.js` 공통 모듈 도입으로 해소되었다.
동일 에러가 재발하면 커밋 히스토리에서 `_cleanup.js` 관련 커밋을 참조한다.

### `Gemini CLI timed out after NNNNms`

`config/memory.js`의 `geminiTimeoutMs` 값이 너무 낮게 설정되어 있다.
기본값은 60,000ms(1분)로 설정되어 있으나, 네트워크 상태나 CLI cold start에 따라
더 길게 설정해야 할 수 있다. 최소 60,000ms 이상 권장.

### `all LLM providers failed: circuit breaker open`

Redis에 저장된 circuit breaker 상태가 열린(open) 채로 남아 있을 때 발생한다.
이전 테스트 실패나 rate limit 초과가 원인인 경우가 많다.

```bash
redis-cli DEL llm:cb:gemini llm:cb:codex llm:cb:copilot
# 또는 패턴으로 일괄 삭제
redis-cli --scan --pattern 'llm:cb:*' | xargs redis-cli DEL
```

### CLI auth 실패

각 CLI별로 수동 로그인이 필요하다.

```bash
gemini login
codex login
copilot auth login
```

로그인 후 `which gemini`, `which codex`, `which copilot`으로 PATH 등록 상태를 확인한다.
