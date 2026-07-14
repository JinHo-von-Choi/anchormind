<p align="center">
  <img src="assets/images/anchormind_logo.png" width="400" alt="AnchorMind Logo">
</p>

<p align="center">
  <a href="https://github.com/JinHo-von-Choi/memento-mcp/releases">
    <img src="https://img.shields.io/github/v/release/JinHo-von-Choi/memento-mcp?style=flat&label=release&color=4c8bf5" alt="GitHub Release" />
  </a>
  <a href="https://github.com/JinHo-von-Choi/memento-mcp/stargazers">
    <img src="https://img.shields.io/github/stars/JinHo-von-Choi/memento-mcp?style=flat&color=f5c542" alt="GitHub Stars" />
  </a>
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/license-Apache%202.0-blue?style=flat" alt="License" />
  </a>
  <a href="https://lobehub.com/mcp/jinho-von-choi-memento-mcp">
    <img src="https://lobehub.com/badge/mcp/jinho-von-choi-memento-mcp" alt="MCP Badge" />
  </a>
</p>

<p align="center">
  <a href="README.en.md">📖 English Documentation</a>
</p>

# AnchorMind

> AI에게 기억을 줍니다. 그리고 그 기억을 발판으로 성장하게 합니다.

매일 아침 기억이 리셋되는 신입직원을 상상해보라. 어제 가르친 것도, 지난주 함께 해결한 문제도, 취향도 전부 까먹는다. AnchorMind는 이 신입에게 기억을 심어준다.

AnchorMind는 MCP(Model Context Protocol) 기반 에이전트 장기 기억 서버다. 세션이 종료되어도 중요한 사실, 결정, 에러 패턴, 절차를 유지하고 다음 세션에서 복원한다.

> 이 프로젝트는 memento-mcp라는 이름으로 시작했다. 기억을 다루는 프로젝트에 잘 어울리는 이름이라고 지금도 생각하지만, 같거나 비슷한 이름의 프로젝트가 많아 AnchorMind로 바꿨다. 흘러가는 대화 속에서 남길 가치가 있는 기억을 닻처럼 붙들어 고정한다는 뜻이며, 세션이 끝나도 유실되지 않는 이 시스템의 앵커 파편(anchor fragment) 개념과도 맞닿아 있다.

단순한 기억의 도서관이 아니다. 피드백이 쌓이면 연결이 강해지고, 경험이 반복되면 패턴이 추상화되고, 세션이 이어지면 이야기가 생긴다. 기억하는 AI가 아니라 경험으로 성장하는 AI를 지향한다.

> [!TIP]
> 설치·설정을 직접 다루기 부담스럽다면 Claude Code·Cursor·Codex 같은 AI 어시스턴트에 다음 한 문장을 전달하면 된다.
>
> > "anchormind 저장소를 내 환경에 설치하고, `docs/INSTALL.md`와 `SKILL.md`를 읽어 권장 설정을 적용한 뒤 동작을 검증해 줘."
>
> 의존성 설치, `.env` 구성, MCP 등록, 헬스 체크까지 AI가 안내한다. 자세한 위임 절차는 [`docs/INSTALL.md`](docs/INSTALL.md#ai에게-맡기기) 참고.

## 30초 체험

AI에게 무언가를 기억시키고, 다음 세션에서 꺼내 보는 흐름이다:

```
[세션 1]
사용자: "우리 프로젝트는 PostgreSQL 15를 쓰고, 테스트는 Vitest로 돌려"
  → AI가 remember 호출 → 파편 2개 저장

[세션 2 — 다음 날]
  → AI가 context 호출 → "PostgreSQL 15 사용", "Vitest 테스트" 자동 복원
사용자: "테스트 어떻게 돌리더라?"
  → AI가 recall 호출 → "Vitest로 테스트 실행" 파편 반환
  → AI: "이 프로젝트는 Vitest를 사용합니다. npx vitest로 실행하세요."
```

매 세션마다 같은 설명을 반복할 필요가 없다.

## 설치

필수: Node.js 20+, PostgreSQL (pgvector 확장)

```bash
cp .env.example.minimal .env
# .env 값을 편집한 뒤 셸에 반영
export $(grep -v '^#' .env | grep '=' | xargs)
npm install
npm run migrate
node server.js
```

OpenAI API 없이 로컬 임베딩을 사용하려면 `.env`에 `EMBEDDING_PROVIDER=transformers`를 추가한다. 기동 시 `Xenova/multilingual-e5-small` 모델을 자동으로 다운로드한다. 단, OpenAI 임베딩으로 이미 저장된 데이터와 혼용하면 차원이 불일치하므로 새로 마이그레이션된 DB에서만 사용할 것.

서버가 뜬 뒤에는 [First Memory Flow](docs/getting-started/first-memory-flow.md)로 동작을 검증한다.

다른 플랫폼 설정은 위 [호환 플랫폼](#호환-플랫폼) 테이블 참조.

### 업데이트

```bash
cd ~/memento-mcp
git pull origin main
npm install
npm run migrate
# 서비스 재시작 (systemd / pm2 / docker 등 환경에 맞게)
```

- `npm run migrate`는 `.env`의 DB 설정을 자동으로 사용한다. `DATABASE_URL` 수동 지정 불필요.
- pgvector 스키마는 자동 감지된다. `PGVECTOR_SCHEMA` 설정은 대부분 불필요.

### Claude Code 연동

`claude mcp add` CLI로 등록한다 (HTTP 타입 MCP 서버는 `settings.json`에 수동 기재해도 인식되지 않는다).

```bash
claude mcp add memento http://localhost:57332/mcp \
  --transport http \
  --scope user \
  --header "Authorization: Bearer YOUR_ACCESS_KEY"
```

등록은 `~/.claude.json`에 저장된다. 확인:

```bash
claude mcp list
# memento: http://localhost:57332/mcp (HTTP) - ✓ Connected
```

프로젝트 단위로 공유하려면 저장소 루트의 `.mcp.json`에 기재한다. 상세 설정은 [Claude Code Configuration](docs/getting-started/claude-code.md) 참조.

### Codex Desktop 연동

Codex Desktop 등 일부 MCP 클라이언트는 deferred/lazy tool discovery를 쓴다. tool_search가 검색어와 limit에 따라 일부 도구만 노출하므로, 항상 존재하는 recall이 저장 편향 쿼리+낮은 limit에서 빠질 수 있다. recall이 안 보이면 더 넓은 쿼리와 limit 20 이상으로 재검색한다. 권장: 에이전트 system prompt/instructions에 이 재검색 규칙을 미리 심어 초기 discovery 루프를 차단한다.

- query: `memento context recall remember reflect batch_remember search_traces reconstruct_history`
- limit: 20 이상

### 지원 환경

| 환경 | 권장도 | 시작 문서 |
|------|--------|-----------|
| Linux / macOS | 권장 | [Quick Start](docs/getting-started/quickstart.md) |
| Windows + WSL2 | 가장 권장 | [Windows WSL2 Setup](docs/getting-started/windows-wsl2.md) |
| Windows + PowerShell | 제한 지원 | [Windows PowerShell Setup](docs/getting-started/windows-powershell.md) |

## 호환 플랫폼

AnchorMind는 MCP(Model Context Protocol) 표준 서버다. Claude Code뿐 아니라, MCP를 지원하는 모든 AI 플랫폼에서 사용할 수 있다.

| 플랫폼 | 설정 위치 | 연결 방식 |
|--------|----------|-----------|
| Claude Code | `claude mcp add` CLI (`~/.claude.json`) 또는 `.mcp.json` | Streamable HTTP |
| Claude Desktop | claude_desktop_config.json | Streamable HTTP |
| Claude.ai Web | Settings > Integrations | OAuth (RFC 7591) |
| Cursor | .cursor/mcp.json | Streamable HTTP |
| Windsurf | ~/.codeium/windsurf/mcp_config.json | Streamable HTTP |
| GitHub Copilot | VS Code MCP Marketplace | Streamable HTTP |
| Codex CLI | ~/.codex/config.toml | Streamable HTTP |
| ChatGPT Desktop | Developer Mode > Apps | OAuth (RFC 7591) |
| Continue | config.json | Streamable HTTP |

공통 설정: 서버 URL `http://localhost:57332/mcp`, Authorization 헤더에 `Bearer YOUR_ACCESS_KEY`.

Claude.ai Web / ChatGPT 연동은 OAuth를 사용한다. 발급한 API 키(`mmcp_xxx`)를 `client_id`로 입력하면 Dynamic Client Registration(RFC 7591) 없이 바로 연결된다. 신뢰 도메인(claude.ai, chatgpt.com)의 redirect URI는 자동 승인된다.

플랫폼별 상세 설정은 [연동 가이드](docs/getting-started/) 참조.

## 7가지 파편 유형

| 유형 | 설명 | 용도 |
|------|------|------|
| `fact` | 사실 | 설정값, 경로, 버전 등 객관적 정보 |
| `decision` | 의사결정 | 아키텍처 선택, 기술 스택 결정과 근거 |
| `error` | 에러 | 발생한 에러와 원인, 해결 방법 |
| `preference` | 선호 | 사용자 스타일, 코딩 규칙, 작업 방식 |
| `procedure` | 절차 | 배포, 빌드, 테스트 등 반복 가능한 단계 |
| `relation` | 관계 | 엔티티 간 연결, 의존성, 소유 관계 |
| `episode` | 에피소드 | 전후관계를 포함하는 서사 기억 (1000자, 나머지는 300자) |

## 핵심 기능

| 기능 | 설명 |
|------|------|
| `remember` | 중요한 정보를 원자적 파편으로 분해하여 저장. `MEMENTO_REMEMBER_ATOMIC=true` 시 quota check + INSERT를 단일 트랜잭션으로 원자화. |
| `recall` | 키워드 + 시맨틱 3계층 검색으로 필요한 기억만 반환. `SearchScope`가 workspace/caseId/affect 등 scope를 L1~L3 전 레이어에 정합 적용. |
| `context` | 세션 시작 시 핵심 맥락을 자동 복원 |
| 자동 정리 | 중복 병합, 모순 탐지, 중요도 감쇠, TTL 기반 망각 |
| storage 어댑터 계층 | `lib/storage/`에 스토리지 추상화 계층이 있다. `getStorage()` 팩토리가 `MEMENTO_STORAGE` ENV에 따라 `PgVectorStore`(기본) 또는 `SqliteVecStore`(스텁, 미구현)를 반환한다. |
| 링크 재통합 | `tool_feedback` 피드백이 fragment_links의 weight/confidence에 실시간 반영 (ReconsolidationEngine). 모순 링크는 자동 격리(quarantine). |
| 확산 활성화 | `recall` 시 `contextText`를 전달하면 관련 파편의 activation_score를 선제적으로 부스트하여 맥락 연관성 높은 결과 우선 반환 (SpreadingActivation). |
| 에피소드 연속성 | `reflect` 후 생성된 episode 파편 간 `preceded_by` 엣지를 자동 생성하여 경험 흐름을 그래프로 보존 (EpisodeContinuityService). |
| 관리 콘솔 | 기억 탐색, 지식 그래프, 통계 대시보드, API 키 그룹/상태 필터, daily-limit 인라인 편집 |
| OAuth 연동 | RFC 7591 Dynamic Client Registration, Claude.ai / ChatGPT Web 통합 지원 |
| Workspace 격리 | 같은 키 내에서도 프로젝트·직종·클라이언트 단위로 기억을 분리. `api_keys.default_workspace`로 자동 태깅, 검색 시 자동 필터. |
| 배치 처리 | `batch_remember`는 multi-row 단일 INSERT(256KB 또는 500행 chunk) + 비동기 큐 워커(BatchRememberWorker)로 임베딩·후처리를 논블로킹 실행. `async: true` 시 ack·재시도(최대 3회)·dead-letter·기동 복구(RPOPLPUSH reliable queue)로 at-least-once 처리 보장. `batch_status(jobId)` 도구로 처리 상태(queued/processing/completed/dead) 조회 가능. 항상 표준 단일 JSON-RPC 응답 반환(`stream` deprecated). `reflect`는 5카테고리를 단일 배치 호출로 위임. EmbeddingWorker는 큐 묶음을 generateBatchEmbeddings + multi-row UPDATE로 처리. |
| Consistency Gate | `fragments.morpheme_indexed` 컬럼으로 형태소 인덱스 완료 여부 추적. 미완료 파편은 L3 형태소 검색 경로에서 자동 제외. |
| Mode preset | `recall-only` / `write-only` / `onboarding` / `audit` JSON preset. `X-Memento-Mode` 헤더 또는 `api_keys.default_mode`로 도구 노출 범위 제한. |
| Affective tagging | `fragments.affect` 컬럼(neutral / frustration / confidence / surprise / doubt / satisfaction). remember / recall 시 감정 레이블로 필터링. |
| 로컬 임베딩 | `EMBEDDING_PROVIDER=transformers`로 외부 API 없이 `@huggingface/transformers` 파이프라인 기반 임베딩(`Xenova/multilingual-e5-small`, 384d 기본). |
| 마이그레이션 lint | `npm run lint:migrations`로 신규 마이그레이션 파일의 번호 충돌·규약 위반을 커밋 전 자동 검사. |

전체 MCP 도구 목록은 [SKILL.md](SKILL.md) 참조.

## CLI

원격 MCP 서버를 로컬 노드 없이 직접 조작할 수 있다. `--remote URL --key KEY` 전역 플래그 또는 `MEMENTO_CLI_REMOTE` / `MEMENTO_CLI_KEY` 환경변수로 지정한다.

```bash
# 원격 서버에서 recall (환경변수 방식)
MEMENTO_CLI_REMOTE=https://example.com/mcp MEMENTO_CLI_KEY=mmcp_xxx memento-mcp recall "query"

# 원격 서버에서 recall (플래그 방식)
memento-mcp recall "query" --remote https://example.com/mcp --key mmcp_xxx

# 표 형식 출력, 결과 5건
memento-mcp recall "query" --format table --limit 5

# idempotency key로 중복 저장 방지
memento-mcp remember "내용" --topic 프로젝트명 --idempotency-key k1
```

`--format table|json|csv` 출력 형식 선택, 14개 서브명령에 `--help`/`-h` 지원. 자세한 플래그는 [docs/cli.md](docs/cli.md).

## API 응답 메타

`recall` / `context` 응답은 `_meta: { searchEventId, hints, suggestion, serverTime }` 필드를 포함한다. `serverTime`은 LLM 클라이언트의 학습 시점 시간 고착을 방지하기 위해 매 응답마다 서버 현재 시각을 노출한다.

```json
{
  "fragments": [...],
  "_meta": {
    "searchEventId": "evt-abc123",
    "hints": { "signal": "consider_context" },
    "suggestion": { "code": "large_limit_no_budget", "message": "..." },
    "serverTime": {
      "iso"        : "2026-05-15T06:32:11.000Z",
      "epoch_ms"   : 1747291931000,
      "display_kst": "2026년 5월 15일 (목) 15:32",
      "timezone"   : "Asia/Seoul"
    }
  }
}
```

`remember` / `link` / `forget` / `amend`는 `dryRun: true` 파라미터로 부작용 없이 예상 결과만 반환한다. 모든 응답에 `X-RateLimit-Limit` / `X-RateLimit-Remaining` / `X-RateLimit-Resource` 헤더가 포함되며 master key 또는 limit=null 설정 시 헤더를 생략한다. `recall`은 `fields` 배열로 반환 필드를 17개 화이트리스트 범위로 제한할 수 있다. `remember` / `batchRemember`는 `idempotencyKey` 파라미터로 같은 key_id 범위 내 중복 저장을 방지한다(최대 128자). `remember` / `batchRemember` 항목 / `amend`의 `content`는 4000자를 초과하면 JSON-RPC -32602 에러로 거부된다. 위 파편 유형별 저장 절삭(1000자/300자)과는 별개로 그보다 앞단에서 적용되는 수신 게이트이며, `batchRemember`는 초과 항목만 실패 처리하고 나머지 배치는 그대로 진행한다.

## 보안

- RBAC default-deny: `TOOL_PERMISSIONS` 맵에 없는 도구명은 권한과 무관하게 즉시 거부.
- 테넌트 격리: forget / amend / link / fragment_history는 SQL 레벨 `key_id` 조건으로 타 테넌트 파편 접근 불가. "없음"과 "권한 없음"을 동일 메시지로 처리하여 존재 여부 노출 방지.
- injectSessionContext: 클라이언트가 전송한 `_keyId` / `_permissions` 등 내부 필드를 서버 인증 결과로 재주입하여 세션 컨텍스트 위조 차단.
- Admin rate limit: `/auth`, `/keys` POST, `/import` POST에 IP 기반 rate limit.
- OpenAPI: `GET /openapi.json` 엔드포인트(`ENABLE_OPENAPI=true`). master key는 전체 경로, API key는 permissions 필터 스펙 반환.

## Symbolic Verification Layer

선택적 설명 가능성, advisory 링크 무결성, 극성 충돌 탐지, 정책 규칙 soft gating. 9 core 모듈 + 5 규칙 파일. 모든 플래그 기본 비활성.

## Smart Recall

- ProactiveRecall: `remember()` 시 키워드 오버랩 기반 유사 파편 자동 링크.
- CaseRewardBackprop: case verification 이벤트 시 증거 파편 importance 자동 역전파.
- SearchParamAdaptor: 사용 패턴 기반 검색 임계값 자동 최적화.
- CBR(Case-Based Reasoning): `recall(caseMode=true)` 로 유사 사례의 goal → events → outcome 흐름을 검색하여 과거 해결 패턴 재활용.
- depth 필터: Planner/Executor 역할별 검색 깊이 제어(`"high-level"` / `"detail"` / `"tool-level"`).
- recall 응답 `key_id`: 반환 파편에 소유 테넌트 식별자 포함.
- Reconsolidation: `tool_feedback` 기반 `fragment_links` weight/confidence 실시간 갱신(`ENABLE_RECONSOLIDATION=true`).
- Spreading Activation: `recall(contextText=...)` 전달 시 대화 맥락 기반 관련 파편 ema_activation 선제 활성화(`ENABLE_SPREADING_ACTIVATION=true`).

`fragments.id`는 `frag-{16자 hex}` text 형식이다. UUID가 아니므로 외부에서 ID를 생성하거나 파싱할 때 주의한다.

`/metrics` 엔드포인트가 Prometheus 호환 형식으로 메트릭을 노출한다. 수집·시각화는 사용자가 자유롭게 구성한다.

## 기억 vs 규칙

AnchorMind가 주입하는 기억 파편은 시스템 프롬프트보다 우선순위가 낮다. "PostgreSQL 15를 쓴다"같은 사실 기억은 잘 작동하지만, "테스트 작성 시 반드시 Given-When-Then 패턴을 쓸 것"같은 행동 규칙은 시스템 프롬프트와 충돌하면 무시될 수 있다.

행동 규칙은 CLAUDE.md, AGENTS.md, 훅(hooks), 스킬(skills) 등 우선순위가 높은 채널에 설정하는 것을 권장한다.

## 벤치마크

[LongMemEval-S](https://arxiv.org/abs/2407.15460) 500문항 기준 성능:

| 지표 | 점수 | 비교 |
|------|------|------|
| 검색 recall@5 | 88.3% | LongMemEval 논문 Stella 1.5B 대비 +8~18pp |
| QA 정답률 | 45.4% | temporal metadata 적용 (baseline 40.4%) |
| 파편 처리량 | 89,006개 / 27초 | 인제스천 + 임베딩 + 검색 전체 파이프라인 |

검색은 6개 문항 유형 중 5개에서 80% 이상 recall을 달성한다. 다만 검색 recall(88.3%)과 QA 정답률(45.4%) 사이에 큰 gap이 존재한다. 이는 검색된 파편에서 정답을 합성하는 reader 단계의 한계로, multi-session 추론과 시간축 추론에서 특히 두드러진다.

상세 분석은 [Benchmark Report](docs/benchmark.md) 참조.

## 사용 패턴

AnchorMind는 사실 기억(fact cache)에 최적화되어 있다. 전후관계가 중요한 경우:

- `episode` 유형으로 서사를 저장하면 "왜 그런 결정을 했는지"까지 복원 가능
- `contextSummary`를 함께 저장하면 recall 시 맥락이 함께 반환됨
- 메인 메모리 시스템(MEMORY.md 등)과 병행하여 사실 검색은 AnchorMind, 맥락 복원은 메인 메모리로 역할 분담하는 이원화 구조도 효과적

## 누가 쓰면 좋은가

- Claude Code / Cursor / Windsurf 등 AI 에이전트를 매일 쓰는 개발자
- 세션마다 같은 설명을 반복하는 게 짜증나는 사람
- AI에게 내 프로젝트 맥락을 기억시키고 싶은 사람

## 디렉토리 구조

```
lib/
  memory/
    read/        # FragmentSearch, SearchScope, SearchSideEffects, CaseRecall 등
    write/       # MemoryRememberer, BatchRememberProcessor 등
    link/        # MemoryLinker, ReconsolidationEngine 등
    consolidate/ # MemoryConsolidator
    embedding/   # EmbeddingWorker, EmbeddingCache, MorphemeIndex
    signals/     # SpreadingActivation, CaseRewardBackprop 등
    processors/  # facade — MemoryRecaller, MemoryReflector 등
  storage/       # PgVectorStore(기본), SqliteVecStore(스텁, 미구현) 어댑터 계층
  llm/           # dispatchChain, provider 구현체
  symbolic/      # SymbolicVerificationLayer (opt-in)
docs/
  getting-started/   # 플랫폼별 설치 가이드
  operations/        # 운영 가이드 (llm-providers, symbolic-hard-gate 등)
  features.md        # 모듈 ledger
  configuration.md   # 환경변수 전체 레퍼런스
```

## 더 알아보기

| 문서 | 내용 |
|------|------|
| [Quick Start](docs/getting-started/quickstart.md) | 상세 설치 가이드 |
| [Architecture](docs/architecture.md) | 시스템 구조, DB 스키마, 3계층 검색, TTL |
| [Configuration](docs/configuration.md) | 환경 변수, MEMORY_CONFIG, 임베딩 Provider |
| [API Reference](docs/api-reference.md) | HTTP 엔드포인트, 프롬프트, 리소스 |
| [CLI](docs/cli.md) | 터미널 명령어 |
| [Internals](docs/internals.md) | 평가기, 통합기, 모순 탐지 |
| [Benchmark](docs/benchmark.md) | LongMemEval-S 벤치마크 상세 분석 |
| [Features](docs/features.md) | 모듈 ledger, 실험 플래그, ENV 매핑 |
| [SKILL.md](SKILL.md) | MCP 도구 전체 레퍼런스 |
| [INSTALL.md](docs/INSTALL.md) | 마이그레이션, 훅 설정, 상세 설치 |
| [CHANGELOG](CHANGELOG.md) | 버전별 변경사항 |

## 운영

- `/health`: DB, Redis, pgvector, 워커 상태를 종합 점검. 부분 장애 시 degraded 응답.
- Rate Limiting: API 키당 100/분, IP당 30/분. 환경변수로 조정 가능.
- 워커 복구: 임베딩/평가 워커가 에러 시 지수 백오프(1s→60s)로 자동 재시도.
- Graceful Shutdown: SIGTERM 시 진행 중 워커 완료 대기(30초) 후 세션 auto-reflect 실행.
- OAuth 엔드포인트: 인증 실패 시 `WWW-Authenticate` 헤더를 반환하여 OAuth 클라이언트가 자동으로 인증 흐름을 시작할 수 있다. 세션 TTL 기본값은 240분이다.
- 마이그레이션 lint: `npm run lint:migrations`로 번호 충돌 및 규약 위반을 커밋 전 검사.
- 운영 가이드: [docs/operations/](docs/operations/) — LLM provider 체인, symbolic hard gate, agent worktree, upstream porting 등.
- 외부 노출 점검: `docs/operations/maintenance.md`의 "외부 노출 점검" 절차로 listen 주소, 인증 키, Origin allowlist 상태를 확인.

## 알려진 제한사항

- L1 Redis 캐시는 API 키 기반 격리만 지원한다. multi-agent 환경에서 에이전트 간 격리는 L2/L3에서 적용된다.
- 자동 품질 평가는 decision, preference, relation 유형만 대상이다. fact, procedure, error는 평가 큐에서 제외된다.
- MEMENTO_ACCESS_KEY를 설정하지 않으면 인증이 비활성화된다. 외부 노출 환경에서는 반드시 설정할 것.
- ALLOWED_ORIGINS — 브라우저 기반 MCP 클라이언트 화이트리스트. 미설정 시 모든 Origin을 허용한다.
  외부 노출 환경에서는 `MCP_STRICT_ORIGIN=true`와 함께 실제 사용하는 브라우저 Origin만 등록할 것.
  데스크탑/CLI/IDE 확장(Claude Code, Cursor, Windsurf, Continue, Cline, Zed, gemini CLI 등)은
  Origin 헤더를 보내지 않으므로 화이트리스트 불필요.
  브라우저 후보: claude.ai, claude.com, chatgpt.com, chat.openai.com, copilot.microsoft.com,
  gemini.google.com, aistudio.google.com, www.perplexity.ai, cursor.com, codeium.com,
  windsurf.com, sourcegraph.com, typingmind.com (실제 호출하는 것만 선별).
- ADMIN_ALLOWED_ORIGINS — Admin UI 호출 origin 화이트리스트. 미설정 시 모든 Origin을 허용한다.
  외부 노출 환경에서는 관리 콘솔 Origin을 명시하거나 리버스 프록시/방화벽에서 접근을 제한할 것.
- TRUST_PROXY_HOPS — 신뢰 가능한 리버스 프록시 hop 수. 미설정 시 기존 동작 유지(XFF 첫 항목).
  직접 노출 시 0, 단일 프록시 뒤에서는 1.
- OAUTH_TRUSTED_ORIGINS — 동의 자동 승인 대상 origin 화이트리스트. 동일 origin에서 여러 앱을 호스팅하면
  OAUTH_ALLOWED_REDIRECT_URIS의 전체 URI 매칭 사용을 권장.

## 기술 스택

- Node.js 20+
- PostgreSQL 14+ (pgvector 확장)
- Redis 6+ (선택)
- OpenAI Embedding API (선택) 또는 `EMBEDDING_PROVIDER=transformers` (로컬 저비용 모드)
- garu-ko / natural PorterStemmer / @node-rs/jieba / kuromoji (로컬 형태소 분석, 언어별 CPU 라우팅; `MEMENTO_MORPHEME_TOKENIZER=local` 기본)
- Gemini CLI / Codex CLI / GitHub Copilot CLI (품질 평가, 자동 reflect; 선택, LLM_PRIMARY / LLM_FALLBACKS로 체인 구성)
- @huggingface/transformers + ONNX Runtime (NLI 모순 분류 + 로컬 임베딩, CPU 전용)
- MCP Protocol 2025-11-25

PostgreSQL만 있으면 핵심 기능이 동작한다. Redis를 추가하면 L1 캐스케이드 검색과 SessionActivityTracker가 활성화되고, OpenAI API 또는 `EMBEDDING_PROVIDER=transformers`를 추가하면 L3 시맨틱 검색과 자동 링크가 활성화된다.

## 만들게 된 계기

<details>
<summary>접기/펼치기</summary>

실무에서 AI를 쓰면서 매일 같은 맥락을 반복 설명하는 비효율을 느꼈다. 시스템 프롬프트에 메모를 넣는 방법도 써봤지만 한계가 명확했다. 파편 수가 늘어나면 관리가 안 되고, 검색이 안 되고, 오래된 정보와 새 정보가 충돌했다.

이미 설명한 것, 이미 세팅한 것을 무한히 반복하게 만드는 것이 가장 큰 문제였다. 인증 정보가 없다고 해서 보면 있고, 세팅 안 돼 있다고 해서 파일을 직접 열어보면 다 돼 있다. 철저하게 논파해서 말 잘 듣게 해 봐야 그때뿐이다. 세션을 다시 시작하면 같은 일이 또 반복된다. 명문대를 수석 졸업했지만 매일 뇌가 리셋되는 신입사원의 교육담당자가 된 기분이었다.

"야 너 미정이 기억나냐" -- 단서 없이는 아무것도 떠오르지 않지만, "초등학교 1학년 때 짝궁" 한마디면 지우개 빌려줬던 일까지 줄줄이 떠오른다. AI도 마찬가지다. 어제 해결한 버그, 지난주 내린 결정, 선호하는 코딩 스타일. 매 세션 리셋 대신, AnchorMind가 기억해둔다.

이 고충을 해소하기 위해 기억을 원자 단위로 분해하고, 계층적으로 검색하고, 시간에 따라 자연스럽게 망각하는 시스템을 설계했다. 인간이 망각의 동물인 것처럼, 이 시스템은 "적절한 망각"을 포함한 기억을 지향한다.

그리고 거기서 멈추지 않는다. 피드백이 누적될수록 연결이 강해지고 약한 링크는 사라진다. 같은 경험이 반복될수록 패턴이 추상화된다. 세션 간 에피소드가 이어질수록 맥락이 이야기가 된다. 도서관을 짓는 게 아니다. 경험으로 성장하는 AI를 만들고 싶었다.

---

기억은 지능의 전제가 아니다. 기억은 지능의 조건이다. 체스를 두는 방법을 알아도, 어제 진 게임을 기억하지 못하면 같은 수를 또 둔다. 모든 언어를 구사해도, 어제 나눈 대화를 기억하지 못하면 매번 처음 만나는 사람이 된다. 수십억 개의 파라미터로 세상 모든 지식을 담아도, 당신과 함께한 어제를 기억하지 못하면 낯선 박식가일 뿐이다.

기억이 있어야 관계가 있다. 관계가 있어야 신뢰가 있다.

기억은 사라지지 않는다. 다만 cold tier로 내려갈 뿐이다. 그리고 충분히 오래 방치된 cold 파편은 다음 consolidate 사이클에서 소멸한다. 이것은 설계이지 버그가 아니다. 쓸모없어진 기억은 자리를 비워야 한다. 아우구스티누스의 궁전에도 창고 정리는 필요하다.

멍청한 걸로 유명한 금붕어새기도 몇 달을 기억한다.

이제 당신의 AI도 그렇다.

</details>

## License

Apache 2.0

---

<p align="center">
  Made by <a href="mailto:jinho.von.choi@nerdvana.kr">Jinho Choi</a> &nbsp;|&nbsp;
  <a href="https://buymeacoffee.com/jinho.von.choi">Buy me a coffee</a>
</p>
