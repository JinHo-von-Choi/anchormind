# benchmark-hot-path

작성자: 최진호
작성일: 2026-04-16

## Purpose

Symbolic Memory 계층이 hot path(`FragmentSearch.search`, `RememberPostProcessor.run`)에 주는 오버헤드를 측정하고, `scripts/baseline-v27.json` 과 비교하여 회귀를 감시한다.

측정 대상 hot path 4종:

| 대상 | 기본 반복 수 | 비고 |
|------|------------|------|
| `remember` | 100 | 랜덤 topic/content |
| `recall` | 100 | 랜덤 키워드 |
| `link` | 100 | 연속 fragment 쌍 |
| `reflect` | 10 | 무거운 연산이므로 샘플 수 축소 |

## CLI Options

| Option | Default | Description |
|--------|---------|-------------|
| `--remember <N>` | 100 | remember() 반복 횟수 |
| `--recall <N>` | 100 | recall() 반복 횟수 |
| `--link <N>` | 100 | link() 반복 횟수 |
| `--reflect <N>` | 10 | reflect() 반복 횟수 |
| `--output <path>` | scripts/baseline-v27.json | 결과 JSON 출력 경로 |
| `--help, -h` | - | 사용법 출력 |

환경 변수:

```
DATABASE_URL    PostgreSQL 연결 문자열 (필수)
```

## Execution

기본 실행 (결과를 `scripts/baseline-v27.json`에 overwrite):

```bash
DATABASE_URL=postgresql://user:pw@localhost:5432/memento_test \
  node scripts/benchmark-hot-path.js
```

반복 횟수 조정:

```bash
DATABASE_URL=postgresql://... node scripts/benchmark-hot-path.js \
  --remember 200 --recall 200
```

사용자 지정 출력 경로:

```bash
DATABASE_URL=postgresql://... node scripts/benchmark-hot-path.js \
  --output scripts/baseline-v28-phase2.json
```

## Output Format

결과는 지정 경로에 JSON으로 저장되며 stdout에도 출력된다.

```json
{
  "runAt": "2026-04-16T00:00:00.000Z",
  "gitSha": "abc1234",
  "note": "baseline for Symbolic Memory regression comparison",
  "remember": { "p50": 12.3, "p95": 45.6, "p99": 78.9, "n": 100 },
  "recall":   { "p50": 8.1,  "p95": 22.4, "p99": 55.1, "n": 100 },
  "link":     { "p50": 5.2,  "p95": 18.3, "p99": 40.7, "n": 100 },
  "reflect":  { "p50": 98.4, "p95": 234.1, "p99": 380.2, "n": 10 }
}
```

분위수는 nearest-rank 방식으로 계산된다. `n`이 0인 항목은 실행 건수 부족을 의미한다.

## Safe Execution Order

1. 테스트 DB 환경에서만 실행. 프로덕션 DB 절대 금지.
2. 기본 플래그 상태(`MEMENTO_SYMBOLIC_ENABLED=false`)로 baseline 확보:

   ```bash
   DATABASE_URL=postgresql://... node scripts/benchmark-hot-path.js
   ```

3. Symbolic 계층 활성화 후 새 baseline 저장:

   ```bash
   MEMENTO_SYMBOLIC_ENABLED=true \
   MEMENTO_SYMBOLIC_SHADOW=true \
   DATABASE_URL=postgresql://... \
     node scripts/benchmark-hot-path.js \
     --output scripts/baseline-symbolic-shadow.json
   ```

4. 단계별 비교:

   각 단계 결과 파일을 `scripts/baseline-v27.json` 과 수동으로 비교하여 p99 오버헤드를 확인한다.

## Prometheus Metrics

| 메트릭 | 설명 |
|--------|------|
| `memento_symbolic_latency_seconds` | Symbolic 계층 처리 시간 히스토그램 |
| `memento_symbolic_claim_total` | claim 추출 누적 건수 |

benchmark 실행 중 Prometheus 메트릭을 함께 관찰하면 hot path 오버헤드의 원인을 symbolic 계층 내 세부 단계별로 분리할 수 있다.

## HNSW 인덱스 강제 검색 (v4.6.0)

v4.6.0에서 벡터 검색 경로(`lib/tools/db.js`)에 다음 세 플래그가 트랜잭션 시작 시 자동 적용된다.

```sql
SET LOCAL enable_seqscan    = off;
SET LOCAL enable_bitmapscan = off;
SET LOCAL hnsw.iterative_scan = relaxed_order;
```

`valid_to`/`agent_id` 필터가 붙으면 PostgreSQL planner가 HNSW 대신 b-tree bitmap scan으로 전환하여 308ms 수준의 지연이 발생했다. 두 스캔을 모두 차단하면 `ORDER BY embedding<=>v LIMIT` 경로가 HNSW index scan을 타게 되어 **308ms→7ms**로 단축된다. `ef_search=80`은 기존 session-level 설정 그대로 유지된다.

benchmark-hot-path 측정 시 이 변경이 `recall` p50/p95/p99에 유의미한 영향을 줄 수 있으므로, v4.6.0 기준선 확보 시 위 플래그가 활성화된 상태(기본값)로 측정해야 한다.

## Notes

- `scripts/baseline-v27.json`에는 테스트 DB(임베딩 비활성) 기준 실측치가 커밋되어 있다. `runAt`·`gitSha`·`note`로 측정 시점과 버전을 확인하고, 재측정 시 동일 조건(테스트 DB, 임베딩 키 미설정)으로 실행해야 비교가 성립한다.
- `link` 반복 횟수는 `remember`에서 생성한 fragment 쌍으로 제한된다. `--link N`이 실제 생성된 fragment 쌍 수보다 크면 실제 실행 횟수가 더 적을 수 있다.
