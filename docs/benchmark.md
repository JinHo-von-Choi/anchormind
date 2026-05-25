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

memento-mcp의 pgvector 시맨틱 검색은 전체 질문 유형에 걸쳐 88.3%의 recall_any@5를 달성한다. 이는 LongMemEval 논문에 보고된 dense retriever(Stella 1.5B: 유사 K 값에서 ~0.7-0.8 범위)와 경쟁력 있는 수준이다. OpenAI 임베딩을 사용한 파편 기반 원자적 저장이 강력한 시맨틱 매칭을 제공한다.

multi-session(98.3%)과 knowledge-update(97.2%) 검색은 거의 완벽하며, memento-mcp가 검색 수준에서 세션 간 정보 분산과 시간적 업데이트를 잘 처리함을 보여준다.

### 검색 약점

single-session-assistant(53.6%)가 가장 약한 검색 카테고리이다. round_direct 전략은 "User: X / Assistant: Y" 쌍으로 저장하지만, 어시스턴트 발화에 대한 질의는 저장된 형식과 질의 시맨틱이 다르기 때문에 매칭이 잘 되지 않을 수 있다.

### QA 갭 분석

검색 대비 QA 갭이 가장 큰 유형은 multi-session(63.6pp)과 temporal-reasoning(62.2pp)이다. 이 유형들은 다수의 검색된 파편에서 정보를 종합하거나 시간에 대한 추론이 필요하며, 이는 검색 품질이 아닌 리더 LLM의 역량에 의존하는 부분이다.

single-session-user의 갭이 가장 작으며(15.6pp), 단일 검색 파편에 직접적인 사실 답변이 존재할 때 리더가 성공적으로 추출함을 확인해준다.

### Abstention

46.7%의 abstention 정확도는 보통 수준이다. 시스템이 "히스토리에 정보가 없음"과 "정보를 검색하지 못함"을 구분하는 데 어려움을 겪으며, 이는 검색 증강 시스템의 근본적 과제이다.

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
