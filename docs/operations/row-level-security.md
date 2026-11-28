# 행 수준 보안 적용 절차

작성자: 최진호
작성일: 2026-08-29

---

## 현재 상태

`agent_memory.fragments`와 `agent_memory.fragment_links`에는 행 수준 보안이 켜져 있고 격리 정책도 걸려 있다(migration-045, 키 목록은 migration-080). 표에 `FORCE ROW LEVEL SECURITY`는 걸지 않았다.

PostgreSQL은 표 소유자에게 정책을 적용하지 않는다. 애플리케이션이 표 소유자 계정으로 접속하는 배포에서는 정책이 걸려 있어도 런타임 질의에 아무 영향이 없다. 즉 지금 키 간 격리를 실제로 지키는 것은 애플리케이션 질의 필터(`lib/memory/keyScope.js`) 한 겹이다.

DB를 두 번째 방어선으로 세우려면 아래 절차가 필요하다. 이 절차는 배포 형상을 바꾸므로 운영자가 판단해 수행한다.

---

## 정책이 보는 두 축

| 축 | 세션 변수 | 동작 |
|-|-|-|
| 에이전트 | `app.current_agent_id` | 값이 일치하거나 행이 `default`이면 허용. `system`과 `admin`은 전체 허용 |
| API 키 | `app.current_key_ids`, `app.current_key_id` | 둘 다 비어 있으면 키 범위 없음으로 보고 종전대로 동작. 값이 있으면 목록(쉼표로 잇는다) 안의 키 소유 행만 허용. 키 없는(마스터) 행은 허용하지 않는다 |

변수는 두 실행기가 설정한다.

- `lib/tools/db.js`의 `queryWithAgentVector`는 에이전트와 키 목록을 함께 건다.
- `lib/tools/row-scope.js`의 `queryScoped`, `applyRowScope`, `beginScoped`는 풀로 바로 보내는 질의와 자체 트랜잭션에 키 목록이나 주체를 건다. 관리 API와 CLI의 질의는 `admin`, 백그라운드 작업(정리 주기, 임베딩 작업자, 스케줄러, 할당량 회계, 기동 점검)은 `system` 주체로 실행한다.

`row-scope.js`의 실행기는 정책이 접속 역할에 적용될 때만 설정을 건다. 표 소유자로 접속하고 FORCE가 꺼진 구성에서는 질의를 그대로 보내므로 왕복이 늘지 않는다. 적용 여부는 `row_security_active()`로 확인해 1분 동안 기억한다. FORCE를 켜거나 끄면 1분 안에 반영된다.

키 목록(`app.current_key_ids`)에는 질의의 키 격리 절이 넣은 키가 들어간다. `lib/memory/keyScope.js`의 도우미(`keyScopeClause` 등)는 절에 넣은 키 id를 바인딩 배열의 기호 속성에 적고(`lib/tools/key-scope-ids.js`), 실행기가 그 목록을 넘긴다. 그룹 공유 읽기는 자기 키와 읽을 수 있는 멤버 키가 함께 목록에 들어가므로 정책을 통과한다. 바인딩 배열을 펼쳐 새 배열을 만들면 목록이 따라가지 않으므로 같은 배열을 실행기에 넘긴다.

정책이 키 축을 보지 않는 질의는 두 가지다.

- 마스터 키 요청. 키 목록이 비어 있고, 정책은 빈 값을 키 범위 없음으로 읽는다.
- 앞선 범위 질의가 고른 id로만 쓰는 후속 문장(접근 수 갱신, 링크 기록, 삭제 뒤 참조 정리). SQL에 키 조건이 없어서 키 목록을 넘기지 않고 에이전트 축만 받는다.

`queryScoped`로 보내는 요청 경로 질의는 에이전트 변수를 걸지 않는다. 그래서 정책이 적용되는 접속에서는 `default` 에이전트의 행만 읽는다. `agentId`를 나눠 쓰는 배포는 3단계에서 해당 경로의 결과를 확인한다.

---

## 적용 절차

### 1. 런타임 역할 분리

마이그레이션 소유자와 애플리케이션 런타임 계정을 나눈다. 런타임 계정은 표 소유자가 아니어야 하고 `BYPASSRLS` 속성이 없어야 한다.

```sql
CREATE ROLE memento_runtime LOGIN PASSWORD '<강한 암호>' NOBYPASSRLS;
GRANT USAGE ON SCHEMA agent_memory TO memento_runtime;
```

사용하는 요청과 작업 경로에 맞춰 필요한 테이블·시퀀스·함수 권한을 부여한다. 스테이징에서 서버의 `POSTGRES_USER`를 이 계정으로 바꾸어 검증한다. 마이그레이션은 소유자 계정으로 실행한다.

### 2. 키 범위 전달 확인

정책 자체는 `tests/db-concurrency/rls-key-list.test.js`가 FORCE와 소유자가 아닌 역할(NOBYPASSRLS)로 확인한다. 이 시험은 키 목록 안의 키 파편만 보이는지, 목록이 비면 키 축을 보지 않는지 본다. system 주체가 전체를 보는지, 목록 밖 키의 행을 쓸 수 없는지도 본다. 키 격리 절의 키 목록이 `queryWithAgentVector`와 `queryScoped`를 거쳐 `app.current_key_ids`로 넘어가는지도 확인한다.

```
DOTENV_CONFIG_PATH=.env.test REDIS_ENABLED=false node --experimental-test-module-mocks --test tests/db-concurrency/rls-key-list.test.js
```

두 표를 건드리는 질의가 실행기를 거치는지는 구조 검사가 본다. 풀에 바로 보내는 질의, 범위를 걸지 않은 자체 트랜잭션, 키 조건을 손으로 쓰고 키 목록을 넘기지 않는 질의가 있으면 실패한다.

```
node --test tests/structure/row-scope.test.js
```

### 3. 스테이징 검증

운영과 같은 스키마의 별도 DB에서 비소유자 런타임 역할로 전 도구 경로를 돌린다. 최소한 remember, recall, context, link, amend, forget, reflect, memory_stats, 관리자 가져오기와 작업자가 정상 응답해야 한다.

```bash
anchormind health --check-rls --strict --json
```

명령은 현재 CLI의 주 DB 접속을 검사한다. `MEMENTO_DB_REQUIRE_RLS=true`로 서버를 시작하면 주 DB와 배치 DB 모두에서 정책 적용, 표 소유자 권한, 우회 역할의 접근 가능성을 검사한다. 실패하면 요청 수신을 시작하기 전에 종료 코드 78로 끝난다. 이 검사는 권한 행렬과 업무별 동작 시험을 보완한다.

마이그레이션 087 이후에는 후보 런타임 역할에 `ALTER ROLE memento_runtime IN DATABASE memento SET app.require_row_scope = 'on';`을 적용해 키·전역·서비스 스코프가 없는 트랜잭션을 거부할 수 있다. 새 연결부터 적용된다. 켜진 연결의 기동 점검은 `required_row_scope` 정책도 확인한다. 구 버전 앱이 사용하는 DB 역할에는 기존 설정을 유지한다.

TLS는 `NODE_EXTRA_CA_CERTS`에 승인된 사설 CA 파일을 지정하고 인증서 이름과 같은 `POSTGRES_HOST`에 `PGSSLMODE=verify-full`로 연결해 확인한다. 배치 DB에 별도 URL을 쓰면 해당 URL에도 검증 옵션을 적용한다. 승인한 CA와 올바른 호스트 이름으로만 연결되는지 검증한 뒤 런타임 설정을 전환한다.

소유자 경로까지 RLS를 적용하는 경우에는 마이그레이션·백업·복원 절차를 먼저 검증한 뒤 아래 설정도 시험한다.

```sql
ALTER TABLE agent_memory.fragments      FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_memory.fragment_links FORCE ROW LEVEL SECURITY;
```

검증 질의:

```sql
SET app.current_agent_id = 'default';
SET app.current_key_id   = '<키 A>';
SELECT count(*) FROM agent_memory.fragments WHERE key_id = '<키 B>';
```

결과가 0이어야 한다. 애플리케이션 필터 없이 DB만으로 막히는지를 보는 것이 목적이다.

### 4. 운영 적용

스테이징에서 전 경로가 통과하면 검증된 비소유자 역할과 동일한 정책으로 전환하고 연결 풀을 다시 연다. `/health/ready`와 허용된 호출, 범위가 제한된 호출을 확인한다.

재개 가져오기의 체크포인트는 작업을 만든 DB 역할에 연결된다. 역할 교체 전에 `agent_memory.import_jobs`의 미완료 작업을 기존 역할에서 끝내고 신규 가져오기 요청을 잠시 멈춘다. 교체 후에는 새 역할로 가져오기를 재개한다.

---

## 되돌리기

같은 비소유자 역할과 정책에서 검증한 앱 버전으로 되돌린다. 연결 풀을 다시 열고 기존 허용 경로와 제한 범위를 확인한다. 이 조건을 만족하는 버전이 없으면 검증을 마칠 때까지 영향받는 요청을 차단한다.

---

## 확인 질의

현재 상태를 보려면 다음을 쓴다.

```sql
SELECT c.relname, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'agent_memory'
   AND c.relname IN ('fragments', 'fragment_links');

SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'agent_memory';
```
