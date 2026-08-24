# memory_stats 통계 타입 수정 보고서

## 한줄 결론

PostgreSQL bigint 문자열로 반환되던 `MemoryConsolidator.getStats()`의 공개 count 통계를 숫자로 정규화했고, 회귀 테스트와 관련 통계 테스트를 통과했다.

## 현재 상태

`완료` — 소스·회귀 테스트 변경은 로컬 커밋 `e609c75` (`fix: normalize memory stats count fields`)에 저장됐다. Docker/full pilot 재실행과 외부 작업은 하지 않았다.

## 쉽게 말하면

PostgreSQL이 `COUNT(*)` 결과를 `"1"`이라는 문자열로 보냈는데, MCP의 `memory_stats`는 숫자 `1`을 공개 계약으로 사용한다. DB 경계에서 count를 숫자로 바꿔 strict 비교가 일치하도록 했다.

## 원인 추적

1. 파일럿 런타임 보고서의 실패 위치는 `tests/integration/security-pilot.test.js:181`의 `stats.stats.total` 비교였고, 실제 값은 `'1'`, 기대값은 `1`이었다.
2. 호출 흐름은 `tool_memoryStats` → `MemoryManager.stats` → `MemoryReflector.stats` → `MemoryConsolidator.getStats` → PostgreSQL aggregate query다.
3. `COUNT(*)`, `COUNT(DISTINCT ...)`, `COUNT(*) FILTER (...)`, `SUM(access_count)`는 node-postgres에서 bigint 문자열로 반환된다. 기존 구현은 `total_tokens`만 `parseInt`했으므로 `total`과 나머지 count 필드가 문자열로 MCP 응답에 남았다.
4. 숫자 계약 근거는 기존 통합/e2e 테스트의 strict numeric assertion (`stats.stats.total === 1`, `result.stats.total === 1`)과 workspace 통계 요약 함수의 숫자 반환 타입·테스트다. 따라서 테스트 assertion을 느슨하게 하지 않고 production entrypoint에서 정규화했다.

## 변경 범위

`MemoryConsolidator.getStats()`에서 다음 SQL count 계열 필드와 `total_accesses`만 정수로 정규화한다.

`total`, `permanent`, `hot`, `warm`, `cold`, `embedded`, `topic_count`, `error_count`, `preference_count`, `decision_count`, `procedure_count`, `fact_count`, `relation_count`, `total_accesses`

기존 `avg_importance`·`avg_utility`의 문자열 포맷과 이미 숫자로 변환하던 `total_tokens`, 스코프 SQL 및 workspace 요약 로직은 변경하지 않았다.

## TDD 증거

- RED: realistic pg bigint string fixture로 회귀 테스트를 먼저 실행했을 때 `total must be a number`, `'string' !== 'number'`로 실패했다.
- GREEN: production boundary에 최소 정규화를 추가한 뒤 같은 테스트가 통과했다.

## 검증

- 집중 통계 테스트: `memory-stats-workspaces.test.js` — 3/3 통과
- 관련 통계·스코프 테스트 묶음 — 43/43 통과
- `npx eslint lib/memory/consolidate/MemoryConsolidator.js tests/unit/memory-stats-workspaces.test.js` — 통과
- `node --check` (소스·테스트) — 통과
- `git diff --check` — 통과

## 제한 사항

Docker/full security pilot은 요청대로 실행하지 않았다. 따라서 이 커밋만으로 새 PostgreSQL 파일럿 6/6 재실행을 주장하지 않으며, 별도 승인 후 새 run에서 대표 통합 흐름을 다시 확인해야 한다.
