# 설치 가이드

> [!TIP]
> 직접 설치할 자신이 없다면 [AI에게 맡기기](#ai에게-맡기기) 섹션부터 보면 된다. 한 줄 프롬프트로 환경 점검·의존성·`.env`·MCP 등록·헬스 체크까지 AI가 진행한다.

## AI에게 맡기기

이 저장소를 처음 다루는 사람이 가장 빠르게 시작하는 경로는 AI 어시스턴트에 위임하는 것이다. Claude Code, Cursor, Codex 같은 도구가 모두 동작한다.

### 권장 프롬프트

**클린 설치 (새 환경에 처음 도입)**

> "memento-mcp 저장소(`https://github.com/JinHo-von-Choi/memento-mcp`)를 내 환경에 클론하고, `docs/INSTALL.md`와 `SKILL.md`를 읽어 다음을 수행해 줘:
>
> 1. 시스템 요구사항 확인 (Node.js, PostgreSQL, Redis 가용성)
> 2. `npm install` 및 `bash setup.sh`로 의존성·.env 생성
> 3. PostgreSQL과 Redis 미설치 시 설치 또는 Docker Compose 권장 구성 제시
> 4. 마이그레이션(`npm run migrate`) 실행
> 5. `node bin/memento.js health`로 헬스 체크 통과 확인
> 6. 현재 사용 중인 AI 클라이언트(Claude Code/Cursor/Codex)의 MCP 설정에 memento-mcp 등록
> 7. `mcp__memento__memory_stats` 호출로 동작 검증
>
> 각 단계 결과를 표로 보고하고, 실패 시 `docs/getting-started/troubleshooting.md` 참고해서 자동 복구를 시도해 줘."

**기존 Claude Code 환경 통합**

> "내 `~/.claude.json`에 memento-mcp MCP 서버를 추가하고 싶다. `docs/getting-started/claude-code.md`를 참고해서 다음을 진행해 줘:
>
> 1. 현재 `~/.claude.json` 백업
> 2. memento-mcp 항목을 mcpServers 섹션에 추가 (URL, ACCESS_KEY)
> 3. Claude Code 재시작 안내
> 4. 도구 목록에 mcp__memento__remember 등이 표시되는지 확인 절차 제시"

### AI가 수행할 작업 체크리스트

위 프롬프트를 받은 AI가 정상적으로 처리했다면 다음이 모두 충족되어야 한다.

- `.env` 파일이 생성되고 `MEMENTO_ACCESS_KEY`·`POSTGRES_*`·`REDIS_*` 키가 모두 채워져 있다
- `npm run migrate`가 `migration-035`까지 통과한다
- `node bin/memento.js health`가 DB/Redis/임베딩 제공자 모두 OK를 반환한다
- AI 클라이언트 도구 목록에 `mcp__*__remember`·`recall`·`reflect`가 노출된다
- `memory_stats` 호출이 0건이라도 정상 응답을 반환한다

### AI가 막혔을 때 사람이 봐야 할 문서

- 의존성 문제: [Troubleshooting](getting-started/troubleshooting.md)
- Windows: [Windows WSL2 Setup](getting-started/windows-wsl2.md)
- Claude Code 등록 세부: [Claude Code Configuration](getting-started/claude-code.md)
- 첫 동작 검증: [First Memory Flow](getting-started/first-memory-flow.md)
- 운영 매뉴얼: [SKILL.md](../SKILL.md)

---

## 시작 경로 선택

- 최소 실행만 빨리 확인: [Quick Start](getting-started/quickstart.md)
- Windows에서 가장 안정적인 설치: [Windows WSL2 Setup](getting-started/windows-wsl2.md)
- Windows에서 Bash 없이 수동 설치: [Windows PowerShell Setup](getting-started/windows-powershell.md)
- Claude Code 연동: [Claude Code Configuration](getting-started/claude-code.md)
- 설치 후 첫 검증: [First Memory Flow](getting-started/first-memory-flow.md)
- 문제 해결: [Troubleshooting](getting-started/troubleshooting.md)

## 지원 정책

- Linux / macOS: 일반 설치 경로
- Windows: WSL2 Ubuntu 경로 권장
- Windows PowerShell: 제한 지원
- `setup.sh`: Bash 환경 전제

## 빠른 시작 (대화형 설치 스크립트)

```bash
bash setup.sh
```

.env 생성, npm install, DB 스키마 적용까지 단계별로 안내한다.

---

## 수동 설치

## 의존성 설치

```bash
npm install

# (선택) CUDA 11 환경에서 설치 오류 발생 시 CPU 전용으로 설치
# npm install --onnxruntime-node-install-cuda=skip
```

### 주의사항: ONNX Runtime 및 CUDA

CUDA 11이 설치된 시스템에서 `@huggingface/transformers`의 의존성인 `onnxruntime-node`가 GPU 바인딩을 시도하다 설치에 실패할 수 있습니다. 이 프로젝트는 CPU 전용으로 최적화되어 있으므로, 설치 시 `--onnxruntime-node-install-cuda=skip` 플래그를 사용하면 문제 없이 설치됩니다.

## PostgreSQL 스키마 적용

```bash
# 최초 설치
psql -U $POSTGRES_USER -d $POSTGRES_DB -f lib/memory/memory-schema.sql
```

## 업그레이드 (기존 설치)

마이그레이션을 순서대로 실행한다.

```bash
psql $DATABASE_URL -f lib/memory/migration-001-temporal.sql      # Temporal 컬럼 추가
psql $DATABASE_URL -f lib/memory/migration-002-decay.sql         # last_decay_at 컬럼 추가
psql $DATABASE_URL -f lib/memory/migration-003-api-keys.sql      # API 키 관리 테이블 추가
psql $DATABASE_URL -f lib/memory/migration-004-key-isolation.sql # fragments.key_id 격리 컬럼 추가
psql $DATABASE_URL -f lib/memory/migration-005-gc-columns.sql    # GC 정책 인덱스 추가
psql $DATABASE_URL -f lib/memory/migration-006-superseded-by-constraint.sql # fragment_links CHECK에 superseded_by 추가
psql $DATABASE_URL -f lib/memory/migration-007-link-weight.sql   # fragment_links.weight 컬럼 추가
psql $DATABASE_URL -f lib/memory/migration-008-morpheme-dict.sql # 형태소 사전 테이블 추가
psql $DATABASE_URL -f lib/memory/migration-009-co-retrieved.sql  # co_retrieved 링크 타입 추가
psql $DATABASE_URL -f lib/memory/migration-010-ema-activation.sql # EMA 활성화 컬럼 추가
psql $DATABASE_URL -f lib/memory/migration-011-key-groups.sql      # API 키 그룹
psql $DATABASE_URL -f lib/memory/migration-012-quality-verified.sql # quality_verified 컬럼 추가
psql $DATABASE_URL -f lib/memory/migration-013-search-events.sql   # 검색 이벤트 관측성 테이블 추가
psql "$DATABASE_URL" -f lib/memory/migration-014-ttl-short.sql
psql "$DATABASE_URL" -f lib/memory/migration-015-created-at-index.sql
psql "$DATABASE_URL" -f lib/memory/migration-016-agent-topic-index.sql
psql "$DATABASE_URL" -f lib/memory/migration-017-episodic.sql
psql $DATABASE_URL -f lib/memory/migration-021-oauth-clients.sql  # OAuth 클라이언트 등록
psql $DATABASE_URL -f lib/memory/migration-025-case-id-episode.sql    # fragments narrative reconstruction 컬럼 (case_id, goal, outcome, phase, resolution_status, assertion_status)
psql $DATABASE_URL -f lib/memory/migration-026-case-events.sql        # case_events + case_event_edges + fragment_evidence 테이블 (Narrative Reconstruction)
psql $DATABASE_URL -f lib/memory/migration-027-v25-reconsolidation-episode-spreading.sql  # fragment_links 재통합 컬럼 + link_reconsolidations + case_events idempotency_key + keywords GIN 인덱스
psql $DATABASE_URL -f lib/memory/migration-028-v253-improvements.sql                     # 복합 인덱스 추가, used_rrf 단일화, superseded_by 제거
psql $DATABASE_URL -f lib/memory/migration-029-search-param-thresholds.sql               # SearchParamAdaptor 검색 파라미터 학습 테이블
psql $DATABASE_URL -f lib/memory/migration-030-search-param-thresholds-key-text.sql      # search_param_thresholds.key_id INTEGER → TEXT (UUID 호환)
psql $DATABASE_URL -f lib/memory/migration-031-content-hash-per-key.sql                  # content_hash 전역 UNIQUE → 테넌트별 partial unique index
psql $DATABASE_URL -f lib/memory/migration-032-fragment-claims.sql                       # fragment_claims 테이블 + tenant 격리 partial unique (Symbolic Memory)
psql $DATABASE_URL -f lib/memory/migration-033-symbolic-hard-gate.sql                    # api_keys.symbolic_hard_gate 컬럼 (symbolic hard gate opt-in)
psql $DATABASE_URL -f lib/memory/migration-034-v2.16.0-bundle.sql                        # api_keys.default_mode + fragments.affect + fragments.idempotency_key (단일 번들)
psql $DATABASE_URL -f lib/memory/migration-035-morpheme-indexed.sql                      # fragments.morpheme_indexed BOOLEAN 추가 + 기존 행 백필 + sparse partial index
```

> **migration-007 재실행**: `EMBEDDING_DIMENSIONS`를 변경하거나 임베딩 제공자를 전환한 경우, `post-migrate-flexible-embedding-dims.js`를 재실행하면 `fragments` 테이블과 `morpheme_dict` 테이블의 벡터 차원이 동시에 갱신된다. 구 경로 `scripts/migration-007-flexible-embedding-dims.js` 심볼릭 링크는 제거됐으므로 `scripts/post-migrate-flexible-embedding-dims.js`를 직접 사용한다.

> **migration-034-v2.16.0 CONCURRENTLY 옵션**: migration-034-v2.16.0-bundle은 트랜잭션 내에서 실행되므로 `CREATE UNIQUE INDEX`를 사용한다. 수백만 건 이상의 대규모 운영 테이블에서 잠금 최소화가 필요한 경우, `npm run migrate` 실행 전에 아래 두 문을 수동으로 실행하면 IF NOT EXISTS 가드에 의해 자동 실행 시 안전하게 SKIP된다.
>
> ```sql
> CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_fragments_idempotency_tenant
>   ON agent_memory.fragments (key_id, idempotency_key)
>   WHERE idempotency_key IS NOT NULL AND key_id IS NOT NULL;
>
> CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_fragments_idempotency_master
>   ON agent_memory.fragments (idempotency_key)
>   WHERE idempotency_key IS NOT NULL AND key_id IS NULL;
> ```

> **migration-035 morpheme_indexed**: `fragments.morpheme_indexed BOOLEAN NOT NULL DEFAULT false` 컬럼을 추가한다. 마이그레이션 실행 시 기존 `keywords IS NOT NULL` 파편은 `true`로 자동 백필된다. 부분 인덱스 `idx_fragments_morpheme_indexed`(`WHERE morpheme_indexed = false`)로 재인덱싱 대상 파편을 sparse하게 추적한다. `DEFAULT false`이므로 롤백 없이 hot deploy가 안전하다. Consistency Gate는 MorphemeIndex 등록이 완료된 파편(`morpheme_indexed = true`)만 morpheme 검색 대상으로 제한한다.

> **rollback 파일 네이밍**: rollback SQL 파일은 `rollback-migration-NNN-*.sql` 형식으로 이름을 지정해야 한다. `migrate.js`의 auto-pickup glob은 `migration-*.sql` 패턴만 인식하므로, `rollback-` 접두어를 붙이면 자동 실행에서 제외된다.

v1.8.0부터 자동 마이그레이션을 지원한다. 위 수동 실행 대신:

```bash
DATABASE_URL=postgresql://user:pass@host:port/dbname npm run migrate
```

신규 마이그레이션 파일을 추가한 경우 `migrate` 실행 전에 body-only 규약 준수 여부를 검사한다.

```bash
npm run lint:migrations
```

규약 상세는 [docs/migration-conventions.md](migration-conventions.md) 참조.

### migration-034 번들 이전 버전에서 업그레이드

```bash
# 1. 의존성 업데이트
npm install

# 2. 마이그레이션 실행 (migration-034-v2.16.0-bundle 포함)
npm run migrate

# 3. EMBEDDING_PROVIDER 재검토
#    provider 변경 또는 EMBEDDING_DIMENSIONS 수정 시:
#    EMBEDDING_DIMENSIONS=N DATABASE_URL=$DATABASE_URL node scripts/post-migrate-flexible-embedding-dims.js
#    DATABASE_URL=$DATABASE_URL node scripts/backfill-embeddings.js

# 4. .env 항목 확인
#    MEMENTO_CLI_REMOTE, MEMENTO_CLI_KEY 추가 여부 검토 (원격 CLI 경유 사용 시)

# 5. 서버 재시작
node server.js
```

### migration-035 이전 버전에서 업그레이드

```bash
# 1. 의존성 업데이트
npm install

# 2. 마이그레이션 실행 (migration-035-morpheme-indexed 포함)
npm run migrate

# 3. .env 항목 확인 (선택)
#    BATCH_DATABASE_URL: batchPool 전용 DB URL. 미설정 시 DATABASE_URL 공유.

# 4. 서버 재시작
node server.js
```

migration-034-v2.16.0-bundle 인덱스 적용 확인:

```sql
-- psql 접속 후
\d agent_memory.fragments
-- idx_fragments_idempotency_tenant, idx_fragments_idempotency_master 두 인덱스가 보여야 한다.
```

`agent_memory.schema_migrations` 테이블에 적용 이력이 기록되며, 미적용 파일만 순서대로 실행된다.

> **v1.1.0 이전에서 업그레이드하는 경우**: migration-006 미실행 시 `amend`, `memory_consolidate`, GraphLinker 자동 관계 생성에서 DB 제약 에러가 발생한다(`superseded_by` INSERT 실패). 기존 DB를 유지하며 업그레이드할 때 반드시 실행해야 한다.

> **migration-007**: fragment_links.weight 컬럼이 없으면 recall 호출 시 `column l.weight does not exist` 에러가 발생한다. v1.2.0 이전에서 업데이트한 경우 반드시 실행할 것.

> **migration-009, 010**: co_retrieved 링크 타입이 없으면 Hebbian 링킹이 DB 제약 에러로 조용히 실패하고, ema_activation 컬럼이 없으면 incrementAccess SQL 오류가 발생한다. 반드시 실행 후 서버를 시작해야 한다.

> **MEMENTO_ACCESS_KEY**: 설정하지 않으면 서버가 시작 시 경고를 출력하며 인증 없이 동작한다. 개발/테스트 환경에서 의도적으로 인증을 비활성화하려면 `.env`에 `MEMENTO_AUTH_DISABLED=true`를 추가한다.

```bash
# 기본 임베딩(1536차원) 사용 시: migration-007 불필요
# 2000차원 초과 모델(Gemini gemini-embedding-001 등) 사용 시:
# EMBEDDING_DIMENSIONS=3072 DATABASE_URL=$DATABASE_URL node scripts/post-migrate-flexible-embedding-dims.js

DATABASE_URL=$DATABASE_URL node scripts/normalize-vectors.js  # 임베딩 L2 정규화 (1회)

# 노이즈 파편 정리 (수동)
node scripts/cleanup-noise.js --dry-run   # 미리보기
node scripts/cleanup-noise.js --execute   # 실행

# 기존 파편 임베딩 백필 (임베딩 API 키 필요, 1회성)
npm run backfill:embeddings
```

## 환경 변수 설정

빠르게 시작하려면:

```bash
cp .env.example.minimal .env
```

운영형 예시를 사용하려면:

```bash
cp .env.example .env
# .env 파일에서 DATABASE_URL, MEMENTO_ACCESS_KEY 등 필수 값 입력
```

추가 환경 변수:

```
DEDUP_BATCH_SIZE              - 시맨틱 dedup 배치 크기 (기본: 100)
DEDUP_MIN_FRAGMENTS           - topic 내 최소 파편 수 (기본: 5)
COMPRESS_AGE_DAYS             - 압축 대상 비활성 일수 (기본: 30)
COMPRESS_MIN_GROUP            - 압축 그룹 최소 크기 (기본: 3)
CONSOLIDATE_INTERVAL_MS       - consolidate 주기 (기본: 3600000 = 1시간)
ALLOWED_ORIGINS               - CORS 허용 Origin 목록 (쉼표 구분)
RERANKER_MODEL                - in-process ONNX 모델 선택: minilm (기본, 영어 전용) 또는 bge-m3 (다국어, 비영어권 권장)
LLM_PRIMARY                   - 주 LLM provider (기본: gemini-cli). gemini-cli, codex, copilot, anthropic 등
LLM_FALLBACKS                 - JSON 배열. 각 원소: {"provider":"anthropic","apiKey":"...","model":"claude-opus-4-6"}
MEMENTO_REMEMBER_ATOMIC       - true로 설정 시 remember() quota 체크+INSERT를 단일 트랜잭션으로 원자화 (기본: false)
MEMENTO_CASE_BACKPROP_ENABLED - true로 설정 시 CaseRewardBackprop 활성화 — case_id 단위 reward 역전파 (기본: false)
MEMENTO_STORAGE               - 스토리지 어댑터 선택. pgvector (기본) 지원. 추가 어댑터는 lib/storage/ 참조
MIGRATION_LINT_FROM           - lint:migrations가 검사를 시작하는 마이그레이션 번호 하한. 미설정 시 현존 파일 최대값+1
```

환경 변수 전체 목록은 [Configuration — 환경 변수](configuration.md#환경-변수) 참조.

---

## 로컬 임베딩 모드 (OpenAI API 키 없는 환경)

OpenAI API 키 없이 `@huggingface/transformers` 기반 로컬 모델로 임베딩을 생성할 수 있다.

### .env 설정

```
EMBEDDING_PROVIDER=transformers
EMBEDDING_MODEL=Xenova/multilingual-e5-small
EMBEDDING_DIMENSIONS=384
# EMBEDDING_API_KEY 절대 설정하지 말 것 — 데이터 혼합 방지
```

- `Xenova/multilingual-e5-small`: 약 120MB, 384차원, 한국어/영어 모두 지원
- `Xenova/multilingual-e5-base`: 약 280MB, 768차원, 정확도 향상
- `EMBEDDING_PROVIDER=transformers`이면 `EMBEDDING_API_KEY`를 동시에 설정할 수 없다. 설정 시 서버 기동이 차단된다.

### 최초 실행 시 모델 다운로드

처음 서버를 시작하면 HuggingFace Hub에서 모델을 자동 다운로드한다. `Xenova/multilingual-e5-small` 기준 약 120MB이며 네트워크 환경에 따라 수 분이 소요된다. 완료 후 로컬에 캐시되어 재시작 시에는 즉시 로드된다.

```
[LocalEmbedder] loading model Xenova/multilingual-e5-small (dtype=q8)
```

### 캐시 경로 (HF_HOME)

기본 캐시 경로: `~/.cache/huggingface`

Docker 배포 시 모델을 볼륨에 마운트하여 재다운로드를 방지한다.

```yaml
# docker-compose.yml 예시
volumes:
  - hf_cache:/root/.cache/huggingface
environment:
  - HF_HOME=/root/.cache/huggingface
```

상세 설정은 [docs/embedding-local.md](embedding-local.md) 참조.

---

## 선택적 의존성

### gemini CLI (기본 LLM provider)

```bash
npm install -g @google/gemini-cli
gemini auth login
```

### Codex CLI (LLM fallback 시)

```bash
npm install -g @openai/codex
codex auth login
```

### Copilot CLI (LLM fallback 시)

```bash
npm install -g @githubnext/github-copilot-cli
github-copilot-cli auth
```

CLI provider를 사용하려면 `LLM_PRIMARY` 또는 `LLM_FALLBACKS`에 `"codex"` / `"copilot"` 값을 설정하면 된다.

---

## 기동 후 검증 체크리스트

서버 기동 후 아래 항목을 순서대로 확인한다.

```bash
# 1. 헬스 엔드포인트 200 확인
curl -s http://localhost:57332/health | jq .status

# 2. 임베딩 일관성 검사 결과 확인 (서버 로그)
# 정상: "consistency check result: PASS"
# 불일치: EMBEDDING_DIMENSIONS 재검토 후 migration-007 재실행

# 3. CLI 진단
node bin/memento.js health
```

`consistency check result: PASS` 로그가 출력되면 임베딩 차원과 DB 벡터가 일치하는 상태다. `FAIL`이 출력되면 `EMBEDDING_DIMENSIONS` 설정과 실제 DB 차원 불일치 — `scripts/post-migrate-flexible-embedding-dims.js`를 재실행한 뒤 서버를 재시작한다.

## CLI 사용법

```bash
# 환경변수 로드 후 사용
export $(grep -v '^#' .env | grep '=' | xargs)

node bin/memento.js stats     # 파편 통계
node bin/memento.js health    # 연결 진단
node bin/memento.js recall "검색어" --topic my-topic --limit 5
node bin/memento.js remember "기억할 내용" --topic my-topic --type fact
node bin/memento.js inspect frag-xxxx
```

## 서버 실행

```bash
node server.js
```

## Claude Code 연결

상세 설정은 [Claude Code Configuration](getting-started/claude-code.md)을 참고한다.

## 훅 기반 Context 자동 로드

memento-mcp는 `initialize` 응답의 `instructions` 필드에서 AI에게 기억 도구를 적극 사용하도록 권장하지만, 이것만으로는 세션 시작 시 과거 기억이 자동으로 주입되지 않는다. Claude Code 훅을 이용하면 AI가 매 세션마다 관련 기억을 능동적으로 불러오도록 강제할 수 있다.

**세션 시작 시 Core Memory 자동 로드** (`~/.claude/settings.json`):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "curl -s -X POST http://localhost:57332/mcp -H 'Authorization: Bearer YOUR_KEY' -H 'Content-Type: application/json' -H 'mcp-session-id: ${MCP_SESSION_ID}' -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"context\",\"arguments\":{}}}'"
          }
        ]
      }
    ]
  }
}
```

또는 `CLAUDE.md`에 아래 지시를 추가하면 AI가 세션 시작 시 스스로 `context` 도구를 호출한다:

```markdown
## 세션 시작 규칙
- 대화 시작 시 반드시 `context` 도구를 호출하여 Core Memory와 Working Memory를 로드한다.
- 에러 해결이나 코드 작업 전에는 `recall(keywords=[관련_키워드], type="error")`로 관련 기억을 먼저 확인한다.
```

`context`는 중요도 높은 파편을 캡슐화하여 반환하므로 컨텍스트 오염 없이 핵심 정보만 주입된다. `recall`은 현재 작업과 관련된 파편을 키워드/시맨틱 검색으로 추가 로드한다. 세션 시작 훅과 `CLAUDE.md` 지시를 병행하면 AI가 처음 만나는 사람처럼 행동하는 현상이 크게 줄어든다.

외부에서 접속할 때는 nginx 리버스 프록시를 통해 노출한다. 내부 IP나 내부 포트를 외부 문서에 직접 기재하지 않는다.
