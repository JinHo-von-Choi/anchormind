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
| MementoOutboxDeadLetter | 재시도 한도를 넘었거나 재시도 불가로 판정된 outbox 이벤트가 있다. 원인을 고친 뒤 되돌리는 절차는 [configuration.md](../configuration.md#outbox) |
| MementoOutboxLag | 전달 예정 시각이 지난 outbox 대기 행 중 가장 오래된 행이 5분 넘게 전달되지 않았다(작업자 처리량 부족, 점유되지 않는 topic). 재시도하는 행은 다음 예정 시각이 미래라 지연에 들어가지 않으므로, 처리기 반복 실패는 `memento_outbox_failed_total`과 dead-letter 건수(`memento_outbox_dead_letter`, MementoOutboxDeadLetter)로 본다 |
| MementoOutboxStatsStale | 어느 프로세스도 5분 넘게 outbox 게이지를 갱신하지 않았다(모든 인스턴스의 작업자 정지, `MEMENTO_OUTBOX_WORKER=off`, 작업자 회차 실패). `MEMENTO_OUTBOX=off`로 기능을 끈 배치에서는 이 규칙을 두지 않는다 |

outbox 게이지는 작업자를 돌리는 프로세스만 갱신한다. 작업자를 돌리지 않는 프로세스도 지표 모듈을 불러오므로 `memento_outbox_lag_seconds`를 0으로 내보내고, 따라서 `absent(memento_outbox_lag_seconds)`는 스크레이프 대상이 사라졌을 때만 참이 되어 작업자 정지를 잡지 못한다. 작업자 정지는 갱신 시각 게이지 `memento_outbox_stats_updated_seconds`(유닉스 초, 갱신 전에는 0)로 본다. 인스턴스가 여럿이면 `max`가 가장 최근 갱신을 고르므로 하나라도 작업자를 돌리면 경보가 나지 않는다.

### 행 잠금 지표

| 지표 | 라벨 | 의미 |
|-|-|-|
| `memento_db_deadlock_retries_total` | `operation` | 잠금 충돌로 끝난 트랜잭션을 처음부터 다시 실행한 횟수. 재시도 횟수 상한은 `MEMENTO_DB_LOCK_RETRY_MAX`(기본 3) |
| `memento_db_write_failures_total` | `operation` | 실패를 던지지 않고 경고 로그로 끝낸 배경 쓰기의 실패 수(현재 SpreadingActivation 활성화 갱신, `operation="activation"`) |

`operation` 값은 `lib/tools/lock-retry.js`의 `LOCK_RETRY_OPERATIONS` 닫힌 집합이다(access, touch_linked, embedding, link_sync, unlink, delete, gc_delete, score_batch, activation, feedback, case_reward, merge_links, tier, ema_decay, anchor_promotion, stale_importance).

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
