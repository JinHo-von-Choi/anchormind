/**
 * 도구 스키마 정의: 에이전트 기억 관리 (Fragment-Based Memory)
 *
 * 작성자: 최진호
 * 작성일: 2026-02-23
 * 수정일: 2026-06-15
 *
 * 16개 MCP 도구의 inputSchema 정의.
 * 각 property에 JSON Schema 표준 examples 배열이 포함되어
 * openapi-generator / Swagger UI 자동 렌더링을 지원한다.
 *
 * 응답 헤더: 모든 엔드포인트는 X-RateLimit-Limit / X-RateLimit-Remaining /
 * X-RateLimit-Reset 헤더를 포함할 수 있다.
 */

import { MAX_CONTENT_INPUT_LENGTH } from "../memory/contentGuard.js";

/** 도구 간 완전 동일한 파라미터 스키마 공유 상수 */
const COMMON_PARAMS = {
  /** 6곳 공유: recall, forget, link, amend, context, graphExplore */
  agentId: {
    type       : "string",
    description: "에이전트 ID",
    examples   : ["agent-claude-code"]
  },
  /** 2곳 공유: remember, batchRemember */
  agentIdRls: {
    type       : "string",
    description: "에이전트 ID (RLS 격리용)",
    examples   : ["agent-claude-code"]
  }
};

export const rememberDefinition = {
  name        : "remember",
  title       : "Remember — 기억 저장",
  annotations : { readOnlyHint: false, idempotentHint: false },
  description : "자기완결적 사실 하나를 파편으로 저장. 저장된 content는 몇 달 뒤 전혀 다른 세션에서 " +
                 "이 한 줄만 봐도 외부 맥락 없이 이해 가능해야 한다. 이 기준을 충족 못하면 호출하지 말고 " +
                 "먼저 문장을 다시 써라.\n\n" +
                 "필수 품질 기준 (모두 충족):\n" +
                 "1) 대명사·지시어 해소 — '그것', '이 에러', '이전에', '위에서 말한' 금지. " +
                 "항상 구체 고유명으로 대체한다.\n" +
                 "2) 구체 엔티티·수치 포함 — '포트 바꿨다' 금지, '인증 서비스 포트를 8080에서 15000으로 변경' 허용.\n" +
                 "3) 메타·자기참조 금지 — '세션 요약', '도구 N회 사용', '이번 대화에서', '현재 작업 중' 같은 " +
                 "자기참조 문자열 저장 금지. 시스템 상태가 아니라 사실 자체만 남긴다.\n" +
                 "4) 원자성 — 독립 주제 두 개 이상이면 각각 별도 호출. 복합 주제는 분리 호출한다.\n" +
                 "5) 인과 결합 예외 — 분리하면 의미가 손상되는 원인-결과, 조건-결정은 한 파편에 유지한다.\n\n" +
                 "판단 테스트: 저장 전 스스로 물어라. '이 content를 6개월 후 처음 보는 다른 AI가 읽어도 " +
                 "무슨 프로젝트의 무슨 문제인지 특정할 수 있는가?' 아니라면 재작성한다.\n\n" +
                 "응답 필드 (v2.8.0+, 기본 비활성):\n" +
                 "- validation_warnings: MEMENTO_SYMBOLIC_POLICY_RULES=true 시 PolicyRules 위반 " +
                 "rule 이름 배열. 비어있지 않으면 파편 품질 개선 후 재호출 권장.\n" +
                 "- error -32003 SYMBOLIC_POLICY_VIOLATION: 해당 API 키가 symbolic_hard_gate=true로 " +
                 "설정된 경우 위반 시 저장 거부. error.data.violations 참조 후 내용 수정하여 재시도.\n\n" +
                 "응답 헤더: X-RateLimit-Limit / X-RateLimit-Remaining / X-RateLimit-Reset 포함 가능.",
  inputSchema: {
    type      : "object",
    properties: {
      content: {
        type       : "string",
        maxLength  : MAX_CONTENT_INPUT_LENGTH,
        description: "기억할 내용 (1~3문장, 300자 이내 권장).\n\n" +
                     "GOOD 예시:\n" +
                     "- '사용자 인증 API 응답 시간을 500ms에서 120ms로 개선 (ORM N+1 쿼리를 JOIN 단일 쿼리로 변경)'\n" +
                     "- '로그인 실패 원인: JWT 만료 검증의 timezone 불일치 → 서버·클라이언트 모두 UTC로 통일하여 해결'\n" +
                     "- '사용자 선호: 커밋 메시지에 이모지 사용 금지'\n" +
                     "- '주문 결제 플로우 아키텍처 결정: 동기 REST 대신 Kafka 이벤트 기반으로 전환 (재시도 보장 우선)'\n\n" +
                     "BAD 예시 (저장 전 재작성 필수):\n" +
                     "- '그게 느려서 개선함' — 주체·대상·수치 불명\n" +
                     "- '이전 에러 해결함' — 어떤 에러인지 특정 불가\n" +
                     "- '세션 자동 요약: 3회 도구 호출, 2개 파편 처리' — 메타·자기참조, 사실 없음\n" +
                     "- '프론트엔드 수정하고 API도 고침' — 독립 주제 2개, 분리 호출 필요\n" +
                     "- '이번 대화에서 사용자가 요청한 대로 처리' — 메타 언급, 사실 없음",
        examples   : [
          "memento-mcp v2.12.0 배포 완료 (2026-04-20). migration-031 적용, fragment_links.weight 컬럼 추가.",
          "사용자 인증 API 응답 시간을 500ms에서 120ms로 개선 (ORM N+1 쿼리를 JOIN 단일 쿼리로 변경)",
          "로그인 실패 원인: JWT 만료 검증의 timezone 불일치 → 서버·클라이언트 모두 UTC로 통일하여 해결",
          "사용자 선호: 커밋 메시지에 이모지 사용 금지"
        ]
      },
      topic: {
        type       : "string",
        description: "파편의 주제 식별자. recall 시 topic 필터로 활용되며, " +
                     "TemporalLinker가 같은 topic의 ±24h 파편에 자동 temporal 링크를 생성한다. " +
                     "프로젝트명 또는 도메인 단위로 지정 권장 (예: memento-mcp, authentication, deployment).",
        examples   : [
          "memento-mcp",
          "authentication",
          "deployment",
          "database",
          "email"
        ]
      },
      type: {
        type       : "string",
        enum       : ["fact", "decision", "error", "preference", "procedure", "relation", "episode"],
        description: "파편 유형. fact=사실, decision=의사결정, error=에러, " +
                             "preference=사용자 선호, procedure=절차, relation=관계, episode=에피소드(1000자). " +
                             "episode 외 타입은 300자 초과 시 절삭.",
        examples   : ["fact", "decision", "error", "preference", "procedure"]
      },
      keywords: {
        type       : "array",
        items      : { type: "string" },
        description: "검색용 키워드 (미입력 시 자동 추출). " +
                     "3~5개 지정 권장. 프로젝트명·호스트명·토픽을 포함하면 검색 정밀도가 높아진다. " +
                     "미지정 시 자동 추출 품질이 낮아 검색에서 누락될 수 있다.",
        examples   : [
          ["memento-mcp", "cli", "remote"],
          ["api", "ratelimit", "x-ratelimit"],
          ["authentication", "jwt", "my-host"]
        ]
      },
      importance: {
        type       : "number",
        minimum    : 0,
        maximum    : 1,
        description: "중요도 0~1 (미입력 시 type별 기본값). " +
                     "preference=0.9, error/procedure=0.8, decision=0.7, fact=0.6 권장. " +
                     "0.5 이하는 검색 시 낮은 우선순위로 처리되므로 핵심 정보는 반드시 0.6 이상 지정할 것.",
        examples   : [0.5, 0.7, 0.8, 0.95]
      },
      source: {
        type       : "string",
        description: "출처 (세션 ID, 도구명 등)",
        examples   : ["session-abc123", "claude-code", "cursor"]
      },
      linkedTo: {
        type       : "array",
        items      : { type: "string" },
        description: "연결할 기존 파편 ID 목록",
        examples   : [["frag-001", "frag-002"]]
      },
      scope: {
        type       : "string",
        enum       : ["permanent", "session"],
        description: "저장 범위. permanent=장기 기억(기본), session=세션 워킹 메모리(세션 종료 시 소멸)",
        examples   : ["permanent", "session"]
      },
      isAnchor: {
        type       : "boolean",
        description: "중요 파편 고정 여부. true 시 중요도 감쇠(decay) 및 만료 삭제 대상에서 제외됨.",
        examples   : [true, false]
      },
      supersedes: {
        type       : "array",
        items      : { type: "string" },
        description: "대체할 기존 파편 ID 목록. 지정된 파편은 valid_to가 설정되고 importance가 반감된다.",
        examples   : [["frag-old-001"]]
      },
      contextSummary: {
        type       : "string",
        description: "이 기억이 생긴 맥락/배경 요약 (1-2문장). recall 시 함께 반환되어 전후관계를 복원한다.",
        examples   : ["memento-mcp v2.11.0 배포 중 migration-030 적용 직후 발생한 오류 분석 맥락"]
      },
      sessionId: {
        type       : "string",
        description: "현재 세션 ID. 같은 세션 파편을 시간 인접 번들로 묶는 데 사용.",
        examples   : ["session-2026-04-20-001"]
      },
      workspace: {
        type       : "string",
        description: "워크스페이스 이름 (예: 'memento-mcp', 'personal', 'client-acme'). " +
                     "미지정 시 키의 default_workspace 적용. " +
                     "전역 기억(모든 워크스페이스에서 조회)으로 저장하려면 지정하지 않고 키에 default_workspace도 없어야 함.",
        examples   : ["memento-mcp", "personal", "client-acme"]
      },
      agentId: COMMON_PARAMS.agentIdRls,
      caseId: {
        type       : "string",
        description: "이 파편이 속한 작업/케이스 식별자. 미설정 시 현재 session_id로 자동 설정. " +
                     "권장 형식: {debug|feat|incident}-{주제}-{YYYY-MM-DD}. " +
                     "caseId를 지정하면 resolutionStatus(open|resolved|abandoned)도 함께 권장된다(미지정 시 caseIdHasResolutionStatus 경고).",
        examples   : ["debug-nginx-ssl-2026-04-20", "feat-cli-remote-2026-04-20"]
      },
      goal: {
        type       : "string",
        description: "에피소드 파편의 목표 (episode 타입 권장)",
        examples   : ["memento-mcp CLI remote 연결 기능 구현 완료"]
      },
      outcome: {
        type       : "string",
        description: "에피소드 파편의 결과",
        examples   : ["CLI --remote 플래그 + 인증 헤더 주입 구현 완료. 통합 테스트 12건 PASS."]
      },
      phase: {
        type       : "string",
        description: "작업 단계 (예: planning, debugging, verification)",
        examples   : ["planning", "debugging", "implementation", "verification"]
      },
      resolutionStatus: {
        type       : "string",
        enum       : ["open", "resolved", "abandoned"],
        description: "작업 해결 상태",
        examples   : ["open", "resolved", "abandoned"]
      },
      assertionStatus: {
        type       : "string",
        enum       : ["observed", "inferred", "verified", "rejected"],
        description: "파편의 신뢰도 수준. 기본값: observed. " +
                     "inferred=추론(검증 전), verified=검증 완료, rejected=폐기.",
        examples   : ["observed", "inferred", "verified", "rejected"]
      },
      affect: {
        type       : "string",
        enum       : ["neutral", "frustration", "confidence", "surprise", "doubt", "satisfaction"],
        description: "정서 태그 (migration-034-v2.16.0-bundle). " +
                     "frustration=반복 실패/좌절, confidence=검증 통과/확신, surprise=예상 외 결과, " +
                     "doubt=불확실, satisfaction=해결/만족. " +
                     "기본값 neutral. 허용되지 않는 값은 neutral로 강제된다.",
        examples   : ["neutral", "frustration", "confidence", "satisfaction"]
      },
      idempotencyKey: {
        type       : "string",
        maxLength  : 128,
        description: "재시도 안전 식별자. 같은 key_id 범위에서 같은 값으로 remember를 반복 호출하면 " +
                     "기존 파편 id를 반환하고 새 파편을 생성하지 않는다. " +
                     "클라이언트 재시도·네트워크 중복 방지 목적. " +
                     "권장 형식: {작업명}-{날짜}-{순번}",
        examples   : ["import-batch-2026-04-20-001", "session-reflect-2026-04-20-final"]
      },
      dryRun: {
        type       : "boolean",
        description: "true 설정 시 변경을 실제 적용하지 않고 실행 계획만 반환. " +
                     "파편 생성 없이 할당량·충돌 검사 결과를 미리 확인할 수 있다.",
        examples   : [true, false]
      }
    },
    required: ["content", "topic", "type"]
  }
};

export const batchRememberDefinition = {
  name        : "batch_remember",
  title       : "Batch Remember — 대량 기억 저장",
  annotations : { readOnlyHint: false, idempotentHint: false },
  description : "여러 파편을 한번에 저장 (대량 기억 입력용). " +
                 "단일 트랜잭션으로 최대 200건을 일괄 INSERT하여 HTTP 라운드트립을 최소화한다. " +
                 "개별 파편은 품질 게이트(validateContent)를 거치며, 부적합 파편은 건너뛴다. " +
                 "episode/link/supersedes 필드는 미지원 (개별 remember 사용). " +
                 "stream 파라미터는 deprecated: 더 이상 SSE progress를 보내지 않고 표준 단일 JSON 응답으로 반환된다.\n\n" +
                 "응답 헤더: X-RateLimit-Limit / X-RateLimit-Remaining / X-RateLimit-Reset 포함 가능.",
  inputSchema: {
    type      : "object",
    properties: {
      fragments: {
        type       : "array",
        items      : {
          type      : "object",
          properties: {
            content   : {
              type       : "string",
              maxLength  : MAX_CONTENT_INPUT_LENGTH,
              description: "기억할 내용 (1~3문장, 300자 이내 권장)",
              examples   : [
                "memento-mcp v2.12.0 배포 완료 (2026-04-20). migration-031 적용.",
                "사용자 인증 API 응답 시간 500ms → 120ms 개선 (N+1 쿼리 제거)"
              ]
            },
            topic     : {
              type       : "string",
              description: "주제",
              examples   : ["memento-mcp", "deployment", "authentication"]
            },
            type      : {
              type: "string",
              enum: ["fact", "decision", "error", "preference", "procedure", "relation", "episode"],
              description: "파편 유형. episode 외 300자, episode 1000자 초과 시 절삭.",
              examples   : ["fact", "decision", "error", "procedure"]
            },
            importance     : {
              type       : "number",
              minimum    : 0,
              maximum    : 1,
              description: "중요도 0~1",
              examples   : [0.6, 0.8, 0.95]
            },
            keywords       : {
              type       : "array",
              items      : { type: "string" },
              description: "검색용 키워드",
              examples   : [["memento-mcp", "cli"], ["api", "ratelimit"]]
            },
            workspace      : {
              type       : "string",
              description: "워크스페이스 이름 (미지정 시 키의 default_workspace 적용)",
              examples   : ["memento-mcp", "personal"]
            },
            idempotencyKey : {
              type       : "string",
              maxLength  : 128,
              description: "재시도 안전 식별자. 같은 key_id 범위에서 같은 값으로 반복 호출하면 기존 파편 id를 반환한다.",
              examples   : ["import-batch-2026-04-20-001", "import-batch-2026-04-20-002"]
            }
          },
          required: ["content", "topic", "type"]
        },
        description: "저장할 파편 배열 (최대 200건)"
      },
      workspace: {
        type       : "string",
        description: "배치 기본 워크스페이스. 개별 파편에 workspace 미지정 시 이 값으로 대체. " +
                     "미지정 시 키의 default_workspace 적용.",
        examples   : ["memento-mcp", "personal"]
      },
      agentId: COMMON_PARAMS.agentIdRls,
      stream: {
        type       : "boolean",
        description: "deprecated: 더 이상 SSE progress 이벤트를 보내지 않는다. " +
                     "batch_remember는 표준 단일 JSON 응답으로 반환된다. " +
                     "이 파라미터는 하위 호환성을 위해 유지되지만 동작에 영향을 주지 않는다.",
        examples   : [true, false]
      },
      async: {
        type       : "boolean",
        description: "true 시 파이어앤포겟(비동기) 모드. 스키마 유효성·content_hash 중복·할당량 선검증만 " +
                     "동기 수행한 뒤 통과 파편을 Redis 큐에 적재하고 즉시 { async:true, accepted, rejected, jobId } 를 " +
                     "반환한다. 본 INSERT는 백그라운드 워커가 처리한다. " +
                     "트레이드오프: 반환 시점은 적재 성공만 보장하며 INSERT 완료를 보장하지 않는다. " +
                     "워커가 ack·재시도(최대 3회)·dead-letter·기동 복구로 at-least-once 처리하며, " +
                     "jobId로 batch_status 도구를 통해 처리 상태(queued/processing/completed/dead)를 조회할 수 있다. " +
                     "Redis 비활성(REDIS_ENABLED=false) 환경에서는 async=true여도 동기 모드로 안전하게 폴백한다. " +
                     "기본값 false (기존 동기 동작 100% 유지).",
        examples   : [true, false]
      }
    },
    required: ["fragments"]
  }
};

export const recallDefinition = {
  name        : "recall",
  title       : "Recall — 저장 기억 회상(검색)",
  annotations : { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  description : "파편 기억 검색. 키워드, 주제, 유형, 자연어 쿼리로 관련 기억을 회상한다. remember/reflect로 저장한 기억을 불러오는 retrieval 짝이다. " +
                 "keywords, text, topic 중 하나 이상 전달 권장. " +
                 "tokenBudget으로 반환량을 제어하여 컨텍스트 오염을 방지. " +
                 "caseMode=true 시 CBR 모드: 유사 케이스를 (goal, events, outcome) 트리플로 반환. " +
                 "depth로 검색 깊이 제어: high-level(의사결정/에피소드), tool-level(절차/에러).\n\n" +
                 "응답 구조: { fragments: [...], _meta: { searchEventId, hints, suggestion } }. " +
                 "_meta.searchEventId는 tool_feedback 호출 시 search_event_id로 전달한다. " +
                 "_meta.hints는 검색 품질 개선 제안, _meta.suggestion은 후속 검색 쿼리 제안이다.\n\n" +
                 "응답 필드 (v2.8.0+, MEMENTO_SYMBOLIC_EXPLAIN=true 시): 각 파편에 " +
                 "explanations: [{code, detail, ruleVersion}] 배열이 포함되어 해당 파편이 검색된 " +
                 "이유를 최대 3개까지 설명한다 (direct_keyword_match, semantic_similarity, " +
                 "graph_neighbor_1hop, temporal_proximity, case_cohort_member, recent_activity_ema).\n\n" +
                 "응답 헤더: X-RateLimit-Limit / X-RateLimit-Remaining / X-RateLimit-Reset 포함 가능.",
  inputSchema: {
    type      : "object",
    properties: {
      keywords: {
        type       : "array",
        items      : { type: "string" },
        description: "검색 키워드. L3 전문 검색(MorphemeIndex)에서 우선 사용되며, " +
                     "SpreadingActivation이 활성화된 경우 그래프 이웃 확장에도 활용된다.",
        examples   : [
          ["cli", "remote", "authentication"],
          ["nginx", "ssl", "certificate"],
          ["memento-mcp", "migration"]
        ]
      },
      topic: {
        type       : "string",
        description: "주제 필터. remember 시 지정한 topic과 정확히 일치하는 파편만 반환.",
        examples   : ["memento-mcp", "authentication", "deployment"]
      },
      type: {
        type       : "string",
        enum       : ["fact", "decision", "error", "preference", "procedure", "relation", "episode"],
        description: "유형 필터. 단일 유형으로 제한하여 검색 정밀도를 높인다.",
        examples   : ["error", "decision", "procedure"]
      },
      text: {
        type       : "string",
        description: "자연어 검색 쿼리 (pgvector 시맨틱 검색 사용). " +
                     "임베딩 기반 L2 검색이 수행되므로 키워드 정확 일치 없이도 의미적으로 유사한 파편을 반환한다.",
        examples   : [
          "nginx SSL 인증서 갱신 절차",
          "API 응답 속도 개선 방법",
          "JWT 토큰 만료 처리"
        ]
      },
      tokenBudget: {
        type       : "number",
        description: "최대 반환 토큰 수 (기본 1000). 이 한도를 초과하면 낮은 중요도 파편부터 잘린다.",
        examples   : [500, 1000, 2000]
      },
      includeLinks: {
        type       : "boolean",
        description: "연결된 파편 포함 여부 (기본 true, 1-hop 제한, resolved_by/caused_by 우선)",
        examples   : [true, false]
      },
      linkRelationType: {
        type       : "string",
        enum       : ["related", "caused_by", "resolved_by", "part_of", "contradicts"],
        description: "연결 파편 관계 유형 필터 (미지정 시 caused_by, resolved_by, related 포함)",
        examples   : ["resolved_by", "caused_by", "related"]
      },
      threshold: {
        type       : "number",
        minimum    : 0,
        maximum    : 1,
        description: "similarity 임계값 (0~1). 이 값 미만의 파편은 결과에서 제외. similarity가 없는 L1/L2 결과는 필터링하지 않음 (기본 없음)",
        examples   : [0.3, 0.5, 0.7]
      },
      agentId: COMMON_PARAMS.agentId,
      includeSuperseded: {
        type       : "boolean",
        description: "true 시 superseded_by로 만료된 파편도 포함하여 검색. 기본 false.",
        examples   : [false, true]
      },
      includePeerAgents: {
        type       : "boolean",
        description: "true 시 같은 API 키/workspace 스코프 내 다른 agentId의 파편도 검색에 포함. 멀티에이전트 협업에서 상대 에이전트의 기억을 조회할 때 사용. 기본 false(현행 agent 격리 유지). 테넌트(키)·workspace 경계는 완화되지 않는다.",
        examples   : [false, true]
      },
      asOf: {
        type       : "string",
        description: "특정 시점 기억 조회 (ISO 8601, 예: '2026-01-15T00:00:00Z'). 미지정 시 현재 유효한 파편만 반환",
        examples   : ["2026-01-15T00:00:00Z", "2026-04-01T09:00:00+09:00"]
      },
      cursor: {
        type       : "string",
        description: "페이지네이션 커서 (이전 결과의 nextCursor 값)",
        examples   : ["eyJpZCI6MTIzfQ=="]
      },
      pageSize: {
        type       : "number",
        description: "페이지 크기 (기본 20, 최대 50)",
        examples   : [10, 20, 50]
      },
      excludeSeen: {
        type       : "boolean",
        description: "true(기본값) 시 이전 context() 호출에서 이미 주입된 파편을 결과에서 제외. " +
                       "false 시 모든 매칭 파편 반환.",
        examples   : [true, false]
      },
      includeKeywords: {
        type       : "boolean",
        description: "true 시 각 파편의 keywords 배열을 응답에 포함 (기본: false)",
        examples   : [true, false]
      },
      includeContext: {
        type       : "boolean",
        description: "true이면 context_summary와 시간 인접 파편을 함께 반환한다. 토큰을 더 사용하지만 전후관계 복원이 가능.",
        examples   : [true, false]
      },
      timeRange: {
        type       : "object",
        description: "시간 범위 필터 (created_at 기준). 자연어 한국어 표현도 지원.",
        properties : {
          from: {
            type       : "string",
            description: "시작 날짜. ISO 8601(예: 2026-03-15) 또는 자연어(예: '3일 전', '지난 주', '지난 화요일')",
            examples   : ["2026-03-15", "3일 전", "지난 주"]
          },
          to  : {
            type       : "string",
            description: "종료 날짜. ISO 8601(예: 2026-03-16) 또는 자연어(예: '오늘', '어제')",
            examples   : ["2026-03-16", "오늘", "어제"]
          }
        }
      },
      workspace: {
        type       : "string",
        description: "워크스페이스 필터. 지정 시 해당 workspace 파편 + 전역(NULL) 파편만 반환. " +
                     "미지정 시 키의 default_workspace 적용.",
        examples   : ["memento-mcp", "personal"]
      },
      contextText: {
        type       : "string",
        description: "현재 대화 맥락 텍스트. 관련 파편을 선제적으로 활성화한다 (Spreading Activation). " +
                     "1~2문장으로 현재 작업 요약을 제공하면 그래프 이웃 파편의 ema_activation이 boost된다.",
        examples   : [
          "memento-mcp CLI remote 연결 기능을 구현 중. --remote 플래그와 인증 헤더 처리가 핵심.",
          "nginx SSL 인증서 갱신 절차를 확인하는 중. 이전에 해결한 방법이 있는지 확인 필요."
        ]
      },
      caseId: {
        type       : "string",
        description: "특정 케이스/작업 ID로 필터링. remember 시 지정한 caseId와 일치하는 파편만 반환.",
        examples   : ["debug-nginx-ssl-2026-04-20", "feat-cli-remote-2026-04-20"]
      },
      resolutionStatus: {
        type       : "string",
        enum       : ["open", "resolved", "abandoned"],
        description: "해결 상태로 필터링.",
        examples   : ["open", "resolved"]
      },
      phase: {
        type       : "string",
        description: "작업 단계로 필터링 (예: planning, debugging, verification, completed).",
        examples   : ["debugging", "verification", "completed"]
      },
      minImportance: {
        type       : "number",
        minimum    : 0,
        maximum    : 1,
        description: "최소 중요도 필터. 이 값 이상의 importance를 가진 파편만 반환.",
        examples   : [0.6, 0.7, 0.8]
      },
      isAnchor: {
        type       : "boolean",
        description: "true 시 앵커(고정) 파편만 반환. 핵심 지식 조회에 유용.",
        examples   : [true, false]
      },
      caseMode: {
        type       : "boolean",
        description: "true 시 CBR(Case-Based Reasoning) 모드. " +
                     "유사 파편을 검색한 뒤 case_id별로 그루핑하여 " +
                     "(goal, events, outcome, resolution_status) 트리플로 반환. " +
                     "과거 유사 작업의 해결 사례를 참조할 때 사용.",
        examples   : [true, false]
      },
      maxCases: {
        type       : "number",
        description: "caseMode에서 반환할 최대 케이스 수 (기본 5, 상한 10)",
        examples   : [3, 5, 10]
      },
      depth: {
        type       : "string",
        enum       : ["high-level", "detail", "tool-level"],
        description: "검색 깊이 필터. " +
                     "high-level: 의사결정/에피소드만 (Planner용). " +
                     "detail: 전체 (기본값). " +
                     "tool-level: 절차/에러/사실만 (Executor용).",
        examples   : ["high-level", "detail", "tool-level"]
      },
      affect: {
        description: "정서 태그 필터 (migration-034-v2.16.0-bundle). 단일 문자열 또는 배열. " +
                     "예: 'frustration'(좌절 경험만), ['confidence','satisfaction'](검증·해결 파편만). " +
                     "미지정 시 affect 무관 검색.",
        oneOf      : [
          {
            type: "string",
            enum: ["neutral", "frustration", "confidence", "surprise", "doubt", "satisfaction"]
          },
          {
            type : "array",
            items: {
              type: "string",
              enum: ["neutral", "frustration", "confidence", "surprise", "doubt", "satisfaction"]
            }
          }
        ]
      },
      fields: {
        type       : "array",
        items      : { type: "string" },
        description: "응답에 포함할 파편 필드 목록 (sparse fields). 미지정 시 전체 필드 반환. " +
                     "지원 키: id/content/type/topic/keywords/importance/created_at/" +
                     "access_count/confidence/linked/explanations/workspace/" +
                     "context_summary/case_id/valid_to/affect/ema_activation",
        examples   : [
          ["id", "content"],
          ["id", "content", "keywords", "importance"],
          ["id", "content", "type", "topic", "importance", "created_at"]
        ]
      }
    }
  }
};

export const forgetDefinition = {
  name       : "forget",
  description: "파편 기억 삭제. id 또는 topic 중 하나는 필수. " +
                 "permanent 계층 파편은 force=true 옵션이 필요하다. " +
                 "에러를 완전히 해결한 직후 해당 error 파편을 삭제하여 다음 세션 context 오염을 방지한다. " +
                 "dryRun=true로 삭제 대상과 연결 링크 수를 먼저 확인하는 것을 권장한다.\n\n" +
                 "응답 헤더: X-RateLimit-Limit / X-RateLimit-Remaining / X-RateLimit-Reset 포함 가능.",
  inputSchema: {
    type      : "object",
    properties: {
      id: {
        type       : "string",
        description: "삭제할 파편 ID. recall 응답의 id 필드 값을 사용한다.",
        examples   : ["frag-abc123", "frag-def456"]
      },
      topic: {
        type       : "string",
        description: "해당 주제의 파편 전체 삭제. id 미지정 시 사용.",
        examples   : ["nginx-ssl-error", "memento-mcp"]
      },
      force: {
        type       : "boolean",
        description: "permanent 파편도 강제 삭제 (기본 false). isAnchor=true 파편 포함.",
        examples   : [false, true]
      },
      agentId: COMMON_PARAMS.agentId,
      dryRun: {
        type       : "boolean",
        description: "true 설정 시 실제 삭제 없이 삭제 대상 파편 정보와 연결 링크 수를 반환.",
        examples   : [true, false]
      }
    }
  }
};

export const linkDefinition = {
  name       : "link",
  description: "두 파편 사이에 관계를 설정한다. 인과, 해결, 구성, 모순 관계를 명시. " +
                 "그래프 이웃 검색(L2.5)에서 링크된 파편은 추가 부스트를 받는다. " +
                 "에러(fromId) → 해결책(toId) 패턴: relationType='resolved_by'. " +
                 "사이클 검사와 소유권 검사는 advisory lock으로 원자적으로 수행된다.\n\n" +
                 "응답 헤더: X-RateLimit-Limit / X-RateLimit-Remaining / X-RateLimit-Reset 포함 가능.",
  inputSchema: {
    type      : "object",
    properties: {
      fromId: {
        type       : "string",
        description: "시작 파편 ID (원인·에러 파편 권장)",
        examples   : ["frag-error-001", "frag-abc123"]
      },
      toId: {
        type       : "string",
        description: "대상 파편 ID (결과·해결책 파편 권장)",
        examples   : ["frag-procedure-001", "frag-def456"]
      },
      relationType: {
        type       : "string",
        enum       : ["related", "caused_by", "resolved_by", "part_of", "contradicts"],
        description: "관계 유형 (기본 related). " +
                     "resolved_by: 에러→해결책. caused_by: 원인→결과. " +
                     "part_of: 하위 파편→상위 에피소드. contradicts: 상충 파편 (자동 격리 트리거).",
        examples   : ["resolved_by", "caused_by", "related", "part_of", "contradicts"]
      },
      agentId: COMMON_PARAMS.agentId,
      weight: {
        type       : "number",
        description: "관계 가중치 (0-1, 기본 1). ReconsolidationEngine이 접근 패턴에 따라 자동 조정한다.",
        examples   : [0.5, 0.8, 1.0]
      },
      dryRun: {
        type       : "boolean",
        description: "true 설정 시 실제 링크 생성 없이 사이클 여부·소유권 검사 결과만 반환.",
        examples   : [true, false]
      }
    },
    required: ["fromId", "toId"]
  }
};

export const amendDefinition = {
  name       : "amend",
  description: "기존 파편의 내용이나 메타데이터를 갱신한다. ID와 링크를 보존하면서 " +
                 "content, topic, keywords, type, importance를 선택적으로 수정. " +
                 "assertionStatus='verified' 로 검증 완료를 기록하거나 " +
                 "assertionStatus='rejected' 로 가설을 폐기할 때 주로 사용한다. " +
                 "case_id가 있는 파편의 assertionStatus 변경은 verification_passed/failed 이벤트를 자동 기록한다.\n\n" +
                 "응답 헤더: X-RateLimit-Limit / X-RateLimit-Remaining / X-RateLimit-Reset 포함 가능.",
  inputSchema: {
    type      : "object",
    properties: {
      id: {
        type       : "string",
        description: "갱신 대상 파편 ID (필수). recall 응답의 id 필드 값을 사용한다.",
        examples   : ["frag-abc123", "frag-def456"]
      },
      content: {
        type       : "string",
        maxLength  : MAX_CONTENT_INPUT_LENGTH,
        description: "새 내용 (300자 초과 시 절삭). remember의 자기완결성 기준 동일 적용.",
        examples   : [
          "memento-mcp SearchParamAdaptor: key_id integer → text 변경 완료 (migration-030). UUID keyId 정규화 포함.",
          "인증 서비스 포트 8080에서 15000으로 변경 완료 (보안 정책: well-known 포트 사용 금지)"
        ]
      },
      topic: {
        type       : "string",
        description: "새 주제",
        examples   : ["memento-mcp", "authentication"]
      },
      keywords: {
        type       : "array",
        items      : { type: "string" },
        description: "새 키워드 목록",
        examples   : [["memento-mcp", "migration", "key_id"], ["authentication", "port", "security"]]
      },
      type: {
        type       : "string",
        enum       : ["fact", "decision", "error", "preference", "procedure", "relation"],
        description: "새 유형",
        examples   : ["fact", "procedure", "decision"]
      },
      importance: {
        type       : "number",
        minimum    : 0,
        maximum    : 1,
        description: "새 중요도",
        examples   : [0.6, 0.8, 0.95]
      },
      isAnchor: {
        type       : "boolean",
        description: "고정 파편 여부 설정",
        examples   : [true, false]
      },
      supersedes: {
        type       : "boolean",
        description: "true 시 기존 파편을 명시적으로 대체(superseded_by 링크 생성 및 중요도 하향)",
        examples   : [true, false]
      },
      assertionStatus: {
        type       : "string",
        enum       : ["observed", "inferred", "verified", "rejected"],
        description: "파편의 확인 상태 변경. verified: 검증 완료, rejected: 폐기. " +
                       "case_id가 있는 파편은 변경 시 verification_passed/verification_failed 이벤트가 자동 기록된다.",
        examples   : ["verified", "rejected", "inferred"]
      },
      agentId: COMMON_PARAMS.agentId,
      dryRun: {
        type       : "boolean",
        description: "true 설정 시 실제 변경 없이 패치 적용 후의 예상 파편 상태를 반환.",
        examples   : [true, false]
      }
    },
    required: ["id"]
  }
};

export const reflectDefinition = {
  name        : "reflect",
  title       : "Reflect — 세션 학습 영속화",
  annotations : { readOnlyHint: false, idempotentHint: false },
  description : "세션 종료 시 학습 내용을 원자 파편으로 영속화한다. " +
                 "각 배열 항목은 독립 파편이 되며, 모두 remember와 동일한 자기완결성 기준을 따른다: " +
                 "대명사 해소, 구체 엔티티명 포함, 메타 언급 금지. " +
                 "세션 ID, 도구 호출 횟수, '이번 대화에서', '이번 세션은' 같은 자기참조적 메타 요약은 " +
                 "절대 저장하지 말 것. 사실·결정·에러·절차만 남긴다. " +
                 "각 배열 항목 하나만 읽고도 어느 프로젝트의 무슨 내용인지 특정 가능해야 한다. " +
                 "항목 하나에 하나의 사실/결정/절차만 담고, 여러 내용을 한 항목에 나열하면 시맨틱 검색 정밀도가 저하된다. " +
                 "sessionId 전달 시 해당 세션의 기존 파편만 종합하여 사용(미입력 항목 자동 채움). " +
                 "summary 또는 sessionId 중 하나 이상 필요. " +
                 "sessionId 전달 시 이전 세션 episode와 preceded_by 엣지가 자동 생성되어 경험 흐름 그래프가 보존된다.\n\n" +
                 "응답 헤더: X-RateLimit-Limit / X-RateLimit-Remaining / X-RateLimit-Reset 포함 가능.",
  inputSchema: {
    type      : "object",
    properties: {
      summary: {
        oneOf: [
          { type: "string" },
          { type: "array", items: { type: "string" } }
        ],
        description: "세션 개요 파편 목록. 배열 권장. 항목 1개 = 사실 1건 (1~2문장). " +
                       "각 항목은 자기완결적이어야 한다: 대명사 해소, 구체 엔티티명 포함, 메타·자기참조 금지. " +
                       "'이번 세션', '1시간 동안', '도구 N회 호출' 같은 문자열 저장 절대 금지. " +
                       "문자열로 전달 시 내부에서 문장 단위로 분리하지만, 직접 배열로 쪼개면 더 정확하다. " +
                       "구체적 결정·에러·절차는 아래 배열에 별도 저장할 것. summary에 몰아넣지 말 것."
      },
      sessionId: {
        type       : "string",
        description: "세션 ID. 전달 시 같은 세션의 파편만 종합하여 reflect 수행"
      },
      decisions: {
        type       : "array",
        items      : { type: "string" },
        description: "기술/아키텍처 결정 목록. 항목 1개 = 결정 1건. " +
                       "자기완결성 기준 준수: 대명사 해소, 구체 엔티티명, 메타 언급 금지. " +
                       "내용이 길어지면 축약하지 말고 항목을 늘릴 것. " +
                       "예: ['세션 저장소를 인메모리 캐시에서 Redis로 교체 (멀티 인스턴스 지원 확보)', " +
                       "'주문 API 응답 캐시 TTL을 600초로 설정 (데이터 갱신 주기 기반)']"
      },
      errors_resolved: {
        type       : "array",
        items      : { type: "string" },
        description: "해결된 에러 목록. 항목 1개 = 에러 1건. " +
                       "자기완결성 기준 준수: 대명사 해소, 구체 엔티티명, 메타 언급 금지. " +
                       "'원인: X → 해결: Y' 형식 권장. 내용이 길어지면 축약하지 말고 항목을 늘릴 것. " +
                       "예: ['주문 목록 API가 빈 배열 반환: 페이징 쿼리에서 OFFSET 파라미터 바인딩 누락 → " +
                       "LIMIT·OFFSET 양쪽 모두 Prepared Statement 파라미터로 교체하여 해결']"
      },
      new_procedures: {
        type       : "array",
        items      : { type: "string" },
        description: "확립된 절차/워크플로우 목록. 항목 1개 = 절차 1개. " +
                       "자기완결성 기준 준수: 대명사 해소, 구체 엔티티명, 메타 언급 금지. " +
                       "절차가 길면 단계별로 쪼개 여러 항목으로 저장할 것. 축약 금지. " +
                       "예: ['스키마 마이그레이션 순서: users 테이블 생성 → orders 테이블 생성 (FK 의존성으로 순서 고정)']"
      },
      open_questions: {
        type       : "array",
        items      : { type: "string" },
        description: "미해결 질문 목록. 항목 1개 = 질문 1건. " +
                       "자기완결성 기준 준수: 대명사 해소, 구체 엔티티명, 메타 언급 금지. " +
                       "예: ['주문 API 캐시 만료 주기를 1시간 vs 24시간 중 어느 쪽이 적합한지 부하 테스트 결과 대기 중']"
      },
      narrative_summary: {
        type       : "string",
        description: "세션 전체를 3~5문장의 서사(narrative)로 요약. 사실 나열이 아니라 이야기로 작성. " +
                       "단 자기참조 금지: '이번 세션', '사용자가 요청하여', '도구를 호출해서' 같은 메타 서술 없이 " +
                       "프로젝트명·문제·해결을 직접 서술할 것. " +
                       "전달하면 episode 파편으로 저장되어 세션 간 맥락 연속성에 기여한다. " +
                       "생략 시 summary에서 자동 생성."
      },
      agentId: {
        type       : "string",
        description: "에이전트 ID"
      },
      task_effectiveness: {
        type       : "object",
        description: "세션 전체의 도구 사용 효과성 종합 평가 (선택)",
        properties : {
          overall_success: {
            type       : "boolean",
            description: "세션의 주요 작업이 성공적으로 완료되었는가"
          },
          tool_highlights: {
            type       : "array",
            items      : { type: "string" },
            description: "특히 유용했던 도구와 이유 (예: 'recall - 이전 에러 해결 이력이 정확히 검색됨')"
          },
          tool_pain_points: {
            type       : "array",
            items      : { type: "string" },
            description: "불편했거나 개선이 필요한 도구와 이유 (예: 'db_query - 결과 페이징이 없어 대량 데이터 처리 불편')"
          }
        }
      }
    },
    required: []
  }
};

export const contextDefinition = {
  name        : "context",
  title       : "Context — 세션 시작 기억 주입",
  annotations : { readOnlyHint: true },
  description : "Core Memory + Working Memory + session_reflect를 분리 로드한다. " +
                 "세션 시작 시 preference, error, procedure, decision 파편을 주입하여 맥락 유지. " +
                 "직전 세션의 reflect 파편(session_reflect 토픽)도 자동 포함. " +
                 "sessionId 전달 시 해당 세션의 워킹 메모리도 함께 반환. " +
                 "structured=true 시 계층적 트리 구조로 반환.\n\n" +
                 "응답 구조: { [ANCHOR MEMORY]: [...], [CORE MEMORY]: [...], [SYSTEM HINT]: string? }. " +
                 "SYSTEM HINT는 미반영 세션 경고 등 시스템 알림을 포함한다. " +
                 "이미 주입된 파편은 이후 recall에서 excludeSeen=true(기본)로 자동 제외된다.\n\n" +
                 "응답 헤더: X-RateLimit-Limit / X-RateLimit-Remaining / X-RateLimit-Reset 포함 가능.",
  inputSchema: {
    type      : "object",
    properties: {
      tokenBudget: {
        type       : "number",
        description: "최대 토큰 수 (기본 2000). 이 한도를 초과하면 낮은 중요도 파편부터 잘린다.",
        examples   : [1000, 2000, 4000]
      },
      types: {
        type       : "array",
        items      : { type: "string" },
        description: "로드할 유형 목록 (기본: preference, error, procedure). " +
                     "decision 추가 시 아키텍처 결정사항도 함께 로드된다.",
        examples   : [
          ["preference", "error", "procedure"],
          ["preference", "error", "procedure", "decision"],
          ["preference", "decision"]
        ]
      },
      sessionId: {
        type       : "string",
        description: "세션 ID (Working Memory 로드용). 현재 세션의 파편도 함께 반환한다.",
        examples   : ["session-2026-04-20-001"]
      },
      agentId: COMMON_PARAMS.agentId,
      workspace: {
        type       : "string",
        description: "워크스페이스 필터. 지정 시 해당 workspace 파편 + 전역(NULL) 파편만 반환. " +
                     "미지정 시 키의 default_workspace 적용.",
        examples   : ["memento-mcp", "personal"]
      },
      structured: {
        type       : "boolean",
        description: "true 시 계층적 트리 구조 반환, false/미지정 시 기존 flat list (기본값: false)",
        examples   : [true, false]
      }
    }
  }
};

export const toolFeedbackDefinition = {
  name       : "tool_feedback",
  description: "도구 사용 결과에 대한 유용성 피드백. 대상 도구(recall, db_query, search_wiki 등)의 " +
                 "결과가 관련성 있었는지(relevant), 충분했는지(sufficient)를 평가한다. " +
                 "피드백 요청 메시지가 주입될 때 또는 도구 결과가 기대와 크게 다를 때 호출. " +
                 "relevant=false 시 연결 링크 weight가 decay되어 이후 검색 정밀도가 자동 개선된다. " +
                 "recall 응답의 _meta.searchEventId를 search_event_id로 전달하면 검색 품질 누적 학습에 기여한다.",
  inputSchema: {
    type      : "object",
    properties: {
      tool_name: {
        type       : "string",
        description: "평가 대상 도구명 (필수)",
        examples   : ["recall", "db_query", "search_wiki"]
      },
      relevant: {
        type       : "boolean",
        description: "결과가 요청 의도와 관련 있었는가 (필수)",
        examples   : [true, false]
      },
      sufficient: {
        type       : "boolean",
        description: "결과가 작업 완료에 충분했는가 (필수)",
        examples   : [true, false]
      },
      suggestion: {
        type       : "string",
        description: "개선 제안 (선택, 100자 이내)",
        examples   : ["키워드를 더 구체적으로 지정하면 정밀도가 높아질 것 같습니다."]
      },
      context: {
        type       : "string",
        description: "사용 맥락 요약 (선택, 50자 이내)",
        examples   : ["nginx SSL 오류 해결 중"]
      },
      session_id: {
        type       : "string",
        description: "세션 ID (선택)",
        examples   : ["session-2026-04-20-001"]
      },
      trigger_type: {
        type       : "string",
        enum       : ["sampled", "voluntary"],
        description: "트리거 유형. sampled=훅 샘플링, voluntary=AI 자발적 (기본 voluntary)",
        examples   : ["voluntary", "sampled"]
      },
      search_event_id: {
        type       : "integer",
        description: "직전 recall이 반환한 _searchEventId. 검색 품질 분석에 사용. " +
                     "recall 응답의 _meta.searchEventId 필드에서 조회한다. " +
                     "(deprecated 표기: 응답 최상단 _searchEventId는 _meta.searchEventId로 이전됨)",
        examples   : [42, 1337]
      },
      fragment_ids: {
        type       : "array",
        items      : { type: "string" },
        description: "피드백 대상 파편 ID 목록 (recall 결과에서 반환된 ID). 제공 시 해당 파편의 활성화 점수가 피드백에 따라 조정된다.",
        examples   : [["frag-abc123", "frag-def456"]]
      }
    },
    required: ["tool_name", "relevant", "sufficient"]
  }
};

export const memoryStatsDefinition = {
  name       : "memory_stats",
  description: "파편 기억 시스템 통계 조회. 전체 파편 수, TTL 분포, 유형별 통계, " +
                 "워크스페이스별 파편 분포, 링크 수, 최근 활동을 반환한다. " +
                 "할당량 소진 여부와 파편 분포 파악에 사용한다.",
  inputSchema: {
    type      : "object",
    properties: {}
  }
};

export const memoryConsolidateDefinition = {
  name       : "memory_consolidate",
  description: "파편 기억 유지보수 실행. TTL 전환, 중요도 감쇠, 만료 삭제, 중복 병합을 수행한다. " +
                 "master key 전용 도구이며, 대량 파편이 있는 경우 HTTP 타임아웃이 발생할 수 있으나 " +
                 "실행 자체는 정상 완료된다. 동시 요청은 프로세스 단위 FIFO 큐에서 순차 실행된다. " +
                 "stream 파라미터는 deprecated: 더 이상 SSE progress를 보내지 않는다. " +
                 "응답 헤더: X-RateLimit-Limit / X-RateLimit-Remaining / X-RateLimit-Reset 포함 가능.",
  inputSchema: {
    type      : "object",
    properties: {
      stream: {
        type       : "boolean",
        description: "deprecated: 더 이상 SSE progress 이벤트를 보내지 않는다. " +
                     "memory_consolidate는 표준 단일 JSON 응답으로 반환된다. " +
                     "이 파라미터는 하위 호환성을 위해 유지되지만 동작에 영향을 주지 않는다.",
        examples   : [true, false]
      }
    }
  }
};

export const graphExploreDefinition = {
  name       : "graph_explore",
  description: "에러 파편 기점으로 인과 관계 체인을 추적한다. RCA(Root Cause Analysis) 전용. " +
               "caused_by, resolved_by 관계를 1-hop 추적하여 에러 원인과 해결 절차를 연결한다 (1-hop 고정, 다중 홉 미지원). " +
               "link(relationType='resolved_by')로 연결된 파편이 있어야 유의미한 결과를 반환한다. " +
               "응답은 { root: fragment, edges: [{ relationType, fragment }] } 구조다.",
  inputSchema: {
    type      : "object",
    properties: {
      startId: {
        type       : "string",
        description: "시작 파편 ID (error 파편 권장). recall로 에러 파편 ID를 먼저 조회 후 사용한다.",
        examples   : ["frag-error-001", "frag-abc123"]
      },
      agentId: COMMON_PARAMS.agentId
    },
    required: ["startId"]
  }
};

export const fragmentHistoryDefinition = {
  name       : "fragment_history",
  description: "파편의 전체 변경 이력 조회. amend로 수정된 이전 버전과 superseded_by 체인을 반환한다. " +
                 "assertionStatus 변경 이력과 각 버전의 content 스냅샷도 포함된다. " +
                 "응답은 { current: fragment, history: [{ version, changed_at, diff }] } 구조다.",
  inputSchema: {
    type      : "object",
    properties: {
      id: {
        type       : "string",
        description: "조회할 파편 ID (필수). recall 응답의 id 필드 값을 사용한다.",
        examples   : ["frag-abc123", "frag-def456"]
      }
    },
    required: ["id"]
  }
};

export const getSkillGuideDefinition = {
  name       : "get_skill_guide",
  description: "Memento MCP 최적 활용 가이드를 반환한다. " +
                 "기억 도구 사용법, 세션 생명주기, 키워드 규칙, 검색 전략, " +
                 "에피소드 기억 활용법, 경험적 기억(Spreading Activation·Reconsolidation·Episode Continuity), " +
                 "다중 플랫폼 관리 등 포괄적 스킬 레퍼런스. " +
                 "플랫폼에 기억 도구 관련 설정(CLAUDE.md, 훅 등)이 없는 경우 이 가이드를 호출하여 참조한다. " +
                 "section 파라미터로 필요한 섹션만 조회하면 토큰을 절약할 수 있다.",
  inputSchema: {
    type      : "object",
    properties: {
      section: {
        type       : "string",
        description: "특정 섹션만 조회. 미지정 시 전체 가이드 반환. " +
                     "가능한 값: overview, lifecycle, keywords, search, episode, multiplatform, codex, tools, importance, experiential, cbr, triggers, antipatterns",
        examples   : ["overview", "lifecycle", "search", "codex", "triggers", "antipatterns"]
      }
    }
  }
};

export const reconstructHistoryDefinition = {
  name       : "reconstruct_history",
  description: "case_id 또는 entity 기반으로 작업 히스토리를 시간순으로 재구성한다. " +
               "인과 체인과 미해결 브랜치를 포함하여 서사를 복원한다. " +
               "case_events DAG, timeline, 인과 체인을 포함한 구조화된 히스토리를 반환한다. " +
               "caseId 또는 entity 중 하나는 필수다.",
  inputSchema: {
    type      : "object",
    properties: {
      caseId   : {
        type       : "string",
        description: "재구성할 케이스 식별자. remember 시 지정한 caseId와 일치해야 한다.",
        examples   : ["debug-nginx-ssl-2026-04-20", "feat-cli-remote-2026-04-20"]
      },
      entity   : {
        type       : "string",
        description: "entity_key 필터 (caseId 없을 때 사용). topic ILIKE 매칭.",
        examples   : ["memento-mcp", "nginx"]
      },
      timeRange: {
        type      : "object",
        properties: {
          from: {
            type       : "string",
            description: "시작 시각 (ISO 8601)",
            examples   : ["2026-04-01T00:00:00Z"]
          },
          to  : {
            type       : "string",
            description: "종료 시각 (ISO 8601)",
            examples   : ["2026-04-20T23:59:59Z"]
          }
        },
        description: "ISO 8601 시간 범위"
      },
      query    : {
        type       : "string",
        description: "추가 키워드 필터",
        examples   : ["migration", "ssl"]
      },
      limit    : {
        type       : "number",
        description: "기본 100, 최대 500",
        examples   : [50, 100, 200]
      },
      workspace: {
        type       : "string",
        description: "워크스페이스 필터. 지정 시 해당 workspace + 전역(NULL) 파편만 대상.",
        examples   : ["memento-mcp"]
      }
    }
  }
};

export const searchTracesDefinition = {
  name       : "search_traces",
  description: "fragments를 정확 매칭으로 탐색한다 (recall의 시맨틱 검색과 달리 content/type/case_id 텍스트 매칭). " +
               "event_type, entity, 키워드로 필터링하여 전체 히스토리를 grep하듯 조회. " +
               "특정 case_id나 session_id의 모든 파편을 시간순으로 확인할 때 유용하다. " +
               "recall이 반환하지 못한 파편을 직접 조회하는 보완 수단으로 사용한다.",
  inputSchema: {
    type      : "object",
    properties: {
      event_type: {
        type       : "string",
        description: "필터할 fragment type (fact, error, decision 등)",
        examples   : ["error", "decision", "fact"]
      },
      eventType : {
        type       : "string",
        description: "event_type의 camelCase alias",
        examples   : ["error", "decision"]
      },
      entity_key: {
        type       : "string",
        description: "topic ILIKE 필터. 부분 일치 지원.",
        examples   : ["memento-mcp", "nginx"]
      },
      entityKey : {
        type       : "string",
        description: "entity_key의 camelCase alias",
        examples   : ["memento-mcp"]
      },
      keyword   : {
        type       : "string",
        description: "content 내 키워드 검색 (ILIKE 부분 일치)",
        examples   : ["migration-030", "SSL", "jwt"]
      },
      case_id   : {
        type       : "string",
        description: "케이스 ID 필터",
        examples   : ["debug-nginx-ssl-2026-04-20"]
      },
      caseId    : {
        type       : "string",
        description: "case_id의 camelCase alias",
        examples   : ["debug-nginx-ssl-2026-04-20"]
      },
      session_id: {
        type       : "string",
        description: "세션 ID 필터",
        examples   : ["session-2026-04-20-001"]
      },
      sessionId : {
        type       : "string",
        description: "session_id의 camelCase alias",
        examples   : ["session-2026-04-20-001"]
      },
      time_range: {
        type      : "object",
        properties: {
          from: {
            type       : "string",
            description: "시작 시각 (ISO 8601)",
            examples   : ["2026-04-01T00:00:00Z"]
          },
          to  : {
            type       : "string",
            description: "종료 시각 (ISO 8601)",
            examples   : ["2026-04-20T23:59:59Z"]
          }
        }
      },
      limit     : {
        type       : "number",
        description: "기본 20, 최대 100",
        examples   : [20, 50, 100]
      },
      workspace : {
        type       : "string",
        description: "워크스페이스 필터. 지정 시 해당 workspace + 전역(NULL) 파편만 대상.",
        examples   : ["memento-mcp"]
      }
    }
  }
};

export const batchStatusDefinition = {
  name       : "batch_status",
  description: "async batch_remember 가 반환한 jobId 의 처리 상태를 조회한다. " +
               "state: queued | processing | completed | dead. Redis 비활성 시 status=null.",
  inputSchema: {
    type      : "object",
    properties: {
      jobId: { type: "string", description: "batch_remember(async:true) 응답의 jobId" }
    },
    required: ["jobId"]
  }
};

export const sessionRotateDefinition = {
  name       : "session_rotate",
  description: "현재 세션을 종료하고 새 sessionId를 발급한다. 토큰 탈취 의심 시 또는 주기적 로테이션에 사용.\n" +
               "동일 bound_key_id / workspace / permissions는 새 세션으로 이관된다.",
  inputSchema: {
    type      : "object",
    properties: {
      reason: {
        type       : "string",
        maxLength  : 256,
        description: "회전 사유 (감사 로그 기록).",
        examples   : ["scheduled_rotation", "suspected_leak", "user_request"]
      }
    }
  }
};
