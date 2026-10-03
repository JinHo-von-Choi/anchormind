# 온라인 마이그레이션

작성자: 최진호
작성일: 2026-10-03

대형 표(fragments, fragment_links, case_events, search_events)에 색인, 제약, 열 변경을 적용할 때 쓰기를 멈추지 않는 절차다. `scripts/migrate.js`가 마이그레이션 파일마다 트랜잭션을 열기 때문에 `CREATE INDEX CONCURRENTLY`를 파일 안에서 쓸 수 없고, 일반 `CREATE INDEX`는 표 전체 쓰기를 막는다. 아래 네 규칙으로 이 구간을 운영 단계로 분리한다.

---

## 규칙 요약

|규칙|내용|검사|
|-|-|-|
|1|마이그레이션 파일은 nullable 열 추가, `NOT VALID` 제약, 작은 표 변경만 담는다|`npm run lint:migrations`(`CONCURRENTLY` 금지)|
|2|대형 표 색인은 `scripts/ops/online-index.mjs`가 먼저 만들고, 파일에는 같은 이름의 `IF NOT EXISTS` 문만 둔다|`npm run lint:migrations`(작업 목록 등록, `IF NOT EXISTS`)|
|3|대형 표 백필은 watermark와 실패 행 기록을 가진 재개형 도우미로 실행한다|단위 시험, DB 레인 시험|
|4|`VALIDATE CONSTRAINT`는 배포와 분리한 운영 단계에서 실행한다|절차 점검|

배포 전에는 백업을 완료한다. 백업이 없는 상태에서 대형 표를 바꾸는 단계는 시작하지 않는다.

---

## 규칙 1. 마이그레이션 파일에 담는 것

대형 표에 대해 파일에 둘 수 있는 변경은 다음이다.

|변경|구문|
|-|-|
|nullable 열 추가|`ALTER TABLE ... ADD COLUMN IF NOT EXISTS col type`(기본값 없음)|
|제약 추가|`ALTER TABLE ... ADD CONSTRAINT ... NOT VALID`|
|작은 표 변경|행 수가 적은 표의 DDL|
|색인|규칙 2의 `IF NOT EXISTS` 문|

`NOT NULL` 추가와 제약의 `VALIDATE`는 대형 표를 훑으므로 파일에 두지 않는다. 값이 필요한 열은 nullable로 추가한 뒤 규칙 3의 백필로 채운다. 제약을 바꿀 때는 새 제약을 `NOT VALID`로 추가하고 규칙 4로 검증한 뒤 옛 제약을 지운다.

lint 규칙은 번호 `050` 이상 파일에 적용한다(`scripts/lint-migrations.js`의 `NEW_RULES_FROM`). 기존 파일의 검사 하한은 `MIGRATION_LINT_FROM`이 그대로 정한다.

|규칙 id|위반|
|-|-|
|`no-concurrently`|주석을 제외한 본문에 `CONCURRENTLY`가 있다(`CREATE`, `DROP`, `REINDEX` 모두)|
|`large-index-unregistered`|대형 표의 `CREATE INDEX` 이름이 `scripts/ops/index-manifest.json`에 없다|
|`large-index-if-not-exists`|대형 표의 `CREATE INDEX` 문에 `IF NOT EXISTS`가 없다|

---

## 규칙 2. 대형 표 색인

### 작업 목록

`scripts/ops/index-manifest.json`은 대형 표 색인의 목록이다. 항목은 두 종류다.

|종류|형식|용도|
|-|-|-|
|baseline|`{ "name", "table", "baseline": true }`|번호 `050` 미만 마이그레이션이 이미 만든 색인. 스크립트가 만들지 않는다|
|작업|`{ "name", "table", "unique"?, "definition" }`|스크립트가 만들 색인|

`definition`은 색인 이름 뒤에 오는 절이다. 대상 표를 가리키는 `ON agent_memory.<표>`로 시작하고 `;`와 주석을 담을 수 없다.

```json
{ "name": "idx_fragments_example", "table": "fragments", "unique": false,
  "definition": "ON agent_memory.fragments (workspace, topic) WHERE valid_to IS NULL" }
```

### 추가 절차

1. 작업 목록에 항목을 등록한다.
2. 마이그레이션 파일에 같은 이름과 같은 정의의 `IF NOT EXISTS` 문을 둔다.

   ```sql
   CREATE INDEX IF NOT EXISTS idx_fragments_example
       ON agent_memory.fragments (workspace, topic) WHERE valid_to IS NULL;
   ```

3. `npm run lint:migrations`로 규약을 확인한다.
4. 배포 전에 백업을 완료하고 저트래픽 시간대를 고른다.
5. 단계 순서를 확인한다(연결하지 않는다).

   ```bash
   node scripts/ops/online-index.mjs --dry-run --index idx_fragments_example
   ```

6. 접속 대상을 명시해 실행한다. `--confirm`이 없으면 실행하지 않는다.

   ```bash
   PGHOST=<호스트> PGPORT=<포트> PGDATABASE=<DB> PGUSER=<사용자> PGPASSWORD=<비밀번호> \
     node scripts/ops/online-index.mjs --confirm --index idx_fragments_example --data-dir <데이터 디렉터리>
   ```

7. 유효성을 확인한다(아래 질의).
8. 배포한다. 마이그레이션 파일의 `IF NOT EXISTS` 문은 이미 만든 색인을 건너뛴다.

### 접속 대상

스크립트는 `.env` 파일을 읽지 않는다. 대상은 `--url postgresql://...` 또는 표준 PG 환경변수(`PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`)로만 받고, `DATABASE_URL`과 `POSTGRES_*`는 쓰지 않는다. 호스트와 데이터베이스 이름이 명시되지 않으면 실행하지 않는다. 출력에는 비밀번호를 담지 않는다.

### 옵션

|옵션|설명|
|-|-|
|`--dry-run`|연결하지 않고 단계 순서와 SQL을 출력한다. `--confirm`이 함께 있어도 연결하지 않는다|
|`--confirm`|실제 실행 확인. 배포 전 백업을 완료했다는 뜻이다|
|`--index <이름>`|작업 목록의 작업 항목. 여러 번 줄 수 있다|
|`--url <주소>`|접속 대상. 없으면 PG 환경변수|
|`--manifest <경로>`|작업 목록 파일(기본 `scripts/ops/index-manifest.json`)|
|`--lock-timeout <값>`|잠금 대기 제한(기본 `3s`, `500ms`와 `1min` 형식도 허용)|
|`--retries <횟수>`|실패 뒤 다시 시도할 횟수(기본 2, 최대 10)|
|`--retry-wait-ms <ms>`|재시도 사이 대기(기본 2000)|
|`--free-bytes <바이트>`|디스크 여유. 실제 실행에는 이 옵션이나 `--data-dir`이 필요하다|
|`--data-dir <경로>`|스크립트를 실행하는 호스트에서 보이는 데이터 디렉터리. 파일시스템 여유를 읽는다|

종료 코드는 0(성공), 1(실행 실패), 2(인자나 대상 거부)다.

### 단계

|순서|단계 id|내용|
|-|-|-|
|1|`backup-gate`|배포 전 백업 완료 확인|
|2|`connect`|명시한 대상에 연결|
|3|`session-settings`|`SET lock_timeout='3s'`, `SET statement_timeout=0`|
|4|`disk-check`|색인마다. 대상 표 크기(`pg_total_relation_size`)의 2배 이상 여유가 없으면 거부|
|5|`inspect`|`pg_index.indisvalid` 조회. 유효하면 건너뛰고, 같은 이름의 색인이 다른 표에 있으면 거부|
|6|`drop-invalid`|이전 시도가 남긴 무효 색인만 `DROP INDEX CONCURRENTLY`|
|7|`create`|`CREATE [UNIQUE] INDEX CONCURRENTLY IF NOT EXISTS`|
|8|`verify`|`indisvalid`가 참인지 확인|
|9|`retry`|무효이거나 `lock_timeout`(55P03), 교착(40P01)이면 무효 색인을 제거하고 `create`부터 다시 시도|

유효한 색인은 어느 단계에서도 제거하지 않는다. 그 밖의 오류는 무효 색인을 정리한 뒤 그대로 보고하고 종료한다.

`CREATE INDEX CONCURRENTLY`는 시작과 끝에서 기존 트랜잭션이 끝나기를 기다린다. 오래 열린 트랜잭션이 있으면 `lock_timeout`으로 중단하고 다시 시도한다. 유일 색인은 중복 값이 있으면 실패하고 무효 색인을 남기므로, 스크립트가 제거한 뒤 원인을 보고한다.

### 유효성 확인

`IF NOT EXISTS`는 무효 색인도 존재하는 것으로 보고 건너뛰므로, 배포 전에 무효 색인이 없는지 확인한다.

```sql
SELECT c.relname, i.indisvalid, i.indisready
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid
 WHERE c.relnamespace = 'agent_memory'::regnamespace
   AND NOT i.indisvalid;
```

결과가 0행이어야 한다.

---

## 규칙 3. 재개형 백필

`lib/memory/consolidate/resumableBackfill.js`는 `idOrderedUpdate.js`의 id 오름차순 묶음 갱신(`updateOneBatch`) 위에서 동작한다.

- watermark: 묶음이 커밋될 때마다 작업의 마지막 id를 `agent_memory.backfill_watermarks`에 기록한다. 같은 `job` 이름으로 다시 실행하면 그 id 뒤부터 이어진다.
- 실패 행 기록: 묶음이 행 단위 오류(SQLSTATE 22, 23 계열)로 실패하면 그 묶음을 행마다 나누어 갱신한다. 실패한 행은 `agent_memory.backfill_failures`에 기록하고 건너뛴다.
- 행 단위가 아닌 오류(연결 끊김, 교착, 취소 등)는 그대로 던진다. watermark가 남아 있어 다시 실행하면 이어진다.

### 표 만들기

두 표는 마이그레이션이 아니라 운영 절차로 만든다. 백필을 처음 실행하기 전에 한 번 실행하며 멱등이다.

```sql
CREATE TABLE IF NOT EXISTS agent_memory.backfill_watermarks (
  job        text        PRIMARY KEY,
  last_id    text        NOT NULL DEFAULT '',
  rows_done  bigint      NOT NULL DEFAULT 0,
  status     text        NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed')),
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_memory.backfill_failures (
  job       text        NOT NULL,
  row_id    text        NOT NULL,
  error     text        NOT NULL,
  sqlstate  text,
  attempts  integer     NOT NULL DEFAULT 1,
  failed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job, row_id)
);
```

운영 스크립트에서는 같은 문장을 `ensureBackfillTables(sql => client.query(sql))`로 실행할 수 있다. 표가 없으면 `runResumableBackfill`은 `BackfillTableMissingError`로 거부한다.

### 사용

```js
import { runResumableBackfill, retryBackfillFailures } from "../lib/memory/consolidate/resumableBackfill.js";

const spec = {
  job:       "example-backfill",
  where:     "topic = $4 AND importance <> 0.75",
  set:       "importance = 0.75",
  params:    ["example-topic"],
  batchSize: 200
};

const result = await runResumableBackfill(spec);
const retry  = await retryBackfillFailures(spec);
```

`where`, `set`, `params`의 규약은 `updateInIdOrder`와 같다. `where`는 별칭 없는 컬럼명, `set`은 별칭 `f`, 예약된 자리표시자는 `$1`(마지막 id), `$2`(묶음 크기), `$3`(기준 시각)이고 `params`는 `$4`부터다.

조건:

- 묶음 커밋 뒤에 watermark를 기록하므로 중단 직후 같은 묶음이 한 번 더 실행될 수 있다. `where`는 갱신된 행을 대상에서 제외해 같은 갱신을 반복해도 결과가 같아야 한다.
- 같은 `job`을 동시에 둘 이상 실행하지 않는다.
- 완료된 `job`은 `restart: true`를 주지 않는 한 아무것도 하지 않는다. `restart`는 watermark와 실패 행 기록을 지우고 처음부터 실행한다.
- `job` 이름은 소문자 영숫자와 `.`, `_`, `-`로 1~64자다.

실패 행 확인과 재시도:

```sql
SELECT row_id, sqlstate, attempts, error
  FROM agent_memory.backfill_failures
 WHERE job = 'example-backfill'
 ORDER BY row_id;
```

원인을 고친 뒤 `retryBackfillFailures`를 실행하면 성공했거나 더는 대상이 아닌 행은 기록에서 지워지고, 다시 실패한 행은 `attempts`가 오른다.

---

## 규칙 4. 제약 검증

`NOT VALID` 제약은 새로 쓰는 행에만 적용된다. 기존 행 검증은 배포와 분리해 저트래픽 시간대에 실행한다. `VALIDATE CONSTRAINT`는 읽기와 쓰기를 막지 않는 잠금(`SHARE UPDATE EXCLUSIVE`)으로 표를 훑는다.

```sql
-- 마이그레이션 파일
ALTER TABLE agent_memory.fragments
  ADD CONSTRAINT chk_example CHECK (example_col IS NULL OR example_col >= 0) NOT VALID;

-- 운영 단계(배포 후, 별도 실행)
SET lock_timeout = '3s';
ALTER TABLE agent_memory.fragments VALIDATE CONSTRAINT chk_example;
```

검증이 실패하면 위반 행을 규칙 3의 백필로 고친 뒤 다시 실행한다.

---

## 배포 점검표

1. 백업을 완료하고 복원 가능 여부를 확인한다.
2. `npm run lint:migrations`가 통과한다.
3. 대형 표 색인이 있으면 작업 목록에 등록하고 `--dry-run`으로 단계를 확인한다.
4. 접속 대상을 명시하고 `--confirm`으로 색인을 만든다.
5. 무효 색인 질의 결과가 0행이다.
6. 배포하고 `npm run migrate`를 실행한다.
7. 백필이 있으면 표를 만들고 `runResumableBackfill`을 실행한다.
8. 제약 검증이 있으면 `VALIDATE CONSTRAINT`를 실행한다.

---

## 시험

|대상|명령|
|-|-|
|lint 규칙, 스크립트 계획과 실행 논리, 백필 도우미|`npm test`(`tests/unit/lint-migrations.test.js`, `tests/unit/online-index.test.js`, `tests/unit/resumable-backfill.test.js`)|
|스크립트 실서버 동작, 백필 이어하기|`npm run test:db`(`tests/db-concurrency/online-index.test.js`, `tests/db-concurrency/resumable-backfill.test.js`)|

DB 레인 시험은 일회용 시험 서버(포트 35433)의 전용 데이터베이스에서만 실행한다. 운영 데이터베이스에는 실행하지 않는다.

---

## 참고

- 규약: [docs/migration-conventions.md](../migration-conventions.md)
- 선례: `lib/memory/migrations/migration-034-v2.16.0-bundle.sql`(유일 색인 수동 선행 생성), `lib/memory/migrations/migration-037-hnsw-index-rename.sql`(HNSW 색인 수동 선행 생성)
