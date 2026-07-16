# Recall 품질 검증 절차

작성자: 최진호
작성일: 2026-07-16

## 1. text recall 0건 회복 (P1)

각 쌍은 의미가 동일한 패러프레이즈다. 저장 문장(A)을 키에 remember한 뒤 질의(B)로
recall하여 A가 결과에 포함되고 count > 0인지 확인한다.

아래 10쌍은 이 저장소의 실제 변경 이력(nginx 재시작, 포트 변경, 형태소 백필,
RRF 컷오프, 키워드 추출 등)에서 뽑은 대표 스모크 쌍이다. 조사 원본 셋이
별도로 존재하면 그 값으로 교체하고, 부재 시 아래 쌍을 기준선으로 사용한다.

| # | 저장(A) | 질의(B) | 기대 |
|-|-|-|-|
| 1 | nginx 설정을 변경한 뒤 서비스를 재시작했다 | nginx 재시작한 이유가 뭐였지 | A1 포함, count>0 |
| 2 | 내부 포트를 10000번대로 옮겼다 | 포트 변경 내역 알려줘 | A2 포함, count>0 |
| 3 | morpheme_indexed=false 파편이 형태소 백필 대상이다 | 형태소 인덱싱 안 된 파편 어떻게 처리하나 | A3 포함, count>0 |
| 4 | RRF 후보 컷오프에서 floor 미지정 시 전량 필터링되는 버그를 고쳤다 | recall 결과가 0건 나오던 문제 원인이 뭐였어 | A4 포함, count>0 |
| 5 | extractKeywords가 한글 조사를 스트리핑하도록 바꿨다 | 키워드 추출에서 조사 제거 어떻게 했지 | A5 포함, count>0 |
| 6 | reflect decision 파편 importance를 0.7로 낮춰 permanent 승격을 막았다 | reflect 파편이 영구 보존되는 문제 어떻게 해결했나 | A6 포함, count>0 |
| 7 | search_param_thresholds의 min_similarity가 하한까지 잘못 학습됐다 | 검색 유사도 임계값이 너무 낮게 잡힌 이유는 | A7 포함, count>0 |
| 8 | MorphemeBackfill 잡을 5분 주기로 스케줄러에 등록했다 | 형태소 백필 잡 실행 주기가 어떻게 되나 | A8 포함, count>0 |
| 9 | camelCase 식별자 원형을 소문자화 전에 보존하도록 수정했다 | 코드 식별자가 키워드에서 깨지던 문제 고친 방법 | A9 포함, count>0 |
| 10 | reflect permanent 파편을 신 정책 기준으로 재평가해 강등했다 | reflect 파편 TTL 강등 마이그레이션이 뭐였지 | A10 포함, count>0 |

실행:

    node scripts/mcp-smoke-recall.js --pairs docs/operations/recall-pairs.json

(기존 스모크 러너가 없으면 recall MCP 도구 또는 anchor_recall_text로 각 쌍을 수동 검증한다.)

합격 기준: 10쌍 전부 count > 0, 정답 파편 상위 노출.

## 2. morpheme_indexed 주간 비율 (P2)

    psql "$DATABASE_URL" -f scripts/recall-quality-metrics.sql

합격 기준: recent_indexed_pct 주간 상승, 4주 내 >= 98%.

## 3. keywords 오염률 (P3)

위 SQL의 polluted_pct. 신규 파편 기준 조사 오염 <= 2%.

## 4. reflect permanent 적재율 (P4)

위 SQL의 permanent_pct. Task 7 마이그레이션 후 유의미 하락.
