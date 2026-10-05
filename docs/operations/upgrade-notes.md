# 업그레이드 노트

이미 설치해 쓰는 서버를 새 버전으로 올릴 때 보는 문서다. 처음 설치하는 경우에는 [README](../../README.md#어떻게-설치하는데)를 본다.

## 공통 절차

업그레이드는 모두 같은 순서로 진행한다.

1. 백업한다. `scripts/ops/backup.sh --label pre-migration`
2. 코드를 받는다.
   ```bash
   git pull origin main
   npm install
   ```
3. 마이그레이션을 먼저 적용한다. 서버 재시작보다 앞서 해야 한다. 새 코드가 새 컬럼을 쓰기 때문이다.
   ```bash
   npm run migrate
   ```
4. 서비스를 재시작한다. (systemd, pm2, docker 등 쓰는 방식대로)

`npm run migrate`는 아직 적용하지 않은 마이그레이션만 순서대로 적용한다. 오래된 버전에서 올릴 때도 명령은 같다. DB 접속 정보는 `.env`에서 읽는다.

대부분은 여기서 끝난다. 아래 경우에만 작업이 더 필요하다.

## 추가 작업이 필요한 경우

| 상황 | 해야 할 일 |
|------|-----------|
| 앵커 권한, 관리자 계정, 본문 어휘 검색이 들어간 업데이트 (migration-053 ~ 060) | [아래 1번](#1-앵커-권한-관리자-계정-본문-어휘-검색-migration-053--060) |
| 같은 내용을 중복으로 보는 기준이 바뀌는 업데이트 (migration-050) | [아래 2번](#2-중복-판정-범위-전환-migration-050) |
| agent 범위 구분이 들어간 업데이트 (migration-047) | [아래 3번](#3-agent-범위-전환-migration-047) |
| 임베딩 제공자나 차원을 바꿨다 | [아래 4번](#4-임베딩-제공자나-차원을-바꿨을-때) |
| 행이 수백만 건인 운영 DB | [아래 5번](#5-행이-매우-많은-운영-db) |

## 1. 앵커 권한, 관리자 계정, 본문 어휘 검색 (migration-053 ~ 060)

바뀌는 내용은 다음과 같다.

- 앵커를 지정하려면 키에 `anchor` 권한이 있어야 한다.
- 비밀번호와 TOTP로 로그인하는 관리자 계정이 생긴다.
- `recall`에 본문 단어로 찾는 검색 경로가 추가된다.

이 마이그레이션은 열과 표만 더한다. 행이 많은 표의 색인은 마이그레이션에서 만들지 않고, `scripts/ops/online-index.mjs`가 쓰기를 막지 않은 채 만든다.

기존 설치에서는 이 순서로 진행한다.

1. 배포 전에 앵커를 쓰는 키에 권한을 준다.
   ```bash
   node scripts/grant-anchor-permission.js --apply
   ```
2. `npm run migrate` 전에 `case_events(source_fragment_id)` 색인을 만든다. 명령은 [online-migration.md](online-migration.md#migration-053--060-배포-순서)에 있다.
3. `npm run migrate`를 실행한다.
4. 마이그레이션 뒤에 본문 어휘 색인을 만든다. 빈 표라면 바로 끝난다.
   ```bash
   node scripts/ops/online-index.mjs --dry-run --index idx_fragments_content_tokens
   PGHOST=<호스트> PGDATABASE=<DB> PGUSER=<사용자> PGPASSWORD=<비밀번호> \
     node scripts/ops/online-index.mjs --confirm --index idx_fragments_content_tokens --data-dir <데이터 디렉터리>
   ```
5. 기존 파편의 토큰과 키 비밀을 채운다.
   ```bash
   node scripts/backfill-content-tokens.mjs --confirm
   node scripts/ops/backfill-key-secrets.mjs --confirm
   ```

새로 설치한 서버는 4번만 하면 된다.

참고:

- 4번의 색인이 유효해지기 전에는 본문 어휘 검색이 동작하지 않는다.
- 관리자 계정을 쓰려면 먼저 환경 변수 `MEMENTO_ADMIN_SEAL_KEY`(32바이트, base64 또는 64자 hex)를 설정한다. `openssl rand -hex 32`의 출력을 쓰면 된다. 이 값은 서버 환경 변수와 오프라인 사본에만 두고, 저장소나 로그에는 남기지 않는다.
- 관리자 계정이 없으면 마스터 키 로그인만 동작한다. 첫 owner 계정은 마스터 키로 `POST /v1/internal/model/nothing/admin-users/bootstrap`을 호출해 만든다.

되돌리기는 [online-migration.md](online-migration.md#migration-053--060-배포-순서)에 있다.

## 2. 중복 판정 범위 전환 (migration-050)

바뀌는 것: 같은 본문을 "키 단위"가 아니라 "키와 workspace 단위"로 중복으로 판단한다 (`MEMENTO_DEDUP_SCOPE=workspace`, 기본).

마이그레이션만으로는 전환이 끝나지 않는다. 키 단위 색인이 남아 있어 마무리 명령이 필요하다.

```bash
# 옵션 없이 실행하면 할 일만 출력한다
node scripts/ops/finish-dedup-scope.mjs

# 실제 전환. 접속 대상은 환경 변수로 준다 (이 스크립트는 .env를 읽지 않는다)
PGHOST=<호스트> PGDATABASE=<DB> PGUSER=<사용자> PGPASSWORD=<비밀번호> \
  node scripts/ops/finish-dedup-scope.mjs --confirm
```

지금 어떤 색인이 있는지 보려면:

```sql
SELECT c.relname, i.indisvalid, i.indisready
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid
 WHERE c.relnamespace = 'agent_memory'::regnamespace
   AND c.relname IN ('uq_frag_hash_per_key', 'uq_frag_hash_master',
                     'fragments_new_key_id_content_hash_idx', 'fragments_new_content_hash_idx',
                     'uq_frag_hash_ws_per_key', 'uq_frag_hash_ws_master');
```

행이 많은 운영 DB는 새 색인을 `npm run migrate`보다 먼저 만든다. 절차와 되돌리기는 [online-migration.md](online-migration.md#중복-판정-범위-전환)에 있다.

## 3. agent 범위 전환 (migration-047)

### 개념

- `agentId`가 `default`이거나 생략되면 같은 키와 workspace의 공유 기억이다.
- 다른 값이면 그 agent만 보는 기억이다.
- 일반 클라이언트는 `agentId`를 생략하거나 `default`로 쓰는 것을 권장한다.
- 다른 agent의 기억을 함께 보는 `includePeerAgents=true`는 마스터 키 전용이다.

### 기존 클라이언트는 당분간 그대로 동작한다

`MEMENTO_ALLOW_LEGACY_UNBOUND_AGENT_SCOPE`의 기본값이 `true`라서 `default`가 아닌 `agentId`를 쓰던 클라이언트도 계속 동작한다. 대신 사용할 때마다 경고 로그가 남고 `mcp_legacy_unbound_agent_scope_total`이 늘어난다.

이 모드에서는 같은 API 키를 공유하는 agent끼리 서로를 구분해 인증할 수 없다. 클라이언트를 옮긴 뒤 이 수치가 더 이상 늘지 않으면 `.env`에 `false`를 적어 엄격 모드로 바꾼다.

### 올리는 순서

1. migration-047을 적용한다 (null을 허용하는 컬럼 추가).
2. 모든 인스턴스를 새 코드로 배포하고 옛 코드가 더는 쓰지 않는지 확인한다.
3. 처리할 양을 먼저 센다.
   ```bash
   memento-mcp anchor-scope --backfill-snapshots
   ```
4. 실제로 채운다.
   ```bash
   memento-mcp anchor-scope --backfill-snapshots --execute --approve-backfill
   ```

`fragment_versions`와 `case_events` 둘 다 이 작업이 필요하고, `migrate`는 남은 양을 경고한다.

이 작업을 하기 전에는 기존 변경 이력이 비어 보일 수 있다. 한 번에 최대 1,000배치까지 처리하며 `--batch-size`는 1~10,000(기본 500)이다. 한도에 닿으면 처리한 건수와 함께 종료하므로 같은 명령을 다시 실행하면 이어서 처리한다.

원본이 없거나 삭제된 행은 격리 상태로 남는다. 격리된 행이 있으면 `SNAPSHOT_BACKFILL_INCOMPLETE`로 실패하고 `sourceMissing`, `sourceDeleted` 건수를 알려 준다. 이 행은 다시 실행해도 복구되지 않으므로 관리자가 확인해야 한다.

### 기존 앵커를 공유 범위로 옮기려면

1. 미리보기: `memento-mcp anchor-scope --classifications <파일>`. 앵커가 아닌 파편도 옮기려면 `--include-non-anchors`를 더한다.
2. 실행: 승인 JSON의 `shared` 목록을 만든 뒤 `--execute --approve-shared`를 함께 준다. `private`와 `unconfirmed`로 분류한 항목은 바뀌지 않는다.

### 주의

- 옛 세션은 다시 연결해 `initialize`부터 해야 한다. 인증 헤더가 없던 옛 세션은 `-32001`로 실패할 수 있다.
- 정규화는 파편과 버전 기록의 agent 값을 같은 트랜잭션에서 옮긴다. 마이그레이션을 롤백해도 정규화는 되돌아가지 않는다. 되돌릴 가능성이 있으면 실행 전에 별도로 백업한다.

## 4. 임베딩 제공자나 차원을 바꿨을 때

`.env`에서 `EMBEDDING_PROVIDER`나 `EMBEDDING_DIMENSIONS`를 바꾸면 벡터 컬럼 차원을 새 설정에 맞춰야 한다. 기존 파편의 임베딩도 다시 만든다.

```bash
EMBEDDING_DIMENSIONS=<새 차원> node scripts/post-migrate-flexible-embedding-dims.js
node scripts/backfill-embeddings.js
```

2000차원을 넘는 모델도 같은 스크립트로 맞출 수 있다. 예를 들어 Gemini `gemini-embedding-001`은 3072차원이다. 로컬 모델로 바꾸는 전체 절차는 [로컬 임베딩 가이드](../embedding-local.md)에 정리돼 있다.

## 5. 행이 매우 많은 운영 DB

migration-034 번들은 트랜잭션 안에서 `CREATE UNIQUE INDEX`를 실행한다. 표에 수백만 건 이상이 있고 잠금을 줄여야 한다면, `npm run migrate`를 실행하기 전에 아래 두 문을 직접 실행한다. 이미 색인이 있으면 마이그레이션은 해당 작업을 건너뛴다.

```sql
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_fragments_idempotency_tenant
  ON agent_memory.fragments (key_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND key_id IS NOT NULL;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_fragments_idempotency_master
  ON agent_memory.fragments (idempotency_key)
  WHERE idempotency_key IS NOT NULL AND key_id IS NULL;
```

적용됐는지는 psql에서 `\d agent_memory.fragments`를 실행해 두 색인이 보이는지 확인한다.

## 마이그레이션 파일을 직접 다룰 때

- 파일 하나만 수동으로 적용: `psql $DATABASE_URL -f lib/memory/migrations/<파일>`. 가능하면 `npm run migrate`를 쓴다. 적용 이력과 opclass 치환을 자동으로 처리한다.
- migration-046은 결번이다.
- 새 마이그레이션 파일을 추가했다면 실행 전에 `npm run lint:migrations`로 규약을 검사한다. 규약은 [migration-conventions.md](../migration-conventions.md)에 있다.
- 롤백용 SQL은 `rollback-migration-NNN-*.sql` 형식으로 이름 짓는다. `migrate`는 `migration-*.sql`만 자동으로 집으므로, `rollback-` 접두어가 붙은 파일은 실행하지 않는다.
- 선택 정리: `node scripts/cleanup-noise.js --dry-run`으로 먼저 확인하고 `--execute`로 노이즈 파편을 지운다. 오래된 설치에서 임베딩 정규화가 한 번 필요하면 `node scripts/normalize-vectors.js`를 실행한다.
