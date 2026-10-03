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

`serve`를 뺀 모든 명령은 서버 로그를 표준 오류로 보낸다(`MEMENTO_LOG_STDERR=true`를 명령 모듈을 불러오기 전에 정한다). 표준 출력에는 명령 결과만 남으므로 `--json` 출력을 그대로 파이프로 넘길 수 있다. 환경에 `MEMENTO_LOG_STDERR`를 직접 두면 그 값을 따른다.

### 원격 접속 환경변수

| 변수 | 설명 |
|------|------|
| `MEMENTO_CLI_REMOTE` | `--remote` 미지정 시 사용할 MCP 서버 URL |
| `MEMENTO_CLI_KEY` | `--key` 미지정 시 사용할 API 키 |
| `CLAUDE_PLUGIN_OPTION_SERVER_URL`, `CLAUDE_PLUGIN_OPTION_API_KEY` | `hook` 전용. Claude Code가 플러그인 훅 프로세스에 넘기는 userConfig 값(`server_url`, `api_key`)이다. 있으면 `MEMENTO_CLI_REMOTE`, `MEMENTO_CLI_KEY`보다 앞선다. 직접 설정하지 않는다 |

`init`은 현재 디렉터리의 `.env`를 불러오지 않으며, 만드는 파일은 환경 변수의 영향을 받지 않는다.

---

## 서브명령 분류

### local-only (원격 접속 불가)

`serve`, `migrate`, `cleanup`, `backfill`, `health`, `update`, `export`, `import`, `benchmark`, `anchor-scope` 는 직접 DB / 프로세스에 접근하는 명령이므로 `--remote` 플래그와 함께 사용하면 에러를 반환한다.

### 원격 지원

`recall`, `remember`, `stats`, `inspect`, `session` 는 `--remote URL --key KEY`로 원격 MCP 서버를 경유하여 실행할 수 있다.

`hook`은 원격 서버 전용이다. `--remote`(또는 `MEMENTO_CLI_REMOTE`)와 `--key`(또는 `MEMENTO_CLI_KEY`)가 반드시 있어야 한다.

`init`은 서버에 접속하지 않고 로컬 파일만 만든다.

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
| `export [--topic x] [--type t] [--format-version n]` | 파편 JSONL 덤프(형식 버전 2 기본) | 아니오 |
| `import [--input FILE] [--key id] [--restore]` | JSONL 흡수 (파일 또는 stdin) | 아니오 |
| `completion <shell>` | bash/zsh 보완 스크립트 출력 | 예 |
| `benchmark [--goldset FILE]` | 골드셋 기반 회상 품질 계측 | 아니오 |
| `anchor-scope [--execute]` | 승인된 공유 앵커 범위 점검·정규화, snapshot backfill (기본 dry-run) | 아니오 |
| `hook <event> --client <name>` | Claude Code, Codex command 훅 실행체 (`SessionStart`, `Stop`, `SessionEnd`) | 원격 전용 |
| `init --target <claude\|codex>` | Claude Code, Codex 플러그인을 로컬 마켓플레이스로 생성 (기본 dry-run, `--write`로 쓰기) | 해당 없음 |

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
node bin/memento.js cleanup --execute --include-nli  # NLI 충돌 파편도 삭제
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

`--format table`은 key/value 표(Fragments, Anchors, Active, Expired, Topics, Avg utility, Noise ratio)와 상위 5개 토픽 표를 출력한다.

출력 예시 (`--format json`, 로컬):

```json
{
  "fragments": 1204,
  "anchors": 38,
  "active": 1180,
  "expired": 24,
  "topics": 12,
  "avgUtility": 0.62,
  "noiseEstimate": { "count": 9, "ratio": 0.7 },
  "topTopics": [{ "topic": "infra", "fragments": 210 }]
}
```

`--remote` 모드의 `stats`는 서버의 `memory_stats` 도구를 호출하므로 master 키가 필요하고, 출력은 서버가 돌려준 통계 객체다.

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
| `--type <t>` | 파편 유형 필터 (fact, decision, error, preference, procedure, relation) |
| `--limit <n>` | 반환 건수 상한 (기본: 10) |
| `--time-range from,to` | 날짜 범위 필터 (ISO 8601) |
| `--workspace <name>` | 해당 workspace + 전역(NULL) 파편 검색 |
| `--all-workspaces` | master 전용 전체 workspace 검색 |
| `--include-peer-agents` | master 전용. 같은 key/workspace 범위의 모든 agent 파편 포함 |

workspace와 key default를 모두 생략하면 전역(NULL) 파편만 검색한다. 저장할 때 workspace를 명시했다면 조회에도 같은 `--workspace`를 전달해야 한다. 빈 결과 힌트는 이 범위 차이를 안내한다. 종전 master 전체 검색 동작이 필요하면 `--all-workspaces`를 명시한다.

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
| `--type <t>` | 파편 유형 (fact, decision, error, preference, procedure, relation. 기본: fact) |
| `--importance <n>` | 중요도 0.0~1.0 (미지정 시 유형별 기본값) |
| `--keywords <a,b,c>` | 쉼표로 구분한 키워드 |
| `--source <name>` | 출처 라벨 (기본: cli) |
| `--stdin` | 표준 입력에서 내용을 읽는다 (TTY가 아니면 자동 감지, 최대 1MB) |
| `--idempotency-key <k>` | 동일 키가 있으면 저장 건너뜀 (멱등성 보장) |

로컬 모드(`--remote` 없음)는 서버 remember와 같은 의미 쓰기 관문을 거쳐 FragmentWriter로 기록한다.

- 이메일, 비밀번호 필드, 휴대전화 번호, API 키와 토큰, 개인 키, 주민등록번호, 카드 번호 형태를 마스킹한다(`MEMENTO_SENSITIVE_SCAN`).
- 300자(episode는 1000자)를 넘는 본문은 잘라 저장한다.
- 지정한 키워드는 소문자로 정규화하고 본문에서 추출한 키워드와 합친다.
- 중복 판정 범위(`MEMENTO_DEDUP_SCOPE`, 기본은 같은 workspace 또는 전역 파편)에 같은 본문이 이미 있으면 새 행을 만들지 않고 기존 파편 id를 출력한다.
- importance는 서버 저장과 같은 유형별 상한을 적용해 저장한다(출력은 요청 값).
- content_hash는 서버 저장과 같은 본문 전체 sha256(64자 16진수)이다.
- PolicyRules 경고가 있으면 `--json` 출력에 `validation_warnings`를 싣는다.

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

`session rotate`는 Redis에 저장된 세션 데이터를 유지하면서 ID만 재바인딩한다. 진행 중이던 작업과 기억 파편은 영향 없다. `reason`은 최대 128자 감사 로그용 문자열이며 CLI의 기본값은 `user_request`다(HTTP를 직접 호출하면 기본값은 `explicit_rotate`).

rotate 엔드포인트 정책:

- HTTP: `POST /session/rotate` (body: `{ "reason": "..." }`)
- 인증: `Authorization: Bearer <API key or master key>` + `Mcp-Session-Id` 헤더로 대상 세션 지정
- Origin 확인: `Origin` 헤더가 없으면 루프백 소켓의 요청만 받는다. `ALLOWED_ORIGINS`와 `ADMIN_ALLOWED_ORIGINS`가 하나라도 설정되어 있으면 두 목록에 없는 Origin은 403
- Rate limit: IP당 분당 `MEMENTO_ROTATE_RATE_LIMIT_PER_MIN` (기본 5) 초과 시 429
- 메트릭: `mcp_session_rotation_total` (label: `outcome`, 값: `rotated`, `not_found`, `expired`, `forbidden`, `unavailable`, `error`), `mcp_rotate_rate_limited_total`

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

파편을 JSONL 형식으로 덤프한다. 백업·이관용. 기본은 형식 버전 2(머리 줄, 파편 줄 전 열, 링크 줄, 끝 줄)이며 [API와 export 형식 버전 정책](api-versioning.md)이 구조를 정한다.

```bash
node bin/memento.js export --topic memento-mcp --type fact > out.jsonl
node bin/memento.js export --since 2026-04-01 --output backup.jsonl
node bin/memento.js export --key <key_id> --limit 500
node bin/memento.js export --include-versions --output full.jsonl
node bin/memento.js export --format-version 1 --output legacy.jsonl
```

주요 옵션: `--topic`, `--type`, `--since <ISO>`, `--limit <n>`, `--output <FILE>`, `--format-version <1|2>`, `--no-links`(링크 줄 제외), `--include-versions`(수정 이력 줄 추가), `--json` (배열 출력).

- 파편은 id 순 묶음으로 읽어 줄 단위로 쓴다.
- 링크는 양 끝이 모두 내보낸 파편이고 삭제되지 않은 것만 싣는다. `--topic`, `--type`, `--since`, `--limit`으로 범위를 좁히면 범위 밖 파편과 이어진 링크는 빠진다.
- 형식 버전 1은 파편 17열만 싣는다.

도움말:

```bash
node bin/memento.js export --help
```

### import

JSONL 파일 또는 stdin에서 파편(과 링크, 수정 이력)을 읽어 적재한다. 형식 버전 2 파일(export 결과)과 버전 1 파일(머리 줄 없는 파편 줄, 2027-10-03까지 수용)을 읽는다.

```bash
node bin/memento.js import --input out.jsonl
cat out.jsonl | node bin/memento.js import
node bin/memento.js import --input out.jsonl --idempotent --dry-run
node bin/memento.js import --input out.jsonl --key <key_id>
node bin/memento.js import --input full.jsonl --restore
```

주요 옵션: `--input <FILE>`, `--key <key_id>`(기록 대상 키, 없으면 마스터 범위), `--idempotent`, `--dry-run`, `--restore`, `--json`.

파편 줄은 줄마다 의미 쓰기 관문을 거쳐(트랜잭션 밖) FragmentWriter로 기록하며 줄마다 트랜잭션을 연다.

- 이메일, 비밀번호 필드, 휴대전화 번호, API 키와 토큰, 개인 키, 주민등록번호, 카드 번호 형태를 마스킹하고, 300자(episode는 1000자)를 넘는 본문은 잘라 저장한다. 키워드는 소문자로 정규화한다.
- 기록 키는 `--key`가 정하며 파일 행의 `key_id`는 읽지 않는다(`ignored.key_id`로 센다). CLI는 서버 호스트의 DB 계정으로 실행하는 소유자 경로이므로 `is_anchor`는 파일 값을 따른다.
- 집계는 imported(새로 기록), duplicates(중복 판정 범위(`MEMENTO_DEDUP_SCOPE`)에 같은 본문이 이미 있음), rejected(유형이 있는 사유), errors(행 문제가 아닌 실패)이고 한 행은 하나에만 들어간다. `--json`의 `skipped`는 `duplicates`와 같은 값이다.
- 관문이 받아들이지 않은 행(본문 누락이나 품질 미달, 4000자 초과, 형식이 잘못된 키워드, hard gate 키의 정책 위반)과 행의 값 때문에 DB가 거부한 행(type, assertion_status CHECK 제약 등)은 `rejected_by_reason`의 사유별로 세고 다음 줄을 계속 가져온다.
- 같은 id가 이미 있고 본문이 다른 행은 `id_conflict`로 거부한다. `--idempotent`는 같은 키 소속의 같은 id만 duplicates로 세고 다른 키 소속의 id는 `id_conflict`다. 다른 행이 쓰는 `idempotency_key`는 `idempotency_conflict`로 거부한다. 동시에 같은 행을 가져온 경우에는 한 번 다시 확인해 같은 본문이면 duplicates로 센다.
- 머리 줄도 끝 줄도 없고 모든 줄이 JSON이 아니거나 기록이 아니면 아무것도 기록하지 않고 종료 코드 1로 끝난다.
- 새로 기록한 행의 값이 파일과 달라지면 `transformed`로 센다(사유 `content`: 관문이 본문을 바꿈, `importance`: 유형별 상한이 값을 낮춤).
- 링크 줄은 양 끝 파편이 같은 실행에서 처리된 경우에만 기록한다. 본문이 같아 기존 파편으로 대응된 끝점은 기존 파편의 id로 건다. 수정 이력 줄은 이 실행에서 새로 만든 파편에만 붙인다.
- `--dry-run`은 같은 경로로 처리하고 끝에 트랜잭션을 되돌린다. 집계는 실제 실행과 같고 관문 지표는 남기지 않는다. 하나의 트랜잭션이라 기록한 행의 잠금을 끝날 때까지 쥐므로 파일당 파편 줄 5000개 안팎으로 나누어 실행한다. DB에 연결한다(관문에서 모두 거부되는 입력은 연결하지 않는다).
- `--restore`는 저장된 값을 되살린다. 형식 버전 2 파일에만 쓸 수 있으며 최소 품질 검사와 저장 길이 절삭을 건너뛰고 `importance`, `ttl_tier`, `workspace_source`를 파일 값 그대로 기록한다. 민감 정보 마스킹은 `MEMENTO_WRITE_GATE`가 켜져 있는 동안 그대로 적용하고(끄면 본문을 다듬지도 가리지도 않는다), 끝나든 오류로 멈추든 감사 로그에 `outcome`(completed, failed)과 그때까지의 집계 한 줄을 남긴다. 본문은 앞뒤 공백을 자르므로 바이트까지 같지는 않다. 보통 가져오기가 바꾸거나 거부하는 기존 행까지 같은 `content_hash`로 되살릴 때 쓴다.
- `created_at`과 `valid_from`은 파일 값을 쓰고, 접근 수와 검증 시각은 가져온 시점 값이 된다. 임베딩은 서버의 임베딩 백필이 만든다.

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

### hook

Claude Code와 Codex의 command 훅에서 실행한다. 하네스가 표준 입력으로 넘긴 훅 JSON을 읽어 서버의 `POST /hooks/<client>/<event>`로 보낸다. 서버 동작과 상한은 [configuration.md](configuration.md#훅-엔드포인트), 하네스 설정 예시는 [getting-started/hooks.md](getting-started/hooks.md)에 있다.

```bash
anchormind hook SessionStart --client claude-code
anchormind hook SessionEnd   --client codex --timeout 3000
```

| 옵션 | 설명 |
|-|-|
| `<event>` | `SessionStart`, `Stop`, `SessionEnd` |
| `--client` | `claude-code`, `codex` |
| `--remote`, `--key` | 서버 MCP 주소와 API 키. 없으면 프로세스 환경 변수 `MEMENTO_CLI_REMOTE`, `MEMENTO_CLI_KEY`를 쓴다. 키는 명령줄 대신 환경 변수로 준다(명령줄 인자는 프로세스 목록에 보인다). `hook`은 다른 명령과 달리 작업 디렉터리의 `.env`를 읽지 않는다(하네스는 작업 중인 저장소에서 훅을 실행하므로 저장소의 `.env`가 키와 발췌를 보낼 주소를 바꾸지 못하게 한다). 업데이트 확인도 하지 않는다 |
| `--timeout` | 요청 제한 시간(ms). 기본 `SessionEnd` 1200(Claude Code의 SessionEnd 훅 예산 1.5초 안), 그 밖 5000 |

- `SessionStart`: 서버 응답 `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"..."}}`를 표준 출력에 그대로 쓴다.
- `Stop`, `SessionEnd`: 입력의 `transcript_path` 파일 끝 4 MiB에서 사용자와 응답 메시지(도구 호출과 결과 제외)를 꺼내 최근 메시지부터 65536바이트 안의 발췌를 만들어 보낸다. 파일을 읽지 못하면 `last_assistant_message`를 쓰고, 보낼 내용이 없으면 요청하지 않고 끝낸다. 표준 출력에는 쓰지 않는다.
- 서버로 보내는 필드는 `hook_event_name`, `session_id`, `cwd`, `source`(SessionStart), `git_remote`, `excerpt`다. `git_remote`는 `cwd` 저장소의 `remote.origin.url`에서 자격 증명과 포트를 지운 값이고, `transcript_path`는 보내지 않는다.
- 실패(인자 오류, 연결 실패, 2xx가 아닌 응답)는 표준 오류에 `[hook] server responded <상태> (<오류 코드>)` 형식으로 쓰고 종료 코드 1로 끝난다. 두 하네스 모두 1을 비차단 오류로 다룬다(차단을 뜻하는 2는 쓰지 않는다).

### init

`integrations/`의 Claude Code 또는 Codex 플러그인을 로컬 플러그인 마켓플레이스 디렉터리로 만든다. 설치 절차는 [getting-started/plugins.md](getting-started/plugins.md)에 있다.

```bash
anchormind init --target claude                    # 만들 파일과 diff만 출력(dry-run)
anchormind init --target claude --write            # ~/.anchormind/claude-code에 쓴다
anchormind init --target codex --dir ./mk --url https://memento.example.com/mcp --write
```

| 옵션 | 설명 |
|-|-|
| `--target` | `claude`, `codex` |
| `--dir` | 마켓플레이스 디렉터리. 기본 `~/.anchormind/claude-code`, `~/.anchormind/codex` |
| `--url` | Codex `config.toml` 안내문에 넣을 MCP 서버 주소. 자격 증명이 든 주소는 거부한다 |
| `--write` | 파일을 쓴다. 없으면 아무것도 쓰지 않는다 |
| `--force` | `--write`와 함께 내용이 다른 기존 파일을 바꾼다 |

- 파일마다 상태를 출력한다: `create`(새 파일), `unchanged`(내용이 같아 건너뜀), `conflict`(내용이 다름. `--force` 없이 `--write`하면 아무 파일도 쓰지 않고 종료 코드 1), `blocked`(디렉터리나 심볼릭 링크. 언제나 쓰지 않음). `create`와 `conflict`는 기존 내용과의 줄 단위 diff를 함께 출력한다.
- 만드는 파일: Claude Code는 `.claude-plugin/marketplace.json`(마켓플레이스 `anchormind-local`)과 `plugins/anchormind/` 아래 `.claude-plugin/plugin.json`, `.mcp.json`, `hooks/hooks.json`, `skills/anchormind/SKILL.md`. Codex는 `.agents/plugins/marketplace.json`과 `plugins/anchormind/` 아래 `plugin.json`, `hooks/hooks.json`.
- API 키는 어떤 파일에도 쓰지 않고 `--key`도 받지 않는다. Claude Code는 플러그인을 켤 때 `api_key`를 묻고 보안 저장소에 둔다. Codex는 `config.toml`에 환경 변수 이름(`bearer_token_env_var = "MEMENTO_CLI_KEY"`)만 적도록 안내한다.
- 서버에 접속하지 않고, 현재 디렉터리의 `.env`를 불러오지 않는다.

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

local-only 명령(`serve`, `migrate`, `cleanup`, `backfill`, `health`, `update`, `export`, `import`, `benchmark`, `anchor-scope`)에서 `--remote`나 `MEMENTO_CLI_REMOTE`를 쓰면 에러가 반환된다.

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
| `npm run test:coverage` | 단위 테스트 실행 후 줄, 분기, 함수 커버리지 합계를 `coverage-baseline.json`과 비교 (`scripts/check-coverage.js`) |
| `npm run test:integration` | 통합/E2E 테스트 일괄 실행 |
| `npm run test:integration:llm` | LLM provider 통합 테스트 순차 실행 |
| `npm run test:e2e` | E2E 테스트만 실행 |
| `npm run test:e2e:local` | `scripts/run-e2e-tests.sh` 실행 |
| `npm run test:db` | 실제 PostgreSQL 시험(행 잠금 순서, 링크 일괄 생성 정합, 온라인 색인과 재개형 백필, 중복 판정 범위, 작업 기억 행, outbox 작업자, 내보내기와 가져오기 왕복). 실행마다 전용 데이터베이스를 만들고 지운다 |
| `npm run test:ci` | `npm test`와 `npm run test:integration` |
| `npm run lint` | ESLint |
| `npm run lint:ratchet` | `scripts/lint-ratchet.js`. 규칙별 수치가 기준선(`scripts/lint-baseline.json`)보다 늘면 실패 |
| `npm run lint:migrations` | `scripts/lint-migrations.js`. 마이그레이션 번호 충돌과 규약 위반 검사 |
| `npm run switches` | `scripts/switch-report.mjs`. 기능 스위치의 적용 값, 기본값, 상태를 표로 출력. `-- --strict`는 값이 잘못된 스위치가 있으면 종료 코드 1 |
| `npm run audit:ci` | audit-ci 의존성 점검 (`audit-ci.jsonc`) |
| `npm run release -- X.Y.Z` | `scripts/release.js`. 릴리스 준비(버전 표기 갱신, 커밋, annotated tag). push와 Release 생성 명령은 출력만 한다 |

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

`fragments`, `morpheme_dict`, `fragment_synthetic_query` 테이블의 벡터 컬럼 차원을 동시에 갱신한다. 스킵 판정은 (타입, 선언 차원) 쌍으로 하며, `--dry-run`으로 변환 대상만 미리 확인할 수 있다. 변환은 테이블별 트랜잭션으로 실행되어 중간 실패 시 롤백된다. 변환 후 `fragments`는 서버 스케줄러가 자동 재임베딩하지만 `morpheme_dict`는 `node scripts/backfill-morpheme-dict.js`를 별도 실행해야 한다.

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

### OAuth 클라이언트 정리

한 번도 쓰인 적 없는 오래된 동적 등록 클라이언트를 정리한다. API 키에 묶인 클라이언트는 대상에서 제외된다. 기본은 후보 수와 표본만 출력하는 미리보기이며 `--execute`를 주면 200건씩 삭제한다.

```bash
node scripts/purge-oauth-clients.js                         # 미리보기
node scripts/purge-oauth-clients.js --older-than-days 45    # 기준일 지정 (기본 30)
node scripts/purge-oauth-clients.js --execute               # 실제 삭제
```

삭제는 되돌릴 수 없으므로 실행 전에 `pg_dump -t agent_memory.oauth_clients`로 표를 보관한다.

### import 순환 검사

```bash
node scripts/import-cycles.js
```

`lib`, `config`, `server.js`의 상대 경로 import에서 크기 2 이상의 순환을 찾아 정적 import만 본 결과와 동적 import를 포함한 결과를 따로 출력한다.

### benchmark

골드셋 (저장문, 질의) 패러프레이즈 쌍으로 회상 품질을 정량 측정한다. 저장문을 격리 스코프에 적재하고 질의를 실행해 정답 파편의 순위를 구한 뒤 Recall@k, MRR, 지연을 산출하고, 실행이 끝나면 적재분을 회수한다.

```bash
node bin/memento.js benchmark
node bin/memento.js benchmark --repeat 3 --json
node bin/memento.js benchmark --save-baseline scripts/baseline-recall.json
node bin/memento.js benchmark --baseline scripts/baseline-recall.json
```

주요 옵션: `--goldset <path>`(기본 `tests/fixtures/recall-goldset.jsonl`), `--baseline <path>`, `--save-baseline <path>`, `--limit <n>`, `--repeat <n>`, `--synthetic`, `--page-size <n>`, `--key-scope isolated|corpus`, `--agent-id <id>`(기본 `benchmark-harness`), `--workspace <name>`(기본 `__benchmark__`), `--no-seed`, `--no-cleanup`, `--format table|json`.

실행 전에 대상 DB(host, port, database)를 표준 에러에 한 줄로 출력한다. 임베딩된 파편이 0건인 실행(`--no-seed` 포함)은 `--save-baseline`을 거부한다. 기준선 파일에는 임베딩 provider, 모델, 차원이 함께 기록되고, `--baseline` 비교에서 모델이나 차원이 다르면 경고한다. `isolated` 모드는 격리 키 `benchmark-harness-key`(상태 `inactive`) 행을 `api_keys`에 한 번 만든다.

`--synthetic`은 적재한 파편에 합성 역질의를 생성한 뒤 평가한다. 역질의 증강의 효과를 통제 변수로 재려는 목적이며, 파편당 LLM 호출이 발생하므로 기본 실행에는 포함되지 않는다.

`--baseline`으로 비교했을 때 회귀가 감지되면 종료 코드 2를 반환한다. Recall 하락 허용치는 2pp, 지연 p95 증가 허용치는 15%다. 같은 적재분 안에서는 회차 간 편차가 0이지만 적재를 다시 하면 1pp 안팎으로 움직이므로, 허용치를 그보다 좁게 잡으면 게이트가 잡음에 반응한다.

측정 모드는 두 가지다.

| 모드 | 후보 집합 | 재현성 | 용도 |
|-|-|-|-|
| `isolated` (기본) | 적재한 골드셋 파편만 | 회차 간 동일 | 변경 전후 귀속 비교 |
| `corpus` | 운영 파편과 경쟁 | 코퍼스 변화에 따라 달라짐 | 실제 건초더미에서의 체감 확인 |

`--repeat`는 한 번 적재한 뒤 평가만 반복해 중앙값과 회차 간 편차를 함께 보고한다. 적재 직후에는 형태소 등록과 자동 링크 생성이 끝나기를 기다리는 안정화 단계가 들어가며, 이 대기가 없으면 같은 코드에서도 회차마다 순위가 흔들린다.

도움말:

```bash
node bin/memento.js benchmark --help
```
