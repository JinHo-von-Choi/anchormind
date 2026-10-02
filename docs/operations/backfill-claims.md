# backfill-claims

작성자: 최진호
작성일: 2026-04-16

## Purpose

기존 파편에 대해 ClaimExtractor를 소급 실행하여 `fragment_claims` 테이블을 채운다. Shadow mode(`MEMENTO_SYMBOLIC_SHADOW=true`) 진입 후 `MEMENTO_SYMBOLIC_EXPLAIN=true` 활성화 전에 반드시 선행해야 한다.

- 실행 시점 이후 새로 들어오는 파편은 `RememberPostProcessor`의 8단계 hook에서 실시간 추출된다.
- 이 스크립트는 `fragment_claims`가 비어 있는 기존 코퍼스 전용이다.
- `MEMENTO_SYMBOLIC_ENABLED` 등 런타임 플래그와 무관하게 스크립트 자체가 동작을 결정한다.

## CLI Options

| Option | Default | Description |
|--------|---------|-------------|
| `--batch-size <N>` | 500 | 단일 배치 처리 파편 수 |
| `--rate-limit-ms <N>` | 100 | 배치 간 대기 시간 (ms) |
| `--tenant-key <KEY>` | (all) | 특정 key_id만 처리. 리터럴 `master` 지정 시 key_id=NULL(master) 단독 처리 |
| `--limit <N>` | (unlimited) | 전체 처리 상한 |
| `--min-confidence <0..1>` | 0.5 | ClaimExtractor confidence 하한. 미달 claim은 삽입 제외 |
| `--dry-run` | false | 추출까지만 실행하고 ClaimStore.insert 생략. claim 수 계산만 |
| `--verbose` | false | 배치별 상세 로그 출력 |
| `--help, -h` | - | 사용법 출력 |

환경 변수:

```
DATABASE_URL    PostgreSQL 연결 문자열 (필수)
```

## Safe Execution Order

1. 샘플 확인: `--dry-run --verbose --limit 100`으로 추출 볼륨 사전 확인

   ```bash
   DATABASE_URL=postgresql://... node scripts/backfill-claims.js \
     --dry-run --verbose --limit 100
   ```

2. 특정 테넌트 격리 검증: `--tenant-key mmcp_xxx --dry-run`

   ```bash
   DATABASE_URL=postgresql://... node scripts/backfill-claims.js \
     --tenant-key mmcp_xxx --dry-run --verbose
   ```

   master 단독 처리:

   ```bash
   DATABASE_URL=postgresql://... node scripts/backfill-claims.js \
     --tenant-key master --dry-run --verbose
   ```

3. 실제 실행: 배치 크기와 rate-limit 조정

   ```bash
   DATABASE_URL=postgresql://... node scripts/backfill-claims.js \
     --batch-size 500 --rate-limit-ms 200
   ```

4. 진행률 확인: `--verbose` 배치별 로그와 종료 시 요약의 `claims_inserted`. 스크립트는 별도 프로세스이며 서버의 `/metrics`에는 반영되지 않는다

## Prometheus Metrics

| 메트릭 | 설명 |
|--------|------|
| `memento_symbolic_claim_extracted_total{extractor,polarity}` | 서버의 `remember` 후처리가 추출한 claim 누적 건수. 이 스크립트의 추출은 집계하지 않는다 |
| `memento_symbolic_gate_blocked_total{phase=cbr}` | CBR 필터에 의한 차단 건수 |

## Output Summary

실행 완료 시 아래 형태의 요약을 stdout으로 출력한다.

```
[backfill] ===== summary =====
  elapsed_ms           : <ms>
  examined             : <N>
  fragments_with_claims: <N>
  claims_extracted     : <N>
  claims_filtered      : <N> (confidence < 0.5)
  claims_inserted      : <N>
  extractor_errors     : <N>
  insert_errors        : <N>
  tenant_violations    : <N>
  mode                 : WRITE
```

`tenant_violations`이 0이 아니면 cross-tenant 격리 문제. `extractor_errors`가 높으면 ClaimExtractor 환경 점검(임베딩 API 연결 등)이 필요하다.

## Notes

- 프로덕션 DB에서 실행 전 반드시 `--dry-run`으로 먼저 수치 확인할 것.
- 키셋 페이지네이션(id DESC) 방식을 사용하므로 대량 파편에서도 OFFSET 방식보다 빠르다.
- 처리는 master → 각 API key 순으로 진행된다. 각 테넌트 완료 시 처리 건수를 출력한다.
