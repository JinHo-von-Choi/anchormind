# CLI

## 개요

`bin/memento.js`는 서버 없이 터미널에서 메모리 서버를 운영·조회할 수 있는 CLI 진입점이다. 전역 설치 시 `anchormind` 명령으로 실행하며, `memento-mcp` 명령도 동일하게 동작한다.

```bash
node bin/memento.js <command> [options]
# 또는
npm run cli -- <command> [options]
```

모든 명령은 `.env` 파일의 `DATABASE_URL` 등 환경변수를 읽는다. 실행 전 환경변수를 로드한다.

```bash
# 환경변수 로드 후 실행 예시
export $(grep -v '^#' .env | grep '=' | xargs)
node bin/memento.js stats
```

---

## 전역 플래그

모든 서브명령에서 공통으로 사용할 수 있는 플래그다.

| 플래그 | 설명 |
|--------|------|
| `--help`, `-h` | 서브명령별 상세 도움말 출력 |
| `--format table\|json\|csv` | 출력 포맷. TTY 환경에서는 기본 `table`, 파이프/리다이렉트 환경에서는 `json` |
| `--json` | `--format json` 별칭 (하위 호환) |
| `--remote URL` | 원격 MCP 서버 URL. 미지정 시 `MEMENTO_CLI_REMOTE` 환경변수 사용 |
| `--key KEY` | 원격 서버 인증용 Bearer API 키. 미지정 시 `MEMENTO_CLI_KEY` 환경변수 사용 |
| `--timeout ms` | 원격 HTTP 요청 타임아웃 (기본: 30000ms) |
| `--verbose` | 에러 시 스택 트레이스 출력 |

### 원격 접속 환경변수

| 변수 | 설명 |
|------|------|
| `MEMENTO_CLI_REMOTE` | `--remote` 미지정 시 사용할 MCP 서버 URL |
| `MEMENTO_CLI_KEY` | `--key` 미지정 시 사용할 API 키 |

---

## 서브명령 분류

### local-only (원격 접속 불가)

`serve`, `migrate`, `cleanup`, `backfill`, `health`, `update` 는 직접 DB / 프로세스에 접근하는 명령이므로 `--remote` 플래그와 함께 사용하면 에러를 반환한다.

### 원격 지원

`recall`, `remember`, `stats`, `inspect` 는 `--remote URL --key KEY`로 원격 MCP 서버를 경유하여 실행할 수 있다.

---

## 명령어 목록

| 커맨드 | 설명 | 원격 지원 |
|--------|------|-----------|
| `serve` | MCP 서버 시작 | 아니오 |
| `migrate` | DB 마이그레이션 실행 | 아니오 |
| `cleanup [--execute]` | 노이즈 파편 정리 (기본 dry-run) | 아니오 |
| `backfill` | 누락된 임베딩 백필 | 아니오 |
| `stats` | 파편/앵커/토픽 통계 | 예 |
| `health` | DB/Redis/임베딩 연결 진단 | 아니오 |
| `recall <query>` | 터미널 recall | 예 |
| `remember <content>` | 터미널 remember | 예 |
| `inspect <id>` | 파편 상세 + 1-hop 링크 | 예 |
| `session <sub>` | 세션 list / show / delete / rotate (master key 필요) | 예 |
| `update [--execute] [--redetect]` | 업데이트 확인 및 적용 (기본 dry-run) | 아니오 |
| `export [--topic x] [--type t]` | 파편 JSONL 덤프 | 아니오 |
| `import [--input FILE]` | JSONL 흡수 (파일 또는 stdin) | 아니오 |
| `completion <shell>` | bash/zsh 보완 스크립트 출력 | 예 |

---

## 명령어 상세

### serve

MCP 서버를 포그라운드로 시작한다.

```bash
node bin/memento.js serve
# 또는
npm start
```

`PORT` 환경변수로 포트 지정 (기본: 57332).

도움말:

```bash
node bin/memento.js serve --help
```

### migrate

`lib/memory/migrations/migration-*.sql` 파일을 순서대로 실행한다. 이미 적용된 마이그레이션은 건너뛴다.

```bash
node bin/memento.js migrate
# 또는
npm run migrate
```

적용 이력은 `agent_memory.schema_migrations` 테이블에 기록된다.

도움말:

```bash
node bin/memento.js migrate --help
```

### cleanup

`util_score`, `importance`, 비활성 기간 조건을 만족하는 노이즈 파편을 삭제한다.

```bash
node bin/memento.js cleanup           # dry-run (미리보기만)
node bin/memento.js cleanup --execute  # 실제 삭제 실행
```

직접 실행 대안:

```bash
node scripts/cleanup-noise.js --dry-run
node scripts/cleanup-noise.js --execute
```

### backfill

임베딩이 없는 기존 파편에 임베딩을 생성한다. 임베딩 API 키 또는 로컬 transformers provider가 필요하다.

```bash
node bin/memento.js backfill
# 또는
npm run backfill:embeddings
```

### stats

파편 수, 앵커 수, 토픽별 분포 등 현황을 출력한다.

```bash
# TTY 환경 — table 포맷 (기본)
node bin/memento.js stats

# JSON 포맷
node bin/memento.js stats --format json

# CSV 포맷
node bin/memento.js stats --format csv

# --json 별칭 (--format json 동일)
node bin/memento.js stats --json

# 원격 서버 조회
node bin/memento.js stats --remote https://memento.anchormind.net/mcp --key mmcp_xxx
```

출력 예시 (`--format table`):

```
fragments   anchors   topics
----------  --------  ------
1204        38        12
```

출력 예시 (`--format json`):

```json
{"fragments": 1204, "anchors": 38, "topics": 12}
```

도움말:

```bash
node bin/memento.js stats --help
```

### health

DB 연결, Redis 상태, 임베딩 provider 동작 여부를 진단한다.

```bash
node bin/memento.js health
node bin/memento.js health --format json
```

### recall

터미널에서 파편 검색을 실행한다. 서버가 실행 중이지 않아도 로컬 DB에서 직접 동작한다. `--remote` 옵션으로 원격 서버를 경유할 수도 있다.

```bash
# 기본 검색
node bin/memento.js recall "검색어"

# 옵션 조합
node bin/memento.js recall "nginx 에러" --topic my-project --limit 5

# 시간 범위 필터
node bin/memento.js recall "2026-01-01 이후 기록" --time-range 2026-01-01,2026-12-31

# 출력 포맷 지정
node bin/memento.js recall "검색어" --format table
node bin/memento.js recall "검색어" --format json
node bin/memento.js recall "검색어" --format csv

# 원격 서버 경유
node bin/memento.js recall "검색어" --remote https://memento.anchormind.net/mcp --key mmcp_xxx

# 환경변수로 원격 설정 후 사용
MEMENTO_CLI_REMOTE=https://memento.anchormind.net/mcp MEMENTO_CLI_KEY=mmcp_xxx \
  node bin/memento.js recall "검색어"
```

옵션:

| 플래그 | 설명 |
|--------|------|
| `--topic <t>` | 주제 필터 |
| `--type <t>` | 파편 유형 필터 (fact, error, procedure, decision, preference, episode) |
| `--limit <n>` | 반환 건수 상한 (기본: 10) |
| `--time-range from,to` | 날짜 범위 필터 (ISO 8601) |

도움말:

```bash
node bin/memento.js recall --help
```

### remember

터미널에서 파편을 저장한다. `--remote` 옵션으로 원격 서버에 저장할 수 있다.

```bash
# 기본 저장
node bin/memento.js remember "PostgreSQL 연결 시 pg_hba.conf 설정 필요" --topic infra --type fact

# 절차 저장
node bin/memento.js remember "배포 완료" --topic deploy-2026 --type procedure

# idempotencyKey 지정 (중복 저장 방지)
node bin/memento.js remember "nginx 재시작 후 443 포트 정상" --topic infra --type fact \
  --idempotency-key "infra-nginx-restart-2026-04-20"

# 원격 서버에 저장
node bin/memento.js remember "배포 완료" --topic deploy-2026 --type procedure \
  --remote https://memento.anchormind.net/mcp --key mmcp_xxx
```

옵션:

| 플래그 | 설명 |
|--------|------|
| `--topic <t>` | 주제 태그 (권장) |
| `--type <t>` | 파편 유형 (fact, error, procedure, decision, preference, episode) |
| `--importance <n>` | 중요도 0.0~1.0 |
| `--idempotency-key <k>` | 동일 키가 있으면 저장 건너뜀 (멱등성 보장) |

도움말:

```bash
node bin/memento.js remember --help
```

### inspect

파편 ID로 전체 메타데이터와 1-hop 링크를 출력한다.

```bash
node bin/memento.js inspect frag-00abc123
node bin/memento.js inspect frag-00abc123 --format json
node bin/memento.js inspect frag-00abc123 --format table

# 원격 서버 조회
node bin/memento.js inspect frag-00abc123 --remote https://memento.anchormind.net/mcp --key mmcp_xxx
```

도움말:

```bash
node bin/memento.js inspect --help
```

### session

활성 세션을 조회하고 강제 종료하거나 ID를 재발급한다. 모든 서브명령은 master key(`MEMENTO_ACCESS_KEY`)를 요구한다. 원격 모드(`--remote` / `--key`)로 지정하면 Admin HTTP API를 직접 호출한다.

서브명령 4종.

```bash
# 활성 세션 목록 (기본 limit 50)
memento-mcp session list [--limit N] [--workspace X] [--format table|json|csv]

# 단일 세션 상세 (keyId, createdAt, lastAccessedAt, expiresAt, heartbeat)
memento-mcp session show <sessionId>

# 세션 강제 종료 (autoReflect 포함)
memento-mcp session delete <sessionId>

# 세션 ID 회전 (session fixation 대응)
memento-mcp session rotate <sessionId> [--reason "suspected_leak"]
```

`session rotate`는 Redis에 저장된 세션 데이터를 유지하면서 ID만 재바인딩한다. 진행 중이던 작업과 기억 파편은 영향 없다. `reason`은 최대 128자 감사 로그용 문자열이며 기본값은 `explicit_rotate`.

rotate 엔드포인트 정책:

- HTTP: `POST /session/rotate` (body: `{ "reason": "..." }`)
- 인증: `Authorization: Bearer <API key or master key>` + `Mcp-Session-Id` 헤더로 대상 세션 지정
- CSRF 방어: `Origin` 헤더 필수. 누락 시 403
- Rate limit: IP당 분당 `MEMENTO_ROTATE_RATE_LIMIT_PER_MIN` (기본 5) 초과 시 429
- 메트릭: `mcp_session_rotation_total` (label: `reason`)

CLI는 초과 시 표준 에러로 `HTTP 429`를 출력한다. 원격 모드에서도 동일한 rate-limit이 적용된다.

출력 예시 (list, table 포맷):

```
SESSION ID                       KEY ID    WORKSPACE  CREATED              LAST ACCESSED        TTL (min)
----------------------------------------------------------------------------------------------------------
aabbcc11-2233-4455-6677-8899ddee  default   paysvc     2026-04-21T10:12:03  2026-04-21T12:34:56  41520
bbccdd22-3344-5566-7788-99aaeeff  mmcp_xx   -          2026-04-21T11:00:00  2026-04-21T12:30:00  41500
```

`--help`로 서브명령별 세부 옵션 확인 가능.

```bash
memento-mcp session --help
memento-mcp session list --help
memento-mcp session rotate --help
```

### update

서버 업데이트를 확인하고 선택적으로 적용한다.

```bash
node bin/memento.js update              # dry-run: 사용 가능한 업데이트 확인
node bin/memento.js update --execute    # 업데이트 적용
node bin/memento.js update --redetect   # 설치 방식 재탐지 후 업데이트
```

도움말:

```bash
node bin/memento.js update --help
```

### export

파편을 JSONL(한 줄당 한 파편) 형식으로 덤프한다. 백업·이관용.

```bash
node bin/memento.js export --topic memento-mcp --type fact > out.jsonl
node bin/memento.js export --since 2026-04-01 --output backup.jsonl
node bin/memento.js export --key mmcp_xxx --limit 500
```

주요 옵션: `--topic`, `--type`, `--since <ISO>`, `--limit <n>`, `--output <FILE>`, `--json` (배열 출력).

도움말:

```bash
node bin/memento.js export --help
```

### import

JSONL 파일 또는 stdin에서 파편을 읽어 `fragments` 테이블에 적재한다.

```bash
node bin/memento.js import --input out.jsonl
cat out.jsonl | node bin/memento.js import
node bin/memento.js import --input out.jsonl --idempotent --dry-run
```

`--idempotent`는 `idempotency_key` 또는 `id` 충돌 시 INSERT를 건너뛴다. `--dry-run`은 검증만 수행한다.

도움말:

```bash
node bin/memento.js import --help
```

### completion

bash/zsh 자동완성 스크립트를 표준 출력으로 인쇄한다.

```bash
node bin/memento.js completion bash >> ~/.bashrc
node bin/memento.js completion zsh  >> ~/.zshrc
source <(node bin/memento.js completion bash)
```

지원 셸: `bash`, `zsh`(bash-compat).

도움말:

```bash
node bin/memento.js completion --help
```

---

## 원격 접속 사용 예시

`--remote`와 `--key`를 직접 지정하거나 환경변수로 설정한다.

```bash
# 직접 지정
node bin/memento.js recall "배포 기록" \
  --remote https://memento.anchormind.net/mcp \
  --key mmcp_xxx

# 환경변수로 설정 후 사용
export MEMENTO_CLI_REMOTE=https://memento.anchormind.net/mcp
export MEMENTO_CLI_KEY=mmcp_xxx
node bin/memento.js recall "배포 기록"
node bin/memento.js stats
node bin/memento.js remember "배포 완료" --topic deploy --type procedure
```

`serve`, `migrate`, `cleanup`, `backfill`, `health`, `update` 명령에서 `--remote`를 사용하면 에러가 반환된다.

---

## 출력 포맷 상세

| 포맷 | 특징 | 권장 상황 |
|------|------|-----------|
| `table` | 사람이 읽기 쉬운 정렬 표 | TTY 터미널 직접 확인 |
| `json` | 기계 판독 가능한 JSON | 파이프 처리, 스크립트 |
| `csv` | 쉼표 구분 값 | 스프레드시트, awk 처리 |

TTY 감지: 파이프나 리다이렉트 환경(`| jq`, `> out.txt`)에서는 `--format`을 명시하지 않아도 자동으로 `json`을 선택한다.

`recall --format csv` 출력 예시:

```
id,type,topic,importance,content
frag-00abc123,fact,infra,0.80,"PostgreSQL 연결 시 pg_hba.conf 설정 필요"
frag-00def456,procedure,deploy-2026,0.70,"배포 완료"
```

---

## npm 스크립트 연동

| 스크립트 | 실행 내용 |
|---------|---------|
| `npm start` | `node server.js` (서버 시작) |
| `npm run cli -- <args>` | `node bin/memento.js <args>` |
| `npm run migrate` | `node scripts/migrate.js` |
| `npm run backfill:embeddings` | `node scripts/backfill-embeddings.js` |
| `npm test` | node:test 단위 테스트 |
| `npm run test:integration` | 통합/E2E 테스트 일괄 실행 |
| `npm run test:integration:llm` | LLM provider 통합 테스트 순차 실행 |

---

## 스크립트 단독 실행

### 임베딩 일관성 검사

```bash
DATABASE_URL=$DATABASE_URL EMBEDDING_DIMENSIONS=1536 \
  node scripts/check-embedding-consistency.js
```

`fragments`와 `morpheme_dict` 두 테이블의 실제 벡터 차원이 `EMBEDDING_DIMENSIONS` 설정과 일치하는지 확인한다. 불일치 시 `FAIL`을 출력하고 `migration-007` 재실행 가이드를 제공한다.

### 벡터 차원 변경 (migration-007 재실행)

임베딩 제공자 변경 또는 `EMBEDDING_DIMENSIONS` 변경 후 실행한다.

```bash
EMBEDDING_DIMENSIONS=384 DATABASE_URL=$DATABASE_URL \
  node scripts/post-migrate-flexible-embedding-dims.js
```

`fragments`와 `morpheme_dict` 테이블의 벡터 컬럼 차원을 동시에 갱신한다.

### 임베딩 백필

기존 파편의 임베딩이 없거나 차원이 변경된 경우 재생성한다.

```bash
node scripts/backfill-embeddings.js
```

### L2 정규화

임베딩 벡터를 L2 정규화한다. 제공자 전환 후 1회 실행하면 된다.

```bash
DATABASE_URL=$DATABASE_URL node scripts/normalize-vectors.js
```
