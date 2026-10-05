# 시스템 요구사항

### 런타임

- Node.js 22 이상 (ESM, top-level await)
  - 서버 실행은 22 이상에서 동작한다. 개발용 단위시험은 `--experimental-test-module-mocks`를 쓰며 이 기능은 24에서만 안정적이다.
- PostgreSQL 14 이상 + pgvector 확장
  - HNSW 인덱스: pgvector 0.5.0 이상 필요
  - `halfvec(N)` 지원(3073차원 이상 모델): pgvector 0.7.0 이상 필요
- Redis 6 이상 (선택, 없으면 stub 동작)

### npm 패키지

- `@huggingface/transformers` ^4.3.0 (package.json 의존성)
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
| `migration-038` ~ `migration-053` | fragment_versions case 필드, feedback 계측, workspace 감사 컬럼, allowed_workspaces, synthetic query, idempotency_records, fragment RLS(ENABLE만), agent scope 감사, case_closed, synthetic query 임베딩 정합, 키와 workspace 단위 content_hash 유일 색인, search_events 예산 선택 열, outbox_events 표, 본문 어휘 채널 열(content_tokens). 번호 046은 비어 있다 |

`post-migrate-flexible-embedding-dims.js`: `EMBEDDING_DIMENSIONS` 변경 또는 임베딩 제공자 전환 시 `fragments`, `morpheme_dict`, `fragment_synthetic_query` 세 테이블의 벡터 컬럼 차원을 함께 갱신한다. 임베딩 제공자 전환마다 재실행이 필요하다.

### 선택적 CLI 바이너리 (LLM provider)

| CLI | 설치 명령 | 용도 |
|-----|---------|------|
| gemini | `npm install -g @google/gemini-cli` | 기본 LLM provider (`LLM_PRIMARY=gemini-cli`) |
| agy | Google Antigravity 공식 installer | Google Antigravity CLI provider (`LLM_PRIMARY=agy-cli`) |
| codex | `npm install -g @openai/codex` | OpenAI Codex CLI fallback |
| copilot | `npm install -g @github/copilot` | GitHub Copilot CLI fallback (`LLM_PRIMARY=copilot-cli`) |
| opencode | `opencode` 실행 파일을 PATH에 설치 | OpenCode CLI provider (`LLM_PRIMARY=opencode-cli`) |
| qwen | `qwen` 실행 파일을 PATH에 설치 | Qwen CLI provider (`LLM_PRIMARY=qwen-cli`) |

각 CLI는 설치 후 별도 로그인이 필요하다. 미설치 또는 인증 실패 시 해당 provider는 다음 fallback으로 전환된다. gemini-cli, copilot-cli, opencode-cli는 기본(`MEMENTO_LLM_CLI_TOOL_APPROVAL=none`)에서 제한된 도구 승인으로 서버 작업 디렉터리가 아닌 빈 임시 디렉터리에서 실행된다.
