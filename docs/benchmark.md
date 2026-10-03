# 벤치마크 리포트

[LongMemEval-S](https://arxiv.org/abs/2410.10813) 벤치마크 기반. 전체 평가 코드: [longmemeval-memento](https://github.com/JinHo-von-Choi/longmemeval-memento)

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

AnchorMind의 pgvector 시맨틱 검색은 전체 질문 유형에 걸쳐 88.3%의 recall_any@5를 기록했다. LongMemEval 논문의 검색 표(Table 3)는 질문당 약 500세션인 LongMemEval_M 기준(Stella V5 1.5B 기본 설계 session R@5 0.706, round R@5 0.582)이므로 이 LongMemEval_S 결과와 직접 비교하지 않는다. 검색은 OpenAI 임베딩을 사용한 파편 단위 저장과 pgvector가 맡았다.

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

### 재현 절차

저장소에 골드셋과 기준선이 함께 있으므로 외부 자산 없이 같은 수치를 낼 수 있다.

```
npm ci
cp .env.example .env       # POSTGRES_* 와 MEMENTO_ACCESS_KEY 를 채운다
npm run migrate
node bin/memento.js benchmark --repeat 3
node bin/memento.js benchmark --key-scope corpus --repeat 3
```

| 자산 | 경로 |
|-|-|
| 골드셋 100문항 | `tests/fixtures/recall-goldset.jsonl` |
| 기준선 수치 | `scripts/baseline-recall.json` |
| 계측 구현 | `lib/memory/signals/RecallBenchmark.js` |

기준선과 비교하려면 `--baseline scripts/baseline-recall.json`을 붙인다. 회귀 판정은 이 비교로 한다.

기준선은 isolated 모드, `Xenova/bge-m3`(1024차원), `--repeat 3`으로 새로 마이그레이션한 DB에서 만든다. `--save-baseline`은 임베딩 provider, 모델, 차원을 함께 기록하고, `--baseline` 비교 시 모델이 다르면 경고한다. 기준선 파일에 `embedding` 필드가 없으면 경고를 내지 않으므로, 경고가 없다는 사실이 모델이 같다는 뜻은 아니다. 임베딩된 파편이 0건인 실행은 `--save-baseline`을 거부하고 종료 코드 1로 끝난다. `--no-seed` 실행은 파편을 적재하지도 임베딩하지도 않으므로 기준선으로 저장할 수 없고, 거부 메시지가 이를 밝힌다. 회귀 판정 허용 하락폭은 Recall과 MRR 2pp, p95 지연 15%다.

`scripts/baseline-recall.json`은 저장된 기준선이다. 임베딩 모델을 지정해 아래 절차를 실행하고 `--save-baseline`으로 덮어써서 갱신한다. 아래 표는 2026-10-03에 isolated 새 DB, `Xenova/bge-m3`, 골드셋 100문항, `--repeat 3`으로 측정한 값이며 저장된 기준선 파일의 내용과는 별개다.

| 항목 (2026-10-03, isolated, bge-m3) | 값 |
|-|-|
| Recall@1 / @5 / @10 | 81.0% / 90.0% / 93.0% |
| MRR | 0.8523 |
| 미검출 | 7 |
| p50 / p95 지연 | 88ms / 102ms |

기준선 갱신 절차: 실행은 마이그레이션, 적재, 삭제를 수행하므로 `DATABASE_URL`과 `POSTGRES_*`는 일회용 DB 또는 스테이징 DB를 가리켜야 하고, 운영 DB를 가리켜서는 안 된다. 벤치마크는 시작 시 stderr에 대상 host, port, database 이름을 한 줄로 출력한다. 적재 전에 이 줄을 확인한다.

```bash
export DATABASE_URL=postgresql://<user>:<password>@<host>:<port>/<throwaway_db>
export POSTGRES_HOST=<host> POSTGRES_PORT=<port> POSTGRES_DB=<throwaway_db> POSTGRES_USER=<user> POSTGRES_PASSWORD=<password>
export EMBEDDING_PROVIDER=transformers EMBEDDING_MODEL=Xenova/bge-m3 EMBEDDING_DIMENSIONS=1024
npm run migrate
node scripts/post-migrate-flexible-embedding-dims.js
EMBEDDING_ENABLED=true node bin/memento.js benchmark --repeat 3 --save-baseline scripts/baseline-recall.json
```

적재는 `api_keys`에 id `benchmark-harness-key`, 상태 `inactive` 행을 하나 만든다. 정상 동작이다. 지우려면 해당 키를 참조하는 파편이 없음을 확인한 뒤 실행한다.

```sql
DELETE FROM agent_memory.api_keys WHERE id = 'benchmark-harness-key' AND status = 'inactive';
```

`api_keys` 행을 지우면 남아 있는 파편의 `key_id`는 NULL이 되며, 이 파편은 마스터 범위로 바뀐다. `link_reconsolidations`에 이 키를 참조하는 행이 있으면 DELETE는 실패한다. `--no-seed`로 실행한 결과에는 임베딩된 파편이 없으므로 벤치마크는 `--no-seed`와 `--save-baseline`을 함께 쓰는 실행을 거부한다.

`isolated`는 적재한 골드셋 파편만 후보로 두므로 회차 간 결과가 동일하다. 회귀 판정에는 이 모드를 쓴다. `corpus`는 운영 데이터가 계속 변하므로 실행 시점에 따라 3포인트 안팎으로 흔들린다. 절대 수치를 인용할 때는 실행 시각과 반복 횟수를 함께 적는다.

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

### 임베딩 모델 교체 (2026-08-28)

`text-embedding-3-small`(OpenAI API, 1536차원)에서 `Xenova/bge-m3`(로컬 transformers, 1024차원)로 교체하고 파편 13,814건, 형태소 사전 28,247건, 보조 벡터 2,257건을 재임베딩했다.

| 지표 | 교체 전 | 교체 후 |
|------|---------|---------|
| Recall@1 (corpus) | 69.0% | 74.0% |
| Recall@5 (corpus) | 76.0% | 94.0% |
| MRR (corpus) | 0.7225 | 0.8249 |
| p95 지연 (corpus) | 996ms | 667ms |
| Recall@5 (isolated) | 86.0% | 67.0% |

코퍼스 경쟁 모드에서 Recall@5가 18pp 오르고 지연은 API 왕복이 사라져 오히려 줄었다. 질의 분류별로는 concept_intent 97.1%, hybrid 100%, temporal 93.3%, exact_symbol 84%다.

격리 모드는 반대로 떨어졌는데, 품질 저하가 아니라 하네스 전제가 깨진 것이다. 최종 랭킹은 `importance 0.4 + recency 0.3 + similarity 0.3`으로 유사도를 0~1 값 그대로 곱하는데, 두 모델의 값 대역이 다르다.

| 모델 | 정답 쌍 유사도 범위 | 랭킹 기여 폭 |
|------|---------------------|--------------|
| text-embedding-3-small | 0.26 ~ 0.52 | 0.078 |
| Xenova/bge-m3 | 0.65 ~ 0.85 | 0.060 |

bge-m3는 값이 높은 대역에 몰려 있어 선형 가중 합에서 변별력이 줄어든다. 격리 모드는 후보 100건의 importance와 저장 시각이 모두 같아 이 약점만 남는 조건이라 수치가 크게 떨어졌다. 코퍼스 모드에서는 벡터 계층이 상위 30건을 먼저 걸러주므로 영향이 작다.

임계값 문제가 아님은 확인했다. 시맨틱 하한을 0.40에서 0.72로 올려도 66%에서 67%로 거의 변하지 않았다.

따라서 격리 모드 수치는 모델을 교체한 시점을 넘어 비교하지 않는다. 기준선도 `scripts/baseline-recall.json`(격리)과 `scripts/baseline-recall-corpus.json`(코퍼스)으로 나눠 보관한다.

후속 과제는 점수 정규화다. 결과 집합 안에서 유사도를 상대화한 뒤 가중치를 적용하면 모델의 값 대역과 무관하게 변별이 유지된다.

### 측정 재현성

키 스코프 격리와 적재 후 안정화 대기를 넣기 전에는 동일 코드로 연속 실행해도 Recall@5가 68%와 57%로 갈렸다. 원인은 두 가지였다. 운영 코퍼스와 경쟁시키면 코퍼스가 계속 변하고, 적재 직후 자동 링크 생성이 비동기로 진행되어 평가 시점마다 그래프 레이어가 다른 이웃을 주입한다. 두 장치를 넣은 뒤로는 회차 간 편차가 0이다.

## 평가 세트 v2 측정 (지표 JSON)

`scripts/measure/recall-metrics.mjs`는 `tests/fixtures/recall-eval-v2`의 질의를 대상 DB에 실행해 지표를 JSON으로 출력한다. 위의 골드셋 계측이 저장문을 적재해 정답을 만드는 것과 달리, 정답은 대상 DB에 이미 있는 파편의 id와 관련도 등급(1 관련, 2 유용, 3 직접 답)이다. 수동 실행이며 CI에 포함하지 않는다.

### 측정 대상

| 항목 | 내용 |
|-|-|
| 부분집합 | 사람 작성 한국어(`human_ko`, 목표 150건 이상), 식별자 정확 일치, 시간 holdout, 원문 비열람 paraphrase, hard negative, 합성(보조, 전체 수치에서 제외하고 따로 보고) |
| 층화 | 띄어쓰기, 조사 변형, 영문 식별자, 한영 혼용 태그와 영역(research, coding, ops, schedule)별 집계 |
| 지표 | R@1/5/10, MRR, 토큰 예산 내 nDCG, 오답 후보 선행 비율(hard negative). R@k는 적중률이다: 상위 k개에 정답이 하나라도 있는 질의의 비율. 정답이 여럿인 질의를 위해 상위 k개에 든 정답 수 / 전체 정답 수의 평균인 `recall_fraction_at_k`를 따로 낸다. 필드 이름 `recall_at_k`는 적중률을 뜻하며 바뀌지 않는다 |
| nDCG | 이득은 2^등급 - 1, 위치 할인은 앞선 항목이 쓴 토큰 수를 단위 100토큰으로 나눈 값으로 1/log2(2 + x), 예산을 넘는 항목은 지급하지 않는다. 항목마다 100토큰이면 통상의 nDCG와 같다. 이상적 순서는 이득 내림차순, 같으면 토큰이 작은 순서로 예산에 채운 탐욕 순서이며 항상 최적은 아니다. 그래서 보고값은 1로 제한한 `ndcg_at_budget`이고, 제한 전 값 `ndcg_uncapped_at_budget`이 함께 출력된다. 제한은 값을 줄일 뿐 두 실행의 짝지은 차이의 방향을 뒤집지 않는다(0이 될 수는 있다). 같은 id가 반복되면 처음 나온 항목만 순위와 nDCG에 센다. 파편의 토큰 수는 DB 본문의 `countTokens` 한 곳에서 오며, 정답은 반환 목록과 이상적 순서에 같은 값을 쓴다 |
| 지연 | cold, warm 동시성 1, warm 동시성 8 세 단계의 p50, p95, 최대. cold는 프로세스 시작 뒤 첫 실행이며 캐시를 비우지 않는다 |
| 임베딩 | `--embeddings off`(기본)는 질의 임베딩 채널을 끈다. `on`은 환경 설정의 provider를 쓴다 |

파일 형식과 사람 작성 질의를 추가하는 절차는 `tests/fixtures/recall-eval-v2/README.md`에 있다. 실제 질의와 라벨은 git이 무시하는 `tests/fixtures/recall-eval-v2/private/`에 두며 스크립트가 그 디렉터리도 읽는다. 라벨은 평가 대상 검색 시스템으로 찾지 않는다. 세트의 구조는 `node --test tests/unit/recall-eval-set.test.js`로 검사한다.

### 실행

```bash
node scripts/measure/recall-metrics.mjs --target localhost:35433/<복구본_DB> --out run-a.json
```

`--target`은 일회용 시험 서버(포트 35433의 시험 컨테이너, 또는 `DB_LANE_SERVER_ALLOW=<host:port>`로 명시한 한 곳)의 데이터베이스여야 하며, 그렇지 않으면 접속 전에 종료 코드 3으로 거부한다. 연결 설정은 `--target`만으로 정해지고 Redis, 캐시, 지표 수집은 꺼진다. 운영 DB에는 접속하지 않는다. 복구본에서 recall이 접근 기록을 남기므로 실행마다 새 복구본에서 시작한다.

출력 JSON에서 `metrics`, `rows`, `coverage`, `labels`는 같은 DB와 같은 세트에서 같은 값이고, 시각과 지연은 `volatile` 아래에 있다. 질의 문장만 보내면 임베딩 off에서 어휘 채널이 비므로 `--query-keywords whitespace`(기본)는 질의를 공백으로 나눈 키워드를 함께 보낸다. 항목의 `keywords` 필드는 이 값보다 우선한다. recall은 기본으로 `includeLinks=false`로 부르며, `--include-links on`이면 연결 파편도 결과에 합류한다.

### 비교 규칙

- 고정 문자열이나 고정 기대값과 대조하지 않는다. 스크립트는 합격 여부를 판정하지 않는다.
- 두 실행의 비교는 질의별 짝지은 부트스트랩 95% 구간으로 한다. 묶음(전체, 부분집합, 태그, 영역)과 지표마다 후보 - 기준의 평균 차이와 구간을 낸다. 구간이 0을 제외할 때만 차이가 있다고 본다.
- 짝지은 질의 수가 `--min-n`(기본 10) 미만인 묶음은 `insufficient_n: true`로 표시하고 `excludes_zero`를 판단하지 않는다(false). 이런 묶음의 구간은 결론으로 인용하지 않는다.
- `--compare`는 두 파일의 `token_budget`, `query_keywords`, `include_links` 가운데 다른 값이 있으면 출력 JSON의 `warnings`와 표준 오류에 알린다. 같은 조건의 실행끼리 비교한다.
- 난수는 시드를 받으므로 같은 입력과 시드는 같은 구간을 낸다. 기본 시드 20261003, 재표집 2000회.
- 같은 DB에서 두 번 실행한 `volatile` 밖의 값이 같은지는 재현성 확인일 뿐 품질 기준이 아니다.

```bash
node scripts/measure/recall-metrics.mjs --compare run-a.json run-b.json --out compare.json
```

### 순위 후 예산 선택 비교 (`MEMENTO_RANK_BEFORE_BUDGET`)

recall 예산 선택(`MEMENTO_RANK_BEFORE_BUDGET=on`)과 검색 순서 절단(`off`)을 같은 세트, 같은 조건에서 비교한다. 스위치는 호출 시점에 읽으므로 실행할 때의 환경 변수로 정하고, 지표 JSON의 `params.rank_before_budget`에 실제 적용 값이 남는다. 예산이 묶이지 않으면 두 경로의 결과가 같으므로 `--token-budget`은 recall 기본값 1000 이하로 두고 두 실행에 같은 값을 쓴다. 연결 파편도 예산 안에서 고르는 효과까지 보려면 두 실행 모두 `--include-links on`을 준다. 실제 실행은 복구본 DB와 임베딩(`--embeddings on`)이 필요한 소유자 단계이며, 아래 절차의 결과는 아직 측정하지 않았다.

```bash
# 1. 새 복구본 A에서 기준 실행(검색 순서 절단)
MEMENTO_RANK_BEFORE_BUDGET=off node scripts/measure/recall-metrics.mjs \
  --target localhost:35433/<복구본_A> --embeddings on --token-budget 1000 --include-links on --out budget-off.json

# 2. 새 복구본 B에서 후보 실행(순위 후 예산 선택)
MEMENTO_RANK_BEFORE_BUDGET=on node scripts/measure/recall-metrics.mjs \
  --target localhost:35433/<복구본_B> --embeddings on --token-budget 1000 --include-links on --out budget-on.json

# 3. 예산 내 nDCG만 짝지은 부트스트랩으로 비교
node scripts/measure/recall-metrics.mjs --compare budget-off.json budget-on.json --metric ndcg_at_budget --out budget-compare.json
```

- `--metric ndcg_at_budget`은 비교 결과에서 그 지표만 남긴다. 구간 값은 모든 지표를 비교할 때와 같다.
- 판단: `comparisons`에서 `group`이 `overall`인 항목의 `ci_low`가 0보다 크고 `insufficient_n`이 false이면 예산 내 nDCG가 개선된 것이다. 부분집합, 태그, 영역 묶음은 같은 규칙으로 읽는다.
- `warnings`에 `token_budget`, `query_keywords`, `include_links` 차이가 있으면 조건이 다른 실행이므로 비교하지 않는다.
- 복구본에 마이그레이션 052를 적용하면(`DATABASE_URL=postgresql://<사용자>:<비밀번호>@localhost:35433/<복구본_B> npm run migrate`, `DATABASE_URL`을 명시해 다른 설정 파일의 접속 값을 쓰지 않게 한다) 후보 실행의 `search_events.candidate_count`, `budget_kept`로 예산이 묶인 recall의 비율을 볼 수 있다(`SELECT count(*) FILTER (WHERE budget_kept < candidate_count), count(*) FROM agent_memory.search_events WHERE candidate_count IS NOT NULL`). 적용하지 않아도 recall과 지표는 같고 검색 이벤트 기록만 실패한다.

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
