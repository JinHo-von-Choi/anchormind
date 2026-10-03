# backup-restore

작성자: 최진호
작성일: 2026-10-03

PostgreSQL이 기억의 유일한 저장소다. 이 문서는 일일 백업, 복구 훈련, 단일 파편 복구, 마이그레이션 전 백업 절차를 정한다. 백업 파일에는 기억 원문이 그대로 들어 있으므로 저장 위치의 권한과 암호화가 정책의 일부다.

`export` CLI(JSONL)는 백업을 대신하지 못한다. 파편 열 일부와 링크, 버전, API 키, 마이그레이션 이력이 빠진다.

---

## 정책 기본값

| 항목 | 기본값 | 바꾸는 방법 |
|-|-|-|
| 주기 | 하루 1회 | 스케줄러(cron, systemd timer)에서 정한다 |
| 보관 | 최근 14일치 | `--keep N` 또는 `MEMENTO_BACKUP_KEEP_DAYS` |
| 저장 위치 | `$XDG_STATE_HOME/memento-mcp/backups`, 없으면 `$HOME/.local/state/memento-mcp/backups` | `--dir DIR` 또는 `MEMENTO_BACKUP_DIR` |
| 저장소 안쪽 | 거부(종료 코드 2) | 바꿀 수 없다 |
| 파일 권한 | 파일 600, 디렉터리 700 | 스크립트가 `umask 077`로 고정 |
| 암호화 | 암호화 볼륨 또는 다른 호스트 사본의 gpg 암호화 권장 | 아래 암호화 절 |
| 복구 목표 | RPO 24시간, RTO 2시간 | 목표이며 보장이 아니다 |
| 시점 복구(WAL 보관) | 도입하지 않음 | `wal_level`, `archive_mode` 확인 후 별도 판단 |

RPO 24시간은 일 1회 백업의 간격에서 나오는 값이다. RTO 2시간은 복구 훈련에서 측정한 복원 시간과 마이그레이션 적용, 기동 확인 시간을 더해 검증해야 하는 목표다. 덤프 크기가 커지면 복원 시간이 늘어나므로 훈련 때마다 `restoreMs`와 덤프 크기를 기록해 외삽한다.

보관 일수는 날짜 기준이다. 같은 UTC 날짜에 여러 번 백업하면 그날 가장 늦은 한 벌만 남기고, 최근 N개 날짜의 대표를 보관한다.

---

## 클라이언트 도구

백업은 `pg_dump`, `pg_restore`, `psql`, `pg_dumpall`, `sha256sum`, `flock`, `node`가 PATH에 있어야 한다.

이 호스트에서 확인한 구성은 호스트의 PostgreSQL 클라이언트 16.15와 시험 컨테이너 서버 15.19다. 클라이언트 주 버전이 서버와 같거나 높으면 덤프와 복원이 동작한다. 클라이언트가 서버보다 낮으면 `pg_dump`가 거부한다. 그럴 때는 서버와 같은 주 버전의 클라이언트 디렉터리를 PATH 앞에 둔다.

```bash
PATH=/usr/lib/postgresql/15/bin:$PATH scripts/ops/backup.sh --dbname memento
```

호스트에 맞는 클라이언트가 없고 DB가 컨테이너에 있으면 컨테이너 안의 클라이언트로 덤프를 만들 수 있다. 이 방법은 체크섬과 행 수 매니페스트를 만들지 않으므로 복구 훈련 입력이 되지 않는다.

```bash
docker exec -e PGPASSWORD="$PGPASSWORD" <컨테이너> pg_dump -U <사용자> -Fc --schema=agent_memory <DB> > memento-manual.dump
```

---

## 접속과 권한

접속 값은 표준 PG 환경변수(`PGHOST`, `PGPORT`, `PGUSER`, `PGDATABASE`, `PGPASSFILE`, `PGPASSWORD`) 또는 인자(`--host`, `--port`, `--user`, `--dbname`)로만 받는다. 비밀번호는 인자로 받지 않는다. 저장소의 환경 파일은 읽지 않는다. 비밀번호는 `~/.pgpass`(권한 600)에 두는 방식을 권장한다.

`agent_memory.fragments`와 `agent_memory.fragment_links`에는 행 수준 보안이 켜져 있다. 백업 계정은 표 소유자이거나 `BYPASSRLS` 속성이 있어야 한다. 그렇지 않으면 `pg_dump`가 오류로 멈추며, 일부 행만 담긴 덤프는 만들어지지 않는다.

---

## 실행

```bash
# 동작만 확인한다. 접속하지 않고 아무것도 쓰지 않는다.
PGHOST=<호스트> PGPORT=<포트> PGUSER=<계정> PGDATABASE=<DB> scripts/ops/backup.sh --dry-run

# 실행
PGHOST=<호스트> PGPORT=<포트> PGUSER=<계정> PGDATABASE=<DB> scripts/ops/backup.sh
scripts/ops/backup.sh --host <호스트> --port <포트> --user <계정> --dbname <DB> --dir <위치> --keep 14
```

| 인자 | 환경변수 | 설명 |
|-|-|-|
| `--dir DIR` | `MEMENTO_BACKUP_DIR` | 저장 위치. 인자가 이긴다 |
| `--keep N` | `MEMENTO_BACKUP_KEEP_DAYS` | 보관 일수(1 이상의 정수, 기본 14) |
| `--host`, `--port`, `--user`, `--dbname` | `PGHOST`, `PGPORT`, `PGUSER`, `PGDATABASE` | 접속 값. 인자가 이긴다 |
| `--no-roles` | 없음 | 역할 정의 덤프를 건너뛴다 |
| `--dry-run` | 없음 | 파일 이름과 보관 정리 대상만 출력한다 |

한 번의 실행이 만드는 파일(저장 위치 안, 모두 권한 600):

| 파일 | 내용 |
|-|-|
| `memento-<UTC 시각>.dump` | `pg_dump -Fc --schema=agent_memory`. 완결 표지이며 마지막에 이름이 확정된다 |
| `memento-<UTC 시각>.dump.sha256` | `sha256sum` 형식 체크섬 |
| `memento-<UTC 시각>.counts.json` | 덤프와 같은 스냅숏에서 센 표별 행 수, `schema_migrations` 최댓값, HNSW 색인 수와 유효 색인 수 |
| `memento-<UTC 시각>.roles.sql` | `pg_dumpall --roles-only --no-role-passwords`. 역할 속성과 소속만 담기고 비밀번호는 없다 |

덤프와 행 수는 `pg_export_snapshot`으로 내보낸 같은 스냅숏에서 읽는다. 쓰기가 계속되는 운영 DB에서도 매니페스트와 덤프가 일치한다. 출력은 파일 이름, 바이트 수, 목차 항목 수, 삭제한 파일 이름뿐이며 행 내용은 출력하지 않는다.

종료 코드는 0 성공, 1 실패, 2 사용법 오류 또는 저장 위치 거부, 3 덤프는 확정됐으나 역할 정의 덤프 실패다. 실패하면 부분 파일을 지우고 보관 정리는 하지 않는다. 같은 저장 위치에서 백업이 겹쳐 실행되면 `flock`으로 두 번째 실행이 거부된다.

### 스케줄 예

cron 항목 예(비밀번호는 `PGPASSFILE`에 둔다). 로그 파일도 600으로 만들기 위해 `umask`를 앞에 둔다.

```
17 3 * * * umask 077; PGHOST=<호스트> PGPORT=<포트> PGUSER=<계정> PGDATABASE=<DB> PGPASSFILE=$HOME/.pgpass MEMENTO_BACKUP_DIR=<위치> <저장소 경로>/scripts/ops/backup.sh >> <위치>/backup.log 2>&1
```

종료 코드가 0이 아닐 때 알림이 가도록 스케줄러나 모니터링에서 확인한다. 백업이 조용히 멈추면 RPO가 늘어난다.

---

## 암호화

백업 파일은 기억 원문의 평문 사본이다. 두 겹으로 보호한다.

1. 저장 위치를 암호화 볼륨(LUKS 또는 암호화 파일시스템)에 둔다. 백업 스크립트, 체크섬, 보관 정리가 그대로 동작하므로 가장 단순하다.
2. 다른 호스트로 보내는 사본은 전송 전에 gpg로 암호화한다. 호스트에는 공개키만 둔다.

```bash
latest=$(ls -1 "$MEMENTO_BACKUP_DIR"/memento-*.dump | tail -1)
gpg --batch --encrypt --recipient <키 ID> --output - "$latest" \
  | ssh <백업 호스트> 'umask 077; cat > <원격 위치>/'"$(basename "$latest").gpg"
```

복원할 때는 개인키가 있는 곳에서 복호화한 뒤 훈련 입력으로 쓴다. `.dump.sha256`은 복호화한 평문 덤프 기준이다.

```bash
gpg --decrypt memento-<시각>.dump.gpg > memento-<시각>.dump
```

보관 정리는 `.gpg` 파일을 관리하지 않는다. 원격 위치의 정리는 원격에서 따로 한다. 개인키는 백업 호스트에 두지 않는다.

---

## 복구 훈련

복구 훈련은 덤프가 실제로 복원되고 원본과 같은 자료가 나오는지 확인한다. 분기에 1회 이상 하고, 백업 절차를 바꾼 직후에도 한다.

### 대상 서버

복구 대상은 일회용 시험 서버뿐이다. `scripts/ops/restore-verify.mjs`는 대상이 아래 조건이 아니면 연결을 열기 전에 거부하며, 운영 서버에는 접속하지 않는다. 규칙은 `tests/db-concurrency/_guard.js`와 같다.

- 호스트가 로컬(`localhost`, `127.0.0.1`, `::1`)이고 포트가 35433
- 사용자 `memento`, 비밀번호 `memento_test`(시험 컨테이너 값)
- 접속 값은 `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_USER`, `POSTGRES_PASSWORD`에서 읽고 비어 있으면 위 값이 기본이다
- 다른 일회용 서버 한 곳은 `DB_LANE_SERVER_ALLOW=<host:port>`로 열 수 있다. 사용자와 비밀번호 조건은 그대로다
- 복원 데이터베이스 이름은 `dbl_<pid>_<hex8>` 형식이며 이 이름만 만들고 지운다

시험 서버 기동:

```bash
docker compose -f docker-compose.test.yml up -d postgres-test
```

운영 덤프를 시험 서버에 올리면 기억 원문이 시험 컨테이너 볼륨에 놓인다. 훈련이 끝나면 일회용 데이터베이스가 지워졌는지(`cleanup.dropped`) 확인하고, 컨테이너 볼륨을 보관하지 않는다면 폐기한다.

### 실행

```bash
node scripts/ops/restore-verify.mjs --dump <저장 위치>/memento-<시각>.dump
```

`--manifest <파일>`로 행 수 매니페스트를 따로 지정할 수 있고, 기본은 같은 벌의 `.counts.json`이다. `--keep`을 주면 일회용 데이터베이스를 지우지 않고 이름을 보고에 남긴다.

동작 순서는 대상 서버 검사, 체크섬 대조, 일회용 데이터베이스 생성과 확장(`vector`, `pg_trgm`) 준비, `pg_restore --no-owner --no-privileges --exit-on-error`, 복구본에서 같은 행 수 질의 실행, 매니페스트와 대조, 일회용 데이터베이스 삭제다. 결과는 표 이름과 숫자만 담은 JSON 한 개이며 종료 코드는 0 일치, 1 불일치 또는 실패, 2 사용법 또는 대상 거부다.

```json
{
  "ok": true,
  "dump": "memento-<시각>.dump",
  "target": { "host": "localhost", "port": 35433, "database": "dbl_<pid>_<hex8>", "kept": false },
  "checksum": { "status": "verified" },
  "restoreMs": 413,
  "comparison": {
    "ok": true,
    "tables": [{ "name": "fragments", "source": 60, "restored": 60, "equal": true }],
    "missingRequired": [],
    "schemaMigrations": { "source": "migration-049-...", "restored": "migration-049-...", "equal": true },
    "hnsw": { "source": { "total": 3, "valid": 3 }, "restored": { "total": 3, "valid": 3 }, "equal": true, "allValid": true }
  },
  "cleanup": { "dropped": true }
}
```

대조 항목은 `agent_memory`의 모든 표의 정확한 행 수(필수 표는 `fragments`, `fragment_links`, `fragment_versions`, `api_keys`), `schema_migrations`의 최대 파일 이름, HNSW 색인 수와 복구본의 무효 색인 유무다. 하나라도 어긋나면 `ok`가 `false`다.

### 점검표

- 최신 벌을 고르고 `sha256sum -c`로 체크섬을 확인했다
- 시험 서버가 떠 있고 `pg_isready -h localhost -p 35433`가 응답한다
- `restore-verify`가 종료 코드 0이고 `comparison.ok`가 `true`다
- `comparison.tables`에서 `equal: false`인 표가 없고 `missingRequired`가 비어 있다
- `schemaMigrations.equal`이 `true`이고 `hnsw.allValid`가 `true`다
- `cleanup.dropped`가 `true`이고 시험 서버에 `dbl_` 데이터베이스가 남지 않았다
- 덤프 크기와 `restoreMs`를 기록했고 RTO 2시간 목표에 대해 외삽했다
- 실패했다면 원인을 고치고 같은 덤프로 다시 통과시켰다

### 전체 복구 절차

새 서버에 복구하는 순서는 다음과 같다.

1. PostgreSQL을 준비하고 `psql -f memento-<시각>.roles.sql`로 역할 속성을 만든다. 비밀번호는 덤프에 없으므로 직접 설정한다. 파일의 `\restrict` 지시어 때문에 덤프를 만든 `pg_dumpall`과 같은 계열의 `psql`로 적용한다.
2. 데이터베이스를 만들고 `CREATE EXTENSION vector; CREATE EXTENSION pg_trgm;`를 실행한다.
3. `pg_restore --exit-on-error --dbname=<DB> memento-<시각>.dump`로 복원한다. 소유자를 유지하려면 `--no-owner`를 주지 않는다.
4. `npm run migrate`로 백업 이후의 마이그레이션이 있으면 적용하고, 서버를 기동해 상태를 확인한다.

`restore-verify`는 소유자와 권한을 복원하지 않는 `pg_restore`로 2번과 3번에 해당하는 단계를 실행하고 행 수를 대조한다. 1번(역할 적용)과 소유자를 유지하는 복원은 훈련 범위 밖이며, 역할 덤프는 파일 생성까지만 확인된다. 새 서버 복구를 처음 하는 날 역할 적용 결과를 확인한다.

---

## 단일 파편 복구

대량 삭제나 일괄 되돌리기가 잘못됐을 때 백업에서 파편 몇 건을 id 단위로 되살린다. 운영 DB에 덤프를 통째로 덮어쓰지 않는다.

1. 삭제 직전에 가장 가까운 벌을 골라 `restore-verify --keep`으로 복구본을 시험 서버에 만든다. 보고의 `target.database`가 복구본 이름이다.
2. 복구본에서 대상 파편, 링크, 버전을 CSV로 내보낸다.
3. 운영 DB의 한 트랜잭션 안에서 임시 표에 적재한 뒤 없는 것만 삽입한다. 같은 id가 있으면 건드리지 않고(`ON CONFLICT DO NOTHING`), 한 번 더 실행해도 중복 행이 생기지 않는다.
4. `linked_to` 배열은 `fragment_links`의 거울이므로 되살린 파편과 이웃의 배열을 링크에서 다시 만든다.

실행 전 확인:

- 운영 `schema_migrations` 최댓값이 백업 매니페스트의 `schemaMigrationsMax`와 같아야 한다. 다르면 아래 `SELECT *`와 `LIKE`가 열을 맞추지 못하므로 중단하고 공통 열을 명시한다.
- 운영 쪽 계정은 표 소유자이거나 `BYPASSRLS`여야 한다.
- 추출 파일에 기억 원문이 들어 있다. 작업 디렉터리는 600/700 권한으로 만들고 끝나면 지운다.

`IDS`에는 따옴표로 감싼 id 목록을 넣는다. 조건으로 고르려면 복구본에서 실행되는 하위 질의를 넣어도 된다(예: `IDS="SELECT id FROM agent_memory.fragments WHERE topic = '<주제>'"`).

```bash
SCRATCH_DB=<복구본 이름>
IDS="'<id1>','<id2>'"

scratch() { PGHOST=localhost PGPORT=35433 PGUSER=memento PGPASSWORD=memento_test psql -X -v ON_ERROR_STOP=1 -d "$SCRATCH_DB" "$@"; }
prod()    { psql -X -v ON_ERROR_STOP=1 "$@"; }   # 운영 접속은 PG 환경변수 또는 서비스 파일로 지정한다

umask 077
WORK=$(mktemp -d)

scratch -c "COPY (SELECT * FROM agent_memory.fragments WHERE id IN ($IDS)) TO STDOUT WITH (FORMAT csv)" > "$WORK/fragments.csv"
scratch -c "COPY (SELECT * FROM agent_memory.fragment_links WHERE from_id IN ($IDS) OR to_id IN ($IDS)) TO STDOUT WITH (FORMAT csv)" > "$WORK/links.csv"
scratch -c "COPY (SELECT * FROM agent_memory.fragment_versions WHERE fragment_id IN ($IDS)) TO STDOUT WITH (FORMAT csv)" > "$WORK/versions.csv"

prod <<SQL
BEGIN;
CREATE TEMP TABLE stage_fragments (LIKE agent_memory.fragments);
CREATE TEMP TABLE stage_links     (LIKE agent_memory.fragment_links);
CREATE TEMP TABLE stage_versions  (LIKE agent_memory.fragment_versions);
\copy stage_fragments FROM '$WORK/fragments.csv' WITH (FORMAT csv)
\copy stage_links     FROM '$WORK/links.csv' WITH (FORMAT csv)
\copy stage_versions  FROM '$WORK/versions.csv' WITH (FORMAT csv)

CREATE TEMP TABLE restored_ids AS
  SELECT s.id FROM stage_fragments s
   WHERE NOT EXISTS (SELECT 1 FROM agent_memory.fragments f WHERE f.id = s.id);

INSERT INTO agent_memory.fragments SELECT * FROM stage_fragments ON CONFLICT DO NOTHING;

SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position) AS link_cols
  FROM information_schema.columns
 WHERE table_schema = 'agent_memory' AND table_name = 'fragment_links' AND column_name <> 'id' \gset
SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position) AS version_cols
  FROM information_schema.columns
 WHERE table_schema = 'agent_memory' AND table_name = 'fragment_versions' AND column_name <> 'id' \gset

INSERT INTO agent_memory.fragment_links (:link_cols)
SELECT :link_cols FROM stage_links s
 WHERE EXISTS (SELECT 1 FROM agent_memory.fragments f WHERE f.id = s.from_id)
   AND EXISTS (SELECT 1 FROM agent_memory.fragments f WHERE f.id = s.to_id)
ON CONFLICT DO NOTHING;

INSERT INTO agent_memory.fragment_versions (:version_cols)
SELECT :version_cols FROM stage_versions s
 WHERE s.fragment_id IN (SELECT id FROM restored_ids)
   AND EXISTS (SELECT 1 FROM agent_memory.fragments f WHERE f.id = s.fragment_id);

UPDATE agent_memory.fragments f
   SET linked_to = COALESCE((
         SELECT array_agg(DISTINCT n.other)
           FROM (SELECT to_id AS other FROM agent_memory.fragment_links WHERE from_id = f.id
                 UNION ALL
                 SELECT from_id        FROM agent_memory.fragment_links WHERE to_id = f.id) n
       ), '{}')
 WHERE f.id IN (SELECT id FROM stage_fragments)
    OR f.id IN (SELECT from_id FROM stage_links UNION SELECT to_id FROM stage_links);
COMMIT;
SQL

rm -rf "$WORK"
```

각 `INSERT`의 `INSERT 0 N`이 기대한 건수인지 확인한다. 외래 키(`superseded_by`) 오류로 트랜잭션이 멈추면 참조 대상 id를 `IDS`에 더해 다시 실행한다. 되살린 행은 PostgreSQL 경로(L2, L3 검색)로 바로 검색된다. Redis L1 키워드 색인에는 반영되지 않으며 서버 재시작 때의 워밍업 범위(최근 5000건)에서 채워진다.

작업이 끝나면 복구본 데이터베이스를 지운다.

```bash
PGHOST=localhost PGPORT=35433 PGUSER=memento PGPASSWORD=memento_test psql -X -d postgres -c "DROP DATABASE \"$SCRATCH_DB\""
```

---

## 마이그레이션 전 백업

스키마를 바꾸는 마이그레이션이 포함된 반영은 직전에 백업을 만든다. 반영 절차는 다음 순서다.

1. `scripts/ops/backup.sh`를 실행하고 종료 코드 0과 `written:` 네 줄을 확인한다.
2. 만들어진 벌의 시각이 반영 직전인지 확인한다.
3. `npm run migrate`를 실행한다.

백업이 없으면 마이그레이션을 실행하지 않는다.
