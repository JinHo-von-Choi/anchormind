# 테스트 가이드

작성자: 최진호
작성일: 2026-04-29
수정일: 2026-05-19

---

## 개요

memento-mcp의 테스트는 세 계층으로 구성된다.

- 단위 테스트 (node:test): 외부 의존성 없이 모듈 단위 검증
- 통합 테스트: DB/Redis 연결 가능 여부를 런타임 자동 판단 또는 환경변수 활성화
- E2E 테스트: 실행 중인 서버와 실제 LLM CLI를 대상으로 하는 전단 검증

단위 테스트 러너는 Node.js 내장 `node:test`만 사용한다. jest 의존성은 없다.

---

## 단위 테스트 실행

```bash
# 전체 단위 테스트
npm test

# 직접 실행 (MEMENTO_METRICS_DEFAULT=off 권장)
MEMENTO_METRICS_DEFAULT=off node --experimental-test-module-mocks --test \
  'tests/unit/*.test.js' \
  'tests/unit/**/*.test.js'
```

`MEMENTO_METRICS_DEFAULT=off`는 prom-client 레지스트리 중복 초기화 경고를 억제한다.
단위 테스트는 DB, Redis, EMBEDDING_API_KEY 없이 실행된다.

---

## 통합 테스트 실행

```bash
# 전체 통합 테스트 + E2E (glob)
npm run test:integration

# LLM E2E만 순차 실행
npm run test:integration:llm
```

통합 테스트 상세 실행 방법과 환경변수 가드는
[tests/integration/README.md](../tests/integration/README.md)를 참조한다.

---

## npm 스크립트 요약

| 스크립트 | 실행 범위 |
|--------|---------|
| `npm test` | unit 전체 (node:test) |
| `npm run test:integration` | 통합 + e2e (tests/integration/*.test.js + tests/e2e/*.test.js) |
| `npm run test:e2e` | e2e만 |
| `npm run test:ci` | `npm test && npm run test:integration` — CI 단일 게이트 (DB/Redis 필요) |
| `npm run lint:migrations` | migration SQL body-only 규약 검사 (MIGRATION_LINT_FROM 기준) |

---

## mock.module 패턴 (node:test)

node:test의 `mock.module`은 ESM 정적 import를 런타임에 가로채는 방식으로 동작한다.
hoisting 없이 `before()` 훅 안에서 등록하고, `after()`에서 `mock.restoreAll()`로 해제한다.

```js
import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";

describe("example mock.module 패턴", () => {
  before(async () => {
    await mock.module("../../lib/redis.js", {
      namedExports: {
        redisClient: { get: mock.fn(async () => null), quit: mock.fn() },
      },
    });
  });

  after(async () => {
    mock.restoreAll();
  });

  it("stub 적용 확인", async () => {
    const { redisClient } = await import("../../lib/redis.js");
    assert.equal(await redisClient.get("key"), null);
  });
});
```

`consolidator-metrics.test.js`는 prom-client를 `mock.module`로 완전 격리하여
레지스트리 충돌 없이 단위 검증한다.

---

## cleanup 표준 패턴

`lib/sessions.js`, `lib/redis.js`, `lib/db.js` 등 timer·socket을 활성화하는 모듈을
import하는 단위 테스트는 `after()` 훅에서 반드시 정리해야 한다.

```js
import { after } from "node:test";
import { assertCleanShutdown } from "../_lifecycle.js";

after(async () => {
  try {
    const { disconnectRedis } = await import("../../lib/redis.js");
    await disconnectRedis();
  } catch (_) {}
  try {
    const { getPrimaryPool } = await import("../../lib/tools/db.js");
    await getPrimaryPool()?.end();
  } catch (_) {}
  await assertCleanShutdown();
});
```

이 패턴이 누락되면 Redis/Postgres 연결이 열린 채로 프로세스가 종료되지 않는다(hang).
`assertCleanShutdown()`은 `tests/unit/test-lifecycle-guard.test.js`가 동작을 검증한다.

단일 파일 실행 시 환경변수 명시:

```bash
MEMENTO_METRICS_DEFAULT=off node --experimental-test-module-mocks --test \
  tests/unit/<파일명>.test.js
```

---

## 테스트 파일 목록

### 단위 테스트 (tests/unit/) — 선택 목록

| 파일 | 검증 내용 |
|---|---|
| `embedding-worker-batch.test.js` | EmbeddingWorker._embedMany 배치화 4 시나리오 (정상/빈content/HTTP400/인덱스오류) |
| `morpheme-batch.test.js` | MorphemeIndex 배치 임베딩 + multi-row INSERT, 순서 보존, HTTP 400 격리 재시도 |
| `consistency-gate.test.js` | Consistency Gate SQL 조건 생성 검증 (morpheme_indexed, morphemeOnly, keyId 조합) |
| `session-linker-batch.test.js` | SessionLinker createLinks 배치 호출, sortedKey 오름차순, cycle 격리, fallback |
| `consolidator-metrics.test.js` | prom-client mock.module 격리, MemoryConsolidator 메트릭 카운터 증감 |
| `recall-final-ranking.test.js` | computeRecallScore rerankerScore/fallback 분기 정렬 |
| `lexical-match-score.test.js` | lexicalMatchScore log 스케일 정규화 및 포화 |
| `server-time-meta.test.js` | serverTimeMeta() 4 필드 (iso, epoch_ms, display_kst, timezone) |
| `proactive-recall-gate.test.js` | ProactiveRecall workspace·caseIdPolicy 3-값 gate |
| `auto-link-session-gate.test.js` | autoLinkSessionFragments schema-fit 1:1 매칭 + linkSuggestions |
| `consolidator-schema-fit-gate.test.js` | evaluateSchemaFitGate SQL 조건 3종 |
| `reflect-meta-link-suggestions.test.js` | tool_reflect 응답 _meta.link_suggestions 구조 |
| `reflect-session-reingest.test.js` | 반복 reflect 시 저장된 세션 파편 재저장 없음, WM error 해결 상태, 세션 그룹 workspace 보존 |

### 통합 테스트 (tests/integration/)

| 파일 | 전제 조건 |
|---|---|
| `db-pool-isolation.test.js` | DB 없는 환경: Pool 구조 케이스 실행, application_name SELECT skip |
| `session-linker-deadlock.test.js` | DATABASE_URL 필수. 미설정 시 전체 skip |
| `reflect-large-payload.test.js` | DB/Redis/API키 불필요. 항상 실행 가능 |

`reflect-large-payload.test.js`와 `embedding-worker-batch.test.js`는 모든 의존성을
stub으로 격리하므로 `npm test`(단위 테스트 러너)로도 실행 가능하다.

---

## 알려진 결함

아래 3건은 LLM provider CLI 통합 계층의 기존 결함이다. 메모리 코어 로직과 무관하다.
CI에서 전체 통과 수를 비교할 때 이 3건을 기준에서 제외하여 판단한다.

| 테스트 | 원인 | 상태 |
|---|---|---|
| codex-cli provider SyntaxError | codex-cli 외부 바이너리 파싱 결함 | upstream 이슈 |
| qwen-cli provider SyntaxError | qwen-cli 외부 바이너리 파싱 결함 | upstream 이슈 |
| llm-provider-cooldown timeout | 의도된 타임아웃 동작 검증 케이스 | 의도적 설계, 수정 불필요 |

---

## 전체 테스트 현황

- 단위 테스트: node:test 단일 러너. DB·Redis·EMBEDDING_API_KEY 불필요. 368개 테스트 파일(tests/unit), 전체 385개(tests/unit, integration, e2e). v4.6.0 신규: batch-remember-async.test.js, batch-remember-worker.test.js, session-activity-scan-limit.test.js, rrf-importance-cutoff.test.js, remember-write-paths.test.js, mcp-session-context.test.js.
- 통합 테스트: DB/Redis 환경에서 전체 통과
- E2E: LLM CLI 인증 환경에서 전체 통과
