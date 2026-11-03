# 행 수준 보안 적용 절차

작성자: 최진호
작성일: 2026-08-29

---

## 현재 상태

`agent_memory.fragments`와 `agent_memory.fragment_links`에 행 수준 보안이 켜져 있고 격리 정책이 걸려 있다(migration-045, 키 목록은 migration-080). 다만 `FORCE ROW LEVEL SECURITY`는 적용하지 않았다.

PostgreSQL은 표 소유자에게 정책을 적용하지 않는다. 애플리케이션이 표 소유자 계정으로 접속하는 배포에서는 정책이 걸려 있어도 런타임 질의에 아무 영향이 없다. 즉 지금 키 간 격리를 실제로 지키는 것은 애플리케이션 질의 필터(`lib/memory/keyScope.js`) 한 겹이다.

DB를 두 번째 방어선으로 세우려면 아래 절차가 필요하다. 이 절차는 배포 형상을 바꾸므로 운영자가 판단해 수행한다.

---

## 정책이 보는 두 축

| 축 | 세션 변수 | 동작 |
|-|-|-|
| 에이전트 | `app.current_agent_id` | 값이 일치하거나 행이 `default`이면 허용. `system`과 `admin`은 전체 허용 |
| API 키 | `app.current_key_ids`, `app.current_key_id` | 둘 다 비어 있으면 키 범위 없음으로 보고 종전대로 동작. 값이 있으면 목록(쉼표로 잇는다) 안의 키 소유 행만 허용. 키 없는(마스터) 행은 허용하지 않는다 |

변수는 `lib/tools/db.js`의 `queryWithAgentVector`가 설정한다. `app.current_key_ids`는 질의의 키 격리 절이 넣은 키 목록이다. `lib/memory/keyScope.js`의 도우미(`keyScopeClause`, `keyScopeScalar`, `keyScopeGroup`, `keyScopeNullable`, `keyScopeNullableIndexed`, `keyScopeCondition`)가 절에 넣은 키 id를 바인딩 배열의 기호 속성에 적고(`lib/tools/key-scope-ids.js`), `queryWithAgentVector`가 그 목록을 넘긴다. 그룹 공유 읽기는 자기 키와 읽을 수 있는 멤버 키가 모두 목록에 들어가므로 정책을 통과한다.

키 격리 도우미를 쓰지 않는 질의(직접 쓴 SQL 조건, `pool.query`로 바로 보내는 관리 API 질의)와 바인딩 배열을 펼쳐 새로 만든 질의는 키 목록이 비어 FORCE를 켜도 키 축 필터를 받지 않는다. 에이전트 축은 모든 `queryWithAgentVector` 질의에 걸리지만, `pool.query`로 바로 보내는 질의는 `app.current_agent_id`가 없어 `default` 에이전트 행만 보게 된다. FORCE 전에 3단계의 전 경로 검증이 필요한 이유다.

---

## 적용 절차

### 1. 런타임 역할 분리

마이그레이션 소유자와 애플리케이션 런타임 계정을 나눈다. 런타임 계정은 표 소유자가 아니어야 하고 `BYPASSRLS` 속성이 없어야 한다.

```sql
CREATE ROLE memento_runtime LOGIN PASSWORD '<강한 암호>' NOBYPASSRLS;
GRANT USAGE ON SCHEMA agent_memory TO memento_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA agent_memory TO memento_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA agent_memory TO memento_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA agent_memory
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO memento_runtime;
```

`.env`의 `POSTGRES_USER`를 이 계정으로 바꾼다. 마이그레이션은 종전 소유자 계정으로 계속 실행한다.

### 2. 키 범위 전달 확인

정책 자체는 `tests/db-concurrency/rls-key-list.test.js`가 FORCE와 소유자 아닌 역할(NOBYPASSRLS)로 검증한다. 키 목록 안의 키 파편만 보이는지, 목록이 비면 키 축을 보지 않는지, system 주체는 전체를 보는지, 목록 밖 키의 행은 쓸 수 없는지, 키 격리 절의 키 목록이 `app.current_key_ids`로 넘어가는지 본다.

```
DOTENV_CONFIG_PATH=.env.test REDIS_ENABLED=false node --experimental-test-module-mocks --test tests/db-concurrency/rls-key-list.test.js
```

키 격리 도우미를 쓰지 않는 질의는 다음으로 찾는다.

```
grep -rn "pool.query\|\.query(" lib/admin lib/memory --include=*.js | grep -i fragments
```

### 3. 스테이징 검증

운영과 같은 스키마의 별도 DB에서 FORCE를 켜고 전 도구 경로를 돌린다. 최소한 remember, recall, context, link, amend, forget, reflect, memory_stats가 정상 응답해야 한다.

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

스테이징에서 전 경로가 통과하면 같은 DDL을 운영에 적용한다. 적용 직후 `/health`와 recall 한 건을 확인한다.

---

## 되돌리기

```sql
ALTER TABLE agent_memory.fragments      NO FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_memory.fragment_links NO FORCE ROW LEVEL SECURITY;
```

정책과 ENABLE은 남겨도 무해하다. 소유자 접속으로 돌아가면 정책이 적용되지 않으므로 종전 동작이 된다.

전면 해제가 필요하면 다음을 쓴다.

```sql
ALTER TABLE agent_memory.fragments      DISABLE ROW LEVEL SECURITY;
ALTER TABLE agent_memory.fragment_links DISABLE ROW LEVEL SECURITY;
```

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
