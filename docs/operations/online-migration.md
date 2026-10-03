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

배포 전에는 `scripts/ops/backup.sh --label pre-migration`으로 백업을 완료한다. 백업이 없는 상태에서 대형 표를 바꾸는 단계는 시작하지 않는다. 절차는 [backup-restore.md](backup-restore.md#마이그레이션-전-백업)에 있다.

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

열 추가와 `CHECK` 제약의 `ADD CONSTRAINT ... NOT VALID`는 짧게나마 표 전체 잠금(`ACCESS EXCLUSIVE`)을 잡고, 외래 키의 `ADD CONSTRAINT ... NOT VALID`는 두 표 모두에 `SHARE ROW EXCLUSIVE` 잠금을 잡는다. 오래 열린 트랜잭션 뒤에서 이 잠금을 기다리는 동안 그 표의 읽기와 쓰기가 줄을 선다. 파일 본문 맨 위에 `SET LOCAL lock_timeout = '3s';`를 두어 대기를 3초로 제한한다. 파일은 러너가 연 트랜잭션 안에서 실행되므로 `SET LOCAL`은 그 파일에만 적용되고 커밋 뒤 사라진다. 잠금을 얻지 못하면 파일 전체가 롤백되고 같은 배포를 다시 실행한다. lint 는 이 구문을 허용한다.

```sql
SET LOCAL lock_timeout = '3s';
ALTER TABLE agent_memory.fragments ADD COLUMN IF NOT EXISTS example_col integer;
```

lint 규칙은 번호 `050` 이상 파일에 적용한다(`scripts/lint-migrations.js`의 `NEW_RULES_FROM`). 기존 파일의 검사 하한은 `MIGRATION_LINT_FROM`이 그대로 정한다.

|규칙 id|위반|
|-|-|
|`no-concurrently`|주석을 제외한 본문에 `CONCURRENTLY`가 있다(`CREATE`, `DROP`, `REINDEX` 모두)|
|`large-index-unregistered`|대형 표의 `CREATE INDEX` 이름이 `scripts/ops/index-manifest.json`에 없다. 이름이 없는 `CREATE INDEX ON ...`도 해당한다|
|`large-index-table-mismatch`|등록된 이름을 작업 목록의 표와 다른 대형 표에 쓴다|
|`large-index-if-not-exists`|대형 표의 `CREATE INDEX` 문에 `IF NOT EXISTS`가 없다|

주석과 작은따옴표 문자열 안의 단어는 검사하지 않고, `DO $$ ... $$` 블록과 함수 본문 같은 달러 인용 본문과 `EXECUTE` 바로 뒤의 작은따옴표 문자열은 코드로 검사한다. `COMMENT ... IS $$...$$`처럼 달러 인용 문자열에 `CREATE INDEX`나 `CONCURRENTLY`를 적으면 위반으로 읽히므로(허용하는 쪽이 아니라 막는 쪽으로 틀린다) 문장 설명은 작은따옴표 문자열로 쓴다.

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
4. 배포 전에 `scripts/ops/backup.sh --label pre-migration`으로 백업을 완료하고([backup-restore.md](backup-restore.md#마이그레이션-전-백업)) 저트래픽 시간대를 고른다.
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

`--url`은 호스트, 포트, 데이터베이스, 사용자, 비밀번호만 읽고 쿼리 매개변수(`sslmode` 등)는 적용하지 않는다. 쿼리 매개변수가 붙은 주소는 거부한다. `--url 주소`와 `--url=주소` 형식을 모두 받으며, 오류 메시지는 옵션 이름만 출력하고 인자의 값(주소와 비밀번호)은 출력하지 않는다.

SSL이 필요한 대상은 PG 환경변수 `PGSSLMODE`로 지정한다. 설치된 `pg`(8.23)는 환경변수 중 `PGSSLMODE`만 읽는다(`PGSSLROOTCERT`, `PGSSLCERT`, `PGSSLKEY`는 읽지 않는다). 값은 다음과 같이 해석한다.

|PGSSLMODE|동작|
|-|-|
|`disable`|SSL을 쓰지 않는다|
|`require`, `verify-ca`, `verify-full`|SSL을 쓰고 서버 인증서를 Node의 신뢰 저장소로 검증한다(세 값의 동작이 같다)|
|`no-verify`|SSL을 쓰고 서버 인증서를 검증하지 않는다|

서버 인증서가 사설 인증 기관에서 발급되었다면 `NODE_EXTRA_CA_CERTS=<CA 번들 경로>`로 신뢰 저장소에 그 인증 기관을 더한다. Node는 이 변수의 인증서를 기본 신뢰 저장소에 추가한다(`tls.getCACertificates("default")`의 개수가 1 늘어나는 것으로 확인했다).

### 옵션

|옵션|설명|
|-|-|
|`--dry-run`|연결하지 않고 단계 순서와 SQL을 출력한다. `--confirm`이 함께 있어도 연결하지 않는다|
|`--confirm`|실제 실행 확인. 배포 전 백업을 완료했다는 뜻이다|
|`--index <이름>`|작업 목록의 작업 항목. 여러 번 줄 수 있다|
|`--url <주소>`|접속 대상. 없으면 PG 환경변수|
|`--manifest <경로>`|작업 목록 파일(기본 `scripts/ops/index-manifest.json`)|
|`--lock-timeout <값>`|잠금 대기 제한(기본 `3s`, `500ms`와 `1min` 형식도 허용)|
|`--retries <횟수>`|실패 뒤 다시 시도할 횟수(기본 2, 최대 10). 시도는 최대 횟수 + 1번이다|
|`--retry-wait-ms <ms>`|첫 재시도 전 대기(기본 2000). 시도마다 두 배가 된다(2초, 4초, 8초)|
|`--retry-max-wait-ms <ms>`|재시도 대기의 상한(기본 30000)|
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
|5|`txn-check`|같은 데이터베이스에서 열려 있는 다른 트랜잭션의 수와 가장 오래된 경과 시간을 경고로 출력한다(중단하지 않는다)|
|6|`inspect`|`pg_index.indisvalid` 조회. 유효하면 건너뛰고, 같은 이름의 색인이 다른 표에 있으면 거부|
|7|`drop-invalid`|이전 시도가 남긴 무효 색인만 `DROP INDEX CONCURRENTLY`|
|8|`create`|`CREATE [UNIQUE] INDEX CONCURRENTLY IF NOT EXISTS`|
|9|`verify`|`indisvalid`가 참인지 확인|
|10|`retry`|무효이거나 `lock_timeout`(55P03), 교착(40P01)이면 무효 색인을 제거하고 대기 후 `create`부터 다시 시도. 무효 색인 제거가 55P03 으로 실패해도 다음 시도가 먼저 제거를 다시 시도한다|

유효한 색인은 어느 단계에서도 제거하지 않는다. 그 밖의 오류는 무효 색인을 정리한 뒤 그대로 보고하고 종료한다. 정리까지 실패하면 원 오류를 원인으로 담은 오류로 보고한다. 재시도를 모두 쓴 뒤에도 무효 색인이 남을 수 있으며, 이 경우 출력이 알리고 다음 실행의 첫 단계가 제거한다.

### 열린 트랜잭션과 백업

`lock_timeout`은 `CREATE INDEX CONCURRENTLY`가 기존 트랜잭션이 끝나기를 기다리는 동안에도 적용된다. 실행 중인 `pg_dump`(반복 읽기 트랜잭션)나 오래 열린 트랜잭션이 하나라도 있으면 매 시도가 대기 제한에 걸려 실패한다. 무효 색인을 지우는 `DROP INDEX CONCURRENTLY`도 같은 트랜잭션을 기다리므로 정리가 실패해 무효 색인이 남을 수 있다.

따라서 백업은 색인 단계 전에 끝나 있어야 하고, 색인 단계 중에는 시작하지 않는다. `txn-check`는 시작 전에 열린 트랜잭션 수와 가장 오래된 것의 경과 시간을 경고로 보여 준다. `pg_stat_activity`는 권한이 없으면 다른 역할의 세션을 보여 주지 않으므로 경고가 없어도 별도 확인이 필요할 수 있다. 직접 확인하는 질의는 다음과 같다.

```sql
SELECT pid, usename, state, now() - xact_start AS age, left(query, 80) AS query
  FROM pg_stat_activity
 WHERE datname = current_database() AND xact_start IS NOT NULL AND pid <> pg_backend_pid()
 ORDER BY xact_start;
```

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
- 실패 행 기록: 묶음이 행 단위 오류(SQLSTATE 22, 23 계열)로 실패하면 그 묶음을 행마다 나누어 갱신한다. 실패한 행은 `agent_memory.backfill_failures`에 기록하고 건너뛴다. 기록에는 SQLSTATE, 계열 이름(`data_exception`, `integrity_constraint_violation`), 제약 이름만 담는다. 오류 메시지는 문제가 된 값을 인용하므로 저장하지 않는다.
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
  job             text        NOT NULL,
  row_id          text        NOT NULL,
  sqlstate        text        NOT NULL,
  error_class     text        NOT NULL,
  constraint_name text,
  attempts        integer     NOT NULL DEFAULT 1,
  failed_at       timestamptz NOT NULL DEFAULT now(),
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
- 같은 `job`을 동시에 둘 이상 실행하지 않는다. watermark는 읽은 값과 같을 때만 갱신하므로 겹쳐 실행해도 뒤로 가지 않으며, 다른 실행이 진행한 것을 발견한 실행은 `BackfillConcurrentRunError`로 멈추고 완료로 표시하지 않는다.
- 완료된 `job`은 `restart: true`를 주지 않는 한 아무것도 하지 않는다. `restart`는 watermark와 실패 행 기록을 지우고 처음부터 실행한다.
- `job` 이름은 소문자 영숫자와 `.`, `_`, `-`로 1~64자다.

실패 행 확인과 재시도:

```sql
SELECT row_id, sqlstate, error_class, constraint_name, attempts
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

## 중복 판정 범위 전환

migration-050은 같은 본문(content_hash)을 하나로 보는 범위를 키 단위에서 키와 workspace 단위로 바꾸는 유일 색인 두 개를 더한다. 키 범위 색인(migration-031)은 이 파일에서 지우지 않고 아래 운영 단계로 지운다. 쓰기 경로(`lib/memory/write/DedupScope.js`)는 실행 시점의 판정 색인을 읽어 판정 범위와 `ON CONFLICT` 대상을 고르므로 세 상태 어느 쪽에서도 동작하고, 배포와 색인 단계의 순서에 묶이지 않는다.

|상태|남아 있는 색인|판정 범위|ON CONFLICT 대상|
|-|-|-|-|
|키 범위만|`uq_frag_hash_per_key`, `uq_frag_hash_master`(또는 `fragments_new_key_id_content_hash_idx`, `fragments_new_content_hash_idx`)|키|키 범위 색인|
|둘 다|위 둘과 `uq_frag_hash_ws_per_key`, `uq_frag_hash_ws_master`|키(키 범위 색인이 다른 workspace의 같은 본문을 막는다)|키 범위 색인|
|workspace 범위만|`uq_frag_hash_ws_per_key`, `uq_frag_hash_ws_master`|`MEMENTO_DEDUP_SCOPE`(기본 `workspace`)|workspace 범위 색인|

표를 다시 만든 설치는 키 범위 색인을 다른 이름으로 가진다. `fragments_new_key_id_content_hash_idx`는 `uq_frag_hash_per_key`와 같은 정의(`UNIQUE (key_id, content_hash) WHERE key_id IS NOT NULL`), `fragments_new_content_hash_idx`는 `uq_frag_hash_master`와 같은 정의(`UNIQUE (content_hash) WHERE key_id IS NULL`)다. 쓰기 경로와 마무리 스크립트는 이 이름의 색인을 `fragments` 표의 유일 색인이고 키 열과 부분 색인 술어가 같을 때 키 범위 색인으로 보고 같은 방식으로 다룬다. 원래 이름과 다른 이름이 함께 있으면 원래 이름의 상태를 따른다. 정의가 다르면 판정 색인으로 보지 않고 `[DedupScope] 색인 <이름>은 <원래 이름>와 정의가 달라 중복 판정 색인으로 보지 않는다` 경고를 한 번 남기며, 마무리 스크립트도 그 색인을 지우지 않고 알린다. 이 절에서 키 범위 색인은 두 이름을 모두 뜻한다.

판정은 키 경로(키 보유, 마스터)마다 따로 한다. 판정 범위는 `pg_index`에 남아 있는 색인으로 정하고, `ON CONFLICT` 대상은 그중 유효(`indisvalid`)한 색인에서만 고른다. 키 범위 색인이 `indisvalid=false`로 남아 있어도(아래 6단계의 주의) 유일성을 계속 강제하므로 「둘 다」처럼 키 범위로 판정한다. 대상으로 쓸 유효 색인이 없으면 `ON CONFLICT` 없이 저장하고 사전 조회만으로 판정한다.

색인 정의는 다음과 같다. workspace NULL과 `''`는 같은 칸이고, 모든 저장 경로(remember, batch_remember, 가져오기)는 `''`와 공백뿐인 workspace를 NULL로 저장한다. 유일성은 열 순서와 무관하며, 사전 조회(`key_id`, `content_hash`)가 색인 앞부분을 쓰도록 `content_hash`를 workspace 앞에 둔다.

```sql
CREATE UNIQUE INDEX uq_frag_hash_ws_per_key
    ON agent_memory.fragments (key_id, content_hash, (COALESCE(workspace, ''))) WHERE key_id IS NOT NULL;
CREATE UNIQUE INDEX uq_frag_hash_ws_master
    ON agent_memory.fragments (content_hash, (COALESCE(workspace, ''))) WHERE key_id IS NULL;
```

판정 범위 workspace에서 전역 파편(workspace NULL)은 모든 workspace에서 보이므로 workspace 요청도 같은 본문의 전역 파편 id를 돌려받는다. 반대로 전역 요청은 workspace 파편과 별개로 저장한다.

색인 상태는 프로세스마다 60초 동안 기억한다. 기억한 상태와 실제가 달라 `ON CONFLICT` 대상 색인이 없거나(42P10) 대상이 아닌 판정 색인이 저장을 막으면(23505) 그 쓰기는 색인 상태를 다시 읽고 다시 판정한다. remember는 같은 트랜잭션 안에서 저장점으로 되돌린 뒤 한 번, batch_remember는 트랜잭션 전체를 되돌린 뒤 최대 두 번 다시 실행한다. 다시 판정한 뒤에도 판정 색인이 23505로 막으면 막은 색인의 범위(키 범위 색인이면 같은 키, workspace 범위 색인이면 같은 칸)로 기존 행을 다시 읽어 중복으로 돌려준다. amend는 UPDATE가 판정 색인의 23505를 받으면 같은 방식으로 병합 신호(`merged`)를 낸다. 가져오기는 FragmentWriter를 거치므로 remember와 같다. 키 범위 색인이 사라진 뒤 최대 60초(또는 새 본문의 저장이 42P10을 받을 때까지) 같은 본문 판정은 키 범위로 남는다.

### 운영 순서

1. `scripts/ops/backup.sh --label pre-migration`으로 백업을 완료한다.
2. 영향 범위를 확인한다. 둘 이상 workspace를 쓰는 키가 전환 뒤 같은 본문을 workspace마다 따로 저장하게 되는 대상이다. `mcp_remember_duplicate_total{kind="other_workspace"}`의 증가 속도가 전환 뒤 늘어날 저장 건수의 추정치다.

   ```sql
   SELECT key_id, count(DISTINCT COALESCE(workspace, '')) AS workspaces, count(*) AS fragments
     FROM agent_memory.fragments
    WHERE valid_to IS NULL
    GROUP BY key_id
   HAVING count(DISTINCT COALESCE(workspace, '')) > 1
    ORDER BY workspaces DESC;
   ```

3. 새 색인을 만든다. 키 범위 색인이 있는 표에는 새 색인 기준의 중복이 있을 수 없다(키 범위 유일성이 더 좁다).

   ```bash
   node scripts/ops/online-index.mjs --dry-run --index uq_frag_hash_ws_per_key --index uq_frag_hash_ws_master
   PGHOST=<호스트> PGPORT=<포트> PGDATABASE=<DB> PGUSER=<사용자> PGPASSWORD=<비밀번호> \
     node scripts/ops/online-index.mjs --confirm --index uq_frag_hash_ws_per_key --index uq_frag_hash_ws_master --data-dir <데이터 디렉터리>
   ```

   스크립트가 실행하는 문장은 다음과 같다.

   ```sql
   SET lock_timeout = '3s';
   SET statement_timeout = 0;
   CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_frag_hash_ws_per_key
       ON agent_memory.fragments (key_id, content_hash, (COALESCE(workspace, ''))) WHERE key_id IS NOT NULL;
   CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_frag_hash_ws_master
       ON agent_memory.fragments (content_hash, (COALESCE(workspace, ''))) WHERE key_id IS NULL;
   ```

4. 무효 색인 질의(위 「유효성 확인」)가 0행이고, 판정 색인이 모두 유효한지 확인한다. 키 범위 색인은 두 이름 중 설치에 있는 쪽이 나온다.

   ```sql
   SELECT c.relname, i.indisvalid, pg_get_indexdef(i.indexrelid) AS definition
     FROM pg_index i
     JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relnamespace = 'agent_memory'::regnamespace
      AND c.relname IN ('uq_frag_hash_per_key', 'uq_frag_hash_master',
                        'fragments_new_key_id_content_hash_idx', 'fragments_new_content_hash_idx',
                        'uq_frag_hash_ws_per_key', 'uq_frag_hash_ws_master');
   ```

5. 배포하고 `npm run migrate`를 실행한다. migration-050의 `IF NOT EXISTS` 문은 이미 만든 색인을 건너뛴다. 이 시점은 「둘 다」 상태라 판정은 키 범위 그대로이고, `MEMENTO_DEDUP_SCOPE=workspace`이면 첫 쓰기 때 `[DedupScope] 키 범위 색인(...)이 있어 해당 경로의 중복 판정은 키 범위로 동작한다` 경고가 한 번 남는다. 다른 이름의 키 범위 색인은 경고에 `uq_frag_hash_per_key=fragments_new_key_id_content_hash_idx`처럼 실제 이름과 함께 적힌다.
6. 동작을 확인한 뒤 마무리 스크립트로 키 범위 색인을 지운다. 이 단계부터 workspace 범위로 판정한다. 스크립트는 새 색인 두 개가 유효하지 않으면 아무것도 지우지 않고 거부하고, 열린 트랜잭션을 경고한 뒤 `DROP INDEX CONCURRENTLY IF EXISTS`를 한 문장씩 실행한다. 잠금 대기 초과(55P03)와 교착(40P01)은 대기 시간을 두 배로 늘리며 다시 시도한다. 다른 이름의 키 범위 색인도 정의가 같으면 같은 방식으로 지운다. 끝나면 키 범위 색인이 두 이름 모두 `pg_class`에서 사라졌는지(무효 상태로 남은 것도 남은 것으로 본다) 확인하고 여섯 이름의 최종 상태를 출력한다. 옵션이 없으면 연결하지 않고 단계만 출력하며(지울 수 있는 네 이름의 `DROP` 문을 모두 보여 준다) `--confirm`이 있어야 실행한다. 접속 대상과 옵션(`--url`, `--lock-timeout`, `--retries`, `--retry-wait-ms`, `--retry-max-wait-ms`)은 online-index.mjs와 같고 환경 파일은 읽지 않는다. 다시 실행해도 안전하다.

   ```bash
   node scripts/ops/finish-dedup-scope.mjs
   PGHOST=<호스트> PGPORT=<포트> PGDATABASE=<DB> PGUSER=<사용자> PGPASSWORD=<비밀번호> \
     node scripts/ops/finish-dedup-scope.mjs --confirm
   ```

   스크립트가 실행하는 문장은 다음과 같다. `DROP`은 남아 있는 이름에만 실행하고, 다른 이름은 정의가 같을 때만 실행한다.

   ```sql
   SET lock_timeout = '3s';
   SET statement_timeout = 0;
   DROP INDEX CONCURRENTLY IF EXISTS agent_memory.uq_frag_hash_per_key;
   DROP INDEX CONCURRENTLY IF EXISTS agent_memory.fragments_new_key_id_content_hash_idx;
   DROP INDEX CONCURRENTLY IF EXISTS agent_memory.uq_frag_hash_master;
   DROP INDEX CONCURRENTLY IF EXISTS agent_memory.fragments_new_content_hash_idx;
   ```

   주의: `DROP INDEX CONCURRENTLY`는 먼저 색인을 `indisvalid=false`로 바꾼 뒤 그 표를 읽거나 쓰는 앞선 트랜잭션이 끝나기를 기다린다. 기다리는 동안과, 잠금 대기 초과(55P03)나 취소로 중단된 뒤에는 색인이 `indisvalid=false, indisready=true`로 남아 유일성을 계속 강제한다. 쓰기 경로는 이 상태를 키 범위로 판정하므로 오류는 나지 않지만 workspace 범위로 바뀌지도 않으며, `[DedupScope] 무효 상태의 판정 색인(...)` 경고가 남는다. 상태는 다음 질의로 확인한다.

   ```sql
   SELECT c.relname, i.indisvalid, i.indisready
     FROM pg_index i
     JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relnamespace = 'agent_memory'::regnamespace
      AND c.relname IN ('uq_frag_hash_per_key', 'uq_frag_hash_master',
                        'fragments_new_key_id_content_hash_idx', 'fragments_new_content_hash_idx',
                        'uq_frag_hash_ws_per_key', 'uq_frag_hash_ws_master');
   ```

   복구는 열린 트랜잭션(위 「열린 트랜잭션과 백업」의 질의)이 끝난 뒤 마무리 스크립트를 다시 실행하는 것이다. 같은 `DROP INDEX CONCURRENTLY IF EXISTS` 문이 무효 상태의 색인도 지운다. 지우기를 그만두고 키 범위 색인을 유효 상태로 되돌리려면 다음을 실행한다(쓰기를 막지 않는다).

   ```sql
   REINDEX INDEX CONCURRENTLY agent_memory.uq_frag_hash_per_key;
   REINDEX INDEX CONCURRENTLY agent_memory.uq_frag_hash_master;
   ```

   다른 이름의 키 범위 색인이 있는 설치는 그 이름(`fragments_new_key_id_content_hash_idx`, `fragments_new_content_hash_idx`)으로 같은 문을 실행한다.

7. 자료 정합을 확인한다. 결과가 0행이어야 한다.

   ```sql
   SELECT key_id, COALESCE(workspace, '') AS ws, content_hash, count(*) AS n
     FROM agent_memory.fragments
    GROUP BY 1, 2, 3
   HAVING count(*) > 1;
   ```

새 설치는 `npm run migrate`가 네 색인을 모두 만든다(「둘 다」 상태). 6단계의 `node scripts/ops/finish-dedup-scope.mjs --confirm`을 실행하면 workspace 범위로 판정한다.

전환 뒤에는 같은 키의 전역 파편과 workspace 파편이 같은 본문을 가질 수 있다. 전역 파편의 workspace를 채우는 운영 스크립트는 대상 workspace에 같은 키의 같은 본문이 이미 있으면 `uq_frag_hash_ws_per_key` 위반(23505)을 받는다. `scripts/backfill-reflect-workspace.js`는 그런 파편을 옮기지 않고 미리보기에서 제외 건수를 출력한다.

### 되돌리기

|상황|방법|
|-|-|
|판정 범위만 되돌린다|`MEMENTO_DEDUP_SCOPE=key`. 호출 시점에 읽으므로 재시작하지 않아도 된다. insert, amend, batch_remember의 사전 조회가 키 범위로 판정하므로 키 범위 색인을 다시 만들 필요가 없다. 이미 workspace마다 저장된 같은 본문 행은 그대로 남는다. workspace 범위 색인만 있는 상태에서는 키 범위 색인과 똑같지는 않다. 두 workspace에 같은 본문을 동시에 쓰면 둘 다 사전 조회를 통과해 따로 저장될 수 있다|
|6단계 전에 코드를 되돌린다|키 범위 색인이 남아 있으므로 이전 버전을 그대로 배포한다. 이전 버전은 키 범위 색인을 `ON CONFLICT` 대상으로 쓰고, 새 색인이 막는 행은 키 범위 색인도 막으므로 함께 있어도 된다. 새 색인을 치우려면 아래 첫 묶음을 실행한다|
|6단계 뒤에 코드를 되돌린다|이전 버전은 키 범위 색인이 없으면 저장이 42P10으로 실패하므로 먼저 키 범위 색인을 다시 만든다. (1) `MEMENTO_DEDUP_SCOPE=key`로 새 중복 생성을 멈춘다. (2) 아래 둘째 묶음으로 키 범위 중복을 찾는다. (3) 0행이 될 때까지 운영자가 정리한다(같은 키의 같은 본문 중 남길 파편을 정하고 나머지를 forget 또는 amend). (4) 아래 셋째 묶음으로 키 범위 색인을 만든다. 실패해 무효 색인이 남으면 `DROP INDEX CONCURRENTLY IF EXISTS`로 지우고 (2)부터 다시 한다. (5) 이전 버전을 배포한다|

```sql
-- 새 색인 치우기
SET lock_timeout = '3s';
DROP INDEX CONCURRENTLY IF EXISTS agent_memory.uq_frag_hash_ws_per_key;
DROP INDEX CONCURRENTLY IF EXISTS agent_memory.uq_frag_hash_ws_master;

-- 키 범위 중복 찾기
SELECT key_id, content_hash, count(*) AS n, array_agg(id ORDER BY created_at) AS ids
  FROM agent_memory.fragments
 WHERE key_id IS NOT NULL
 GROUP BY key_id, content_hash
HAVING count(*) > 1;
SELECT content_hash, count(*) AS n, array_agg(id ORDER BY created_at) AS ids
  FROM agent_memory.fragments
 WHERE key_id IS NULL
 GROUP BY content_hash
HAVING count(*) > 1;

-- 키 범위 색인 다시 만들기
SET lock_timeout = '3s';
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_frag_hash_per_key
    ON agent_memory.fragments (key_id, content_hash) WHERE key_id IS NOT NULL;
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_frag_hash_master
    ON agent_memory.fragments (content_hash) WHERE key_id IS NULL;
```

---

## 배포 점검표

1. `scripts/ops/backup.sh --label pre-migration`으로 백업을 완료하고 복원 가능 여부를 확인한다([backup-restore.md](backup-restore.md#마이그레이션-전-백업)).
2. `npm run lint:migrations`가 통과한다.
3. 대형 표 색인이 있으면 작업 목록에 등록하고 `--dry-run`으로 단계를 확인한다.
4. 접속 대상을 명시하고 `--confirm`으로 색인을 만든다.
5. 무효 색인 질의 결과가 0행이다.
6. 배포하고 `npm run migrate`를 실행한다.
7. 백필이 있으면 표를 만들고 `runResumableBackfill`을 실행한다.
8. 제약 검증이 있으면 `VALIDATE CONSTRAINT`를 실행한다.
9. migration-050이 포함된 배포는 동작을 확인한 뒤 `node scripts/ops/finish-dedup-scope.mjs`로 단계를 보고 `--confirm`으로 키 범위 색인을 지운 다음 자료 정합을 확인한다(「중복 판정 범위 전환」의 6, 7단계). 3, 4단계의 색인은 `uq_frag_hash_ws_per_key`, `uq_frag_hash_ws_master`다.
10. migration-054가 포함된 배포는 3, 4단계에서 `idx_ce_source_fragment_id`(case_events)를 만든다. 배포 뒤 `node scripts/purge-orphan-case-summaries.js`로 원본 파편이 없는 요약 수를 보고, `pg_dump -t agent_memory.case_events`로 표를 보관한 다음 `--execute`로 정리한다([cli.md](../cli.md)).

---

## 시험

|대상|명령|
|-|-|
|lint 규칙, 스크립트 계획과 실행 논리, 백필 도우미|`npm test`(`tests/unit/lint-migrations.test.js`, `tests/unit/online-index.test.js`, `tests/unit/resumable-backfill.test.js`)|
|스크립트 실서버 동작, 백필 이어하기|`npm run test:db`(`tests/db-concurrency/online-index.test.js`, `tests/db-concurrency/resumable-backfill.test.js`)|
|중복 판정 범위의 세 색인 상태, 무효 상태로 남은 키 범위 색인, 다른 이름의 키 범위 색인, 실행 중 색인 제거, 마무리 스크립트|`npm test`(`tests/unit/dedup-scope.test.js`, `tests/unit/dedup-scope-alias.test.js`, `tests/unit/fragment-writer-dedup-scope.test.js`, `tests/unit/batch-remember-dedup-scope.test.js`, `tests/unit/finish-dedup-scope.test.js`), `npm run test:db`(`tests/db-concurrency/dedup-scope.test.js`)|

DB 레인 시험은 일회용 시험 서버(포트 35433)의 전용 데이터베이스에서만 실행한다. 운영 데이터베이스에는 실행하지 않는다.

---

## 참고

- 규약: [docs/migration-conventions.md](../migration-conventions.md)
- 선례: `lib/memory/migrations/migration-034-v2.16.0-bundle.sql`(유일 색인 수동 선행 생성), `lib/memory/migrations/migration-037-hnsw-index-rename.sql`(HNSW 색인 수동 선행 생성)
