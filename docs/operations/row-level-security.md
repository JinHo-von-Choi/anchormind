# 행 수준 보안 적용 절차

작성자: 최진호
작성일: 2026-08-29

---

## 현재 상태

`agent_memory.fragments`와 `agent_memory.fragment_links`에 행 수준 보안이 켜져 있고 격리 정책이 걸려 있다(migration-045). 다만 `FORCE ROW LEVEL SECURITY`는 적용하지 않았다.

PostgreSQL은 표 소유자에게 정책을 적용하지 않는다. 애플리케이션이 표 소유자 계정으로 접속하는 배포에서는 정책이 걸려 있어도 런타임 질의에 아무 영향이 없다. 즉 지금 키 간 격리를 실제로 지키는 것은 애플리케이션 질의 필터(`lib/memory/keyScope.js`) 한 겹이다.

DB를 두 번째 방어선으로 세우려면 아래 절차가 필요하다. 이 절차는 배포 형상을 바꾸므로 운영자가 판단해 수행한다.

---

## 정책이 보는 두 축

| 축 | 세션 변수 | 동작 |
|-|-|-|
| 에이전트 | `app.current_agent_id` | 값이 일치하거나 행이 `default`이면 허용. `system`과 `admin`은 전체 허용 |
| API 키 | `app.current_key_id` | 값이 비어 있으면 키 범위 없음으로 보고 종전대로 동작. 값이 있으면 그 키 소유 행만 허용 |

두 변수는 `lib/tools/db.js`의 `queryWithAgentVector`가 설정한다. 키 값은 호출부가 `opts.keyId`로 넘길 때만 채워진다.

이 설계 때문에 `opts.keyId`를 넘기지 않는 기존 호출부는 FORCE를 켜도 키 축 필터를 받지 않는다. DB 격리를 온전히 얻으려면 키 범위가 있는 모든 질의가 `opts.keyId`를 넘기도록 먼저 정리해야 한다.

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

### 2. 키 범위 전달 정리

키 범위가 있는 질의가 `opts.keyId`를 넘기는지 확인한다. 넘기지 않는 질의는 FORCE 적용 후에도 DB 수준 키 격리를 받지 못한다.

```
grep -rn "queryWithAgentVector" lib/ --include=*.js | wc -l
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
