# maintenance

작성자: 최진호
작성일: 2026-04-19
수정일: 2026-10-03

운영 중 필요에 따라 실행하는 유지보수 스크립트 목록이다. 각 스크립트의 목적, 선행 조건, 실행 명령, 권장 빈도를 기술한다.

---

## 외부 노출 점검

memento-mcp가 localhost 밖에 노출되는지와 브라우저 Origin 정책이 의도대로 설정됐는지 확인한다.

```bash
ss -ltnp | grep ':57332'
grep -E '^(MEMENTO_ACCESS_KEY|MCP_STRICT_ORIGIN|ALLOWED_ORIGINS|ADMIN_ALLOWED_ORIGINS|TRUST_PROXY_HOPS|MEMENTO_CORS_MODE|MEMENTO_SSE_QUERY_KEY|MEMENTO_OAUTH_REDIRECT_CHECK|MEMENTO_FRAME_OPTIONS)=' .env | sed -E 's/=.*/=<set>/'
```

판단 기준:

- `*:57332` 또는 `0.0.0.0:57332`이면 네트워크 전체 인터페이스에 노출된다.
- 외부 노출 환경에서는 `MEMENTO_ACCESS_KEY`를 반드시 설정한다.
- 브라우저 기반 MCP 클라이언트를 허용할 때는 `ALLOWED_ORIGINS`에 실제 Origin만 둔다. 설정하면 목록 밖 Origin은 403이다. 미설정으로 둘 때의 응답 방식은 `MEMENTO_CORS_MODE`(기본 `observe`)로 정한다.
- Admin UI를 브라우저에서 열면 `ADMIN_ALLOWED_ORIGINS`를 명시하거나 리버스 프록시/방화벽에서 접근을 제한한다.
- 리버스 프록시 뒤에서 IP 기반 제한을 쓰면 실제 프록시 hop 수에 맞춰 `TRUST_PROXY_HOPS`를 설정한다.

Smoke test:

```bash
curl -si http://localhost:57332/health | head
curl -si -H 'Origin: https://evil.example' http://localhost:57332/mcp | head
```

`ALLOWED_ORIGINS`를 설정했다면 목록 밖 Origin은 403이어야 한다. 미설정이면 요청은 통과하며, `MEMENTO_CORS_MODE=allowlist`일 때만 신뢰 도메인 밖 Origin에 `Access-Control-Allow-Origin`이 붙지 않는다. `MCP_STRICT_ORIGIN=true`이면 `/mcp`는 신뢰 도메인과 `ALLOWED_ORIGINS` 밖의 Origin을 403으로 거부한다.

---

## 상태 확인 경로

| 경로 | 용도 | 응답 |
|-|-|-|
| `GET /health/live` | 재시작 판단. 이벤트 루프가 요청을 처리하는지만 본다 | 항상 200 `{"status":"alive","uptime":...}` |
| `GET /health/ready` | 의존 서비스 상태. 주 DB가 `MEMENTO_HEALTH_READY_DB_TIMEOUT_MS`(기본 2000) 안에 응답하는지 본다 | 200 `{"status":"ready"}` 또는 503 `{"status":"not_ready","reason":"db_timeout"\|"db_error"}` |
| `GET /health` | 기존 종합 상태(DB, Redis, pgvector, 워커) | 기존과 같다 |

세 경로 모두 인증 없이 호출할 수 있다. 호출 수와 지연은 `mcp_http_requests_total`의 `endpoint` 라벨로 구분한다.

종료 신호(SIGTERM, SIGINT)는 한 번만 처리하며, 이미 종료 중일 때 오는 신호는 `Shutdown already in progress` 로그만 남긴다. 종료 절차가 `MEMENTO_SHUTDOWN_DEADLINE_MS`(기본 60000, 0은 상한 없음) 안에 끝나지 않으면 종료 코드 1로 강제 종료한다.

---

## 와치독

`memento-watchdog.sh`는 cron이 매분 실행한다. `GET /health/live`가 200이 아니면(연결 실패, 5초 시간 초과 포함) 서비스를 재시작한다. `/health/live`가 404인 서버는 `/health`가 응답하면 살아 있는 것으로 본다. `/health/ready`는 호출해 상태 변화만 로그에 남기며, 준비 실패는 재시작 사유가 아니다.

| 환경 변수 | 기본값 | 의미 |
|-|-|-|
| `MEMENTO_WATCHDOG_BASE_URL` | `http://127.0.0.1:57332` | 상태 확인 대상 주소 |
| `MEMENTO_WATCHDOG_SERVICE` | `memento-mcp.service` | 재시작할 systemd 서비스 이름 |
| `MEMENTO_WATCHDOG_STATE_FILE` | `/tmp/memento-watchdog.state` | 상태 파일 경로. 연속 재시작 횟수, 마지막 재시작 시각, 마지막 ready 응답 코드를 한 줄로 기록한다 |
| `MEMENTO_WATCHDOG_LOCK_FILE` | 상태 파일 경로에 `.lock`을 붙인 값 | 중복 실행을 막는 잠금 파일. 이미 실행 중이면 조용히 끝난다 |
| `MEMENTO_WATCHDOG_STARTUP_GRACE_SEC` | `120` | 서비스 기동 후 이 시간 안에는 응답이 없어도 재시작하지 않는다 |
| `MEMENTO_WATCHDOG_BACKOFF_BASE_SEC` | `60` | 연속 재시작 사이의 첫 대기 시간 |
| `MEMENTO_WATCHDOG_BACKOFF_MAX_SEC` | `1800` | 연속 재시작 대기 시간의 상한 |
| `MEMENTO_WATCHDOG_RESTART_CMD` | (없음) | 지정하면 `sudo systemctl restart`를 대신해 이 명령을 실행한다 |
| `MEMENTO_WATCHDOG_NOW` | 현재 시각(epoch 초) | 시각 주입. 시험용 |
| `MEMENTO_WATCHDOG_SERVICE_AGE_SEC` | (없음) | 서비스 기동 후 경과 초 주입. 시험용 |
| `MEMENTO_WATCHDOG_ACTIVE_ENTER_TIMESTAMP` | (없음) | 서비스 기동 시각 주입. 시험용 |

연속 재시작의 대기 시간은 60초에서 시작해 재시작마다 두 배로 늘어 1800초에서 멈춘다. 대기 시간 안에 다시 응답 실패를 만나면 재시작하지 않고 로그만 남긴다. `/health/live`가 200으로 돌아오면 연속 재시작 횟수는 0으로 돌아간다.

재시작 이력은 재시작 명령을 부르기 전에 임시 파일을 거쳐 상태 파일에 기록한다. 상태 디렉터리에 쓸 수 없어 이력을 남길 수 없으면 간격을 지킬 수 없으므로 재시작을 건너뛰고 한 줄을 로그에 남긴다. 상태 파일이 손상됐으면 방금 재시작한 것으로 보고 첫 대기 구간부터 다시 시작한다.

---

## 메트릭 모니터링

서버 건전성 지표를 확인하는 두 가지 경로다. 목적에 따라 선택한다.

| 항목 | Admin /metrics-summary | Grafana |
|-|-|-|
| 목적 | 즉각 진단 (at-a-glance) | 심층 분석, 시계열 추이 |
| 접근 방법 | Admin UI 메트릭 메뉴 또는 REST API | 운영자가 구성한 Grafana 인스턴스 |
| 데이터 소스 | prom-client in-memory Registry | Prometheus scrape (15s 간격) |
| 응답 캐시 | 10초 | Prometheus 보관 주기 |
| 폴링 주기 | Admin UI 자동 30초 | 대시보드 설정에 따름 |
| DB/Redis 의존 | 없음 | Prometheus 서버 필요 |
| 장기 보관 | 없음 (재시작 시 초기화) | Prometheus TSDB 보관 |

### Admin /metrics-summary 경로

엔드포인트: `GET /v1/internal/model/nothing/metrics-summary`

인증: `Authorization: Bearer <MEMENTO_ACCESS_KEY>` (master 키 전용)

응답 구조:

```json
{
  "cards": {
    "activeSessions": 12,
    "authDeniedRate5m": 0.5,
    "rbacDeniedRate5m": 0.0,
    "tenantBlockedTotal": 3,
    "rpcLatencyP50": 45,
    "rpcLatencyP99": 230,
    "toolErrorRate5m": 0.2,
    "symbolicGateBlocked": 0,
    "oauthTokensIssuedRate1h": 8
  },
  "tools": [
    { "tool": "remember", "total_calls": 1024, "success_rate": 0.998, "p95_ms": 35 }
  ],
  "errors": [
    { "error_type": "rpc_invalid_params", "count": 5, "last_seen": "2026-04-20T15:00:00Z" }
  ],
  "generated_at": "2026-04-20T16:00:00Z",
  "window_sec": 60
}
```

rate 값(authDeniedRate5m, toolErrorRate5m 등)은 서버 메모리의 직전 snapshot과 현재 Counter 값의 delta를 windowSec으로 나눈 값이다. 서버 재시작 시 첫 번째 응답의 rate는 0이다.

`?windowSec=N` 쿼리 파라미터로 rate 계산 윈도우를 조정한다 (기본 60초, 최솟값 5초).

### 배치 풀 메트릭

`BatchRememberProcessor`가 전용 연결 풀(`application_name=memento-mcp:batch`)을 사용한다. 풀 크기는 주 풀 최대 연결 수의 30%(최소 2)이며, `BATCH_DATABASE_URL`이 설정되면 별도 DB로, 미설정이면 같은 DB의 별도 풀로 연결한다. 스케줄러가 1분 간격으로 수집하는 풀 상태를 아래 세 게이지로 관찰한다.

```
mcp_batch_pool_active_connections   — 체크아웃된 연결 수
mcp_batch_pool_idle_connections     — 유휴 연결 수
mcp_batch_pool_waiting_count        — 연결 대기 쿼리 수
```

`mcp_batch_pool_waiting_count`가 지속적으로 0이 아니면 배치 풀 크기 또는 `BATCH_DATABASE_URL` 연결 수 설정을 검토한다.

### 비반영 세션 SCAN 상한

`SessionActivityTracker.getUnreflectedSessions(limit)`는 Redis SCAN(COUNT 50)으로 `frag:activity:*` 키를 순회한다. 최대 20회(50×20=1000키) 순회 후 중단하는 상한(`MAX_SCANS=20`)이 적용되어 있다. Admin UI "REFLECT ALL"(limit=1000), context 빌더(limit=3) 등 호출 사이트에 따라 실제 탐색 범위가 달라지며, Redis keyspace가 매우 큰 환경에서는 상한 이전에 조기 종료될 수 있다.

### Grafana 경로

memento-mcp 서버의 `/metrics` 엔드포인트를 scrape한다 (인증 필요, scrape_interval 15초).

Prometheus `/metrics` 엔드포인트가 메트릭을 노출한다. 수집 도구는 운영자가 자유롭게 구성한다.

---

## migration-034-v2.16.0-bundle 적용 체크리스트

migration-034-v2.16.0-bundle은 `fragments.idempotency_key` 컬럼과 테넌트별 partial unique index 2개를 추가한다.

### 기본: 자동 실행

`npm run migrate`가 `migration-034-v2.16.0-bundle.sql`을 번호 순으로 자동 탐지하여 실행한다. `agent_memory.schema_migrations`에 적용 이력이 기록된다.

```bash
DATABASE_URL=postgresql://... npm run migrate
```

### 대규모 운영 테이블: 수동 CONCURRENTLY 실행

수백만 건 이상의 파편이 있는 운영 DB에서는 `CREATE INDEX`가 테이블 잠금을 발생시킬 수 있다. 이 경우 `npm run migrate` 실행 전에 아래 두 문을 직접 실행한다. IF NOT EXISTS 가드로 인해 자동 실행 시 SKIP된다.

```sql
-- psql 접속 후 (DATABASE_URL 환경에서 직접 실행)
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_fragments_idempotency_tenant
  ON agent_memory.fragments (key_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND key_id IS NOT NULL;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_fragments_idempotency_master
  ON agent_memory.fragments (idempotency_key)
  WHERE idempotency_key IS NOT NULL AND key_id IS NULL;
```

CONCURRENTLY 실행은 트랜잭션 외부에서 이루어지므로 반드시 BEGIN/COMMIT 없이 단독 실행한다.

### 인덱스 검증

적용 후 psql에서 확인:

```sql
\d agent_memory.fragments
```

출력에 `idx_fragments_idempotency_tenant`와 `idx_fragments_idempotency_master` 두 인덱스가 모두 표시되어야 한다.

---

## X-RateLimit-* 모니터링

API 키 세션의 `POST /mcp` 응답에 `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Resource: fragments` 헤더가 포함된다(파편 할당량 기준, master 키와 null 할당량은 생략).

### 구현 특성

- `QuotaChecker.getUsage()`: 모듈 레벨 Map 캐시, TTL 10초, 최대 1000개 키 항목
- in-memory 캐시이므로 서버 재시작 시 초기화된다. 다중 인스턴스 배포에서는 인스턴스별로 독립 집계된다.

### nginx access log 기반 수집

nginx access_log 포맷에 헤더를 추가하면 Prometheus `nginx-exporter` 또는 Vector/Fluent Bit 파이프라인으로 수집할 수 있다.

```nginx
log_format memento_main '$remote_addr - $upstream_http_x_ratelimit_remaining '
                        '[$time_local] "$request" $status';
```

### Prometheus/Grafana 연동

`/metrics`에는 키별 할당량 게이지가 없다. 할당량 상태는 응답 헤더(`X-RateLimit-Remaining`)나 Admin API 키 목록의 `fragment_count`, `fragment_limit`에서 확인한다. 캐시 통과 횟수는 `mcp_quota_cache_pass_total`로 노출된다. remember 중복 적중 횟수는 `mcp_remember_duplicate_total{kind}`로 노출되며 `kind`는 `same_scope`, `other_workspace`, `closed`, `unknown`이다. 라벨이 붙은 카운터라 첫 적중이 발생하기 전에는 값이 출력되지 않는다.

---

## 정리 사이클 수동 실행

스케줄러가 기본 6시간 주기로 실행하는 것과 같은 경로다. 점검이나 마이그레이션 직후 확인 목적으로만 수동 호출한다.

MCP `memory_consolidate` 도구는 master 키 세션 전용이다. 일반 키 세션에는 tools/list에 나오지 않고, 호출하면 `Permission denied: 'memory_consolidate' requires master authentication`(-32001)이 반환된다. 마스터 컨텍스트로 직접 실행하려면 다음을 쓴다.

    node -e "import('dotenv/config').then(async()=>{const {MemoryManager}=await import('./lib/memory/MemoryManager.js');console.log(JSON.stringify(await MemoryManager.create().consolidate(),null,1));process.exit(0)})"

2026-08-28 운영 실측 기준 약 1만 3천 파편 규모에서 전 사이클 소요는 7분(421초)이다. 한 사이클의 대표 결과는 다음과 같았다.

| 항목 | 값 |
|-|-|
| ttlTransitions | 132 |
| expiredDeleted | 9 |
| fragmentsSplit | 2 |
| semanticDedupMerged | 1 |
| utilityUpdated | 13211 |
| anchorsPromoted | 47 |
| anchorPromotionEnabled | true |

`anchorPromotionEnabled`는 `MEMENTO_AUTO_PROMOTE_ANCHORS`의 적용 상태다. `false`이면 `promote_anchors` 단계만 `disabled_by_config` 사유로 건너뛴다. `anchorsPromoted`가 발생하면 해당 파편이 permanent 계층으로 올라가므로, 이후 `forget`은 `force: true` 없이는 삭제하지 못한다. 점검용 파편을 만들었다면 정리 사이클을 돌리기 전에 회수하는 편이 낫다.

시맨틱 중복 제거 단계의 차단 건수는 `memento_consolidate_gate_blocked_total`로 노출된다. 라벨이 붙은 카운터라 첫 차단이 발생하기 전에는 값이 출력되지 않는다.

## 스위치 보고

릴리스 보고마다 기능 스위치의 on/off 표를 싣는다. 표는 `scripts/switch-report.mjs`가 만든다.

1. 보고 대상 환경의 환경 변수를 셸에 올린다. 스크립트는 프로세스 환경만 읽고 `.env` 파일을 읽지 않는다. 서비스 환경 파일을 쓰는 설치에서는 `set -a; . <환경 파일 경로>; set +a`로 올린다.
2. `npm run switches -- --strict`를 실행해 표를 얻는다. 값이 잘못된 스위치가 있으면 종료 코드 1이므로 그 상태로는 릴리스 보고를 마치지 않는다(관문). 표에는 스위치, 적용 값, 기본값, 상태(`on`, `off`, 방식 선택 열거는 `mode`), 기본과 다름, 분류, 예외 분류, 용도가 있다. 키, 토큰, 주소를 담는 변수는 표에 없고, 잘못된 원본 값은 출력하지 않는다.
3. 표를 릴리스 보고에 붙이고 다음을 본문에 적는다. 기본과 다른 스위치와 그 이유, `값 오류`로 표시된 스위치와 조치, 출고 때 켜지 않은 스위치(예외 분류 칸이 채워진 항목과 기본이 `off`인 항목)의 현재 상태.
4. 서비스가 떠 있으면 같은 요약을 관리 API `GET /v1/internal/model/nothing/stats`의 `switches`와 기동 로그의 `[Startup] switches:` 줄에서 확인할 수 있다. 표와 이 요약의 개수가 같아야 한다.
5. 스위치를 추가하거나 기본값을 바꾼 변경은 같은 변경에서 `config/switches.js`와 `docs/configuration.md`, `docs/configuration.en.md`, `.env.example`을 함께 고친다. `tests/unit/switch-ledger-structure.test.js`가 누락을 실패로 알린다.

---

## 스크립트 목록 및 호출 조건

| 스크립트 | 목적 | 호출 조건 | 빈도 |
|-|-|-|-|
| `scripts/migrate.js` | DB 마이그레이션 자동 실행 및 synthetic-query 보조 임베딩 차원 정합화 | 서버 업그레이드, 초기 설치 | 버전 업그레이드 시 1회 |
| `scripts/ops/backup.sh` | agent_memory 스키마 `pg_dump -Fc`, 체크섬, 행 수 매니페스트, 역할 정의 덤프 (`--dir`, `--keep`, `--dry-run`). 절차는 `docs/operations/backup-restore.md` | 일일 백업, 마이그레이션 반영 직전 | 하루 1회와 마이그레이션 전 |
| `scripts/ops/restore-verify.mjs` | 덤프를 일회용 시험 서버(35433)에 복원해 행 수, `schema_migrations` 최댓값, HNSW 색인을 매니페스트와 대조하고 JSON으로 출력 | 복구 훈련 | 분기 1회 이상 |
| `scripts/ops/online-index.mjs` | 작업 목록(`scripts/ops/index-manifest.json`)의 대형 표 색인을 `CONCURRENTLY`로 생성 (`--dry-run`, `--confirm`, `--index`, `--data-dir` 또는 `--free-bytes`). 절차는 `docs/operations/online-migration.md` | 대형 표 색인이 있는 마이그레이션 반영 전 | 조건부 |
| `scripts/ops/finish-dedup-scope.mjs` | 새 판정 색인 두 개가 유효한지 확인한 뒤 키 범위 content_hash 색인을 `DROP INDEX CONCURRENTLY`로 지워 중복 판정 범위 전환을 마침 (옵션 없으면 단계만 출력, `--confirm`으로 실행) | migration-050 반영 뒤 「중복 판정 범위 전환」 6단계 | 일회성 |
| `scripts/measure/recall-metrics.mjs` | 평가 세트로 R@k, MRR, 토큰 예산 내 nDCG, 지연을 일회용 시험 서버의 DB에서 측정하고 `--compare`로 두 실행을 비교. 절차는 `docs/benchmark.md` | 검색 경로나 스위치 변경 전후 비교 | 조건부 |
| `scripts/measure/protocol-era-probe.mjs` | `handleMcpPost`를 같은 프로세스의 임시 서버(127.0.0.1, 기본 포트 18913, 57332 거부)에 물리고 MCP 2026-07-28 방식 요청, 규격의 era 판정, initialize 폴백, `memento_modern_protocol_attempts_total` 값을 JSON으로 출력. `DOTENV_CONFIG_PATH`가 없는 파일이거나 임시 디렉터리 아래 파일이 아니면 설정을 읽기 전에 종료 코드 2로 멈추며(`.env`, `.env.test` 거부), 임시 서버의 마스터 키는 실행마다 만든 무작위 값이다. `REDIS_ENABLED=false`로 실행 | 프로토콜 처리 경로 변경 전후 | 조건부 |
| `scripts/backfill-embeddings.js` | embedding IS NULL 파편에 임베딩 일괄 생성 | EMBEDDING_PROVIDER 변경 후, 임베딩 API 장애 복구 후 | 조건부 1회 |
| `scripts/backfill-morpheme-dict.js` | morpheme_dict의 embedding NULL 행 일괄 재임베딩 (`--dry-run`·`--batch`·`--sleep-ms`·`--max`) | 형태소 사전 NULL 행 누적 확인 시 (backfill-embeddings는 fragments 전용이라 이 테이블을 다루지 않음) | 조건부 1회 |
| `scripts/check-embedding-consistency.js` | 설정 차원과 DB 실제 벡터 차원 일치 검증 | 서버 기동 시 자동 실행 (server.js 내부 호출) | 기동마다 자동 |
| `scripts/normalize-vectors.js` | 기존 임베딩 벡터 L2 정규화 | 임베딩 제공자 전환 직후 1회 | 조건부 1회 |
| `scripts/cleanup-noise.js` | 초단문·빈 세션 요약·NLI 재귀 쓰레기 파편 탐지·삭제 | recall 품질 저하 또는 context 토큰 예산 오염 시 | 조건부, 필요 시 월 1회 |
| `scripts/purge-oauth-clients.js` | 한 번도 쓰이지 않은 오래된 OAuth DCR 클라이언트 정리 (기본 미리보기, `--execute`로 삭제, `--older-than-days`, 키 묶음 클라이언트 제외) | `oauth_clients`에 미사용 행이 누적됐을 때. 삭제 전 `pg_dump -t agent_memory.oauth_clients` 보관 | 조건부 |
| `scripts/purge-orphan-case-summaries.js` | 원본 파편이 없는 `case_events` 요약을 `[삭제됨]`으로 정리 (대상은 `--url` 또는 PG 환경변수만, 기본 미리보기, `--execute --i-have-a-backup`으로 변경, `--batch`) | migration-054 배포 직후 1회, 이후 만료 정리와 병합이 남긴 요약을 확인할 때. 변경 전 `pg_dump -t agent_memory.case_events` 보관 | 일회성, 이후 조건부 |
| `scripts/post-migrate-flexible-embedding-dims.js` | fragments + morpheme_dict + fragment_synthetic_query 임베딩 컬럼 차원 동시 조정 | EMBEDDING_DIMENSIONS 변경 또는 provider 전환 시 | 조건부 1회 |
| `scripts/backfill-claims.js` | 기존 코퍼스에 ClaimExtractor 소급 실행 | Shadow mode(MEMENTO_SYMBOLIC_SHADOW=true) 활성화 전 | 일회성 |
| `scripts/backfill-split-keywords.js` | keywords가 빈 split 자식 파편에 키워드 소급 생성 | 5.3.1 이하에서 생성된 split 자식이 키워드 검색에 잡히지 않을 때 | 일회성 |
| `scripts/backfill-body-keywords.js` | 본문 식별자가 keywords에 없는 파편에 추출 결과 소급 병합 | 5.4.1 이하에서 keywords를 지정해 저장한 파편의 코드 식별자가 검색되지 않을 때 | 일회성 |
| `scripts/benchmark-hot-path.js` | remember/recall/link/reflect 4개 hot path p50/p95/p99 측정 | Symbolic Memory feature flag 전환 전후 회귀 기준선 확보 | 조건부 |
| `scripts/switch-report.mjs` | 기능 스위치별 적용 값, 기본값, on/off, 기본과 다름을 마크다운 표로 출력 (`npm run switches`, 프로세스 환경만 읽음) | 릴리스 보고, 환경 변경 점검 | 릴리스마다 |
| `scripts/run-e2e-tests.sh` | Docker 기반 E2E 테스트 실행 | CI/CD 파이프라인 또는 대규모 리팩터링 후 회귀 검증 | CI마다 또는 릴리즈 전 |
| `scripts/smoke-test-symbolic.sh` | Symbolic Memory end-to-end smoke 검증 | MEMENTO_SYMBOLIC_* 플래그 전환 후 | 조건부 |
| `scripts/test-llm-callers.mjs` | AutoReflect/ConsolidatorGC/ContradictionDetector/MemoryEvaluator LLM 스키마 E2E 검증 | LLM provider 교체 또는 프롬프트 수정 후 | 조건부 |

`npm run migrate`는 번호가 매겨진 SQL 마이그레이션을 적용한 뒤
`fragment_synthetic_query.embedding`을 기존 `fragments.embedding`과 비교한다.
두 컬럼의 타입 또는 선언 차원이 다르면 같은 트랜잭션에서 보조 테이블을 잠근 뒤
HNSW 인덱스를 삭제하고, `fragment_synthetic_query`의 파생 행 전체를 삭제한 다음
컬럼 타입을 변경하고 `WHERE embedding IS NOT NULL` 부분 HNSW 인덱스를 재생성한다.
실패하면 행 삭제와 DDL을 함께 롤백한다. `fragments`와 `morpheme_dict`의
임베딩은 이 보정 단계에서 변경하지 않는다. 이 동작은 `migration-049`로
버전 이력에도 기록되며, 이미 정합한 설치에서는 아무 변경도 하지 않는다.

행을 남긴 채 임베딩만 NULL로 바꾸면 `SyntheticQueryWorker.backfill()`의
`NOT EXISTS` 조건에 걸려 다시 생성되지 않으므로 행 자체를 삭제한다.
마이그레이션이 동기적으로 역질의를 생성하는 것은 아니다.
`MEMENTO_SYNTHETIC_QUERY_ENABLED=true`이고 임베딩이 설정된 워커가 동작하면,
큐가 빈 회차의 기존 백필이 현재 중요도·유형 등 자격 조건을 만족하는 파편을 회수한다.
재생성이 끝날 때까지 역질의 검색 결과가 줄어들 수 있으며, 설정한 생성·임베딩
제공자에 따라 재생성 비용이 발생할 수 있다. 워커가 꺼져 있으면 파생 행은 비어 있는 채로 남는다.

---

## backfill-embeddings

### 목적

`agent_memory.fragments` 테이블에서 `embedding IS NULL`인 파편에 임베딩 벡터를 일괄 생성한다. `EMBEDDING_PROVIDER` 변경 후 기존 임베딩과의 차원 불일치를 해소하거나, 임베딩 API 장애 중 저장된 파편을 사후 처리할 때 사용한다.

중요: OpenAI 계열 임베딩과 로컬 transformers 임베딩은 차원이 다르므로 혼합할 수 없다. provider를 전환한 경우에는 기존 파편 전체를 재생성해야 한다. 서버 기동 시 `scripts/check-embedding-consistency.js`가 차원 불일치를 감지하면 기동을 거부하므로 반드시 backfill 완료 후 재시작한다.

### 선행 조건

- `DATABASE_URL` 환경변수 설정
- `EMBEDDING_API_KEY`(또는 `OPENAI_API_KEY`) 또는 `EMBEDDING_PROVIDER=transformers` 설정
- 대상 파편 수가 많을 경우 외부 임베딩 API rate limit 감안

### 실행 명령

```bash
DATABASE_URL=postgresql://... npm run backfill:embeddings
# 또는 직접 실행
DATABASE_URL=postgresql://... node scripts/backfill-embeddings.js
```

배치 크기 10, 배치 간격 500ms로 고정 실행된다. 진행 상황은 stdout의 `Embedded: N (failed: F)` 카운터로 확인한다.

### 권장 빈도

`EMBEDDING_PROVIDER` 변경 시 1회. 임베딩 API 장애 복구 후 누락 파편이 있을 경우 조건부 실행.

---

## backfill-split-keywords

### 목적

`source LIKE 'split:%'`이면서 `keywords`가 비어 있는 파편에 본문 기반 키워드를 소급 생성한다. 키워드가 빈 파편은 배열 교집합(`keywords && $1`)을 사용하는 검색 경로에서 조회되지 않는다.

추출은 정상 저장 경로와 동일하게 `FragmentFactory.extractKeywords(content)`를 사용한다. 추출 결과가 비면 해당 파편은 건너뛰며 빈 배열로 덮어쓰지 않는다.

### 선행 조건

- `DATABASE_URL` 환경변수 설정
- 기본 실행은 dryRun이며 대상 건수와 샘플만 출력한다. 실제 반영은 `--execute` 필수

### 실행 명령

```
node scripts/backfill-split-keywords.js            # 미리보기
node scripts/backfill-split-keywords.js --execute  # 실제 반영
```

### 대상 확인 질의

```sql
SELECT count(*) FROM agent_memory.fragments
 WHERE source LIKE 'split:%' AND coalesce(cardinality(keywords), 0) = 0;
```

---

## cleanup-noise

### 목적

`agent_memory.fragments`에서 저품질 파편 3가지 범주를 탐지하고 삭제한다.

- 초단문: `content` 길이 < 10자, `access_count` <= 1, `is_anchor IS NOT TRUE`
- 빈 세션 요약: `type = 'fact'`, `content LIKE '%파편 0개 처리%'`, `importance < 0.3`
- NLI 재귀 쓰레기: `content LIKE '[모순 해결]%'`, `access_count <= 1`, `importance < 0.3` (`--include-nli` 지정 시에만 처리)

기본 실행은 `--dry-run` 모드로 삭제 대상 수와 샘플만 출력한다.

### 선행 조건

- `DATABASE_URL` 환경변수 설정
- 실제 삭제 전 `--dry-run`으로 대상 규모 확인 필수

### 실행 명령

```bash
# 대상 미리보기 (삭제하지 않음)
DATABASE_URL=postgresql://... node scripts/cleanup-noise.js --dry-run

# NLI 쓰레기 포함 미리보기
DATABASE_URL=postgresql://... node scripts/cleanup-noise.js --dry-run --include-nli

# 실제 삭제
DATABASE_URL=postgresql://... node scripts/cleanup-noise.js --execute

# NLI 쓰레기까지 포함하여 삭제
DATABASE_URL=postgresql://... node scripts/cleanup-noise.js --execute --include-nli
```

### 권장 빈도

조건부. 노이즈 파편이 recall 품질이나 context 토큰 예산에 영향을 준다고 판단될 때 1회성 실행. 정기 실행이 필요하면 월 1회를 기준으로 한다.

---

## benchmark-hot-path

### 목적

`remember`, `recall`, `link`, `reflect` 4개 hot path의 p50/p95/p99 latency를 측정하고 결과를 JSON으로 저장한다. Symbolic Memory 계층 전환 전후 회귀 기준선 확보를 위해 설계되었으며, 결과는 `scripts/baseline-v27.json`에 저장된다.

### 선행 조건

- `DATABASE_URL` 환경변수 설정 (테스트 DB 전용. 프로덕션 DB 사용 금지)
- baseline 확보 시 `MEMENTO_SYMBOLIC_ENABLED=false`(기본값) 상태로 실행

### 실행 명령

```bash
# 기본 실행 (각 100/100/100/10회)
DATABASE_URL=postgresql://... node scripts/benchmark-hot-path.js

# 반복 횟수 및 출력 경로 지정
DATABASE_URL=postgresql://... node scripts/benchmark-hot-path.js \
  --remember 200 --recall 200 \
  --output scripts/baseline-custom.json

# Symbolic 계층 활성화 후 비교 측정
MEMENTO_SYMBOLIC_ENABLED=true \
DATABASE_URL=postgresql://... node scripts/benchmark-hot-path.js \
  --output scripts/baseline-symbolic.json
```

출력 JSON 형식: `{ runAt, gitSha, remember, recall, link, reflect }`. 각 항목은 `{ p50, p95, p99, n }` 구조다.

### 권장 빈도

조건부. Symbolic Memory feature flag 전환 전후에 실행하여 오버헤드를 비교한다.

---

## backfill-claims

### 목적

기존 코퍼스에 `ClaimExtractor`를 소급 실행하여 `fragment_claims` 테이블을 채운다. 실행 이후 새로 들어오는 파편은 `RememberPostProcessor` 8단계 hook에서 실시간 추출되므로, 이 스크립트는 `fragment_claims`가 비어 있는 기존 코퍼스 전용이다.

자세한 실행 가이드는 `docs/operations/backfill-claims.md`를 참조한다.

### 선행 조건

- `DATABASE_URL` 환경변수 설정
- ClaimExtractor가 의존하는 임베딩 API(`OPENAI_API_KEY` 등) 또는 로컬 transformers provider 설정
- 실행 전 `--dry-run`으로 추출 볼륨 및 `tenant_violations` 수치 확인 필수

### 실행 명령

```bash
# 볼륨 사전 확인 (dry run)
DATABASE_URL=postgresql://... node scripts/backfill-claims.js --dry-run --verbose --limit 100

# 전체 실행
DATABASE_URL=postgresql://... node scripts/backfill-claims.js \
  --batch-size 500 --rate-limit-ms 200

# 특정 테넌트만 처리
DATABASE_URL=postgresql://... node scripts/backfill-claims.js \
  --tenant-key mmcp_xxx --dry-run --verbose
```

### 권장 빈도

일회성. Shadow mode 활성화(`MEMENTO_SYMBOLIC_SHADOW=true`) 전 1회 실행.

---

## test-llm-callers

### 목적

`AutoReflect`, `ConsolidatorGC`, `ContradictionDetector`(2종), `MemoryEvaluator` 5개 LLM caller가 외부 LLM으로부터 기대하는 JSON 스키마를 올바르게 수신하는지 E2E로 검증한다. LLM provider 교체 또는 프롬프트 수정 후 회귀 확인 용도다.

### 선행 조건

- `LLM_PRIMARY`, `LLM_FALLBACKS` 환경변수 설정
- `POSTGRES_*`, `REDIS_*`, `OPENAI_API_KEY`, `LOG_DIR` 환경변수 설정
- 외부 LLM 엔드포인트(Gemini CLI, Ollama Cloud 등)가 네트워크 접근 가능 상태

### 실행 명령

```bash
# gemini-cli 우선 실행
node scripts/test-llm-callers.mjs

# Ollama Cloud fallback 강제 (gemini-cli PATH 차단)
PATH="/usr/bin:/bin" node scripts/test-llm-callers.mjs
```

종료 코드: 모든 케이스 통과 시 0, 하나라도 실패 시 1. stdout에 `PASS N/5  FAIL M/5` 요약을 출력한다.

### 권장 빈도

조건부. LLM provider 변경 또는 caller 프롬프트 수정 후 실행.
