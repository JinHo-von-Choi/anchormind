## 시스템 요구사항

### 런타임

- Node.js 20 이상 (ESM, top-level await)
  - 서버 실행은 20 이상에서 동작한다. 개발용 단위시험은 `--experimental-test-module-mocks`를 쓰며 이 기능은 24에서만 안정적이다.
- PostgreSQL 14 이상 + pgvector 확장
  - HNSW 인덱스: pgvector 0.5.0 이상 필요
  - `halfvec(N)` 지원(3073차원 이상 모델): pgvector 0.7.0 이상 필요
- Redis 6 이상 (선택, 없으면 stub 동작)

### npm 패키지

- `@huggingface/transformers` 3.8.1 (이미 설치됨)
  - `EMBEDDING_PROVIDER=transformers` 또는 `MEMENTO_RERANKER_ENABLED=true` 또는 `NLI_SERVICE_URL` 미설정 시 활성화
  - 별도 설치 없이 `node_modules`에 포함됨

### 메모리 요구사항 (추가 모델 기준)

기본 서버(임베딩 API 사용, Reranker/NLI 비활성) 외 추가 구성 시 메모리를 고려한다:

| 구성 | 추가 메모리 |
|------|-----------|
| 로컬 임베딩 e5-small (Q8) | ~150 MB |
| 로컬 임베딩 e5-base (Q8) | ~300 MB |
| Reranker minilm (Q8) | ~80 MB |
| Reranker bge-m3 (Q8) | ~280 MB |
| NLIClassifier mDeBERTa | ~250 MB |

세 모듈(LocalEmbedder + Reranker + NLIClassifier)을 모두 활성화하면 추가 최대 ~730 MB. ONNX Runtime은 프로세스 내에서 공유된다.

### DB 마이그레이션

| 파일 | 내용 |
|------|------|
| `migration-034-v2.16.0-bundle.sql` | `api_keys.default_mode TEXT` 컬럼 + 인덱스 |
| `migration-034-v2.16.0-bundle.sql` | `fragments.affect TEXT CHECK(...)` 컬럼 + partial 인덱스 |
| `migration-036-split-attempt-failed-at.sql` | `fragments.split_attempt_failed_at TIMESTAMPTZ` 컬럼 추가 |
| `migration-037-hnsw-index-rename.sql` | HNSW 인덱스 이름 정합화 |

`post-migrate-flexible-embedding-dims.js`: `EMBEDDING_DIMENSIONS` 변경 또는 임베딩 제공자 전환 시 `fragments`와 `morpheme_dict` 두 테이블의 벡터 컬럼 차원을 동시에 갱신한다. 임베딩 제공자 전환마다 재실행이 필요하다.

### 선택적 CLI 바이너리 (LLM provider)

| CLI | 설치 명령 | 용도 |
|-----|---------|------|
| gemini | `npm install -g @google/gemini-cli` | 기본 LLM provider (`LLM_PRIMARY=gemini-cli`) |
| agy | Google Antigravity 공식 installer | Google Antigravity CLI provider (`LLM_PRIMARY=agy-cli`) |
| codex | `npm install -g @openai/codex` | OpenAI Codex CLI fallback |
| copilot | `npm install -g @githubnext/github-copilot-cli` | GitHub Copilot CLI fallback |

각 CLI는 설치 후 별도 로그인이 필요하다(`gemini auth login`, `agy`, `codex auth login`, `github-copilot-cli auth`). 미설치 또는 인증 실패 시 해당 provider는 다음 fallback으로 전환된다.

---

## 2026-03-31 프로젝트 정밀 분석 보고서 작성 요구사항

작성자: 최진호
작성일: 2026-03-31

### 1. 목적

현재 시점의 memento-mcp 저장소를 다시 정밀 분석하여, 기존 2026-03-10 분석 보고서 이후 누적된 구조 변화와 운영 성숙도를 최신 상태 기준으로 재평가한다.

### 2. 범위

- 최신 버전 기준 엔트리포인트, 인증, 세션, 검색, 저장, 유지보수, 관리자 콘솔 구조 분석
- 실제 테스트 실행을 통한 건강도 검증
- README 및 아키텍처 문서와 구현 간 불일치 확인
- 모듈별 심화 분석 추가

### 3. 산출물

1. `docs/reports/project-analysis-2026-03-31.md`
2. 모듈별 심화 분석 포함
3. 테스트 실행 결과 반영
4. 문서 정합성 문제와 우선순위 제안 포함

### 4. 성공 기준

- 기존 보고서보다 현재 구현을 더 정확히 반영한다.
- 단순 개요가 아니라 모듈별 책임, 강점, 리스크, 개선 우선순위를 제시한다.
- 코드 변경 없이도 다음 기술 의사결정에 바로 활용 가능한 수준의 보고서여야 한다.

## 2026-03-26 관리자 콘솔 기획 및 스티치 디자인 요구사항

작성자: 최진호
작성일: 2026-03-26

### 1. 목적

현재 관리자 UI는 운영 최소 기능 중심이며, 실제 운영자가 기억 서버 상태를 빠르게 파악하고 API 키, 그룹, 검색 품질, 세션, 유지보수 상태를 통합 관리하기에는 화면 구조와 정보 밀도가 부족하다.

이번 작업의 목적은 아래 두 가지다.

- 운영자 중심의 관리자 콘솔 정보구조(IA)와 기능 우선순위를 정의한다.
- 기존 다크 네온 계열 디자인 언어를 유지하되, 스티치를 통해 운영 콘솔 수준의 완성도 있는 화면 시안을 생성한다.

### 2. 사용자 정의

- 시스템 운영자: 서버 상태, 세션, 오류, 유지보수 상태를 빠르게 파악해야 한다.
- 보안 관리자: API 키 발급, 키 상태 변경, 그룹 멤버십 변경, 접근 이상 징후를 관리해야 한다.
- 메모리 엔지니어: 검색 품질, 검색 경로, TTL/감쇠, 임베딩 백로그, 품질 평가 상태를 점검해야 한다.

### 3. 정보 구조

관리자 콘솔은 아래 6개 영역으로 구성한다.

1. 개요 대시보드
2. API 키 관리
3. 그룹 및 권한 관리
4. 메모리 탐색 및 검색 품질
5. 세션 및 작업 큐 관제
6. 운영 로그 및 유지보수 제어

### 4. 화면별 핵심 기능

#### 4.1 개요 대시보드

- 총 파편 수, 활성 세션 수, 오늘 API 호출 수, 활성 키 수, DB 크기, Redis 상태, 서버 업타임 표시
- 최근 파편 생성 활동 타임라인
- 위험/주의 카드:
  - Redis 연결 끊김
  - 임베딩 백로그 증가
  - 품질 미검증 파편 증가
  - 고아 링크 또는 superseded chain 이상
- 빠른 실행 패널:
  - 키 생성
  - 그룹 생성
  - 유지보수 실행
  - 로그 확인

#### 4.2 API 키 관리

- 키 목록, 상태(active/revoked), 접두사, 생성일, 그룹 수, 최근 사용량 조회
- 키 생성 플로우
- 키 비활성화/삭제
- 키별 상세 패널:
  - 오늘 호출량
  - 최근 사용일
  - 연결 그룹
  - 메모리 격리 범위

#### 4.3 그룹 및 권한 관리

- 그룹 생성/삭제
- 그룹별 멤버 수, 연결 키 목록 확인
- 키를 그룹에 추가/제거
- 향후 확장 고려:
  - 그룹별 정책 프리셋
  - 접근 허용 범위 태그

#### 4.4 메모리 탐색 및 검색 품질

- topic, type, key_id, sessionId, valid_to 기준 탐색
- type 필터는 fact, error, decision, procedure, preference, episode 지원
- 최근 recall/query 이벤트, relevance/sufficiency 피드백 요약
- 검색 레이어 지표:
  - L1/L2/L3 latency
  - hit rate
  - semantic threshold 분포
- 검색 품질 개선용 빠른 인사이트:
  - 검색 실패 상위 쿼리
  - 낮은 utility_score 파편
  - superseded 정리 후보

#### 4.5 세션 및 작업 큐 관제

- 활성 세션 수 및 세션별 최근 활동 시간
- EmbeddingWorker 백로그
- AutoReflect 대기/완료 상태
- MemoryEvaluator 처리량 및 실패 건수
- 스케줄러 작업 상태:
  - consolidate
  - decay
  - contradiction detection

#### 4.6 운영 로그 및 유지보수 제어

- 오류 로그, 경고 로그, 최근 유지보수 실행 이력
- 운영 액션 패널:
  - 유지보수 수동 실행
  - 임베딩 재시도
  - 고아 링크 정리
  - 검색 메트릭 리포트 보기
- 파괴적 액션은 항상 별도 확인 모달 필요

### 5. 디자인 방향

- 기존 `assets/admin/index.html`의 시각 언어를 계승한다.
- 다크 배경, 블루/사이언 포인트, 유리 질감, 시스템 관제실 느낌을 유지한다.
- 단순 CRUD 화면이 아니라 "메모리 운영 관제 콘솔"로 보이도록 한다.
- 카드, 차트, 로그 패널, 타임라인, 필터 바의 밀도와 계층을 명확히 한다.
- 모바일은 세로 스택 기반, 데스크톱은 12컬럼 운영 패널 레이아웃을 사용한다.

### 6. 스티치 산출물 범위

이번 디자인 산출물은 최소 3개 스크린으로 구성한다.

1. Admin Overview Dashboard
2. API Key & Group Management
3. Memory Ops Explorer

필요 시 아래 추가 화면을 후속 산출물로 확장할 수 있다.

- Session Control Center
- Maintenance & Logs

### 7. 성공 기준

- 현재 구현된 관리자 API와 자연스럽게 매핑된다.
- 아직 미구현된 기능도 향후 확장 가능한 정보구조로 제시된다.
- 운영자가 10초 이내에 시스템 건강 상태를 파악할 수 있다.
- 보안 관리자가 키/그룹 관련 핵심 작업을 3클릭 이내에 수행할 수 있다.
- 스티치 결과물이 기존 관리자 UI보다 정보 밀도, 우선순위, 관제성에서 명확히 우수하다.

### 8. 스티치 산출물

- 프로젝트: `projects/1592166149333170145`
- 대표 대시보드(Desktop): `projects/1592166149333170145/screens/12364c48dd67431ba9a5e058ed7386cb`
- 대시보드 대안안(Desktop): `projects/1592166149333170145/screens/ad26067c69894e71882545bfc6c45b28`
- 대시보드 모바일안(Mobile): `projects/1592166149333170145/screens/177fbc06f5a943e599838cdc1dc69555`
- API 키 및 그룹 관리(Desktop): `projects/1592166149333170145/screens/cb35b178bded4410b7eeb0897a13a6d2`
- 메모리 운영 및 관측성(Desktop): `projects/1592166149333170145/screens/b31bf93e338744858ddc4da2821eb743`

### 9. 권장 후속 작업

1. 개요 대시보드 대안안 2개 중 메인 안 1개를 확정한다.
2. `세션 관리`와 `운영 로그/유지보수` 스크린을 후속 생성한다.
3. 선택한 스티치 화면을 기준으로 `assets/admin/index.html` 정보구조 개편안을 만든다.
4. 현재 `lib/admin/admin-routes.js` API 범위와 미구현 운영 기능 간 갭을 표로 정리한다.

### 10. 구현 계획 문서

- 관리자 콘솔 대체 구현 플랜: `docs/plans/2026-03-26-admin-dashboard-replacement.md`

  1. 검색 경로 선택을 contextual bandit으로 바꾸기
     현재 구조는 L1→L2→L3와 일부 RRF 병합이 이미 있습니다. 여기에 “어떤 쿼리에서 어떤 경로가 가장 싸고 정확한가”를 bandit이 학습하
     게 만들면 좋습니다.
     행동(action) 예시는 아래처럼 둘 수 있습니다.

  - L1 only
  - L1+L2
  - L2+L3
  - L1+L2+L3+RRF
  - query rewrite 후 L2+L3
  - late interaction rerank 추가

  보상(reward)은 지금 있는 tool_feedback, count, latency, 후속 사용 성공률로 정의하면 됩니다.

  - reward = α * relevant + β * sufficient - γ * latency_ms - δ * token_cost

  이 방향은 논문적으로 가장 실용적입니다. Li et al.의 contextual bandit 추천 논문은 부분 피드백 환경에서 정책을 온라인 학습하고,
  오프라인 로그 평가까지 제시합니다. 지금 저장소의 tool_feedback 로그는 bandit 학습 데이터로 바로 전환하기 좋습니다. 이건 제 추론
  입니다.
  소스:

  -
  https://www.microsoft.com/en-us/research/publication/a-contextual-bandit-approach-to-personalized-news-article-recommendation-3/?lang=ja
  - https://arxiv.org/abs/1003.0146

  2. reasoning-heavy 쿼리만 별도 질의계획기로 보내기
     최신 retrieval 연구를 보면, 어려운 질의는 임베딩 품질만 높여도 한계가 있습니다. BRIGHT는 reasoning-intensive retrieval에서 기
     존 검색기가 매우 약하고, “질의에 대한 명시적 추론”을 넣으면 성능이 올라간다고 보고합니다. 논문 요약 기준으로 최대 12.2
     nDCG@10p 개선이 나옵니다.
     이 프로젝트에 맞추면 다음 구조가 됩니다.

  - 쉬운 질의: 기존 L1/L2/L3
  - 어려운 질의: 질의 분해
      - 의도 파악
      - 핵심 제약 추출
      - 시간성/부정/비교 조건 추출
      - 확장 질의 2~3개 생성
      - 각 질의를 병렬 검색 후 병합

  즉, “벡터 검색 이전의 의사결정 모델”을 붙이는 것입니다. 이건 bandit과 같이 써도 됩니다.
  소스:

  - https://arxiv.org/abs/2407.12883

  3. single-vector에서 multi-vector late interaction으로 올리기
     현재는 single embedding 기반입니다. 그런데 기억 파편은 짧더라도 “원인”, “해결”, “시간성”, “선호”, “결정” 같은 다중 측면이 섞
     입니다. 이런 데이터는 late interaction 계열이 잘 맞습니다.
     후보는 2단계입니다.

  - 1차: 기존 single-vector ANN으로 후보 50~100개
  - 2차: ColBERT류 late interaction rerank
  - 장기적으로는 MUVERA처럼 multi-vector를 single-vector ANN 인프라 위에 근사시키는 방향

  의미:

  - 정확도는 ColBERT 계열이 유리
  - 서빙 비용은 MUVERA류 근사가 유리

  이 프로젝트에는 “전면 교체”보다 “rerank 전용 추가”가 현실적입니다.
  소스:

  - https://arxiv.org/abs/2004.12832
  - https://research.google/pubs/muvera-simple-and-effective-multi-vector-retrieval-via-fixed-dimensional-encodings/

  4. filter-aware vector planner를 넣기
     이 시스템은 topic, type, key_id, valid_to, is_anchor 같은 메타필터가 많습니다. 이런 구조에서는 ANN 자체보다 “필터 선택도에 따
     라 pre-filter / post-filter / inline-filter 중 무엇이 유리한지”를 정하는 planner가 중요합니다.
     최신 정리 논문도 filtered vector search에서 핵심 문제가 바로 여기라고 봅니다.
     실무적으로는:

  - 선택도 높음: pre-filter 후 exact 또는 작은 ANN
  - 선택도 중간: inline-filter
  - 선택도 낮음: ANN 후 post-filter + iterative widening
  - efSearch, candidate size도 동적으로 조정

  이건 decision tree나 작은 contextual bandit으로도 충분합니다.
  소스:

  - https://research.google/pubs/filtered-vector-search-state-of-the-art-and-research-opportunities/
  - https://arxiv.org/abs/1603.09320

  프로젝트에 바로 맞는 우선순위는 이렇습니다.

  1. 1단계
     tool_feedback와 검색 메트릭으로 retrieval-policy bandit 추가
     이게 ROI가 가장 높습니다. 기존 구조를 거의 안 깨고 성능/비용 둘 다 최적화할 수 있습니다.
  2. 2단계
     reasoning query planner 추가
     BRIGHT류 문제에 대응하려면 필요합니다. 특히 error, procedure, decision 검색에는 효과가 클 가능성이 높습니다.
     이건 논문 근거 + 현재 도메인 특성에 기반한 제 추론입니다.
  3. 3단계
     ColBERT-style reranker를 recall 상위 50개에만 적용
     정확도 향상용입니다. 전체 인덱스 교체보다 안전합니다.
  4. 4단계
     filtered vector planner + dynamic efSearch
     성능 최적화용입니다. 특히 key_id, topic, type, valid_to 조합이 많은 이 프로젝트에서 중요합니다.

  제가 추천하는 실제 구현안은 이것입니다.

  - RetrievalPolicyManager 신설
  - 입력 feature:
      - query 길이
      - keywords 개수
      - text 유무
      - topic/type 존재 여부
      - sessionId 유무
      - key filter 개수
      - 최근 유사 질의 성공률
      - 현재 Redis/DB 상태
  - action:
      - 검색 경로 선택
      - candidate size
      - rerank 사용 여부
      - query rewrite 사용 여부
  - reward:
      - tool_feedback.relevant
      - tool_feedback.sufficient
      - latency penalty
      - token penalty
  - 초기 정책:
      - rule-based bootstrap
  - 이후:
      - LinUCB 또는 Thompson Sampling

  이건 지금 코드베이스에 가장 잘 들어갑니다. Decision Transformer 같은 offline RL 계열은 현재 로그 규모와 온라인 제어 범위를 보면
  과합니다. bandit이 더 맞습니다. 이 부분은 제 설계 판단입니다.

  원하시면 다음 단계로 바로 이어서 해드릴 수 있습니다.

  1. 이 저장소 기준으로 bandit 기반 retrieval-policy 설계서 작성
  2. 최소 구현안 코드 패치
  3. 논문 6~8편 더 추려서 “적용 가능성 / 구현 난이도 / 기대효과” 표로 정리

  참고 링크

  - HNSW: https://arxiv.org/abs/1603.09320
  - BRIGHT: https://arxiv.org/abs/2407.12883
  - ColBERT: https://arxiv.org/abs/2004.12832
  - Contextual Bandit 추천: https://arxiv.org/abs/1003.0146
  - Microsoft Research 요약 페이지:

  https://www.microsoft.com/en-us/research/publication/a-contextual-bandit-approach-to-personalized-news-article-recommendation-3/?lang=ja
  - MUVERA: https://research.google/pubs/muvera-simple-and-effective-multi-vector-retrieval-via-fixed-dimensional-encodings/
  - Filtered Vector Search: https://research.google/pubs/filtered-vector-search-state-of-the-art-and-research-opportunities/
