# 로컬 임베딩 Provider 사용 가이드

작성자: 최진호
작성일: 2026-04-18
수정일: 2026-04-29

---

## 개요

`EMBEDDING_PROVIDER=transformers` 설정으로 OpenAI API 없이 로컬 transformers.js 모델을 사용하여 임베딩을 생성할 수 있다. 다음 상황에서 유용하다.

- OpenAI API 비용을 제거하고 싶은 경우
- 인터넷 접속이 차단된 네트워크 격리 환경 (초기 모델 다운로드 후 오프라인 동작 가능)
- 메모리 내용이 외부 API 서버에 전송되지 않아야 하는 개인정보 보호 요건

Reranker 및 NLIClassifier와 동일한 transformers.js ONNX 스택을 재사용하므로 추가 의존성 설치가 불필요하다.

---

## 지원 모델 비교

| 모델 | 차원 | RAM (Q8) | 한국어 | 영어 | 다국어 | 추천 상황 |
|---|---:|---:|:-:|:-:|:-:|---|
| Xenova/multilingual-e5-small | 384 | ~150MB | 양호 | 양호 | 100+ 언어 | 기본값, 저사양 서버, 빠른 인덱싱 |
| Xenova/bge-m3 | 1024 | ~600MB | 우수 | 우수 | 100+ 언어 | 품질 중시, 메모리 여유 (2GB+) |
| Xenova/paraphrase-multilingual-MiniLM-L12-v2 | 384 | ~180MB | 양호 | 양호 | 50+ 언어 | paraphrase 탐지 중심 |
| Xenova/all-MiniLM-L6-v2 | 384 | ~90MB | 부족 | 양호 | 영어 전용 | 영어 프로젝트, 최저 리소스 |

---

## 데이터 혼합 금지 원칙

pgvector의 `vector(N)` 타입은 컬럼 레벨에서 차원이 고정된다. 다른 차원의 벡터(예: OpenAI 1536차원과 e5-small 384차원)를 동일 컬럼에 혼용하면 pgvector가 오류를 반환하거나 검색 결과가 완전히 무의미해진다.

다음 규칙을 반드시 지킬 것:

- `EMBEDDING_PROVIDER=transformers`와 `OPENAI_API_KEY`, `GEMINI_API_KEY`, `EMBEDDING_API_KEY`를 동시에 설정하지 않는다. config 로딩 단계에서 자동으로 차단된다.
- 차원 불일치가 감지되면 `server.js` 기동 시 `check-embedding-consistency` 검사에서 실패하고 서버가 시작을 거부한다.
- 기존 데이터가 있는 상태에서 provider를 변경하려면 반드시 아래 전환 절차(시나리오 B)를 따른다.

---

## 시나리오별 전환 절차

### 시나리오 A: 초기 사용자 (DB 비어있음)

DB에 임베딩 데이터가 없는 초기 상태에서 바로 로컬 provider로 시작하는 경우다.

`.env` 파일에 다음 내용을 추가한다:

```
EMBEDDING_PROVIDER=transformers
EMBEDDING_MODEL=Xenova/multilingual-e5-small
EMBEDDING_DIMENSIONS=384
```

`OPENAI_API_KEY`, `EMBEDDING_API_KEY` 등 API 기반 임베딩 환경변수는 설정하지 않는다.

초기화 및 서버 기동:

```bash
npm run migrate   # 기반 스키마는 vector(1536)으로 생성된다
EMBEDDING_DIMENSIONS=384 node scripts/post-migrate-flexible-embedding-dims.js   # fragments, morpheme_dict, fragment_synthetic_query를 vector(384)로 맞춘다
node server.js
```

### 시나리오 B: 기존 OpenAI 사용자 → 로컬 전환 (1536차원 데이터 보유)

기존 1536차원 임베딩 데이터를 포기하고 로컬 provider로 전환하는 절차다. 전환 후 기존 파편의 임베딩은 NULL로 초기화되므로 반드시 backfill 재생성이 필요하다.

```bash
# 1. .env 파일 수정
#    OPENAI_API_KEY 줄을 주석 처리하거나 삭제한다.
#    아래 줄을 추가한다:
EMBEDDING_PROVIDER=transformers
EMBEDDING_MODEL=Xenova/multilingual-e5-small
EMBEDDING_DIMENSIONS=384

# 2. 차원 변경 마이그레이션 재실행
EMBEDDING_DIMENSIONS=384 node scripts/post-migrate-flexible-embedding-dims.js

# 3. 기존 파편 임베딩 재생성
node scripts/backfill-embeddings.js

# 4. 서버 기동
node server.js
```

### 시나리오 C: 기존 OpenAI 유지

변경 없이 기존 설정을 그대로 유지한다. 이 가이드의 내용은 적용되지 않는다.

---

## 모델 변경 방법

기본 e5-small에서 bge-m3로 업그레이드하려면 차원이 384에서 1024로 바뀐다. 차원 변경이 수반되므로 시나리오 B와 동일한 마이그레이션 + backfill 절차가 필요하다.

`.env` 수정:

```
EMBEDDING_PROVIDER=transformers
EMBEDDING_MODEL=Xenova/bge-m3
EMBEDDING_DIMENSIONS=1024
```

이후 아래 순서로 실행:

```bash
EMBEDDING_DIMENSIONS=1024 node scripts/post-migrate-flexible-embedding-dims.js
node scripts/backfill-embeddings.js
node server.js
```

---

## 메모리 및 성능 참고

- 첫 호출 시 Hugging Face Hub에서 모델을 다운로드한다. e5-small 약 120MB, bge-m3 약 500MB. 이후에는 로컬 캐시를 사용한다.
- 캐시 경로 지정을 권장한다:

```
HF_HOME=/var/lib/memento/huggingface
```

- Docker 배포 시 볼륨 마운트 예:

```
-v /var/lib/memento/huggingface:/root/.cache/huggingface
```

- CPU 기준 임베딩 지연시간 (Q8 quantized):

| 모델 | 임베딩 latency (CPU) |
|---|---|
| Xenova/multilingual-e5-small | ~30-80ms |
| Xenova/bge-m3 | ~150-300ms |

- Reranker(~150MB) 및 NLIClassifier(~250MB)를 동시에 활성화하면 합산 메모리 사용량을 반드시 사전에 확인한다. bge-m3 + Reranker bge-m3 조합은 약 1GB 이상의 RAM을 사용한다.

---

## 문제 해결

`Embedding dim mismatch: expected 384, got 1024`
- 환경변수 `EMBEDDING_DIMENSIONS`와 실제 모델 출력 차원이 다르다. 모델 변경 시 `EMBEDDING_DIMENSIONS`도 함께 갱신해야 한다.

기동 실패 `차원 불일치 발견`
- DB에 저장된 기존 벡터 차원과 현재 config 차원이 다르다. 시나리오 B 절차를 수행한다.

첫 호출 지연
- 모델 초기 다운로드 중이다. 로그에서 `[LocalEmbedder] loading model ...` 메시지를 확인한다. 다운로드 완료 후 정상 응답한다.

OOM (메모리 부족)
- 더 작은 모델로 전환한다. bge-m3 사용 중이라면 e5-small로, e5-small 사용 중이라면 all-MiniLM-L6-v2(영어 전용)로 다운그레이드한다.

---

---

## EmbeddingWorker 배치 retry 정책

`EmbeddingWorker._embedMany`는 여러 파편을 `generateBatchEmbeddings` 1회로 처리한 뒤 `multi-row UPDATE FROM (VALUES ...) v(id, vec)` 1회로 저장한다.

청크 분할: 누적 256KB 또는 200건 중 먼저 도달한 기준으로 분할.

### batch retry 흐름

```
generateBatchEmbeddings(texts) 호출
    │
    ├── 성공 → multi-row UPDATE (::text, ::vector placeholder)
    │
    └── HTTP 400 에러 발생
            │
            ├── 정규식 /Invalid 'input\[(\d+)\]'/ 파싱
            │       │
            │       ├── 인덱스 매칭 성공 (badIdx 특정)
            │       │       ├── 해당 행 dead-letter 큐 이동
            │       │       │   (queue:{queueKey}:dead)
            │       │       └── 나머지 행으로 _embedChunk 재귀 호출
            │       │
            │       └── 인덱스 미명시 (정규식 매칭 실패)
            │               └── 청크 전체를 _embedOne 단건 fallback 순차 처리
            │
            └── 그 외 에러 → _embedOne 단건 fallback
```

dead-letter 키: `queue:{embeddingWorker.queueKey}:dead`. 해당 파편 ID와 에러 메시지, 실패 시각이 JSON으로 lpush된다.

### fragments.id 타입 주의사항

`fragments.id`는 `frag-{16자 hex}` 형식의 TEXT 타입이다. multi-row UPDATE SQL에서 반드시 `::text` cast를 사용해야 한다. `::uuid` cast를 사용하면 형식 불일치로 런타임 오류가 발생한다.

```sql
-- 올바른 형식
UPDATE agent_memory.fragments AS f
   SET embedding = v.vec::vector
  FROM (VALUES ($1::text, $2::vector), ($3::text, $4::vector)) AS v(id, vec)
 WHERE f.id = v.id

-- 금지 (::uuid cast 사용 불가 — fragments.id는 TEXT)
-- FROM (VALUES ($1::uuid, $2::vector)) AS v(id, vec)
```

---

## MorphemeIndex 배치 처리

`MorphemeIndex.getOrRegisterEmbeddings`는 사전에 없는 형태소 전체를 `generateBatchEmbeddings` 1회 + `multi-row INSERT` 1회로 등록한다.

청크 크기: 200건 또는 256KB 누적 중 먼저 도달. 형태소 수가 많으면 자동으로 복수 청크로 분할된다.

배치 실패 시 retry:
- `/Invalid 'input\[N\]'/` 패턴으로 문제 항목 격리 후 나머지 재시도
- 인덱스 미명시 에러 시 `_fallbackSingleRegister`로 단건 순차 처리

형태소 등록 완료 후 `fragments.morpheme_indexed = true`로 갱신된다 (migration-035 컬럼). 미완료 파편은 L2 키워드 매칭에는 참여하지만 형태소 기반 L3 시맨틱 검색(`FragmentSearch._searchL3` morpheme sub-path)에서 제외된다.

---

## 관련 문서

- `tests/integration/README.md` — 통합 테스트 실행 가이드
- `scripts/post-migrate-flexible-embedding-dims.js` — 차원 변경 마이그레이션 스크립트
- `scripts/check-embedding-consistency.js` — 서버 기동 시 차원 일관성 검증 로직
- `docs/configuration.md` — 전체 환경변수 목록 (EMBEDDING_PROVIDER, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS 항목 포함)
