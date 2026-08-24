# memory_stats 통계 타입 수정 보고서

## 한줄 결론

PostgreSQL bigint 문자열로 반환되던 `MemoryConsolidator.getStats()`의 공개 count 통계를 안전한 숫자로 정규화했고, 잘못된 값은 필드별 오류로 거부하도록 보강했다.

## 현재 상태

`완료` — 1차 수정 `e609c75`, 보고서 커밋 `f5aa30b`, 엄격한 타입 검증 보강 `385b856`가 현재 branch에 저장되어 있다. 이 보고서 수정은 문서-only이며 아직 커밋하지 않았다. Docker/full pilot 재실행과 외부 작업은 하지 않았다.

## 쉽게 말하면

PostgreSQL이 `COUNT(*)` 결과를 `"1"`이라는 문자열로 보냈는데, MCP의 `memory_stats`는 숫자 `1`을 공개 계약으로 사용한다. DB 경계에서 안전한 숫자만 변환하고, 예를 들어 `"12abc"`는 조용히 `12`로 자르지 않고 오류로 막는다.

## 원인 추적

1. 파일럿 런타임 보고서의 실패 위치는 `tests/integration/security-pilot.test.js:181`의 `stats.stats.total` 비교였고, 실제 값은 `'1'`, 기대값은 `1`이었다.
2. 호출 흐름은 `tool_memoryStats` → `MemoryManager.stats` → `MemoryReflector.stats` → `MemoryConsolidator.getStats` → PostgreSQL aggregate query다.
3. `COUNT(*)`, `COUNT(DISTINCT ...)`, `COUNT(*) FILTER (...)`, `SUM(access_count)`는 node-postgres에서 bigint 문자열로 반환된다. 기존 구현은 `total_tokens`만 `parseInt`했으므로 `total`과 나머지 count 필드가 문자열로 MCP 응답에 남았다.
4. 숫자 계약 근거는 기존 통합/e2e 테스트의 strict numeric assertion (`stats.stats.total === 1`, `result.stats.total === 1`)과 workspace 통계 요약 함수의 숫자 반환 타입·테스트다. 따라서 테스트 assertion을 느슨하게 하지 않고 production entrypoint에서 정규화했다.

## 변경 범위

`MemoryConsolidator.getStats()`에서 다음 SQL count 계열 필드와 `total_accesses`·`total_tokens`를 정수로 정규화한다.

`total`, `permanent`, `hot`, `warm`, `cold`, `embedded`, `topic_count`, `error_count`, `preference_count`, `decision_count`, `procedure_count`, `fact_count`, `relation_count`, `total_accesses`, `total_tokens`

기존 `avg_importance`·`avg_utility`의 문자열 포맷, 스코프 SQL 및 workspace 요약 로직은 변경하지 않았다.

## TDD 증거

- RED: realistic pg bigint string fixture로 회귀 테스트를 먼저 실행했을 때 `total must be a number`, `'string' !== 'number'`로 실패했다.
- GREEN: production boundary에 최소 정규화를 추가한 뒤 같은 테스트가 통과했다.

### 엄격 검증 보강

- RED: `"12abc"`, `"1.5"`, 음수, `NaN`, 빈 문자열, `Number.MAX_SAFE_INTEGER + 1`을 먼저 넣었을 때 기존 `parseInt`가 일부를 통과시켜 `Missing expected rejection`이 발생했다.
- GREEN: canonical decimal digit string만 허용하고 `BigInt`로 안전 범위를 먼저 확인한 뒤 `Number`로 변환하도록 수정했다. JS 숫자 입력도 `Number.isSafeInteger`와 비음수 조건을 통과해야 한다.
- SQL `SUM`인 `total_accesses`·`total_tokens`만 null/undefined를 0으로 대체하며, `COUNT` 계열 null/undefined는 필드 오류로 거부한다.

### bigint 정책

운영 경계의 node-postgres 기본 파서는 PostgreSQL `bigint`를 native `BigInt`가 아닌 십진 문자열로 반환한다. 따라서 이 공개 경계는 canonical 십진 문자열과 안전한 JavaScript 숫자만 허용하며, native `BigInt` 입력은 거부한다. custom bigint parser/타입 오버라이드는 이 경계에서 지원하지 않는다.

## 검증

- 집중 통계 테스트: `memory-stats-workspaces.test.js` — 5/5 통과
- 현재 관련 집중 명령(5개 test file) — 45 tests, 11 suites, 45 pass, 0 fail, 0 cancelled
- `npx eslint` (production 1개 + 관련 test 2개) — 통과
- `node --check` (production 1개 + 관련 test 2개) — 통과
- `git diff --check` — 통과
- null/undefined, canonical `0`/`1`, `Number.MAX_SAFE_INTEGER` 허용 및 malformed/negative/unsafe 값 거부 회귀 테스트 — 통과

## 제한 사항

Docker/full security pilot은 요청대로 실행하지 않았다. 따라서 이 커밋만으로 새 PostgreSQL 파일럿 6/6 재실행을 주장하지 않으며, 별도 승인 후 새 run에서 대표 통합 흐름을 다시 확인해야 한다.
