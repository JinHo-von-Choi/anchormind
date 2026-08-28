# 벤치마크 리포트

[LongMemEval-S](https://arxiv.org/abs/2407.15460) 벤치마크 기반. 전체 평가 코드: [longmemeval-memento](https://github.com/JinHo-von-Choi/longmemeval-memento)

일자: 2026-03-29
평가자: 최진호

## 구성

| 항목 | 값 |
|------|-----|
| 데이터셋 | LongMemEval_S (500개 질문, 6개 유형 + abstention) |
| 수집 방식 | round_direct (턴 쌍 원문 그대로, 300자 절단) |
| 저장소 | PostgreSQL bulk INSERT, OpenAI text-embedding-3-small을 통한 pgvector 임베딩 |
| 검색 | memento-mcp recall API (3계층 캐스케이드: L1 Redis, L2 PostgreSQL GIN, L3 pgvector HNSW) |
| Top-K | 5 |
| 리더 | Gemini 2.5 Flash (direct 방식, chain-of-thought 미사용) |
| 평가자 | Gemini 2.5 Flash (LongMemEval 공식 프롬프트 그대로 이식) |
| 총 파편 수 | 89,006 (전체 임베딩 완료) |

## 검색 성능

| 지표 | 점수 |
|------|------|
| recall_any@5 | 0.883 |
| recall_all@5 | 0.649 |

### 유형별 검색 성능 (recall_any@5)

| 질문 유형 | n | recall_any@5 |
|-----------|---|-------------|
| multi-session | 121 | 0.983 |
| knowledge-update | 72 | 0.972 |
| single-session-user | 64 | 0.953 |
| temporal-reasoning | 127 | 0.874 |
| single-session-preference | 30 | 0.800 |
| single-session-assistant | 56 | 0.536 |

### 검색 경로 분포

| 계층 | 적중률 |
|------|--------|
| L1 (Redis keyword) | 0.0% |
| L2 (PostgreSQL GIN) | 0.0% |
| L3 (pgvector semantic) | 99.0% |
| RRF fusion | 100.0% |

L1과 L2가 0%인 이유는 round_direct 수집 방식이 세션 ID와 날짜를 키워드로 저장하며 콘텐츠 용어는 저장하지 않기 때문이다. 3계층 캐스케이드는 올바르게 L3 시맨틱 검색으로 폴스루되며, L3가 질의의 99%를 처리한다.

## QA 정확도

| 지표 | 점수 |
|------|------|
| 전체 정확도 | 0.404 |
| 태스크 평균 정확도 | 0.434 |
| Abstention 정확도 | 0.467 |

### 유형별 QA 정확도

| 질문 유형 | n | 정확도 | 검색 | 갭 |
|-----------|---|--------|------|-----|
| single-session-user | 64 | 0.797 | 0.953 | 0.156 |
| knowledge-update | 72 | 0.583 | 0.972 | 0.389 |
| single-session-preference | 30 | 0.467 | 0.800 | 0.333 |
| multi-session | 121 | 0.347 | 0.983 | 0.636 |
| temporal-reasoning | 127 | 0.252 | 0.874 | 0.622 |
| single-session-assistant | 56 | 0.161 | 0.536 | 0.375 |

갭 = 검색 recall - QA 정확도. 갭이 클수록 올바른 세션을 검색했음에도 리더가 답변 추출에 실패한 것을 의미한다.

## 분석

### 검색 강점

AnchorMind의 pgvector 시맨틱 검색은 전체 질문 유형에 걸쳐 88.3%의 recall_any@5를 달성한다. 이는 LongMemEval 논문에 보고된 dense retriever(Stella 1.5B: 유사 K 값에서 ~0.7-0.8 범위)와 경쟁력 있는 수준이다. OpenAI 임베딩을 사용한 파편 기반 원자적 저장이 강력한 시맨틱 매칭을 제공한다.

multi-session(98.3%)과 knowledge-update(97.2%) 검색은 거의 완벽하며, AnchorMind가 검색 수준에서 세션 간 정보 분산과 시간적 업데이트를 잘 처리함을 보여준다.

### 검색 약점

single-session-assistant(53.6%)가 가장 약한 검색 카테고리이다. round_direct 전략은 "User: X / Assistant: Y" 쌍으로 저장하지만, 어시스턴트 발화에 대한 질의는 저장된 형식과 질의 시맨틱이 다르기 때문에 매칭이 잘 되지 않을 수 있다.

### QA 갭 분석

검색 대비 QA 갭이 가장 큰 유형은 multi-session(63.6pp)과 temporal-reasoning(62.2pp)이다. 이 유형들은 다수의 검색된 파편에서 정보를 종합하거나 시간에 대한 추론이 필요하며, 이는 검색 품질이 아닌 리더 LLM의 역량에 의존하는 부분이다.

single-session-user의 갭이 가장 작으며(15.6pp), 단일 검색 파편에 직접적인 사실 답변이 존재할 때 리더가 성공적으로 추출함을 확인해준다.

### Abstention

46.7%의 abstention 정확도는 보통 수준이다. 시스템이 "히스토리에 정보가 없음"과 "정보를 검색하지 못함"을 구분하는 데 어려움을 겪으며, 이는 검색 증강 시스템의 근본적 과제이다.

## 오프라인 골드셋 계측 (2026-08-28)

LongMemEval-S가 외부 데이터셋과 별도 하네스를 요구하는 것과 달리, 저장소에 동봉한 골드셋으로 변경 전후를 즉시 비교하기 위한 계측이다. 측정 조건이 다르므로 위의 LongMemEval 수치와 직접 비교하지 않는다.

| 항목 | 값 |
|------|-----|
| 골드셋 | `tests/fixtures/recall-goldset.jsonl` 100문항 |
| 구성 | (저장문, 패러프레이즈 질의) 쌍. 정답이 구성상 확정되어 별도 라벨링이 필요 없다 |
| 질의 분류 | exact_symbol 25, concept_intent 35, hybrid 25, temporal 15 |
| 실행 | `node bin/memento.js benchmark --repeat 2` |

측정 모드는 둘이다. `isolated`는 적재한 골드셋 파편만 후보로 두어 회차 간 결과가 동일하고, `corpus`는 운영 파편과 경쟁시켜 실제 건초더미에서의 체감을 본다.

### 질의 의도 프로파일 적용 전후

| 지표 | 프로파일 비활성 | 프로파일 활성 |
|------|-----------------|---------------|
| Recall@1 (isolated) | 52.0% | 68.0% |
| Recall@5 (isolated) | 64.0% | 86.0% |
| MRR (isolated) | 0.5707 | 0.7603 |
| 미검출 (isolated) | 36 | 13 |
| p95 지연 (isolated) | 299ms | 316ms |
| Recall@5 (corpus) | 50.0% | 76.0% |
| p95 지연 (corpus) | 1001ms | 996ms |

### 질의 분류별 Recall@5 (isolated, 프로파일 활성)

| 분류 | 문항 | Recall@5 |
|------|------|----------|
| exact_symbol | 25 | 72.0% |
| concept_intent | 35 | 80.0% |
| hybrid | 25 | 100.0% |
| temporal | 15 | 100.0% |

### 합성 역질의 증강 적용 전후

골드셋 앞 30문항에 역질의를 생성한 뒤 같은 질의로 재측정했다. 생성 대상 제한을 계측용으로 완화해(importance 0.5 이상, 전 유형) 30개 파편에 75건의 역질의를 색인했다.

| 지표 | 미적용 | 적용 |
|------|--------|------|
| Recall@1 | 70.0% | 76.7% |
| Recall@5 | 80.0% | 86.7% |
| MRR | 0.7317 | 0.7983 |
| 미검출 | 6 | 4 |
| p95 지연 | 278.5ms | 311ms |

회수된 항목은 전부 exact_symbol 계열이었다. `3300 포트를 쓰는 서비스가 뭐였지`, `컨슈머 그룹 아이디를 뭘로 바꿨지`, `90일 지난 객체 어디로 옮기게 설정했나` 세 건은 저장문이 영문 표기이고 질의가 한국어여서 본문 벡터로는 후보에 들어오지 못했다.

보조 벡터 조회를 본 검색과 순차로 붙였을 때는 p95가 278.5ms에서 531ms로 뛰면서 Recall@5는 81.7%에 그쳤다. 병렬 실행으로 바꾸고 채택 상한을 두자 지연 증가는 32ms로 줄고 Recall@5는 86.7%가 되었다. 이미 충분한 본문 결과에 보조 후보를 무제한 섞으면 정확 일치가 밀려난다.

정확도 개선의 실제 원인은 보조 결과의 정렬이었다. `id = ANY(...)` 조회는 입력 순서를 보존하지 않으므로, 채택 상한이 걸린 상태에서 정렬 없이 앞 몇 건만 취하면 유사도 1.0짜리 정답이 버려진다. 병렬 실행과 정렬 교정을 한 번에 적용한 초기 기록에서는 이 원인을 병렬화 쪽으로 잘못 귀속했다.

### 임베딩 유사도 분포 실측

기본 시맨틱 임계값 0.40이 실제 유사도 분포보다 높게 잡혀 있었다. text-embedding-3-small 기준으로 한국어 질의와 영문 기술용어가 섞인 저장문의 패러프레이즈 쌍 코사인이 0.2621이었고, 임의 파편 5000건 대비 분포는 p50 0.228 / p95 0.335였다. 정답 파편이 임계값 미달로 후보에서 탈락하고 0.39~0.43대 무관 파편이 대신 반환되는 구조였다.

이 실측이 질의 의도별 임계값 보정의 근거다. 개념·원인·절차 질의에 한해 임계값을 0.20 낮춰 후보 진입을 넓혔고, 코드 식별자 질의는 기존 임계값을 유지했다.

### 측정 재현성

키 스코프 격리와 적재 후 안정화 대기를 넣기 전에는 동일 코드로 연속 실행해도 Recall@5가 68%와 57%로 갈렸다. 원인은 두 가지였다. 운영 코퍼스와 경쟁시키면 코퍼스가 계속 변하고, 적재 직후 자동 링크 생성이 비동기로 진행되어 평가 시점마다 그래프 레이어가 다른 이웃을 주입한다. 두 장치를 넣은 뒤로는 회차 간 편차가 0이다.

## Ablation 연구

동일 검색 결과(round_direct, K=5, recall_any@5=0.883)에 대해 세 가지 리더 조건을 테스트했다.

### 전체 결과

| 조건 | 전체 | 태스크 평균 | Abstention | 변화량 (전체) |
|------|------|------------|------------|--------------|
| Baseline (direct) | 0.404 | 0.434 | 0.467 | -- |
| + temporal metadata + abstention | 0.449 | 0.460 | 0.533 | +4.5pp |
| CoN v2 (conflict resolution + causal linking + restraint) | 0.406 | 0.416 | 0.267 | +0.2pp |

### 유형별 상세

| 유형 | Baseline | Improved | CoN v2 | 최대 변화량 |
|------|----------|----------|--------|------------|
| knowledge-update | 0.583 | 0.736 | 0.722 | +15.3pp |
| multi-session | 0.347 | 0.355 | 0.339 | +0.8pp |
| single-session-assistant | 0.161 | 0.161 | 0.143 | 0pp |
| single-session-preference | 0.467 | 0.333 | 0.267 | -13.4pp |
| single-session-user | 0.797 | 0.844 | 0.766 | +4.7pp |
| temporal-reasoning | 0.252 | 0.331 | 0.260 | +7.9pp |

### Ablation 분석

"Improved" 조건(temporal metadata 접두사 + abstention 감지)이 +4.5pp로 가장 높은 전체 향상을 달성한다. 단일 유형 기준 가장 큰 향상은 knowledge-update(+15.3pp)이며, 날짜 접두사가 사용자 정보가 업데이트된 경우 리더가 가장 최근 답변을 식별할 수 있게 해준다. temporal-reasoning도 명시적 타임스탬프로 인해 +7.9pp 향상되었다.

CoN v2는 knowledge-update에서 유사한 향상(+13.9pp)을 달성하지만 single-session-preference(-20pp)와 abstention(26.7% vs 46.7%)에서 하락한다. CoN 템플릿의 "추측하지 말 것" 지시가 유효하지만 불확실한 답변을 억제하며, 다단계 추론 형식이 단순한 사실 답변을 희석시킨다.

single-session-assistant는 모든 조건에서 변화 없이 16.1%를 유지하며, 병목이 검색(53.6% recall)에 있지 읽기 전략에 있지 않음을 확인해준다.

### K=10 검색

| 지표 | K=5 | K=10 | 변화량 |
|------|-----|------|--------|
| recall_any | 0.883 | 0.885 | +0.2pp |
| recall_all | 0.649 | 0.687 | +3.8pp |
| ndcg | 0.775 | 0.785 | +1.0pp |

K=10은 recall_all을 소폭 개선(+3.8pp)하지만 recall_any에는 미미한 영향만 미친다. pgvector HNSW 인덱스는 대부분의 경우 이미 top-5 내에서 가장 관련 있는 파편을 반환하기 때문이다.

## 평가자 보정

48개 층화 표본을 Gemini 2.5 Flash와 GPT-4o 양쪽으로 평가했다.

| 유형 | 일치율 |
|------|--------|
| knowledge-update | 8/8 (100%) |
| multi-session | 8/8 (100%) |
| single-session-assistant | 8/8 (100%) |
| temporal-reasoning | 8/8 (100%) |
| single-session-user | 7/8 (87.5%) |
| single-session-preference | 5/8 (62.5%) |
| 전체 | 44/48 (91.7%) |

Gemini와 GPT-4o는 91.7%의 판정에서 일치한다. 유일한 유의미한 차이는 single-session-preference(62.5%)이며, 루브릭 기반 평가에서 주관적 해석이 허용되기 때문이다. 모든 사실 기반 질문 유형은 거의 완벽한 일치를 보인다.

### 제한 사항

1. 평가자 차이: GPT-4o 대신 Gemini 2.5 Flash 사용. 보정 결과 91.7% 일치이며, preference 질문이 주요 차이점이다.
2. 단일 수집 조건: round_direct만 테스트. atomic_fact 조건은 관련 사실을 추출하여 QA 정확도를 개선할 수 있다.
3. round_direct의 300자 절단으로 긴 턴의 정보가 손실된다.
4. L1/L2 검색 계층이 bulk DB 삽입으로 Redis 인덱스 구축을 우회하여 비활성 상태이다.
5. 검색 응답에 confidence/similarity 점수가 없어 abstention 감지가 제한된다.

## 파이프라인 실행 시간

| 단계 | 소요 시간 |
|------|-----------|
| 수집 (DB bulk INSERT) | 27초 |
| 임베딩 백필 (89,006 파편) | ~15분 |
| 검색 (500개 질문, MCP API) | 2분 |
| 생성 (Gemini API, 조건당) | ~27분 |
| 평가 (Gemini API, 조건당) | ~15분 |
| 전체 (3개 조건) | ~3시간 |

## 벡터 검색 HNSW 인덱스 강제 (v4.6.0)

v4.6.0부터 벡터 검색 트랜잭션 시작 시 `SET LOCAL enable_seqscan = off`, `SET LOCAL enable_bitmapscan = off`, `SET LOCAL hnsw.iterative_scan = relaxed_order`가 자동 적용된다. `valid_to`/`agent_id` 필터 조건에서 planner가 HNSW 대신 bitmap scan으로 전환하던 현상을 차단하여 **308ms→7ms** 수준의 레이턴시 단축이 확인됐다. 이 측정치는 위 벤치마크 평가 이후 추가된 최적화로, 본 벤치마크의 검색 수치와 직접 비교할 수 없으나 운영 환경의 recall 경로 레이턴시 기준으로 참조한다.

## MorphemeTokenizer 단위 성능 (v4.3.0)

| 항목 | 값 |
|-|-|
| 호출당 평균 처리 시간 | 1.06 ms/call |
| 측정 버전 | v4.3.0 |
| 측정일 | 2026-05-22 |

`lib/memory/embedding/MorphemeTokenizer.js`의 토큰화 단계 단독 측정치. RememberPostProcessor의 형태소 등록 경로(L3 시맨틱 검색 매칭 대상)에서 사용한다.

## 파일

- `results/retrieval_round_direct_k5_mcp.jsonl` -- 검색 결과 (K=5)
- `results/retrieval_round_direct_k10_mcp.jsonl` -- 검색 결과 (K=10)
- `results/evaluation_round_direct_k5_mcp.jsonl` -- baseline 평가
- `results/evaluation_round_direct_k5_improved.jsonl` -- improved (temporal + abstention) 평가
- `results/evaluation_round_direct_k5_conv2.jsonl` -- CoN v2 평가
- `results/judge_calibration.jsonl` -- Gemini vs GPT-4o 보정 데이터
