# 마이그레이션 규약

작성자: 최진호
작성일: 2026-05-13

---

## 파일명 규약

- 형식: `migration-NNN-<kebab-slug>.sql`
- `NNN`은 3자리 0-패딩 연속 번호 (예: `036`, `037`)
- 슬러그는 소문자 영숫자와 하이픈만 허용
- 예: `migration-036-add-session-index.sql`
- 번호 충돌이 발생하면 머지 시점에 +1 하여 재번호 부여

---

## body-only 규약

`scripts/migrate.js`는 각 파일을 외부 트랜잭션으로 감싸고 적용 이력 등록을 자동 처리한다.
따라서 마이그레이션 파일 본문에 다음을 작성하지 않는다.

### BEGIN / COMMIT 래퍼 작성 금지

`migrate.js`가 `BEGIN` / `COMMIT` / `ROLLBACK`을 외부에서 제어한다.
파일 안에 이 구문을 포함하면 중첩 트랜잭션이 발생하거나 오류가 생긴다.

금지 예시:

```sql
-- 작성 금지
BEGIN;
ALTER TABLE agent_memory.fragments ADD COLUMN foo text;
COMMIT;
```

허용 예시:

```sql
ALTER TABLE agent_memory.fragments ADD COLUMN foo text;
```

### schema_migrations INSERT 작성 금지

`migrate.js`는 SQL 실행 후 자동으로 다음을 수행한다.

```sql
INSERT INTO agent_memory.schema_migrations (filename) VALUES ($1);
```

파일 본문에 이 INSERT를 직접 작성하지 않는다.

---

## opclass placeholder

벡터 인덱스를 생성할 때 `vector_cosine_ops` 를 그대로 작성한다.
`migrate.js`는 실행 시점에 실제 embedding 컬럼 타입(vector / halfvec)을 검사하여
`vector_cosine_ops` 또는 `halfvec_cosine_ops` 로 일괄 치환한다.

허용 예시:

```sql
CREATE INDEX IF NOT EXISTS idx_fragments_embedding
    ON agent_memory.fragments
    USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);
```

환경별로 opclass를 분기하는 코드를 파일 안에 작성할 필요가 없다.

---

## 멱등성 패턴

동일 마이그레이션이 두 번 적용되더라도 오류가 발생하지 않도록 DDL에 멱등 조건을 명시한다.

| 작업 | 권장 구문 |
|-|-|
| 테이블 생성 | `CREATE TABLE IF NOT EXISTS` |
| 인덱스 생성 | `CREATE INDEX IF NOT EXISTS` |
| 컬럼 추가 | `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` |
| 타입 생성 | `CREATE TYPE IF NOT EXISTS` (PG 9.6 이상 불가 시 `DO $$ BEGIN ... EXCEPTION WHEN duplicate_object THEN NULL; END $$`) |
| 시퀀스 생성 | `CREATE SEQUENCE IF NOT EXISTS` |

---

## 새 마이그레이션 추가 절차

1. 현재 가장 높은 번호를 확인한다.

   ```sh
   ls lib/memory/migrations/migration-*.sql | sort | tail -1
   ```

2. 다음 번호로 파일을 생성하고 body-only 규약과 멱등성 패턴을 적용한다.

3. lint를 실행하여 규약 위반이 없는지 확인한다.

   ```sh
   npm run lint:migrations
   ```

4. 마이그레이션을 실제 DB에 적용한다.

   ```sh
   npm run migrate
   ```

---

## 기존 파일 처리 방침

번호 `035` 이하의 기존 파일(cutoff 이전)은 lint 대상에서 제외된다.
`MIGRATION_LINT_FROM` 환경변수로 cutoff를 조정할 수 있다.

향후 추가되는 파일(번호 `036` 이상)만 위 규약 준수가 강제된다.
