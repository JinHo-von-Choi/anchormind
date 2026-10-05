# 기능 상세

AnchorMind가 제공하는 기능, 응답 메타, 선택 모듈, 기술 스택의 상세 목록이다. 처음 쓰는 경우 [README](../README.md)의 흐름과 FAQ를 먼저 본다. 환경 변수는 [configuration.md](configuration.md), 모듈별 입출력은 [features.md](features.md)에 있다.

## 기능 목록

괄호 안의 이름은 켜고 끄는 환경 변수다. 값과 기본값은 [configuration.md](configuration.md)에 있다.

### 기억을 넣고 꺼낸다

- `remember`: 중요한 내용을 한두 문장짜리 파편으로 나눠 저장한다. `MEMENTO_REMEMBER_ATOMIC=true`이면 할당량 확인과 저장을 한 트랜잭션으로 묶는다.
- `batch_remember`: 여러 파편을 한 번에 저장한다. `async: true`로 부르면 서버가 뒤에서 처리하고 실패하면 최대 3회 다시 시도한다. 처리 상태는 `batch_status(jobId)`로 본다.
- `recall`: 키워드, 형태소, 의미 세 단계로 검색해 필요한 기억만 돌려준다. workspace, caseId, affect 같은 범위가 세 단계 모두에 똑같이 적용된다.
- `context`: 세션을 시작할 때 핵심 기억을 한 번에 복원한다. `agentId=X`로 부르면 X의 기억과 공유 기억을 함께, 생략하면 공유 기억만 돌려준다.
- `reflect`: 세션을 마칠 때 요약을 저장한다. 이어지는 세션의 에피소드끼리는 `preceded_by` 관계가 자동으로 걸려 경험의 흐름이 남는다.

### 검색이 정확해지게 한다

- 확산 활성화: `recall`에 `contextText`로 지금 하는 일을 알려 주면 관련 파편이 먼저 나온다 (`ENABLE_SPREADING_ACTIVATION`).
- 본문 어휘 검색: 본문 단어로도 찾는다. 임베딩이 꺼져 있어도 동작하지만 GIN 색인이 있어야 한다 (`MEMENTO_LEXICAL_CHANNEL`).
- 예산 안에서 고르기: 연결된 파편까지 후보로 점수를 매긴 뒤 `tokenBudget` 안에서 고른다 (`MEMENTO_RANK_BEFORE_BUDGET`).
- 답 꾸러미: `recall(format: "pack")`은 출처와 저장일이 붙은 인용용 블록을 돌려준다. `context`가 주입하는 줄에도 저장일과 확인 상태가 붙는다 (`MEMENTO_CONTEXT_ANNOTATE`).
- 로컬 임베딩: `EMBEDDING_PROVIDER=transformers`로 외부 API 없이 임베딩을 만든다. 기본 모델은 `Xenova/multilingual-e5-small`(384차원)이다.
- 정서 태그: 파편에 `affect`(neutral, frustration, confidence, surprise, doubt, satisfaction)를 붙이고 이 값으로 걸러 검색한다.
- 검색 제안: `recall` 응답의 `_meta.suggestion`이 비효율적인 질의를 알려 준다. 반복 질의, 맥락 없는 빈 결과, 예산 없는 큰 `limit`, 유형을 지정하지 않은 잡음 질의가 대상이며 무시해도 된다.

### 기억을 스스로 정리한다

- 자동 정리: 중복 병합, 모순 탐지, 중요도 감쇠, 오래된 기억의 TTL 만료가 주기적으로 돈다. 만료 정리는 한 주기에 100건 단위로 반복한다 (`MEMENTO_GC_THROUGHPUT`).
- 링크 재조정: `tool_feedback`이 쌓이면 파편 사이 연결의 가중치가 바뀌고, 서로 모순되는 연결은 자동으로 격리된다 (`ENABLE_RECONSOLIDATION`).
- 중복 판정: 같은 본문은 키와 workspace 안에서 하나로 본다. 이미 있으면 `remember` 응답의 `duplicate_of`에 기존 파편 id가 실린다 (`MEMENTO_DEDUP_SCOPE`).
- 연쇄 삭제: `forget`은 그 파편에서 만들어진 사례 요약과 모순 해소 기록의 본문 사본도 같은 트랜잭션에서 지운다 (`MEMENTO_FORGET_CASCADE`).
- 형태소 색인 확인: 형태소 색인이 끝나지 않은 파편은 형태소 검색에서 자동으로 빠진다.

### 누가 무엇을 볼 수 있는지 정한다

- workspace 격리: 같은 키 안에서도 프로젝트나 고객 단위로 기억을 나눈다. workspace를 지정하지 않으면 키의 `default_workspace`를, 그것도 없으면 전역 기억만 조회한다. 전체 조회(`allWorkspaces=true`)는 마스터 키만 할 수 있다.
- 모드 프리셋: `recall-only`, `write-only`, `onboarding`, `audit` 중 하나로 키가 쓸 수 있는 도구를 줄인다. `X-Memento-Mode` 헤더나 키의 `default_mode`로 지정한다.
- 앵커 권한과 읽기 허가: 앵커 지정은 `anchor` 권한과 키별 상한으로 제한하고 (`MEMENTO_ANCHOR_PERMISSION`), 읽기 대상 workspace는 키의 `allowed_workspaces`로 판정한다 (`MEMENTO_WORKSPACE_READ_AUTHZ`).
- 관리 권한과 관리자 계정: 관리 API는 라우트마다 필요한 능력을 정해 두고 역할(owner, admin, reviewer, auditor, viewer, service)로 판정한다. 관리자는 비밀번호와 TOTP로 로그인한다 (`MEMENTO_ADMIN_USERS`). `GET /me`가 자기 능력과 범위를 보여 준다.
- API 키 수명: 키마다 만료 시각, 허용 주소 대역, 소유자, 종류를 둘 수 있다. 겹치는 기간을 둔 교체, 폐기, 접근 검토 서명을 관리 API와 콘솔에서 한다.
- 출처와 신뢰 등급: `remember`의 `origin`과 키의 상한으로 파편의 `trust_tier`(0~3)가 정해진다. 1 이하는 ANCHOR와 CORE 주입에서 빠지고, `recall` 응답에 출처가 실린다 (`MEMENTO_PROVENANCE`).
- 검토 대기열: 에이전트의 지시를 덮어쓰려는 문구, 낮은 신뢰 등급의 앵커·preference·procedure, 권한 없는 앵커 요청은 거부하지 않고 검토 대기로 저장한다. 관리 API로 승인하거나 거절하고, 30일간 결정이 없으면 자동으로 거절된다 (`MEMENTO_REVIEW_QUEUE`).

### 저장을 안전하게 한다

- 쓰기 관문: `remember`, `amend`, `batch_remember`, reflect가 만드는 쓰기, 가져오기, CLI의 로컬 `remember`가 모두 같은 검사를 거친다. 검사는 정규화, 민감 정보 마스킹, 유형별 길이 상한, 정책 규칙, workspace 허가, 앵커 권한이다. 위반은 `validation_warnings`로 알리고, `symbolic_hard_gate=true`인 키에서만 거부한다 (`MEMENTO_WRITE_GATE`, `MEMENTO_SENSITIVE_SCAN`).
- 감사 해시 체인: 관리 변경, 관리 인증, 기억 쓰기, 앵커, 관문 거부, 검토 결정, 외부 전송을 해시로 이어 기록한다. 관리 API, 관리 콘솔, `anchormind audit verify`로 조회하고 검증한다 (`MEMENTO_AUDIT_DB`).
- LLM 외부 전송 정책: 키와 workspace별 `egress_policy`로 외부 LLM 제공자를 제한하고, 나가는 본문을 마스킹하고, 전송을 기록한다 (`MEMENTO_EGRESS_POLICY`).
- Redis 없이도 작업 기억: Redis가 준비되지 않으면 `remember(scope=session)`를 PostgreSQL 행으로 받고, 응답의 `working_memory`가 저장 경로를 알려 준다 (`MEMENTO_WM_PG_FALLBACK`).
- 트랜잭션 outbox: 변경과 같은 트랜잭션에서 이벤트를 기록하고 작업자가 topic별 처리기에 전달한다. 재시도, 실패 보관, 보존 정리를 포함한다 (`MEMENTO_OUTBOX`).

### 연동과 운영

- OAuth: Claude.ai Web, ChatGPT Web은 RFC 7591 동적 클라이언트 등록으로 연결한다. 같은 토큰으로 다시 연결하면 새 세션 대신 기존 세션을 이어 쓴다.
- 훅과 플러그인: `POST /hooks/{client}/{event}`와 `anchormind hook`이 Claude Code, Codex의 세션 시작 주입과 종료 회고를 건다. `anchormind init --target claude|codex`가 플러그인을 만든다 (`MEMENTO_HOOK_ENDPOINTS`). 설치는 [플러그인 설치](getting-started/plugins.md).
- 관리 콘솔: 기억 탐색, 지식 그래프, 통계, API 키 그룹과 상태 필터, 일일 한도 편집.
- 내보내기와 가져오기: 형식 버전 2 JSONL로 파편 전체 열, 링크, 수정 이력을 내보낸다. 가져오기는 대상 키를 정해 같은 쓰기 관문으로 기록한다. 호환 규칙은 [api-versioning.md](api-versioning.md).
- 마이그레이션 검사: `npm run lint:migrations`가 새 마이그레이션 파일의 번호 충돌과 규약 위반을 커밋 전에 잡는다.

전체 MCP 도구 목록은 [SKILL.md](../SKILL.md)에 있다.

## 사용 패턴

AnchorMind는 사실 기억(fact cache)에 맞다. 전후관계가 중요할 때는 아래 방식을 쓴다.

- `episode` 유형으로 서사를 저장하면 "왜 그런 결정을 했는지"까지 되살릴 수 있다.
- `contextSummary`를 함께 저장하면 recall 때 맥락도 같이 돌아온다.
- 메인 메모리 시스템(MEMORY.md 등)과 나눠 쓰는 방식도 괜찮다. 사실 검색은 AnchorMind가 맡고, 맥락 복원은 메인 메모리가 맡는 구조다.

## API 응답 메타

`recall` / `context` 응답에는 `_meta: { searchEventId, hints, suggestion, serverTime }` 필드가 들어간다. `serverTime`은 LLM 클라이언트가 학습 시점의 시간에 묶이지 않도록, 응답마다 서버의 현재 시각을 보여준다.

```json
{
  "fragments": [...],
  "_meta": {
    "searchEventId": 1234,
    "hints": [
      { "signal": "consider_context", "suggestion": "...", "trigger": "recall" }
    ],
    "suggestion": { "code": "empty_result_no_context", "message": "..." },
    "serverTime": {
      "iso"        : "2026-05-15T06:32:11.000Z",
      "epoch_ms"   : 1747291931000,
      "display_kst": "2026년 5월 15일 (목) 15:32",
      "timezone"   : "Asia/Seoul"
    }
  }
}
```

`remember` / `amend` / `forget`의 성공 응답에는 일정 확률로 `_meta.hints`에 `feedback_sampled` 신호가 실린다. 힌트의 `args`를 그대로 `tool_feedback`에 넘겨 결과를 평가하면 된다(`MEMENTO_FEEDBACK_SAMPLING=false`로 비활성화).

`remember` / `link` / `forget` / `amend`는 `dryRun: true` 파라미터를 받는다. 이 값을 쓰면 부작용 없이 예상 결과만 돌려준다. API 키 세션의 `POST /mcp` 응답에는 `X-RateLimit-Limit` / `X-RateLimit-Remaining` / `X-RateLimit-Resource: fragments` 헤더가 붙는다(파편 할당량 기준). master key이거나 할당량이 null이면 이 헤더는 생략된다. `recall`은 `fields` 배열로 반환 필드를 19개 화이트리스트 안에서 제한할 수 있다. `remember` / `batchRemember`는 `idempotencyKey` 파라미터로 같은 key_id 범위 안의 중복 저장을 막는다(최대 128자). `remember` / `batchRemember` 항목 / `amend`의 `content`가 4000자를 넘으면 JSON-RPC -32602 에러로 거부된다. 앞서 말한 파편 유형별 저장 절삭(1000자/300자)과는 별개로, 그보다 먼저 적용되는 수신 게이트다. `batchRemember`에서는 초과 항목만 실패하고 나머지 배치는 그대로 진행된다.

## Symbolic Verification Layer

선택적 설명 가능성, advisory 링크 무결성, 극성 충돌 탐지, 정책 규칙 soft gating을 다룬다. 구성은 8 core 모듈 + 2 규칙 파일이다. 모든 플래그의 기본값은 비활성이다.

## Smart Recall

- ProactiveRecall: `remember()` 시 키워드 오버랩을 기준으로 유사 파편을 자동 링크한다.
- CaseRewardBackprop: case verification 이벤트가 발생하면 증거 파편의 importance를 자동 역전파한다.
- SearchParamAdaptor: 사용 패턴에 맞춰 검색 임계값을 자동 조정한다.
- CBR(Case-Based Reasoning): `recall(caseMode=true)`로 유사 사례의 goal → events → outcome 흐름을 찾고, 과거 해결 패턴을 다시 쓴다.
- depth 필터: Planner/Executor 역할에 따라 검색 깊이를 조정한다(`"high-level"` / `"detail"` / `"tool-level"`).
- recall 응답 `key_id`: 반환 파편에 소유 테넌트 식별자를 포함한다.
- Reconsolidation: `tool_feedback`을 바탕으로 `fragment_links` weight/confidence를 실시간 갱신한다(`ENABLE_RECONSOLIDATION=true`).
- Spreading Activation: `recall(contextText=...)` 전달 시 대화 맥락에 맞는 파편의 ema_activation을 먼저 활성화한다(`ENABLE_SPREADING_ACTIVATION=true`).

`fragments.id`는 `frag-{16자 hex}` text 형식이다. UUID가 아니므로 외부에서 ID를 만들거나 파싱할 때 주의해야 한다.

## 기술 스택

- Node.js 22+
- PostgreSQL 14+ (pgvector 확장)
- Redis 6+ (선택)
- OpenAI Embedding API (선택) 또는 `EMBEDDING_PROVIDER=transformers` (로컬 저비용 모드)
- garu-ko / natural PorterStemmer / @node-rs/jieba / kuromoji (로컬 형태소 분석, 언어별 CPU 라우팅. 기본값은 `MEMENTO_MORPHEME_TOKENIZER=local`)
- LLM provider 18종(CLI: gemini-cli, agy-cli, codex-cli, copilot-cli, qwen-cli, opencode-cli / HTTP: openai, anthropic, gemini, groq, openrouter, xai, ollama, vllm, deepseek, mistral, cohere, zai). 품질 평가와 자동 reflect 등에 선택적으로 사용하며, LLM_PRIMARY / LLM_FALLBACKS로 체인을 구성한다. 기본값은 `gemini-cli`다.
- @huggingface/transformers + ONNX Runtime (NLI 모순 분류 + 로컬 임베딩, CPU 전용)
- MCP Protocol 2025-11-25

PostgreSQL만 있어도 저장, keywords 배열 일치 회상, 링크, 관리 기능은 동작한다. 자연어 `text` 질의 회상은 임베딩이 있어야 결과를 낸다. Redis를 붙이면 L1 캐스케이드 검색과 SessionActivityTracker가 켜진다. OpenAI API 또는 `EMBEDDING_PROVIDER=transformers`를 추가하면 L3 시맨틱 검색과 자동 링크도 사용할 수 있다.
