# maintenance

작성자: 최진호
작성일: 2026-04-19
수정일: 2026-04-20

운영 중 필요에 따라 실행하는 유지보수 스크립트 목록이다. 각 스크립트의 목적, 선행 조건, 실행 명령, 권장 빈도를 기술한다.

---

## 외부 노출 점검

memento-mcp가 localhost 밖에 노출되는지와 브라우저 Origin 정책이 의도대로 설정됐는지 확인한다.

```bash
ss -ltnp | grep ':57332'
grep -E '^(MEMENTO_ACCESS_KEY|MCP_STRICT_ORIGIN|ALLOWED_ORIGINS|ADMIN_ALLOWED_ORIGINS|TRUST_PROXY_HOPS)=' .env | sed -E 's/=.*/=<set>/'
```

판단 기준:

- `*:57332` 또는 `0.0.0.0:57332`이면 네트워크 전체 인터페이스에 노출된다.
- 외부 노출 환경에서는 `MEMENTO_ACCESS_KEY`를 반드시 설정한다.
- 브라우저 기반 MCP 클라이언트를 허용할 때는 `MCP_STRICT_ORIGIN=true`와 `ALLOWED_ORIGINS`를 함께 설정한다.
- Admin UI를 브라우저에서 열면 `ADMIN_ALLOWED_ORIGINS`를 명시하거나 리버스 프록시/방화벽에서 접근을 제한한다.
- 리버스 프록시 뒤에서 IP 기반 제한을 쓰면 실제 프록시 hop 수에 맞춰 `TRUST_PROXY_HOPS`를 설정한다.

Smoke test:

```bash
curl -si http://localhost:57332/health | head
curl -si -H 'Origin: https://evil.example' http://localhost:57332/mcp | head
```

`MCP_STRICT_ORIGIN=false`에서는 등록되지 않은 Origin도 CORS만으로 차단되지 않을 수 있다. `MCP_STRICT_ORIGIN=true`에서는 허용 목록에 없는 Origin이 403이어야 한다.

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

`BATCH_DATABASE_URL`이 설정된 경우 `EmbeddingWorker`와 `BatchRememberProcessor`가 전용 연결 풀(`application_name=memento-mcp:batch`)을 사용한다. 풀 상태는 아래 세 게이지로 관찰한다.

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

HTTP 응답에 `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` 헤더가 포함된다.

### 구현 특성

- `QuotaChecker.getUsage()`: 모듈 레벨 Map 캐시, TTL 10초, 상한 1000 파편/창
- in-memory 캐시이므로 서버 재시작 시 초기화된다. 다중 인스턴스 배포에서는 인스턴스별로 독립 집계된다.

### nginx access log 기반 수집

nginx access_log 포맷에 헤더를 추가하면 Prometheus `nginx-exporter` 또는 Vector/Fluent Bit 파이프라인으로 수집할 수 있다.

```nginx
log_format memento_main '$remote_addr - $upstream_http_x_ratelimit_remaining '
                        '[$time_local] "$request" $status';
```

### Prometheus/Grafana 연동

서버의 `/metrics` 엔드포인트(인증 필요)에서 아래 메트릭으로 rate limit 상태를 확인할 수 있다.

```
memento_quota_used_total   — 창 내 사용된 파편 수 (레이블: key_id)
memento_quota_limit        — 설정된 상한 (레이블: key_id)
```

Grafana 알림 권장 임계값: `memento_quota_used_total / memento_quota_limit > 0.8` 시 경고.

---

## 정리 사이클 수동 실행

스케줄러가 기본 6시간 주기로 실행하는 것과 같은 경로다. 점검이나 마이그레이션 직후 확인 목적으로만 수동 호출한다.

MCP `memory_consolidate` 도구는 `admin` 권한을 요구하며, 권한이 없으면 `-32600 Internal error`가 반환되고 실제 사유는 서버 로그에만 남는다. 마스터 컨텍스트로 직접 실행하려면 다음을 쓴다.

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

`anchorsPromoted`가 발생하면 해당 파편이 permanent 계층으로 올라가므로, 이후 `forget`은 `force: true` 없이는 삭제하지 못한다. 점검용 파편을 만들었다면 정리 사이클을 돌리기 전에 회수하는 편이 낫다.

시맨틱 중복 제거 단계의 차단 건수는 `memento_consolidate_gate_blocked_total`로 노출된다. 라벨이 붙은 카운터라 첫 차단이 발생하기 전에는 값이 출력되지 않는다.

## 스크립트 목록 및 호출 조건

| 스크립트 | 목적 | 호출 조건 | 빈도 |
|-|-|-|-|
| `scripts/migrate.js` | DB 마이그레이션 자동 실행 | 서버 업그레이드, 초기 설치 | 버전 업그레이드 시 1회 |
| `scripts/backfill-embeddings.js` | embedding IS NULL 파편에 임베딩 일괄 생성 | EMBEDDING_PROVIDER 변경 후, 임베딩 API 장애 복구 후 | 조건부 1회 |
| `scripts/backfill-morpheme-dict.js` | morpheme_dict의 embedding NULL 행 일괄 재임베딩 (`--dry-run`·`--batch`·`--sleep-ms`·`--max`) | 형태소 사전 NULL 행 누적 확인 시 (backfill-embeddings는 fragments 전용이라 이 테이블을 다루지 않음) | 조건부 1회 |
| `scripts/check-embedding-consistency.js` | 설정 차원과 DB 실제 벡터 차원 일치 검증 | 서버 기동 시 자동 실행 (server.js 내부 호출) | 기동마다 자동 |
| `scripts/normalize-vectors.js` | 기존 임베딩 벡터 L2 정규화 | 임베딩 제공자 전환 직후 1회 | 조건부 1회 |
| `scripts/cleanup-noise.js` | 초단문·빈 세션 요약·NLI 재귀 쓰레기 파편 탐지·삭제 | recall 품질 저하 또는 context 토큰 예산 오염 시 | 조건부, 필요 시 월 1회 |
| `scripts/post-migrate-flexible-embedding-dims.js` | fragments + morpheme_dict 임베딩 컬럼 차원 동시 조정 | EMBEDDING_DIMENSIONS 변경 또는 provider 전환 시 | 조건부 1회 |
| `scripts/backfill-claims.js` | 기존 코퍼스에 ClaimExtractor 소급 실행 | Shadow mode(MEMENTO_SYMBOLIC_SHADOW=true) 활성화 전 | 일회성 |
| `scripts/backfill-split-keywords.js` | keywords가 빈 split 자식 파편에 키워드 소급 생성 | 5.3.1 이하에서 생성된 split 자식이 키워드 검색에 잡히지 않을 때 | 일회성 |
| `scripts/backfill-body-keywords.js` | 본문 식별자가 keywords에 없는 파편에 추출 결과 소급 병합 | 5.4.1 이하에서 keywords를 지정해 저장한 파편의 코드 식별자가 검색되지 않을 때 | 일회성 |
| `scripts/benchmark-hot-path.js` | remember/recall/link/reflect 4개 hot path p50/p95/p99 측정 | Symbolic Memory feature flag 전환 전후 회귀 기준선 확보 | 조건부 |
| `scripts/run-e2e-tests.sh` | Docker 기반 E2E 테스트 실행 | CI/CD 파이프라인 또는 대규모 리팩터링 후 회귀 검증 | CI마다 또는 릴리즈 전 |
| `scripts/smoke-test-symbolic.sh` | Symbolic Memory end-to-end smoke 검증 | MEMENTO_SYMBOLIC_* 플래그 전환 후 | 조건부 |
| `scripts/test-llm-callers.mjs` | AutoReflect/ConsolidatorGC/ContradictionDetector/MemoryEvaluator LLM 스키마 E2E 검증 | LLM provider 교체 또는 프롬프트 수정 후 | 조건부 |

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
