# monitoring

작성자: 최진호
작성일: 2026-10-03

공유 Prometheus 인스턴스가 memento-mcp 지표를 수집하고 경보를 평가하기 위한 스크레이프 잡과 경보 규칙이다. 이 문서의 YAML 블록은 공유 인스턴스의 provisioning 디렉터리에 반영하는 초안이다.

---

## 수집 대상

| 경로 | 인증 | 용도 |
|-|-|-|
| `/metrics` | `MEMENTO_ACCESS_KEY` 설정 시 마스터 키 Bearer 필요. 키가 없거나 틀리면 401 | Prometheus 지표 |
| `/health` | `MEMENTO_ACCESS_KEY` 설정 시 마스터 키 Bearer가 있으면 전체 상세, 없으면 최소 본문(`status`, `timestamp`)만 | 서비스 상태 종합(DB, Redis, pgvector, 워커). DB가 응답하지 않으면 503 |
| `/health/live` | 없음 | 프로세스 생존 확인(DB, Redis를 보지 않음) |
| `/health/ready` | 없음 | 주 DB 응답 확인(`MEMENTO_HEALTH_READY_DB_TIMEOUT_MS`(기본 2000, 범위 100~4500) 안에 응답하면 200, 아니면 503) |

`/health/live`와 `/health/ready`는 키 설정과 관계없이 항상 키 없이 응답한다. `MEMENTO_ACCESS_KEY`를 설정하지 않은 배치에서는 `/health`도 키 없이 전체 상세를 돌려준다.

---

## 스크레이프 잡

`prometheus.yml`의 `scrape_configs`에 다음 잡을 추가한다. 마스터 키는 설정 파일에 적지 않고 `credentials_file`로 파일을 참조한다. 해당 파일은 키 문자열 한 줄만 담고 Prometheus 실행 계정만 읽을 수 있게 둔다.

```yaml
scrape_configs:
  - job_name: memento-mcp
    scrape_interval: 15s
    metrics_path: /metrics
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/secrets/memento-master-key
    static_configs:
      - targets: ["127.0.0.1:57332"]
        labels:
          component: memento-mcp
```

`MEMENTO_ACCESS_KEY`를 설정하지 않은 배치에서는 `authorization` 항목을 생략한다.

---

## 경보 규칙

`up`은 Prometheus가 스크레이프마다 만드는 시계열이고, 나머지 지표는 memento-mcp가 `/metrics`로 내보낸다. 라벨이 있는 카운터는 해당 라벨 조합이 처음 증가한 뒤에 나타난다.

```yaml
groups:
  - name: memento-mcp-alerts
    rules:
      - alert: MementoMCPDown
        expr: up{job="memento-mcp"} == 0
        for: 2m
        labels: { severity: critical, component: memento-mcp }
      - alert: MementoAuthStoreErrors
        expr: sum(rate(mcp_auth_store_errors_total[5m])) > 0
        for: 5m
        labels: { severity: warning, component: memento-mcp }
      - alert: MementoSplitStepFailures
        expr: sum(increase(memento_consolidate_split_step_failed_total[6h])) > 0
        labels: { severity: info, component: memento-mcp }
      - alert: MementoDbLockRetries
        expr: sum(increase(memento_db_deadlock_retries_total[1h])) > 0
        labels: { severity: info, component: memento-mcp }
      - alert: MementoProtocolVersionOther
        expr: sum(increase(mcp_protocol_version_negotiations_total{requested_version="other"}[1h])) > 0
        labels: { severity: info, component: memento-mcp }
      - alert: MementoModernProtocolShare
        expr: |
          sum(increase(memento_modern_protocol_attempts_total[1d]))
            / clamp_min(sum(increase(memento_modern_protocol_attempts_total[1d])) + sum(increase(mcp_protocol_version_negotiations_total[1d])), 1)
            > 0.5
        labels: { severity: info, component: memento-mcp }
      - alert: MementoOutboxDeadLetter
        expr: max(memento_outbox_dead_letter) > 0
        for: 5m
        labels: { severity: warning, component: memento-mcp }
      - alert: MementoOutboxLag
        expr: max(memento_outbox_lag_seconds) > 300
        for: 10m
        labels: { severity: warning, component: memento-mcp }
      - alert: MementoOutboxStatsStale
        expr: max(memento_outbox_stats_updated_seconds) < time() - 300
        for: 10m
        labels: { severity: warning, component: memento-mcp }
```

| 경보 | 의미 |
|-|-|
| MementoMCPDown | 스크레이프가 2분간 실패한다 |
| MementoAuthStoreErrors | API 키 저장소 조회가 키 판정 전에 실패한다(`operation` 라벨로 구분) |
| MementoSplitStepFailures | 장문 파편 분할의 커밋 단계가 실패한다(`step` 라벨로 구분) |
| MementoDbLockRetries | 파편 행을 여러 개 잠그는 쓰기 트랜잭션이 교착(40P01)이나 잠금 대기 상한(55P03)으로 끝나 다시 실행됐다(`operation` 라벨로 경로 구분). 재실행은 결과를 바꾸지 않으며, 지속되면 `docs/concurrency.md`의 잠금 순서를 벗어난 경로를 찾는다 |
| MementoProtocolVersionOther | 지원 목록에 없는 프로토콜 버전을 요청한 협상이 있다 |
| MementoModernProtocolShare | 하루 동안 세션 없는 현대식 프로토콜 시도가 initialize 협상보다 많다. 현대식 요청을 먼저 보내는 클라이언트는 400 응답 뒤 initialize로 돌아가므로 시도 하나에 협상 하나가 짝을 이루고, 비율이 0.5를 넘으면 돌아가지 않는 클라이언트가 있다는 뜻이다. 아래 "프로토콜 개정 지표"를 본다 |
| MementoOutboxDeadLetter | 재시도 한도를 넘었거나 재시도 불가로 판정된 outbox 이벤트가 있다. 원인을 고친 뒤 되돌리는 절차는 [configuration.md](../configuration.md#outbox) |
| MementoOutboxLag | 전달 예정 시각이 지난 outbox 대기 행 중 가장 오래된 행이 5분 넘게 전달되지 않았다(작업자 처리량 부족, 점유되지 않는 topic). 재시도하는 행은 다음 예정 시각이 미래라 지연에 들어가지 않으므로, 처리기 반복 실패는 `memento_outbox_failed_total`과 dead-letter 건수(`memento_outbox_dead_letter`, MementoOutboxDeadLetter)로 본다 |
| MementoOutboxStatsStale | 어느 프로세스도 5분 넘게 outbox 게이지를 갱신하지 않았다(모든 인스턴스의 작업자 정지, `MEMENTO_OUTBOX_WORKER=off`, 작업자 회차 실패). `MEMENTO_OUTBOX=off`로 기능을 끈 배치에서는 이 규칙을 두지 않는다 |

outbox 게이지는 작업자를 돌리는 프로세스만 갱신한다. 작업자를 돌리지 않는 프로세스도 지표 모듈을 불러오므로 `memento_outbox_lag_seconds`를 0으로 내보내고, 따라서 `absent(memento_outbox_lag_seconds)`는 스크레이프 대상이 사라졌을 때만 참이 되어 작업자 정지를 잡지 못한다. 작업자 정지는 갱신 시각 게이지 `memento_outbox_stats_updated_seconds`(유닉스 초, 갱신 전에는 0)로 본다. 인스턴스가 여럿이면 `max`가 가장 최근 갱신을 고르므로 하나라도 작업자를 돌리면 경보가 나지 않는다.

### 프로토콜 개정 지표

| 지표 | 라벨 | 의미 |
|-|-|-|
| `memento_modern_protocol_attempts_total` | `signal` | 세션 없는 비initialize 요청 중 MCP-Protocol-Version 헤더가 지원 목록 밖이거나(`header`) `params._meta`에 `io.modelcontextprotocol/protocolVersion`이 있는(`meta`) 요청 수. 둘 다면 `header_and_meta`. 이 요청들은 세지는 것과 별개로 400과 JSON-RPC `-32000`("Session required")을 받는다 |

`signal` 값은 `header`, `meta`, `header_and_meta` 세 값이고 기록 함수가 그 밖의 값을 `unknown`으로 닫는다. 지원 목록 안의 헤더나 헤더 없음만으로는 세지 않는다. 본문이 배열(일괄 요청)이면 원소 중 하나라도 `_meta`에 프로토콜 버전을 가지면 `meta` 신호로 보고 요청 하나를 한 번 센다. 세션 없는 initialize는 세지 않는다. 분모로 쓰는 `mcp_protocol_version_negotiations_total`은 `/mcp`와 레거시 SSE 경로의 initialize를 모두 센다.

### 행 잠금 지표

| 지표 | 라벨 | 의미 |
|-|-|-|
| `memento_db_deadlock_retries_total` | `operation` | 잠금 충돌로 끝난 트랜잭션을 처음부터 다시 실행한 횟수. 재시도 횟수 상한은 `MEMENTO_DB_LOCK_RETRY_MAX`(기본 3) |
| `memento_db_write_failures_total` | `operation` | 실패를 던지지 않고 경고 로그로 끝낸 배경 쓰기의 실패 수(SpreadingActivation 활성화 갱신 `operation="activation"`, ConsolidatorGC의 stale 중요도 하향 `operation="stale_importance"`) |

`operation` 값은 `lib/tools/lock-retry.js`의 `LOCK_RETRY_OPERATIONS` 닫힌 집합이다(access, touch_linked, embedding, link_sync, unlink, delete, gc_delete, score_batch, activation, feedback, case_reward, merge_links, tier, ema_decay, anchor_promotion, stale_importance).

### 만료 정리 지표

| 지표 | 라벨 | 의미 |
|-|-|-|
| `memento_gc_backlog` | 없음 | 정리 단계 `expired_delete`가 끝난 직후 센 남은 만료 후보 수(상한 100000에서 세기를 멈추는 근사값). 정리 주기(`CONSOLIDATE_INTERVAL_MS`, 기본 6시간)마다 갱신하며 첫 정리 전에는 0이다. 값이 주기마다 줄지 않고 쌓이면 `MEMENTO_GC_MAX_DELETE_PER_CYCLE`과 `MEMENTO_GC_TIME_BUDGET_MS`를 본다 |

### 본문 어휘 채널 지표

| 지표 | 라벨 | 의미 |
|-|-|-|
| `memento_lexical_tokens_coverage_ratio` | 없음 | 현행 파편 가운데 `content_tokens`를 채운 비율. 1보다 작으면 일부 파편이 어휘 채널에서 빠진다(`scripts/backfill-content-tokens.mjs`, 키별 수는 그 미리보기) |
| `memento_lexical_tokens_missing` | 없음 | `content_tokens`를 채우지 않은 현행 파편 수. 완료된 백필 작업 뒤에 생긴 NULL 행도 여기에 남는다 |
| `memento_lexical_channel_skipped_total` | `reason`(timeout, error) | 어휘 질의를 그 요청에서 뺀 횟수. timeout은 `MEMENTO_LEXICAL_TIMEOUT_MS` 초과다 |
| `memento_lexical_tokenize_skipped_total` | `reason`(long_run, probe_error) | 저장 경로가 `content_tokens`를 채우지 못한 횟수. long_run은 공백 없이 200자를 넘게 이어진 한글, 한자, 가나 연속, probe_error는 열 확인 질의 실패다 |

두 게이지는 `/metrics` 수집 시점에 10분이 지났을 때만 현행 파편을 키로 묶어 다시 센다. `MEMENTO_LEXICAL_CHANNEL=off`이거나 열이 없으면(마이그레이션 053 이전) 값을 내보내지 않는다.

### 감사, 검토, 외부 전송, 훅 지표

경보 규칙 없이 추세와 이상을 보는 계수기다. 감사 이벤트의 승격 지연과 실패는 `memento_outbox_*{topic="audit.record"}`로 본다.

| 지표 | 라벨 | 의미 |
|-|-|-|
| `memento_audit_enqueue_failed_total` | 없음 | 기록하지 못한 감사 이벤트 수. 0이 아니면 감사 행이 빠졌다 |
| `memento_audit_recorded_total` | 없음 | `admin_audit_events`에 새로 기록한 행 수 |
| `memento_audit_cleaned_total` | 없음 | 보존 기간(`MEMENTO_AUDIT_RETENTION_DAYS`)이 지나 지운 감사 행 수 |
| `memento_review_flag_total` | `entry`, `reason` | 검토 대기열 표지를 단 쓰기의 진입점과 사유별 건수 |
| `memento_review_decisions_total` | `decision` | 검토 대기열의 승인, 거절, 30일 미결정 자동 거절 건수 |
| `memento_anchor_decision_total` | `outcome`, `reason` | `remember`와 `amend`의 앵커 지정 판정 건수. `downgraded`와 `permission`이 `warn`에서 일반 파편으로 낮춰진 요청이다 |
| `memento_workspace_read_authz_total` | `surface`, `reason`, `outcome` | 읽기 경로 workspace 허가와 master 전용 preset 판정에서 허가 밖으로 판정된 요청 수. `would_deny`는 `warn`에서 통과시킨 요청이다 |
| `memento_context_core_trust_excluded_total` | `reason` | context의 ANCHOR와 CORE 주입에서 신뢰 등급 판정으로 뺀 파편 수 |
| `memento_llm_egress_calls_total` | `stage`, `provider`, `provider_class`, `outcome` | 외부 전송 정책을 거친 LLM 제공자 호출 건수 |
| `memento_llm_egress_bytes_total` | `stage`, `provider_class` | LLM 제공자에게 보낸 프롬프트 바이트 |
| `memento_llm_egress_skipped_total` | `stage`, `reason` | 외부 전송 정책 때문에 건너뛴 LLM 단계 호출 건수 |
| `memento_llm_egress_masked_total` | `stage` | 외부 전송 전 마스킹에서 일치한 민감 정보 규칙 종류 수 |
| `memento_hook_calls_total` | `client`, `event`, `outcome` | 훅 엔드포인트 요청 수 |
| `memento_hook_reflect_total` | `outcome` | 훅 회고 소비자가 처리한 outbox 이벤트 수 |

---

## 반영과 검증

1. 스크레이프 잡과 규칙을 공유 인스턴스의 provisioning 파일에 추가한다.
2. 규칙 문법은 `promtool check rules`로 확인한다.
3. Prometheus의 Targets 화면에서 `memento-mcp` 잡이 UP인지 확인한다.
4. `/metrics` 출력에 규칙이 참조하는 지표의 `# TYPE` 줄이 있는지 확인한다.

```bash
curl -s -H "Authorization: Bearer $(cat /etc/prometheus/secrets/memento-master-key)" http://127.0.0.1:57332/metrics \
  | grep -cE "^# TYPE (mcp_auth_store_errors_total|memento_consolidate_split_step_failed_total|memento_db_deadlock_retries_total|mcp_protocol_version_negotiations_total) "
```

기대값은 4이다. 이 저장소의 `tests/unit/monitoring-doc-structure.test.js`는 위 규칙의 지표 이름과 셀렉터 라벨이 등록된 지표와 일치하는지, 값 집합이 닫힌 라벨(프로토콜 버전)의 셀렉터 값이 코드가 만들 수 있는 값인지 검사한다.
