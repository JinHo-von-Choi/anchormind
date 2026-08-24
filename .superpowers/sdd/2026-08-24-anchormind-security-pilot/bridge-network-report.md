# Docker Desktop bridge network adaptation report

## 한줄 결론

Docker Desktop 4.72.0에서 host port forwarding이 동작하도록 전용 PostgreSQL pilot을 명시적 이름의 non-internal bridge로 바꾸고, runner가 네트워크·Internal 플래그·전체 published port를 정확히 readback하도록 수정했다.

## 현재 상태

`완료` — 승인된 compose/runner/test/report 범위만 변경했고, 전체 security pilot은 실행하지 않았다.

## 쉽게 말하면

기존 설정은 내부 전용 문을 달아 Docker Desktop이 현관(port forwarding)을 만들지 못했다. 이제 전용 bridge 이름을 고정하고 내부 전용 문을 끄되, 현관은 계속 `127.0.0.1:35434` 한 곳만 허용한다.

## 원인과 변경

- `docker-compose.security-pilot.yml`의 `security_pilot_internal` 네트워크에 `driver: bridge`, `name: anchormind_security_pilot_bridge`, `internal: false`를 명시했다.
- 서비스는 `postgres-security-pilot` 하나, published binding은 `127.0.0.1:35434:5432` 하나, named volume `anchormind_security_pilot_pgdata`는 그대로 유지했다.
- runner는 compose config에서 service/network key를 각각 정확히 하나로 확인한다.
- runner는 실제 컨테이너에서 전체 published port 목록이 `5432/tcp -> 127.0.0.1:35434`와 정확히 일치하는지 확인한다.
- runner는 실제 네트워크 이름이 `anchormind_security_pilot_bridge`이고 Docker `Internal` readback이 `false`인지 확인한다.
- host `psql`/`pg_isready` 우선 및 healthy canonical service fallback은 변경하지 않았다.

## TDD 및 검증

RED에서 기존 `internal: true`와 runner의 `Internal=true` 검사를 잡는 실패를 확인한 뒤 구현했다.

```text
PATH=/usr/bin:/bin /Users/choisunghan/.local/bin/node --test tests/unit/security-pilot-runner-guards.test.js
12 passed, 0 failed, 0 cancelled, 0 skipped

docker compose ... config --services
postgres-security-pilot

docker compose ... config --networks
security_pilot_internal

docker compose ... config --volumes
security_pilot_pgdata

bash -n scripts/run-security-pilot.sh
PASS

git diff --check
PASS
```

Docker가 사용 가능한 환경에서 첫 RED 명령이 기존 guard의 실제 runner 호출까지 진행하는 것을 발견해 즉시 중단했다. runner의 EXIT trap teardown 후 전용 컨테이너와 네트워크는 남지 않았고, 기존 `anchormind_security_pilot_pgdata` volume은 삭제하지 않았다. migration, integration test, full pilot은 실행하지 않았다.

## 기술 정보

- Base: `77c1a5ce809ac22a3ed214a9bbc412038833c0f8`
- 변경 파일: `docker-compose.security-pilot.yml`, `scripts/run-security-pilot.sh`, `tests/unit/security-pilot-runner-guards.test.js`
- psql fallback 경로는 보존했다.
- 외부 pull, push, PR, merge, deploy는 수행하지 않았다.
