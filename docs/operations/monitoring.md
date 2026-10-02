# monitoring

작성자: 최진호
작성일: 2026-10-03

공유 Prometheus 인스턴스가 memento-mcp 지표를 수집하고 경보를 평가하기 위한 스크레이프 잡과 경보 규칙이다. 이 문서의 YAML 블록은 공유 인스턴스의 provisioning 디렉터리에 반영하는 초안이다.

---

## 수집 대상

| 경로 | 인증 | 용도 |
|-|-|-|
| `/metrics` | `MEMENTO_ACCESS_KEY` 설정 시 마스터 키 Bearer 필요 | Prometheus 지표 |
| `/health/live` | 없음 | 프로세스 생존 확인(DB, Redis를 보지 않음) |
| `/health/ready` | 없음 | 주 DB 응답 확인(`MEMENTO_HEALTH_READY_DB_TIMEOUT_MS`(기본 2000, 범위 100~4500) 안에 응답하면 200, 아니면 503) |

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

`up`은 Prometheus가 스크레이프마다 만드는 시계열이고, 나머지 지표는 memento-mcp가 `/metrics`로 내보낸다.

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
      - alert: MementoProtocolVersionOther
        expr: sum(increase(mcp_protocol_version_negotiations_total{requested_version="other"}[1h])) > 0
        labels: { severity: info, component: memento-mcp }
```

| 경보 | 의미 |
|-|-|
| MementoMCPDown | 스크레이프가 2분간 실패한다 |
| MementoAuthStoreErrors | API 키 저장소 조회가 키 판정 전에 실패한다(`operation` 라벨로 구분) |
| MementoSplitStepFailures | 장문 파편 분할의 커밋 단계가 실패한다(`step` 라벨로 구분) |
| MementoProtocolVersionOther | 지원 목록에 없는 프로토콜 버전을 요청한 협상이 있다 |

---

## 반영과 검증

1. 스크레이프 잡과 규칙을 공유 인스턴스의 provisioning 파일에 추가한다.
2. 규칙 문법은 `promtool check rules`로 확인한다.
3. Prometheus의 Targets 화면에서 `memento-mcp` 잡이 UP인지 확인한다.
4. `/metrics` 출력에 규칙이 참조하는 지표의 `# TYPE` 줄이 있는지 확인한다.

```bash
curl -s -H "Authorization: Bearer $(cat /etc/prometheus/secrets/memento-master-key)" http://127.0.0.1:57332/metrics \
  | grep -cE "^# TYPE (mcp_auth_store_errors_total|memento_consolidate_split_step_failed_total|mcp_protocol_version_negotiations_total) "
```

기대값은 3이다. 이 저장소의 `tests/unit/monitoring-doc-structure.test.js`는 위 규칙의 지표 이름과 셀렉터 라벨이 등록된 지표와 일치하는지 검사한다.
