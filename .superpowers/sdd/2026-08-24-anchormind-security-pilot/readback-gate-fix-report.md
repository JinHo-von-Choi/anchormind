# Readback gate fix report

## 한줄 결론

보안 파일럿 런너의 Bash 3.2 assertion 무시 문제와 integration fixture 조기 삭제 문제를 수정하고, Docker 없이 집중 검증을 통과했다.

## 현재 상태

`완료` — 구현·회귀 테스트·정적 검증을 마쳤다. Docker 파일럿 자체는 실행하지 않았다.

## 변경 내용

- 런너의 compose service/network, service ID/health/port/mount/network, database/vector/dimension/count/pairs readback을 `security_pilot_require` 또는 명시적인 `if ! ...; then ...; exit` gate로 바꿨다.
- `/bin/bash` 3.2.57에서 거짓 gate가 비제로로 끝나는 회귀 테스트를 추가했다.
- `SECURITY_PILOT_DEFER_SYNTHETIC_CLEANUP=true`를 integration test 실행에만 주입했다.
- 해당 값이 정확히 `true`일 때만 integration after hook의 synthetic topic와 두 UUID key 삭제를 미루고, pool 종료와 tripwire 복원은 항상 시도하도록 했다.
- 런너가 NDJSON에서 기대 pair를 만들고 실제 multiline pair와 정확히 비교·출력한 뒤, `security-pilot-synthetic` topic과 UUID `00000000-0000-0000-0000-00000000aaaa`, `00000000-0000-0000-0000-00000000bbbb`만 삭제하고 잔여 수 `0`을 확인하도록 했다.
- EXIT trap은 DB readiness가 확인된 경우 같은 synthetic 범위만 먼저 정리하고, volume을 지우지 않는 `down --remove-orphans`를 수행한다.

## 검증 결과

- `node --test tests/unit/security-pilot-runner-guards.test.js tests/unit/security-pilot-cleanup.test.js` — 18 passed
- `/bin/bash --version` — GNU bash 3.2.57
- `bash -n scripts/run-security-pilot.sh` — 통과
- `node --check tests/integration/security-pilot.test.js` — 통과
- `node --check tests/fixtures/security-pilot-cleanup.js` — 통과
- `npx eslint tests/integration/security-pilot.test.js tests/fixtures/security-pilot-cleanup.js tests/unit/security-pilot-cleanup.test.js` — 통과
- `git diff --check` — 통과
- `scripts/run-security-pilot.sh` Docker 실행 — 하지 않음

## Round 1 cleanup 검증

- `tests/shell/security-pilot-cleanup.sh` — fake canonical `docker`/`pg_isready`/`psql` 실행 통과
- shell-level 검증 범위: exact synthetic DELETE SQL, remaining-count query 성공·비제로·query failure, canonical service 부재 시 SQL query 0회, non-synthetic fixture 행 보존, 원래 비제로 종료 코드 보존, cleanup 실패 시 성공을 비제로로 승격, teardown 실패 시 `-v` 미사용

## Round 2 lint-only 검증

- `tests/unit/security-pilot-runner-guards.test.js`의 정규식 이스케이프와 공백 표현만 수정했다.
- targeted ESLint: 0 errors
- runner guard + cleanup unit tests: 18 passed
- executable cleanup shell test: PASS
- Docker/runtime 실행: 하지 않음

## 남은 불확실성

실제 PostgreSQL/Docker 환경에서의 파일럿 E2E와 teardown readback은 이번 작업 범위에서 재실행하지 않았다. 위 결과는 런너 계약과 cleanup 순서의 로컬 집중 검증 증거다.
