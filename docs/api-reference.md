# API Reference

작성자: 최진호
수정일: 2026-06-16

MCP 도구 상세는 [SKILL.md](../SKILL.md) 참조.

---

## HTTP 엔드포인트

| 메서드 | 경로 | 설명 |
|--------|------|------|
| POST | /mcp | Streamable HTTP. JSON-RPC 요청 수신. MCP-Session-Id 헤더 필요 (초기 initialize 제외) |
| GET | /mcp | Streamable HTTP. SSE 스트림 열기. 서버 측 푸시용 |
| DELETE | /mcp | Streamable HTTP. 세션 명시적 종료 |
| GET | /sse | Legacy SSE. 세션 생성. `accessKey` 쿼리 파라미터로 인증 |
| POST | /message?sessionId= | Legacy SSE. JSON-RPC 요청 수신. 응답은 SSE 스트림으로 전달 |
| GET | /health | 헬스 체크. DB 쿼리(SELECT 1), 세션 상태, Redis 연결을 확인하고 JSON으로 반환. `REDIS_ENABLED=false` 시 Redis는 `disabled`로 표시되며 200 반환. DB 장애 시 503 |
| GET | /metrics | Prometheus 메트릭. prom-client가 수집한 HTTP 요청 카운터, 세션 게이지 등 |
| GET | /openapi.json | OpenAPI 3.1.0 스펙. 인증 필수. master key는 Admin REST API 포함 전체 경로를 반환하며, API key는 해당 키의 `permissions` 배열에 맞게 도구 목록이 필터된 스펙을 반환. `ENABLE_OPENAPI=true` 환경변수로 활성화. 비활성 시 404 반환. |
| GET | /.well-known/oauth-authorization-server | OAuth 2.0 인가 서버 메타데이터 |
| GET | /.well-known/oauth-protected-resource | OAuth 2.0 보호 리소스 메타데이터 |
| GET | /authorize | OAuth 2.0 인가 엔드포인트. PKCE code_challenge 필요 |
| POST | /token | OAuth 2.0 토큰 엔드포인트. authorization_code 교환 |
| GET | /v1/internal/model/nothing | Admin SPA. app shell HTML 제공(인증 불필요). 데이터 API는 마스터 키 인증 필요 |
| GET | /v1/internal/model/nothing/assets/* | Admin 정적 파일 (admin.css, admin.js). 인증 불필요 |
| POST | /v1/internal/model/nothing/auth | 마스터 키 검증 엔드포인트 |
| GET | /v1/internal/model/nothing/stats | 대시보드 통계 (파편 수, API 호출량, 시스템 메트릭, searchMetrics, observability, queues, healthFlags) |
| GET | /v1/internal/model/nothing/activity | 최근 파편 활동 로그 (10건) |
| GET | /v1/internal/model/nothing/keys | API 키 목록 조회 |
| POST | /v1/internal/model/nothing/keys | API 키 생성. 원시 키는 응답에서 단 1회 반환 |
| PUT | /v1/internal/model/nothing/keys/:id | API 키 상태 변경 (active ↔ inactive) |
| PUT | /v1/internal/model/nothing/keys/:id/daily-limit | API 키 일일 호출 제한 변경. 마스터 키 인증 필요 |
| PATCH | /v1/internal/model/nothing/keys/:id/workspace | API 키의 default_workspace 변경. `{ workspace: "name" }` 또는 `{ workspace: null }` (null=해제) |
| DELETE | /v1/internal/model/nothing/keys/:id | API 키 삭제 |
| GET | /v1/internal/model/nothing/groups | 키 그룹 목록 |
| POST | /v1/internal/model/nothing/groups | 키 그룹 생성 |
| DELETE | /v1/internal/model/nothing/groups/:id | 키 그룹 삭제 |
| GET | /v1/internal/model/nothing/groups/:id/members | 그룹 멤버 목록 |
| POST | /v1/internal/model/nothing/groups/:id/members | 키를 그룹에 추가 |
| DELETE | /v1/internal/model/nothing/groups/:gid/members/:kid | 그룹에서 키 제거 |
| GET | /v1/internal/model/nothing/memory/overview | 메모리 전체 현황 (유형/토픽 분포, 품질 미검증, superseded, 최근 활동) |
| GET | /v1/internal/model/nothing/memory/search-events?days=N | 검색 이벤트 분석 (총 검색 수, 실패 쿼리, 피드백 통계) |
| GET | /v1/internal/model/nothing/memory/fragments | 파편 검색/필터링 (topic, type, key_id, workspace, page, limit) |
| GET | /v1/internal/model/nothing/memory/anomalies | 이상 탐지 결과 |
| GET | /v1/internal/model/nothing/sessions | 세션 목록 (활동 enrichment, 미반영 세션 수) |
| GET | /v1/internal/model/nothing/sessions/:id | 세션 상세 (검색 이벤트, 도구 피드백) |
| POST | /v1/internal/model/nothing/sessions/:id/reflect | 수동 reflect 실행 |
| DELETE | /v1/internal/model/nothing/sessions/:id | 세션 종료 |
| POST | /v1/internal/model/nothing/sessions/cleanup | 만료 세션 정리 |
| POST | /v1/internal/model/nothing/sessions/reflect-all | 미반영 세션 일괄 reflect |
| GET | /v1/internal/model/nothing/logs/files | 로그 파일 목록 (크기 포함) |
| GET | /v1/internal/model/nothing/logs/read | 로그 내용 조회 (file, tail, level, search 파라미터) |
| GET | /v1/internal/model/nothing/logs/stats | 로그 통계 (레벨별 카운트, 최근 에러, 디스크 사용량) |
| GET | /v1/internal/model/nothing/memory/graph?topic=&limit= | 지식 그래프 데이터 (nodes + edges) |
| GET | /v1/internal/model/nothing/export?key_id=&topic= | 파편 JSON Lines 스트림 내보내기 |
| POST | /v1/internal/model/nothing/import | 파편 JSON 배열 가져오기 |

### /health 엔드포인트 정책

| 의존성 | 분류 | down 시 응답 |
|--------|------|-------------|
| PostgreSQL | 필수 | 503 (degraded) |
| Redis | 선택 | 200 (healthy, warnings 포함) |

Redis가 비활성화(`REDIS_ENABLED=false`)되거나 연결 실패해도 서버는 healthy(200)를 반환합니다.
L1 캐시와 Working Memory가 비활성화되지만 핵심 기억 저장/검색은 PostgreSQL만으로 동작합니다.

인증 방식은 두 가지다. Streamable HTTP는 `initialize` 요청 시 `Authorization: Bearer <MEMENTO_ACCESS_KEY>` 헤더로 인증하며 이후 세션으로 유지된다. Legacy SSE는 `/sse?accessKey=<MEMENTO_ACCESS_KEY>` 쿼리 파라미터로 인증한다.

### HTTP 응답 헤더 — Rate Limit

할당량(fragment_limit)이 설정된 API 키로 MCP 도구를 호출할 때 아래 헤더가 응답에 포함된다.

| 헤더 | 설명 |
|------|------|
| `X-RateLimit-Limit` | 키에 설정된 파편 총 허용 수 |
| `X-RateLimit-Remaining` | 현재 남은 파편 수 |
| `X-RateLimit-Resource` | 측정 대상 리소스 식별자 (`fragments`) |

master key (keyId=null) 또는 limit=null인 키는 헤더를 생략한다. 사용량 캐시 TTL은 10초이다.

클라이언트 소비 예시 (curl):
```
HTTP/1.1 200 OK
X-RateLimit-Limit: 5000
X-RateLimit-Remaining: 4880
X-RateLimit-Resource: fragments
```

### RBAC (Role-Based Access Control)

모든 MCP 도구 호출은 RBAC 검증을 통과해야 한다.

- master key (`MEMENTO_ACCESS_KEY`): `permissions=null`로 처리되며 모든 도구를 호출할 수 있다.
- API key (`mmcp_xxx`): 키 생성 시 지정된 `permissions` 배열 기준으로 도구 접근이 제한된다. 배열에 필요한 권한이 없으면 즉시 거부된다.
- `TOOL_PERMISSIONS` 맵에 등록된 도구는 해당 권한 레벨이 요구된다. 맵에 등록되지 않은 도구명은 `required=null`로 간주되어 권한 검사를 통과한다. 도구를 RBAC 경계에 편입하려면 `TOOL_PERMISSIONS` 맵에 명시적으로 등록해야 한다.
- 권한 레벨은 세 가지다: `read`(recall/context/memory_stats 등), `write`(remember/forget/amend 등), `admin`(memory_consolidate/apply_update 등). `admin` 권한을 가진 키는 모든 레벨을 호출할 수 있다.
- 타 테넌트(다른 API 키)가 소유한 파편에 forget/amend/link 요청 시 `"Fragment not found"` 에러가 반환된다. SQL 레벨에서 `key_id` 조건으로 격리되므로 존재 여부조차 노출되지 않는다.

보호된 리소스에 인증 없이 접근하면 `401 Unauthorized`와 함께 `WWW-Authenticate: Bearer resource_metadata="</.well-known/oauth-protected-resource URL>"` 헤더가 반환된다.

### Mode Preset

`X-Memento-Mode` 헤더 또는 `initialize` 요청의 `params.mode`로 세션 동작 모드를 지정할 수 있다. admin console에서 `api_keys.default_mode`를 설정하면 키 단위 기본값을 고정할 수 있다.

| Preset | 설명 | 허용 도구 |
|--------|------|----------|
| `recall-only` | 읽기 전용 세션. 기억 저장·수정 도구 차단. 검색 전용 에이전트에 사용. | recall, context, memory_stats, graph_explore, fragment_history, reconstruct_history, search_traces, get_skill_guide, tool_feedback |
| `write-only` | 저장 전용 세션. recall, context 차단. 데이터 수집 파이프라인에 사용. | remember, batch_remember, forget, amend, link, reflect |
| `onboarding` | 사용자 안내 세션. get_skill_guide를 첫 도구로 강제 노출. | 전체 (get_skill_guide 우선 안내) |
| `audit` | 읽기·추적 전용 세션. 쓰기 도구 전체 차단. 감사·컴플라이언스 목적. | recall, context, memory_stats, graph_explore, fragment_history, reconstruct_history, search_traces |

HTTP 헤더로 설정:
```
X-Memento-Mode: recall-only
```

`initialize` 파라미터로 설정:
```json
{
  "method": "initialize",
  "params": {
    "mode": "recall-only",
    "protocolVersion": "2025-06-18"
  }
}
```

### 세션 재사용

토큰 기반 세션 재사용이 활성화되어 있다. 클라이언트가 `Mcp-Session-Id` 없이 재연결하더라도 동일 Bearer 토큰이면 서버가 기존 세션을 자동으로 복구한다. 클라이언트 측에는 투명하게 동작하며 별도 설정이 필요하지 않다.

### POST /session/rotate

세션 ID 탈취 의심 시 진행 중 상태를 유지한 채 세션 식별자만 재발급한다. Redis에 저장된 세션 데이터는 그대로 보존되고 ID만 교체되므로 기억 파편과 MCP 연결 상태에 영향 없다.

요청:

```http
POST /session/rotate HTTP/1.1
Authorization: Bearer <API key or master key>
Mcp-Session-Id: <대상 sessionId>
Origin: https://example.com
Content-Type: application/json

{ "reason": "suspected_leak" }
```

응답 (200):

```json
{
  "ok": true,
  "oldSessionId": "aabbcc11-...-8899ddee",
  "newSessionId": "ffeedd22-...-3344ccbb",
  "reason": "suspected_leak",
  "rotatedAt": "2026-04-21T12:34:56.789Z"
}
```

정책:

- 인증: `Authorization: Bearer` 필수. 대상 세션 소유권이 일치하지 않으면 403
- CSRF 방어: `Origin` 헤더 필수. 누락 또는 허용 목록 외 Origin이면 403
- Rate limit: IP당 분당 `MEMENTO_ROTATE_RATE_LIMIT_PER_MIN` 회 (기본 5). 초과 시 429
- `reason` 필드는 감사 로그용으로 최대 128자. 지정하지 않으면 `explicit_rotate`
- 메트릭: `mcp_session_rotation_total{reason}` 카운터 + `mcp_rotate_rate_limited_total` 카운터
- CLI: `memento-mcp session rotate <sessionId>` 서브명령으로 동일 기능 호출. 자세한 사용법은 `docs/cli.md` 참조

### tools/list 응답 — meta 필드

각 도구의 `tools/list` 응답 항목은 `meta` 필드를 포함한다.

```json
{
  "name": "recall",
  "description": "...",
  "inputSchema": { ... },
  "meta": {
    "capabilities": ["search", "pagination", "caseMode"],
    "riskLevel": "read",
    "requiresMaster": false,
    "beta": false,
    "idempotent": true
  }
}
```

| 필드 | 타입 | 설명 |
|------|------|------|
| `capabilities` | string[] | 도구가 지원하는 기능 태그 목록 |
| `riskLevel` | string | 도구의 위험 등급. `read` / `write` / `admin` |
| `requiresMaster` | boolean | master key(MEMENTO_ACCESS_KEY)만 호출 가능 여부 |
| `beta` | boolean | 실험적 기능 여부. true 시 인터페이스가 변경될 수 있음 |
| `idempotent` | boolean | 동일 파라미터로 반복 호출해도 부작용이 없는지 여부 |

---

## OAuth 2.0

RFC 7591 Dynamic Client Registration 및 PKCE 기반 Authorization Code Flow를 지원한다.

### /.well-known/oauth-authorization-server

서버 메타데이터 응답에 `registration_endpoint`가 포함된다.

```json
{
  "issuer": "https://{domain}",
  "authorization_endpoint": "https://{domain}/authorize",
  "token_endpoint": "https://{domain}/token",
  "registration_endpoint": "https://{domain}/register",
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code"],
  "code_challenge_methods_supported": ["S256"]
}
```

### POST /register

RFC 7591 동적 클라이언트 등록. 인증 불필요.

요청 본문:

```json
{
  "client_name": "Claude",
  "redirect_uris": ["https://claude.ai/api/mcp/auth_callback"]
}
```

응답 201:

```json
{
  "client_id": "mmcp_...",
  "client_name": "Claude",
  "redirect_uris": ["https://claude.ai/api/mcp/auth_callback"],
  "grant_types": ["authorization_code"],
  "token_endpoint_auth_method": "none"
}
```

> **API 키 바인딩**: `Authorization: Bearer <API 키>` 헤더를 함께 전송하면 `client_id = "<name>_<keyIdHex8>"` 형식의 URL-safe 이름으로 자동 등록된다. 이후 `/authorize`에서 해당 API 키의 tenant 격리 컨텍스트가 자동 복원된다. 헤더 없이 등록하면 랜덤 `client_id` 방식으로 fallback된다.

### GET /authorize

OAuth 2.0 인가 엔드포인트. PKCE `code_challenge` 및 `code_challenge_method=S256` 필수.

쿼리 파라미터: `response_type=code`, `client_id`, `redirect_uri`, `code_challenge`, `code_challenge_method`, `state`(선택).

사용자 동의 화면을 렌더링하며, 동의 후 `redirect_uri`로 `code`를 포함한 302 리다이렉트를 반환한다.

### POST /authorize

동의 화면에서 사용자가 허용 또는 거부를 선택할 때 폼 데이터로 제출된다.

| 필드 | 값 |
|------|----|
| `decision` | `allow` 또는 `deny` |
| `response_type` | 원본 OAuth 파라미터 |
| `client_id` | 원본 OAuth 파라미터 |
| `redirect_uri` | 원본 OAuth 파라미터 |
| `code_challenge` | 원본 OAuth 파라미터 |
| `code_challenge_method` | 원본 OAuth 파라미터 |
| `state` | 원본 OAuth 파라미터 (존재 시) |

- `decision=allow`: `redirect_uri?code=<code>&state=<state>` 로 302 리다이렉트
- `decision=deny`: `redirect_uri?error=access_denied` 로 302 리다이렉트

### PUT /v1/internal/model/nothing/keys/:id/daily-limit

API 키의 일일 호출 제한을 변경한다. 마스터 키 인증 필요.

요청 본문:

```json
{ "daily_limit": 50000 }
```

응답:

```json
{ "success": true, "daily_limit": 50000 }
```

---

## 프롬프트 (Prompts)

미리 정의된 가이드라인으로 AI가 기억 시스템을 효율적으로 사용하도록 돕는다.

| 이름 | 설명 | 주요 역할 |
|------|------|----------|
| `analyze-session` | 세션 활동 분석 | 현재 대화에서 저장할 가치가 있는 결정, 에러, 절차를 자동으로 추출하도록 유도 |
| `retrieve-relevant-memory` | 관련 기억 검색 가이드 | 특정 주제에 대해 키워드와 시맨틱 검색을 병행하여 최적의 컨텍스트를 찾도록 보조 |
| `onboarding` | 시스템 사용법 안내 | AI가 Memento MCP의 도구들을 언제 어떻게 써야 하는지 스스로 학습 |

---

## 리소스 (Resources)

기억 시스템의 현재 상태를 실시간으로 조회할 수 있는 MCP 리소스.

| URI | 설명 | 데이터 소스 |
|-----|------|------------|
| `memory://stats` | 시스템 통계 | `fragments` 테이블의 유형별, 계층별 카운트 및 유용성 점수 평균 |
| `memory://topics` | 주제 목록 | `fragments` 테이블의 모든 고유한 `topic` 레이블 목록 |
| `memory://config` | 시스템 설정 | `MEMORY_CONFIG`에 정의된 가중치 및 TTL 임계값 |
| `memory://active-session` | 세션 활동 로그 | `SessionActivityTracker`(Redis)에 기록된 현재 세션의 도구 사용 이력 |

---

## MCP 도구 — recall

### 파라미터

| 이름 | 타입 | 필수 | 설명 |
|------|------|------|------|
| keywords | string[] | - | 키워드 검색 (L1→L2) |
| text | string | - | 자연어 쿼리 (L3 시맨틱) |
| topic | string | - | 주제 필터 |
| type | string | - | 타입 필터 (fact, decision, error, preference, procedure, relation, episode) |
| tokenBudget | number | - | 최대 반환 토큰. 기본 1000. |
| includeLinks | boolean | - | 연결된 파편 포함 (1-hop, resolved_by/caused_by 우선). 기본 true. |
| linkRelationType | string | - | 연결 파편 관계 유형 필터 (related, caused_by, resolved_by, part_of, contradicts) |
| threshold | number | - | similarity 임계값 (0~1) |
| includeSuperseded | boolean | - | 만료(superseded) 파편 포함. 기본 false. |
| asOf | string | - | ISO 8601. 특정 시점 기준 유효 파편만. |
| excludeSeen | boolean | - | context()에서 이미 주입된 파편 제외. 기본 true. |
| includeKeywords | boolean | - | 각 파편의 keywords 배열을 응답에 포함 |
| includeContext | boolean | - | context_summary + 인접 파편 포함 |
| timeRange | object | - | {from, to} 시간 범위 필터 (ISO 8601 또는 자연어) |
| caseId | string | - | 케이스 ID 필터. 해당 케이스 파편만 반환. |
| resolutionStatus | string | - | 해결 상태 필터 (open / resolved / abandoned) |
| phase | string | - | 작업 단계 필터 (planning, debugging, verification 등) |
| caseMode | boolean | - | CBR 모드. 유사 파편을 case_id별로 그루핑하여 (goal, events, outcome) 트리플로 반환. 과거 유사 작업 해결 사례 참조 시 사용. |
| maxCases | number | - | caseMode에서 반환할 최대 케이스 수. 기본 5, 상한 10. |
| depth | string | - | 검색 깊이 필터. "high-level" / "detail" / "tool-level". 상세 설명은 아래 참조. |
| workspace | string | - | 검색 범위 제한. 지정 시 해당 workspace + 전역(NULL) 파편만 반환. |
| contextText | string | - | 현재 대화 맥락 텍스트. 관련 파편을 선제적으로 활성화 (ENABLE_SPREADING_ACTIVATION=true 시). |
| cursor | string | - | 페이지네이션 커서 |
| pageSize | number | - | 기본 20, 최대 50 |
| agentId | string | - | 에이전트 ID |
| minImportance | number | - | 최소 중요도 필터 (0~1). 이 값 이상의 importance를 가진 파편만 반환. |
| isAnchor | boolean | - | true 시 앵커(고정) 파편만 반환. 핵심 지식 조회에 유용. |
| affect | string \| string[] | - | 정서 태그 필터. 단일 문자열 또는 배열. 해당 affect 값을 가진 파편만 반환. 유효값: neutral, frustration, confidence, surprise, doubt, satisfaction |
| fields | string[] | - | 응답에 포함할 파편 필드 목록. 미지정 시 전체 필드 반환. 지원 키: id / content / type / topic / keywords / importance / created_at / access_count / confidence / linked / explanations / workspace / context_summary / case_id / valid_to / affect / ema_activation |

### 응답 파편 필드 (주요)

각 반환 파편에는 `key_id` 필드가 포함된다. master key 호출 시 타 API 키 소유 파편도 반환될 수 있으며, 이 경우 `key_id` 값으로 소유 키를 식별할 수 있다. API key 호출 시에는 자신이 소유한 파편(`key_id` 일치) 또는 그룹 공유 파편만 반환된다.

`affect` 필드: 해당 파편에 태그된 정서 상태. 저장 시 지정한 값과 동일하게 반환된다.

`_meta`: recall/context 응답 최상위의 메타데이터 래퍼.

- `searchEventId`: 검색 이벤트 식별자. 후속 `tool_feedback` 호출 시 FK로 사용.
- `hints`: 검색 결과 신호 배열(`no_results`, `stale_results`, `active_errors` 등).
- `suggestion`: 사용 패턴 기반 도구 제안.
- `serverTime`: 응답 생성 시점의 서버 시각. LLM 클라이언트의 학습 시점 시간 고착을 방지하기 위해 모든 recall/context 응답에 일관되게 포함된다. `iso`(UTC ISO 8601), `epoch_ms`(Unix ms), `display_kst`(Asia/Seoul 한국어 표기), `timezone` 4필드 구성.

```json
{
  "_meta": {
    "searchEventId": 1234,
    "hints": ["contextText 파라미터 추가로 SpreadingActivation 활성화 권장"],
    "suggestion": { "code": "empty_result_no_context", "recommendedTool": "recall" },
    "serverTime": {
      "iso"        : "2026-05-15T06:32:11.000Z",
      "epoch_ms"   : 1747291931000,
      "display_kst": "2026년 5월 15일 (목) 15:32",
      "timezone"   : "Asia/Seoul"
    }
  }
}
```

| 필드 | 설명 |
|------|------|
| `_meta.searchEventId` | tool_feedback 호출 시 `search_event_id` 파라미터로 전달할 FK 값. `commitSearchSideEffects`가 영속화한 검색 이벤트 ID. |
| `_meta.hints` | 시스템이 제안하는 검색 개선 힌트 배열 |
| `_meta.suggestion` | RecallSuggestionEngine 생성 힌트 객체 (감지된 문제 없으면 null) |

`_meta.suggestion`: RecallSuggestionEngine이 현재 검색 패턴을 분석하여 생성한 힌트 객체. 감지된 문제가 없으면 `null`이다.

```json
{
  "_suggestion": {
    "code": "empty_result_no_context",
    "message": "결과가 없습니다. contextText 파라미터로 현재 맥락을 전달하면 SpreadingActivation이 관련 파편을 선제 활성화합니다.",
    "recommendedTool": "recall",
    "recommendedArgs": { "contextText": "현재 작업 맥락 요약" }
  }
}
```

`_suggestion` 감지 규칙:

| code | 트리거 조건 | 권유 |
|------|------------|------|
| `repeat_query` | 동일 키워드/텍스트 쿼리를 30분 이내 3회 이상 반복 | depth 또는 type 필터 추가 |
| `empty_result_no_context` | 결과 0건이고 contextText가 없는 경우 | contextText 추가 또는 keywords 확장 |
| `large_limit_no_budget` | pageSize=50 요청이고 tokenBudget 미지정인 경우 | tokenBudget 명시로 응답 크기 제어 |
| `no_type_filter_noisy` | type 필터 없이 10건 이상 반환되었고 depth도 미지정인 경우 | type 또는 depth 필터 추가 |

`explanation` (`MEMENTO_SYMBOLIC_EXPLAIN=true` 시에만 포함): 해당 파편이 검색 결과에 포함된 이유를 최대 3개 reason code로 설명한다.

```json
{
  "fragment": {
    "id": "...",
    "explanations": [
      { "code": "direct_keyword_match",  "detail": "L2 형태소/키워드 매치",  "ruleVersion": "v1" },
      { "code": "graph_neighbor_1hop",   "detail": "그래프 이웃 1-hop",       "ruleVersion": "v1" }
    ]
  }
}
```

reason code 목록 (최대 3개):

- `direct_keyword_match` — L2 형태소/키워드 매칭으로 결과에 포함됨
- `semantic_similarity` — L3 pgvector 임베딩 유사도로 결과에 포함됨
- `graph_neighbor_1hop` — L2.5 그래프 이웃 1-hop으로 결과에 포함됨
- `temporal_proximity` — timeRange 필터 또는 ±24h 시간 인접성으로 결과에 포함됨
- `case_cohort_member` — caseMode 경로에서 동일 case_id 코호트로 결과에 포함됨
- `recent_activity_ema` — ema_activation 상위로 가점 부여되어 결과에 포함됨

### depth enum

| 값 | 대상 유형 | 용도 |
|----|----------|------|
| `"high-level"` | decision, episode만 | Planner용. 전략 수립·방향 결정 시. |
| `"detail"` | 전체 (기본값) | 일반 검색. 타입 제한 없음. |
| `"tool-level"` | procedure, error, fact만 | Executor용. 구체적 실행 단계·설정값 조회 시. |

### caseMode 응답 구조

`caseMode=true` 시 일반 fragments 외에 `cases` 배열이 추가로 반환된다.

```json
{
  "caseMode": true,
  "cases": [{
    "case_id": "abc-123",
    "goal": "nginx 502 해결",
    "outcome": "upstream 포트 불일치 수정",
    "resolution_status": "resolved",
    "events": [
      {"event_type": "error_observed", "summary": "502 Bad Gateway"},
      {"event_type": "fix_attempted", "summary": "nginx.conf 수정"},
      {"event_type": "verification_passed", "summary": "200 OK 확인"}
    ],
    "fragment_count": 5,
    "relevance_score": 3
  }],
  "caseCount": 1
}
```

#### event_type enum

| 값 | 설명 |
|----|------|
| `milestone_reached` | 주요 마일스톤 달성 |
| `hypothesis_proposed` | 가설 제안 |
| `hypothesis_rejected` | 가설 기각 |
| `decision_committed` | 의사결정 확정 |
| `error_observed` | 에러 관측 |
| `fix_attempted` | 수정 시도 |
| `verification_passed` | 검증 통과 |
| `verification_failed` | 검증 실패 |

---

## MCP 도구 — remember

파편 기반 기억 저장. 반드시 1~2문장 단위의 원자적 사실 하나만 저장한다. 내용이 많으면 여러 번 호출하여 각각 저장할 것.

### 파라미터

| 이름 | 타입 | 필수 | 설명 |
|------|------|------|------|
| content | string | O | 기억할 내용 (1~3문장, 300자 이내 권장). 입력 자체는 최대 4000자까지 허용되며 초과 시 `-32602` 오류로 거부된다 |
| topic | string | O | 주제 (예: database, email, deployment, security) |
| type | string | O | 파편 유형. fact, decision, error, preference, procedure, relation, episode. episode 외 타입은 300자 초과 시 절삭. |
| keywords | string[] | - | 검색용 키워드 (미입력 시 자동 추출) |
| importance | number | - | 중요도 0~1 (미입력 시 type별 기본값) |
| source | string | - | 출처 (세션 ID, 도구명 등) |
| linkedTo | string[] | - | 연결할 기존 파편 ID 목록 |
| scope | string | - | 저장 범위. permanent=장기 기억(기본), session=세션 워킹 메모리(세션 종료 시 소멸) |
| isAnchor | boolean | - | 중요 파편 고정 여부. true 시 중요도 감쇠(decay) 및 만료 삭제 대상에서 제외됨. |
| supersedes | string[] | - | 대체할 기존 파편 ID 목록. 지정된 파편은 valid_to가 설정되고 importance가 반감된다. |
| contextSummary | string | - | 이 기억이 생긴 맥락/배경 요약 (1-2문장). recall 시 함께 반환되어 전후관계를 복원한다. |
| sessionId | string | - | 현재 세션 ID. 같은 세션 파편을 시간 인접 번들로 묶는 데 사용. |
| workspace | string | - | 워크스페이스 이름. 미지정 시 키의 default_workspace 적용. |
| agentId | string | - | 에이전트 ID (RLS 격리용) |
| caseId | string | - | 이 파편이 속한 작업/케이스 식별자. 미설정 시 현재 session_id로 자동 설정. |
| goal | string | - | 에피소드 파편의 목표 (episode 타입 권장) |
| outcome | string | - | 에피소드 파편의 결과 |
| phase | string | - | 작업 단계 (예: planning, debugging, verification) |
| resolutionStatus | string | - | 작업 해결 상태 (open, resolved, abandoned) |
| assertionStatus | string | - | 파편의 신뢰도 수준 (observed, inferred, verified, rejected). 기본값: observed |
| affect | string | - | 기억 당시의 정서 상태 태그. 기본값: neutral. 유효값: neutral, frustration, confidence, surprise, doubt, satisfaction |
| idempotencyKey | string | - | 재시도 안전 식별자 (최대 128자). 같은 key_id 범위에서 동일 값으로 remember를 반복 호출하면 새 파편을 생성하지 않고 기존 파편 id를 반환한다. 클라이언트 재시도·네트워크 중복 방지 목적. |
| dryRun | boolean | - | true 설정 시 변경을 실제 적용하지 않고 실행 계획만 반환. 할당량·충돌 검사 결과를 파편 생성 없이 미리 확인할 수 있다. |

`affect` 사용 예:
```json
{
  "content": "Redis 연결 실패 원인이 REDIS_SENTINEL_ENABLED 미설정임을 확인했다.",
  "topic": "redis",
  "type": "error",
  "affect": "frustration"
}
```

### 응답

dryRun=true 응답 (실제 저장 없음):
```json
{
  "dryRun": true,
  "simulated": {
    "fragment": { "content": "...", "type": "fact", "topic": "..." },
    "conflicts": [],
    "validation_warnings": [],
    "quota": { "used": 120, "limit": 5000, "remaining": 4880 }
  }
}
```

violations 없는 경우 (정상 저장):
```json
{
  "success": true,
  "id": "frag-...",
  "keywords": ["..."],
  "ttl_tier": "warm",
  "scope": "permanent",
  "conflicts": []
}
```

violations 있는 경우 (soft gate — 저장됨):
```json
{
  "success": true,
  "id": "frag-...",
  "keywords": ["..."],
  "ttl_tier": "warm",
  "scope": "permanent",
  "conflicts": [],
  "validation_warnings": ["decisionHasRationale"]
}
```

`validation_warnings`: PolicyRules soft gating violations rule 이름 string[]. violations 없으면 필드 자체 생략. `MEMENTO_SYMBOLIC_POLICY_RULES=false` (기본값) 시 항상 생략. atomic 경로(`MEMENTO_REMEMBER_ATOMIC=true`)와 non-atomic 경로 모두 동일한 `_runPolicyGate` 호출 경로를 거치므로 포맷이 동일하다. 활성화 시 다음 5가지 predicate 중 실패한 것이 누적된다:

- `decisionHasRationale` — decision 타입이 linked_to 2건 이상 또는 근거 키워드 미포함
- `errorHasResolutionPath` — error 타입이 cause/fix 키워드 또는 resolution_status 미포함
- `procedureHasStepMarkers` — procedure 타입에 번호/단계 마커 부재
- `caseIdHasResolutionStatus` — case_id 보유 파편이 resolution_status 미설정
- `assertionNotContradictory` — 기존 assertion과 polarity 충돌

경고는 soft gate이므로 저장을 차단하지 않는다. `api_keys.symbolic_hard_gate=true` 설정 시 경고 발생 파편은 저장 거부된다. 이 경우 아래 에러 코드가 반환된다.

### 에러 코드

- `-32003` (SYMBOLIC_POLICY_VIOLATION): Symbolic hard gate가 활성화된 키에서 PolicyRules violations 발생. 저장이 거부됨. MCP 도구 에러(isError: true)가 아닌 JSON-RPC **프로토콜 레벨** 에러다.
- `-32602` (Invalid params): `content` 길이가 4000자를 초과. JSON-RPC 프로토콜 레벨 에러다.

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "error": {
    "code": -32003,
    "message": "policy_violation: decisionHasRationale",
    "data": {
      "violations": ["decisionHasRationale"],
      "fragmentType": "decision"
    }
  }
}
```

---

## MCP 도구 — batch_remember

여러 파편을 한번에 저장 (대량 기억 입력용). 단일 트랜잭션으로 최대 200건을 일괄 INSERT하여 HTTP 라운드트립을 최소화한다.

### 파라미터

| 이름 | 타입 | 필수 | 설명 |
|------|------|------|------|
| fragments | object[] | O | 저장할 파편 배열 (최대 200건). 각 항목은 content(string, 필수, 최대 4000자, 초과 시 해당 항목 `-32602` 거부), topic(string, 필수), type(string, 필수), importance(number), keywords(string[]), workspace(string), idempotencyKey(string, 최대 128자) 포함. |
| workspace | string | - | 배치 기본 워크스페이스. 개별 파편에 workspace 미지정 시 이 값으로 대체. 미지정 시 키의 default_workspace 적용. |
| agentId | string | - | 에이전트 ID (RLS 격리용) |
| stream | boolean | - | deprecated: 더 이상 SSE progress 이벤트를 보내지 않는다. batch_remember는 표준 단일 JSON 응답으로 반환된다. 이 파라미터는 하위 호환성을 위해 유지되지만 동작에 영향을 주지 않는다. |
| async | boolean | - | true 시 파이어앤포겟(비동기) 모드 (기본 false). 스키마 유효성·content_hash 중복·할당량 선검증만 동기 수행한 뒤 통과 파편을 Redis 큐에 적재하고 즉시 `{async: true, accepted: N, rejected: N, jobId: "..."}` 를 반환한다. 본 INSERT는 백그라운드 워커(BatchRememberWorker)가 처리한다. Redis 비활성(REDIS_ENABLED=false) 환경에서는 async=true여도 동기 모드로 폴백한다. |

### async=true 응답 예시

```json
{
  "async": true,
  "accepted": 5,
  "rejected": 1,
  "jobId": "batch-1750000000000-a1b2c3d4"
}
```

동기 모드(기본)에서는 `results[]` 배열이 반환된다. `jobId`는 `batch_status` 도구로 처리 상태를 조회할 수 있다. 비동기 워커는 ack·재시도(최대 3회)·dead-letter·기동 복구(RPOPLPUSH reliable queue)로 at-least-once 처리를 보장한다.

### 사전 validate 에러 코드

각 파편은 INSERT 전 아래 조건을 검사한다. 실패한 파편은 `results[i].success = false`로 기록되며 배열의 나머지 파편 저장에는 영향을 주지 않는다.

| 에러 메시지 | 원인 |
|-|-|
| `content is required` | `content` 필드가 null 또는 undefined |
| `content length N exceeds max 4000` | `content` 필드가 4000자 초과 |
| `type is required` | `type` 필드 누락 |
| `Content too short: length < 10 and word count < 3` | `FragmentFactory.validateContent` 판정 실패 — 내용이 너무 짧음 |
| `fragment_limit_exceeded` | API 키 파편 할당량 초과 |

---

## MCP 도구 — batch_status

`batch_remember(async: true)`가 반환한 `jobId`의 처리 상태를 조회한다. 읽기 전용. Redis 비활성 시 `status: null`을 반환한다.

### 파라미터

| 이름 | 타입 | 필수 | 설명 |
|------|------|------|------|
| jobId | string | O | `batch_remember(async: true)` 응답의 `jobId` |

### 응답

| 필드 | 타입 | 설명 |
|------|------|------|
| jobId | string | 조회한 jobId |
| state | string | `queued` \| `processing` \| `completed` \| `dead` |
| accepted | number | 큐에 적재된 파편 수 |
| processed | number | 처리 완료 파편 수 |
| failed | number | 처리 실패 파편 수 |

### 응답 예시

```json
{
  "jobId": "batch-1750000000000-a1b2c3d4",
  "state": "completed",
  "accepted": 5,
  "processed": 5,
  "failed": 0
}
```

---

## MCP 도구 — forget

파편 기억 삭제. id 또는 topic 중 하나는 필수. permanent 계층 파편은 force 옵션이 필요.

### 파라미터

| 이름 | 타입 | 필수 | 설명 |
|------|------|------|------|
| id | string | - | 삭제할 파편 ID |
| topic | string | - | 해당 주제의 파편 전체 삭제 |
| force | boolean | - | permanent 파편도 강제 삭제 (기본 false) |
| agentId | string | - | 에이전트 ID |
| dryRun | boolean | - | true 설정 시 실제 삭제 없이 삭제 대상 파편 정보와 연결 링크 수를 반환. |

---

## MCP 도구 — link

두 파편 사이에 관계를 설정한다. 인과, 해결, 구성, 모순 관계를 명시.

### 파라미터

| 이름 | 타입 | 필수 | 설명 |
|------|------|------|------|
| fromId | string | O | 시작 파편 ID |
| toId | string | O | 대상 파편 ID |
| relationType | string | - | 관계 유형 (related, caused_by, resolved_by, part_of, contradicts). 기본 related. |
| agentId | string | - | 에이전트 ID |
| weight | number | - | 관계 가중치 (0-1, 기본 1) |
| dryRun | boolean | - | true 설정 시 실제 링크 생성 없이 사이클 여부·소유권 검사 결과만 반환. |

---

## MCP 도구 — amend

기존 파편의 내용이나 메타데이터를 갱신한다. ID와 링크를 보존하면서 선택적으로 수정.

### 파라미터

| 이름 | 타입 | 필수 | 설명 |
|------|------|------|------|
| id | string | O | 갱신 대상 파편 ID |
| content | string | - | 새 내용 (300자 초과 시 절삭). 입력 자체는 최대 4000자까지 허용되며 초과 시 `-32602` 오류로 거부된다 |
| topic | string | - | 새 주제 |
| keywords | string[] | - | 새 키워드 목록 |
| type | string | - | 새 유형 (fact, decision, error, preference, procedure, relation) |
| importance | number | - | 새 중요도 (0~1) |
| isAnchor | boolean | - | 고정 파편 여부 설정 |
| supersedes | boolean | - | true 시 기존 파편을 명시적으로 대체 (superseded_by 링크 생성 및 중요도 하향) |
| assertionStatus | string | - | 파편의 확인 상태 변경 (observed, inferred, verified, rejected). case_id가 있는 파편은 변경 시 verification_passed/verification_failed 이벤트가 자동 기록된다. |
| agentId | string | - | 에이전트 ID |
| dryRun | boolean | - | true 설정 시 실제 변경 없이 패치 적용 후의 예상 파편 상태를 반환. |

---

## MCP 도구 — reflect

세션 종료 시 학습 내용을 원자 파편으로 영속화한다. 각 배열 항목이 독립 파편으로 저장되므로 항목 하나에 하나의 사실/결정/절차만 담을 것.

### 파라미터

| 이름 | 타입 | 필수 | 설명 |
|------|------|------|------|
| summary | string \| string[] | - | 세션 개요 파편 목록. 배열 권장. 항목 1개 = 사실 1건 (1~2문장). |
| sessionId | string | - | 세션 ID. 전달 시 같은 세션의 파편만 종합하여 reflect 수행. |
| decisions | string[] | - | 기술/아키텍처 결정 목록. 항목 1개 = 결정 1건. |
| errors_resolved | string[] | - | 해결된 에러 목록. '원인: X → 해결: Y' 형식 권장. |
| new_procedures | string[] | - | 확립된 절차/워크플로우 목록. 항목 1개 = 절차 1개. |
| open_questions | string[] | - | 미해결 질문 목록. 항목 1개 = 질문 1건. |
| narrative_summary | string | - | 세션 전체를 3~5문장의 서사(narrative)로 요약. episode 파편으로 저장되어 세션 간 맥락 연속성에 기여. 생략 시 summary에서 자동 생성. |
| agentId | string | - | 에이전트 ID |
| task_effectiveness | object | - | 세션 도구 사용 효과성 종합 평가. overall_success(boolean), tool_highlights(string[]), tool_pain_points(string[]) 포함. |

### 응답 구조

```json
{
  "count": 5,
  "fragments": [
    { "id": "frag-...", "content": "...", "type": "fact", "keywords": ["..."] }
  ],
  "breakdown": {
    "summary": 2,
    "decisions": 1,
    "errors": 0,
    "procedures": 1,
    "questions": 1,
    "episode": 1
  }
}
```

`breakdown` 필드는 카테고리별 저장된 파편 수를 나타낸다. `episode`는 narrative_summary가 있을 때만 포함된다. 내부적으로 5개 카테고리는 단일 `batchRememberProcessor` 호출로 처리되지만 결과는 `_category` 메타를 기반으로 카테고리별 재집계되므로 breakdown shape이 보존된다.

### AutoReflect 타임아웃

세션 종료 시 자동 실행되는 AutoReflect는 Gemini CLI 호출에 `GEMINI_TIMEOUT_MS` 환경변수로 설정된 타임아웃(기본값 30000ms)을 적용한다. 외부 게이트웨이(예: claude.ai MCP 프록시) 60s 컷오프 대비 30s 마진을 확보하기 위해 30s로 설정되어 있다. 40000ms 이상으로 변경하지 않는다.

| 환경변수 | 기본값 | 설명 |
|-|-|-|
| `GEMINI_TIMEOUT_MS` | 30000 | AutoReflect의 Gemini CLI 호출 타임아웃 (ms). `lib/memory/processors/AutoReflect.js` 상수 `GEMINI_TIMEOUT_MS`로 export됨 |

---

## MCP 도구 — context

Core Memory + Working Memory + session_reflect를 분리 로드한다. 세션 시작 시 preference, error, procedure, decision 파편을 주입하여 맥락 유지.

### 파라미터

| 이름 | 타입 | 필수 | 설명 |
|------|------|------|------|
| tokenBudget | number | - | 최대 토큰 수 (기본 2000) |
| types | string[] | - | 로드할 유형 목록 (기본: preference, error, procedure) |
| sessionId | string | - | 세션 ID (Working Memory 로드용) |
| agentId | string | - | 에이전트 ID |
| workspace | string | - | 워크스페이스 필터. 지정 시 해당 workspace 파편 + 전역(NULL) 파편만 반환. 미지정 시 키의 default_workspace 적용. |
| structured | boolean | - | true 시 계층적 트리 구조 반환, false/미지정 시 기존 flat list (기본값: false) |

---

## MCP 도구 — tool_feedback

도구 사용 결과에 대한 유용성 피드백. 대상 도구의 결과가 관련성 있었는지, 충분했는지를 평가한다.

### 파라미터

| 이름 | 타입 | 필수 | 설명 |
|------|------|------|------|
| tool_name | string | O | 평가 대상 도구명 |
| relevant | boolean | O | 결과가 요청 의도와 관련 있었는가 |
| sufficient | boolean | O | 결과가 작업 완료에 충분했는가 |
| suggestion | string | - | 개선 제안 (100자 이내) |
| context | string | - | 사용 맥락 요약 (50자 이내) |
| session_id | string | - | 세션 ID |
| trigger_type | string | - | 트리거 유형. sampled=훅 샘플링, voluntary=AI 자발적 (기본 voluntary) |
| search_event_id | integer | - | 직전 recall이 반환한 _meta.searchEventId. 검색 품질 분석에 사용. |
| fragment_ids | string[] | - | 피드백 대상 파편 ID 목록. 제공 시 해당 파편의 활성화 점수가 피드백에 따라 조정된다. |

---

## MCP 도구 — memory_stats

파편 기억 시스템 통계 조회. 전체 파편 수, TTL 분포, 유형별 통계를 반환한다.

### 파라미터

파라미터 없음.

---

## MCP 도구 — memory_consolidate

파편 기억 유지보수 실행. TTL 전환, 중요도 감쇠, 만료 삭제, 중복 병합을 수행한다.

### 파라미터

파라미터 없음.

---

## MCP 도구 — graph_explore

에러 파편 기점으로 인과 관계 체인을 추적한다. RCA(Root Cause Analysis) 전용. caused_by, resolved_by 관계를 1-hop 추적하여 에러 원인과 해결 절차를 연결한다.

### 파라미터

| 이름 | 타입 | 필수 | 설명 |
|------|------|------|------|
| startId | string | O | 시작 파편 ID (error 파편 권장) |
| agentId | string | - | 에이전트 ID |

---

## MCP 도구 — fragment_history

파편의 전체 변경 이력 조회. amend로 수정된 이전 버전과 superseded_by 체인을 반환한다.

### 파라미터

| 이름 | 타입 | 필수 | 설명 |
|------|------|------|------|
| id | string | O | 조회할 파편 ID |

---

## MCP 도구 — get_skill_guide

Memento MCP 최적 활용 가이드를 반환한다. 기억 도구 사용법, 세션 생명주기, 키워드 규칙, 검색 전략, 경험적 기억 활용법 등 포괄적 스킬 레퍼런스.

### 파라미터

| 이름 | 타입 | 필수 | 설명 |
|------|------|------|------|
| section | string | - | 특정 섹션만 조회. 미지정 시 전체 가이드 반환. 가능한 값: overview, lifecycle, keywords, search, episode, multiplatform, tools, importance, experiential, triggers, antipatterns |

---

## MCP 도구 — reconstruct_history

case_id 또는 entity 기반으로 작업 히스토리를 시간순으로 재구성한다. 인과 체인과 미해결 브랜치를 포함하여 서사를 복원한다.

### 파라미터

| 이름 | 타입 | 필수 | 설명 |
|------|------|------|------|
| caseId | string | - | 재구성할 케이스 식별자 |
| entity | string | - | entity_key 필터 (caseId 없을 때 사용) |
| timeRange | object | - | ISO 8601 시간 범위. from(시작 시각), to(종료 시각) 포함. |
| query | string | - | 추가 키워드 필터 |
| limit | number | - | 기본 100, 최대 500 |
| workspace | string | - | 워크스페이스 필터. 지정 시 해당 workspace + 전역(NULL) 파편만 대상. |

---

## MCP 도구 — search_traces

fragments를 정확 매칭으로 탐색한다 (recall의 시맨틱 검색과 달리 content/type/case_id 텍스트 매칭). event_type, entity, 키워드로 필터링하여 전체 히스토리를 grep하듯 조회.

### 파라미터

| 이름 | 타입 | 필수 | 설명 |
|------|------|------|------|
| event_type | string | - | 필터할 fragment type (fact, error, decision 등) |
| eventType | string | - | event_type의 camelCase alias |
| entity_key | string | - | topic ILIKE 필터 |
| entityKey | string | - | entity_key의 camelCase alias |
| keyword | string | - | content 내 키워드 검색 |
| case_id | string | - | 케이스 ID 필터 |
| caseId | string | - | case_id의 camelCase alias |
| session_id | string | - | 세션 ID 필터 |
| sessionId | string | - | session_id의 camelCase alias |
| time_range | object | - | 시간 범위 필터. from(시작 시각, ISO 8601), to(종료 시각, ISO 8601) 포함. |
| limit | number | - | 기본 20, 최대 100 |
| workspace | string | - | 워크스페이스 필터. 지정 시 해당 workspace + 전역(NULL) 파편만 대상. |

---

## 사용 예시

### fields 파라미터로 sparse 응답

id, content, importance만 반환받아 토큰 절감:

```bash
curl -X POST https://memento.example.com/mcp \
  -H "Authorization: Bearer $MEMENTO_KEY" \
  -H "Mcp-Session-Id: $SESSION" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc":"2.0","id":1,"method":"tools/call",
    "params":{
      "name":"recall",
      "arguments":{
        "keywords":["nginx","502"],
        "fields":["id","content","importance","type"]
      }
    }
  }'
```

MCP JSON-RPC 동등 호출:
```json
{ "method": "tools/call", "params": { "name": "recall", "arguments": { "keywords": ["nginx","502"], "fields": ["id","content","importance","type"] } } }
```

### idempotencyKey로 재시도 안전 저장

네트워크 오류 후 동일 요청 재전송 시 중복 생성 없음:

```bash
curl -X POST https://memento.example.com/mcp \
  -H "Authorization: Bearer $MEMENTO_KEY" \
  -H "Mcp-Session-Id: $SESSION" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc":"2.0","id":2,"method":"tools/call",
    "params":{
      "name":"remember",
      "arguments":{
        "content":"nginx upstream 포트를 8080에서 15001로 변경하여 502 해결",
        "topic":"nginx",
        "type":"procedure",
        "importance":0.8,
        "idempotencyKey":"nginx-fix-2026-04-20-001"
      }
    }
  }'
```

동일 `idempotencyKey`로 재호출 시 응답:
```json
{ "success": true, "id": "frag-abc123", "idempotent": true }
```

### dryRun으로 저장 전 계획 확인

```bash
curl -X POST https://memento.example.com/mcp \
  -H "Authorization: Bearer $MEMENTO_KEY" \
  -H "Mcp-Session-Id: $SESSION" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc":"2.0","id":3,"method":"tools/call",
    "params":{
      "name":"remember",
      "arguments":{
        "content":"Redis Sentinel 연결 실패 — REDIS_SENTINEL_ENABLED 미설정",
        "topic":"redis",
        "type":"error",
        "dryRun":true
      }
    }
  }'
```

응답:
```json
{
  "dryRun": true,
  "simulated": {
    "fragment": { "content": "Redis Sentinel 연결 실패 — REDIS_SENTINEL_ENABLED 미설정", "type": "error", "topic": "redis" },
    "conflicts": [],
    "validation_warnings": [],
    "quota": { "used": 120, "limit": 5000, "remaining": 4880 }
  }
}
```

### Rate Limit 헤더 소비 예시

```bash
# 응답 헤더 확인
curl -si -X POST https://memento.example.com/mcp \
  -H "Authorization: Bearer $API_KEY" \
  ... | grep X-RateLimit
# X-RateLimit-Limit: 5000
# X-RateLimit-Remaining: 4879
# X-RateLimit-Resource: fragments
```

---

## 권장 사용 흐름

1. 세션 시작 — `context()`로 핵심 기억을 로드한다. 선호, 에러 패턴, 절차가 복원된다. 미반영 세션이 있으면 힌트가 표시된다.
2. 작업 중 — 중요한 결정, 에러, 절차 발생 시 `remember()`로 저장한다. 저장 시 유사 파편과 자동으로 링크가 생성된다. 과거 경험이 필요하면 `recall()`로 검색한다. 에러 해결 후 `forget()`으로 에러 파편을 정리하고 `remember()`로 해결 절차를 기록한다.
3. 세션 종료 — `reflect()`로 세션 내용을 구조화된 파편으로 영속화한다. 수동 호출 없이도 세션 종료/만료 시 AutoReflect가 자동으로 실행된다.

---

## 주요 환경변수 — 도구 동작 영향

| 변수 | 기본값 | 영향 범위 |
|-|-|-|
| `MEMENTO_REMEMBER_ATOMIC` | `false` | `true` 시 remember 경로가 `_rememberAtomic`으로 전환. `SELECT api_keys FOR UPDATE` + 단일 BEGIN/COMMIT 트랜잭션으로 quota 재검증과 INSERT를 원자적으로 처리. `_runPolicyGate`는 양 경로 모두 동일하게 실행되므로 `validation_warnings` 포맷에 차이 없음. |
| `MEMENTO_CASE_BACKPROP_ENABLED` | `false` | `true` 시 case_id를 가진 파편의 amend(resolutionStatus 변경) 시점에 동일 caseId 파편들의 importance를 역전파 조정. `lib/config.js`의 `CASE_BACKPROP_ENABLED` 상수로 export. case 해결 완료 시 관련 파편의 활성화 점수가 상향되어 이후 recall 정밀도를 높인다. |
| `MEMENTO_STORAGE` | `pgvector` | 스토리지 어댑터 선택. `pgvector`(기본, 프로덕션용 PgVectorStore) 또는 `sqlite-vec`(SqliteVecStore). 어댑터 교체 시 `transaction(fn)` 인터페이스가 유지되므로 write 경로 동시성 시맨틱은 동일하게 보존됨. |
| `MEMENTO_SYMBOLIC_POLICY_RULES` | `false` | `true` 시 `_runPolicyGate`가 PolicyRules soft gate를 평가하여 위반 rule 이름을 `validation_warnings`에 누적. |

---

## 관련 문서

- [로컬 임베딩 설정](embedding-local.md) — `EMBEDDING_PROVIDER=transformers` 전환 절차 상세
- [통합/E2E 테스트](../tests/integration/README.md) — 테스트 환경 구성 및 실행 방법
- [아키텍처](architecture.md) — 컴포넌트 의존성 및 검색 파이프라인
- [설정 레퍼런스](configuration.md) — 전체 환경변수 목록 및 MEMORY_CONFIG
