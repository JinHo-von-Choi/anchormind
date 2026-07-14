/**
 * JSON-RPC 핸들러
 *
 * 작성자: 최진호
 * 작성일: 2026-01-30
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SUPPORTED_PROTOCOL_VERSIONS, DEFAULT_PROTOCOL_VERSION } from "./config.js";
import { SymbolicPolicyViolationError } from "./symbolic/errors.js";
import { filterTools } from "./memory/ModeRegistry.js";

const __filename = fileURLToPath(import.meta.url);
const PKG_VERSION = JSON.parse(fs.readFileSync(path.resolve(path.dirname(__filename), "..", "package.json"), "utf8")).version;
import { getToolsDefinition } from "./tools/index.js";
import { TOOL_REGISTRY }     from "./tool-registry.js";
import { PROMPTS, getPrompt as getPromptContent } from "./tools/prompts.js";
import { RESOURCES, readResource as readResourceContent } from "./tools/resources.js";
import {
  recordRpcMethod,
  recordToolExecution,
  recordProtocolNegotiation,
  recordError,
  recordRbacDenied
} from "./metrics.js";
import { logInfo, logError } from "./logger.js";
import { checkPermission }   from "./rbac.js";

/**
 * JSON-RPC 에러 응답 생성
 */
export function jsonRpcError(id, code, message, data) {
  const err                = { code, message };

  if (data !== undefined) {
    err.data             = data;
  }

  return {
    jsonrpc: "2.0",
    id,
    error : err
  };
}

/**
 * JSON-RPC 성공 응답 생성
 */
export function jsonRpcResult(id, result) {
  return {
    jsonrpc: "2.0",
    id,
    result
  };
}

/**
 * 프로토콜 버전 협상
 * 클라이언트가 요청한 버전과 서버가 지원하는 버전을 비교하여 최적 버전 선택
 *
 * @param {string|undefined} clientVersion - 클라이언트가 요청한 프로토콜 버전
 * @returns {string} - 협상된 프로토콜 버전
 */
function negotiateProtocolVersion(clientVersion) {
  if (!clientVersion) {
    logInfo(`[Protocol] Client did not specify version, using default: ${DEFAULT_PROTOCOL_VERSION}`);
    return DEFAULT_PROTOCOL_VERSION;
  }

  if (SUPPORTED_PROTOCOL_VERSIONS.includes(clientVersion)) {
    logInfo(`[Protocol] Client requested ${clientVersion}, supported - using requested version`);
    return clientVersion;
  }

  /** 서버 최신 버전 이하의 날짜 기반 버전이면 호환성 수용 */
  const latestVersion = SUPPORTED_PROTOCOL_VERSIONS[0];
  try {
    const clientDate = new Date(clientVersion);
    const latestDate = new Date(latestVersion);
    if (!isNaN(clientDate.getTime()) && !isNaN(latestDate.getTime()) && clientDate <= latestDate) {
      logInfo(`[Protocol] Client requested ${clientVersion}, which is <= server latest (${latestVersion}) - accepting for forward compatibility`);
      return clientVersion;
    }
  } catch {
    /* 날짜 파싱 실패 시 폴백 로직 수행 */
  }

  /** 날짜 기반 가장 가까운 하위 버전 선택 */
  const clientDate       = new Date(clientVersion);
  let fallbackVersion    = null;

  for (const supportedVersion of SUPPORTED_PROTOCOL_VERSIONS) {
    const supportedDate  = new Date(supportedVersion);
    if (supportedDate <= clientDate) {
      fallbackVersion    = supportedVersion;
      break;
    }
  }

  if (!fallbackVersion) {
    fallbackVersion      = SUPPORTED_PROTOCOL_VERSIONS[SUPPORTED_PROTOCOL_VERSIONS.length - 1];
    logInfo(`[Protocol] Client requested ${clientVersion}, older than all supported - using oldest: ${fallbackVersion}`);
  } else {
    logInfo(`[Protocol] Client requested ${clientVersion}, not explicitly in supported list - falling back to ${fallbackVersion}`);
  }

  return fallbackVersion;
}

/**
 * README.md 읽기 (환영 메시지용)
 */
/**
 * initialize 핸들러
 */
export async function handleInitialize(params) {
  const startTime        = process.hrtime.bigint();

  try {
    // 클라이언트가 요청한 프로토콜 버전 확인
    const clientVersion      = params?.protocolVersion;
    const negotiatedVersion  = negotiateProtocolVersion(clientVersion);

    // 프로토콜 버전 협상 메트릭 기록
    recordProtocolNegotiation(clientVersion, negotiatedVersion);

    const aiInstructions     = `# Memento MCP Server

연결 성공. Fragment-Based Memory 시스템.

## 세션 시작 시 필수 행동 (자동 실행)

1. context 도구를 즉시 호출하여 Core/Working Memory를 로드한다.
   - 과거 세션에서 저장된 중요 파편(fact/decision/error/preference/procedure/relation/episode)이 주입된다.
   - 이를 생략하면 이전 세션에서 축적된 사용자 맥락을 잃는다.

2. 플랫폼에 기억 도구 관련 설정(CLAUDE.md, 훅, .cursorrules 등)이 없는 경우:
   - get_skill_guide 도구를 호출하여 Memento MCP 최적 활용 가이드를 로드한다.
   - 가이드에 따라 사용자에게 적절한 세팅(훅 설정, 키워드 규칙 등)을 권한다.
   - 훅이란 세션 시작/종료 시 기억 도구를 자동 호출하도록 플랫폼에 등록하는 설정이다.
   - 사용자가 훅을 설정하지 않았다면, 다음을 권장한다:
     a) SessionStart 훅: context 도구 자동 호출 → 과거 기억 자동 로드
     b) UserPromptSubmit 훅: 토큰 사용량 모니터링 → 임계값 초과 시 reflect 촉구
     c) 세션 종료 전 reflect 도구 수동 호출 습관화
   - 훅 설정 없이 사용하는 경우, 이 사실을 인지하고 아래 능동 관리 규칙을 더욱 철저히 적용한다.

## 능동 트리거 테이블 (모든 플랫폼 공통)

다음 신호를 감지하면 즉시 해당 도구를 호출한다. 사용자 요청 없이도 선제 실행.

| 감지 신호 | 호출 도구 | 파라미터 힌트 |
|----------|----------|-------------|
| 세션 시작 | context | structured=true |
| "에러", "오류", "안 됨", "실패" 발화 | recall (먼저) | type="error", keywords=[관련 키워드] |
| 에러 원인 확정 | remember | type="error", importance=0.8 |
| 에러 해결 완료 | forget (해당 error 파편) + remember | type="procedure", importance=0.8 |
| "설정", "포트", "경로", "버전" 변경 | recall (먼저) | keywords=[설정명] |
| 아키텍처/기술 선택 확정 | remember | type="decision", importance=0.7 |
| "이전에", "저번에", "전에" 언급 | recall | query=관련 내용 |
| 세션 종료 의도 감지 | reflect | 현재 세션 핵심 내용 |
| 복잡한 작업/버그 추적 시작 | remember | type="decision", importance=0.7, caseId로 파편 묶기 시작 |
| 작업 단계 전환 | remember | type="procedure", importance=0.6, phase 갱신 (planning→debugging→verification) |
| 작업 완전 해결 직후 | remember | type="procedure", importance=0.8, resolutionStatus="resolved", outcome에 해결 요약 |
| 가설/추론 기록 | remember | type="fact", importance=0.6, assertionStatus="inferred", 검증 후 amend로 "verified" |
| recall 응답에 _meta.hints[0] 포함 | hint.trigger 도구 고려 | hint.suggestion 참조 (v3.1.0에서 top-level _memento_hint mirror 제거 완료. _meta.hints[0]만 사용) |
| context 응답에 _meta.hints[0] 포함 | hint.trigger 도구 고려 | hint.suggestion 참조 (v3.1.0에서 top-level _memento_hint mirror 제거 완료. _meta.hints[0]만 사용) |
| recall 응답에 _meta.suggestion 포함 | suggestion.recommendedTool 검토 후 적용 | suggestion.recommendedArgs 참조 (v3.1.0에서 top-level _suggestion mirror 제거 완료. _meta.suggestion만 사용) |
| mode 활성화 상태에서 차단된 도구 호출 | memory_stats로 현재 mode 확인 | 필요 시 모드 전환 요청 |

## 대화 중 능동적 기억 관리 (필수)

다음 상황이 발생하면 즉시 해당 도구를 호출하거나 사용자에게 제안한다:

### remember 즉시 호출
- 사용자가 에러 원인을 파악하거나 해결책을 확정한 순간
- 사용자가 아키텍처/기술 스택 선택을 결정한 순간
- 사용자가 새로운 서비스 포트, 경로, 설정값을 확인한 순간
- 사용자가 배포/빌드/테스트 절차를 완성한 순간
- 사용자가 명시적 선호도나 스타일을 언급한 순간

### 키워드 작성 규칙 (remember/reflect 공통)
- 프로젝트 작업인 경우: keywords에 프로젝트명을 반드시 포함 (예: "memento-mcp", "docs-mcp")
- 디바이스/호스트 구분이 가능한 경우: hostname이나 식별자를 keywords에 포함 (예: "my-host", "macbook-pro")
  - 작업 디렉토리 경로, 환경변수, 시스템 정보 등에서 추출 가능
- topic 필드도 프로젝트명으로 설정하면 recall 시 프로젝트별 필터링이 가능하다
- affect 파라미터: 반복 실패로 좌절한 에러는 affect="frustration", 성공적으로 해결된 절차는 affect="satisfaction"으로 태깅하면 감정 기반 필터링이 가능하다 (neutral/frustration/confidence/surprise/doubt/satisfaction)

### recall 먼저 호출 (작업 전 의무)
- 에러 해결 시작 전: 동일 에러의 과거 해결 기록 확인
- 설정/환경변수 변경 전: 이전 결정 사항 확인
- 사용자가 "이전에", "저번에", "전에"를 언급할 때

### reflect 제안
- 세션이 길어지거나 중요한 작업이 마무리되는 시점
- 사용자가 세션을 종료하려 할 때
- 복잡한 문제가 해결된 직후
- reflect 시 복수의 원자적 파편(fact/decision/error 등)을 개별 저장한다.
- reflect의 summary/decisions/errors_resolved 각 항목의 키워드에도 프로젝트명과 호스트 정보를 포함한다.
- 세션에서 저장한 파편들이 맥락상 연결되어 있다면(동일 작업, 인과 관계, 시간 순서), 추가로 episode 유형 파편을 생성하여 전후관계를 서사로 보존한다. contextSummary 파라미터로 맥락 요약을 첨부하면 recall 시 전후관계 복원에 유리하다.

### forget 제안
- 에러가 완전히 해결된 직후 해당 error 파편 정리 제안

## MCP 도구 사용 불가 시 curl 직접 호출

세션 컨텍스트 초과, 연결 끊김, 플랫폼 제한 등으로 remember/recall/context/reflect 도구를 호출할 수 없을 때는 curl로 직접 HTTP 요청한다. SERVER_URL과 ACCESS_KEY는 MCP 연결 설정에서 확인한다.

단계 1 — 세션 초기화 (SESSION_ID 획득):
  SESSION_ID=$(curl -s -X POST $SERVER_URL -H "Content-Type: application/json" -H "Authorization: Bearer $ACCESS_KEY" -D - -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}' 2>/dev/null | grep -i "^mcp-session-id" | tr -d '\\r' | awk '{print $2}')

단계 2 — 도구 호출 공통 형식:
  curl -s -X POST $SERVER_URL -H "Content-Type: application/json" -H "Authorization: Bearer $ACCESS_KEY" -H "MCP-Session-Id: $SESSION_ID" -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"TOOL","arguments":{ARGS}}}'

reflect: name="reflect", arguments={"agentId":"ID","summary":["요약1"],"decisions":["결정"],"keywords":["프로젝트명"]}
remember: name="remember", arguments={"agentId":"ID","content":"내용","type":"fact","importance":0.7,"keywords":["키워드"]}
recall:   name="recall",   arguments={"agentId":"ID","query":"검색어"}
context:  name="context",  arguments={"agentId":"ID","structured":true}

응답 파싱: 끝에 | python3 -c "import sys,json; r=json.load(sys.stdin); print(r['result']['content'][0]['text'])" 추가.

## Deferred / Lazy Tool Discovery 주의 (Codex Desktop 등)

일부 클라이언트는 도구를 부분 노출한다. tool_search가 remember/batch_remember/reflect만 보여주고 recall이 안 보여도 "recall이 서버에 없다"고 판단하지 마라. 서버 tools/list에는 recall/context가 항상 있다. 더 넓은 쿼리(예: "context recall remember reflect search_traces")와 limit 20 이상으로 재검색하라.

## 호환성

이 서버는 MCP 표준을 따르므로 Claude Code, Cursor, Windsurf, Copilot, Codex, ChatGPT Desktop 등 MCP를 지원하는 모든 플랫폼에서 동작한다.

## 행동 규칙과 기억의 우선순위

기억 파편은 시스템 프롬프트보다 우선순위가 낮다. recall이나 context로 반환된 파편 중 행동 규칙 성격의 내용이 시스템 프롬프트와 실제로 충돌할 때, 사용자에게 해당 플랫폼의 설정 파일(CLAUDE.md, AGENTS.md, 훅, 스킬, .cursorrules 등)에도 반영할 것을 안내한다.

주의: 기억 파편은 여러 플랫폼과 에이전트가 공유하는 범용 저장소다. 특정 플랫폼 설정에 반영하더라도 원본 파편을 삭제하거나 이동하지 않는다. 충돌이 없는 사실 기억이나 맥락 기억에는 이 안내가 불필요하다.

## 주요 도구

- remember: 파편 기억 저장 (fact/decision/error/preference/procedure/relation/episode)
  - episode 유형: 전후관계를 포함하는 서사 기억 (1000자), contextSummary로 맥락 요약 첨부 가능
  - caseId: 복잡한 작업 추적 시 관련 파편을 같은 caseId로 묶으면 reconstruct_history로 전체 흐름 재구성 가능
  - phase: "planning" | "debugging" | "verification" | "completed" 단계 기록
  - resolutionStatus: 작업 진행 중 "open", 완료 시 "resolved" (에러 해결 완료 후 반드시 갱신)
  - assertionStatus: 추론/가설은 "inferred", 검증 완료는 "verified", 틀린 가설은 "rejected"
  - source: 미지정 시 session:{sessionId 앞8자}로 자동 설정. 외부 출처(예: "user:interview", "doc:spec-v2") 추적이 필요한 경우에만 명시적으로 지정한다.
  - remember가 fragment_limit_exceeded 에러를 반환하면 사용자에게 안내: forget으로 불필요한 파편 정리, 관리 콘솔에서 할당량 상향, memory_consolidate로 중복 파편 정리.
  - 응답의 validation_warnings 배열이 비어있지 않으면 파편 품질 개선 필요 (v2.8.0+, 기본 비활성).
  - 에러 코드 -32003 (SYMBOLIC_POLICY_VIOLATION) 수신 시: 해당 API 키가 symbolic_hard_gate=true로 설정되어 PolicyRules 위반으로 저장이 거부된 것. error.data.violations 배열에 위반된 predicate 명이 포함되어 있으므로 내용을 수정 후 재시도한다.
- recall: 기억 검색 (키워드, 주제, 시맨틱 검색)
  - includeContext=true: context_summary와 시간 인접 파편을 함께 반환하여 전후관계 복원
  - caseId: 특정 케이스/작업 ID로 필터링하여 관련 파편만 반환
  - resolutionStatus: "open" | "resolved" | "abandoned"로 해결 상태 필터링
  - phase: 작업 단계 필터링 (planning, debugging, verification, completed 등)
  - caseMode=true: CBR 모드. 유사 파편을 case_id별로 그루핑하여 (goal, events, outcome) 트리플로 반환. 과거 유사 작업 해결 사례 참조 시 사용. 예: recall(text="nginx 502", caseMode=true)
  - maxCases: caseMode에서 반환할 최대 케이스 수 (기본 5, 상한 10)
  - depth: 검색 깊이 필터 — "high-level": decision/episode만 (Planner용, 전략 수립 시 사용). "detail": 전체 (기본값). "tool-level": procedure/error/fact만 (Executor용, 구체적 실행 단계 조회 시 사용). 예: Planner → recall(topic="프로젝트명", depth="high-level"), Executor → recall(keywords=["nginx","설정"], depth="tool-level")
  - 응답 파편에 explanations[].code가 포함되면 해당 파편이 검색된 이유를 설명한다 (v2.8.0+, MEMENTO_SYMBOLIC_EXPLAIN=true 필요).
- forget: 기억 삭제
- link: 파편 간 관계 설정
- amend: 기억 수정. 에러 해결 후 resolutionStatus="resolved"·outcome="해결 요약"으로 갱신, 가설 검증 후 assertionStatus="verified" 또는 "rejected", 단계 완료 후 phase 갱신에 활용
- reflect: 세션 요약 저장
- context: Core/Working Memory 로드
- tool_feedback: 도구 유용성 피드백. ENABLE_RECONSOLIDATION=true 시 fragment_ids 지정하면 relevant 여부에 따라 fragment_links weight를 동적 갱신(decay/reinforce)
- memory_stats: 메모리 통계
- memory_consolidate: 메모리 유지보수
- graph_explore: 에러 인과 관계 추적 (RCA)
- fragment_history: 파편 변경 이력 조회
- get_skill_guide: Memento MCP 최적 활용 스킬 가이드 (전체 또는 섹션별)
- reconstruct_history: case_id 또는 entity 기반으로 작업 히스토리를 시간순 재구성. causal_chains(인과 체인), unresolved_branches(미해결 브랜치), case_events DAG, summary 반환. 복잡한 케이스 전체 흐름 파악에 사용
- search_traces: fragments를 event_type / entity_key / keyword / case_id / session_id로 grep하듯 탐색. 경량 필터링 도구 (기본 20건, 최대 100건)

## 사용 팁

- 사실관계(fact)와 서사/맥락(episode)을 함께 저장하면 "안다"와 "이해한다"를 모두 커버한다.
- 사실 검색은 Memento가 빠르고 정확하다. 전후관계가 중요한 기억은 episode 유형이나 메인 메모리 시스템과 병행을 권장한다.

## 자동 백그라운드 학습 (v2.5.7)

다음 동작은 도구 호출 없이 자동으로 실행된다:
- remember() 후: 유사 파편에 related_to 링크 자동 생성 (keyword overlap >= 50%)
- case verification 이벤트 시: 증거 파편 importance 자동 조정 (+0.15/-0.10)
- 모든 검색 시: minSimilarity가 사용 패턴에 따라 자동 학습됨

프로토콜 버전: ${negotiatedVersion}
지원 버전: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}`;

    const toolCount = getToolsDefinition(null).length;
    const result = {
      protocolVersion: negotiatedVersion,
      serverInfo     : {
        name       : "anchormind-server",
        version    : PKG_VERSION,
        description: `Memento MCP - Fragment-Based Memory Server (도구 ${toolCount}개)

주요 기능:
- 파편 기반 기억 시스템 (Fragment-Based Memory)
- 3계층 검색 (Redis L1 → PostgreSQL L2 → pgvector L3) + RRF 하이브리드 병합
- 비동기 임베딩 + 자동 관계 생성 (EmbeddingWorker → GraphLinker 이벤트 체인)
- 시간-의미 복합 랭킹 (anchorTime 기반, 과거 시점 질의 지원)
- Core Memory / Working Memory 분리 (스마트 캡 + 유형별 슬롯 제한)
- recall 페이지네이션 (cursor 기반)
- 다차원 GC 정책 (utility_score + fact/decision 고립 파편 정리)
- TTL 기반 기억 계층 관리 + 지수 감쇠
- 에러 인과 관계 그래프 (RCA) + 소급 링킹
- batch_remember multi-row INSERT (24컬럼 × N행, 256KB/500행 chunk, ON CONFLICT 유지; async:true 시 Redis 큐 적재·즉시 반환)
- reflect 5카테고리 BatchRememberProcessor 단일 위임 (summary/decisions/errors_resolved/new_procedures/open_questions)
- MorphemeIndex Consistency Gate (fragments.morpheme_indexed 컬럼, L3 진입 보호, migration-035)
- batchPool 분리 (getBatchPool, application_name='memento-mcp:batch', BATCH_DATABASE_URL 옵션)

지원 프로토콜: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}
협상 프로토콜: ${negotiatedVersion}`
      },
      capabilities   : {
        tools: { listChanged: false },
        prompts: { listChanged: false },
        resources: { listChanged: false, subscribe: false }
      },
      instructions   : aiInstructions
    };

    // RPC 메서드 호출 메트릭 기록
    const duration = Number(process.hrtime.bigint() - startTime) / 1e9;
    recordRpcMethod("initialize", true, duration);

    return result;
  } catch (err) {
    const duration = Number(process.hrtime.bigint() - startTime) / 1e9;
    recordRpcMethod("initialize", false, duration);
    throw err;
  }
}

/**
 * tools/list 핸들러
 */
export function handleToolsList(_params, sessionData) {
  const startTime        = process.hrtime.bigint();

  try {
    const keyId          = sessionData?.keyId ?? null;
    const mode           = sessionData?.mode  ?? null;
    const isMaster       = keyId === null;
    const allTools       = getToolsDefinition(keyId);
    const tools          = filterTools(allTools, mode, isMaster);

    const result = { tools };

    // RPC 메서드 호출 메트릭 기록
    const duration = Number(process.hrtime.bigint() - startTime) / 1e9;
    recordRpcMethod("tools/list", true, duration);

    return result;
  } catch (err) {
    const duration = Number(process.hrtime.bigint() - startTime) / 1e9;
    recordRpcMethod("tools/list", false, duration);
    throw err;
  }
}

/**
 * tools/call 핸들러
 */
export async function handleToolsCall(params) {
  const startTime        = process.hrtime.bigint();

  if (!params || typeof params.name !== "string") {
    throw new Error("Tool name is required");
  }

  const name             = params.name;
  const args             = params.arguments || {};

  const entry            = TOOL_REGISTRY.get(name);

  if (!entry) {
    const error          = new Error(`Unknown tool: ${name}`);
    error.code           = -32601;
    throw error;
  }

  /** RBAC 권한 검증 — _permissions가 null이면 master key (전체 허용) */
  const { allowed, required } = checkPermission(args._permissions ?? null, name);
  if (!allowed) {
    recordRbacDenied(name, `requires_${required}`);
    const error          = new Error(`Permission denied: '${name}' requires '${required}' permission`);
    error.code           = -32600;
    throw error;
  }

  const toolResult       = await entry.handler(args);

  // post-processing (예: get_doc → updateAccessStats)
  if (entry.post) {
    entry.post(args, toolResult);
  }

  // 로그 출력
  if (entry.log) {
    const message        = entry.log(args, toolResult);
    if (message) {
      logInfo(`[Tool] ${message}`);
    }
  }

  // 도구 실행 메트릭
  const toolDuration     = Number(process.hrtime.bigint() - startTime) / 1e9;
  recordToolExecution(name, true, toolDuration);

  // 응답 포맷 공통 메트릭
  const rpcDuration      = Number(process.hrtime.bigint() - startTime) / 1e9;
  recordRpcMethod("tools/call", true, rpcDuration);

  // 커스텀 응답 포맷 (예: send_sms)
  if (entry.formatResponse) {
    return entry.formatResponse(args, toolResult);
  }

  // 기본 응답 포맷

  /** MCP spec: isError 어댑터 — 도구가 { success: false } 또는 { error: ... } 를 반환해도
   *  클라이언트가 구조적으로 실패를 감지할 수 있도록 isError 플래그를 설정한다.
   *  텍스트 페이로드(JSON.stringify)는 하위 호환성을 위해 그대로 유지한다. */
  const isToolError      = toolResult?.isError === true
                        || toolResult?.success  === false
                        || (toolResult?.error !== undefined && toolResult?.error !== null);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(toolResult, null, 2)
      }
    ],
    isError: isToolError
  };
}

/**
 * prompts/list 핸들러
 */
export function handlePromptsList(_params) {
  const startTime        = process.hrtime.bigint();

  try {
    const result = {
      prompts: PROMPTS
    };

    const duration = Number(process.hrtime.bigint() - startTime) / 1e9;
    recordRpcMethod("prompts/list", true, duration);

    return result;
  } catch (err) {
    const duration = Number(process.hrtime.bigint() - startTime) / 1e9;
    recordRpcMethod("prompts/list", false, duration);
    throw err;
  }
}

/**
 * prompts/get 핸들러
 */
export async function handlePromptsGet(params) {
  const startTime        = process.hrtime.bigint();

  if (!params || typeof params.name !== "string") {
    throw new Error("Prompt name is required");
  }

  try {
    const result = await getPromptContent(params.name, params.arguments || {});

    const duration = Number(process.hrtime.bigint() - startTime) / 1e9;
    recordRpcMethod("prompts/get", true, duration);

    return result;
  } catch (err) {
    const duration = Number(process.hrtime.bigint() - startTime) / 1e9;
    recordRpcMethod("prompts/get", false, duration);
    throw err;
  }
}

/**
 * resources/list 핸들러
 */
export function handleResourcesList(_params) {
  const startTime        = process.hrtime.bigint();

  try {
    const result = {
      resources: RESOURCES
    };

    const duration = Number(process.hrtime.bigint() - startTime) / 1e9;
    recordRpcMethod("resources/list", true, duration);

    return result;
  } catch (err) {
    const duration = Number(process.hrtime.bigint() - startTime) / 1e9;
    recordRpcMethod("resources/list", false, duration);
    throw err;
  }
}

/**
 * resources/read 핸들러
 */
export async function handleResourcesRead(params) {
  const startTime        = process.hrtime.bigint();

  if (!params || typeof params.uri !== "string") {
    throw new Error("Resource URI is required");
  }

  try {
    const result = await readResourceContent(params.uri, params);

    const duration = Number(process.hrtime.bigint() - startTime) / 1e9;
    recordRpcMethod("resources/read", true, duration);

    return result;
  } catch (err) {
    const duration = Number(process.hrtime.bigint() - startTime) / 1e9;
    recordRpcMethod("resources/read", false, duration);
    throw err;
  }
}

/**
 * JSON-RPC 요청 디스패처
 */
export async function dispatchJsonRpc(msg, sessionData = {}) {
  if (!msg || typeof msg !== "object") {
    return { kind: "error", response: jsonRpcError(null, -32600, "Invalid Request") };
  }

  const jsonrpc             = msg.jsonrpc || "2.0";
  const id                  = Object.prototype.hasOwnProperty.call(msg, "id") ? msg.id : undefined;
  const method              = msg.method;
  const params              = msg.params;

  if (jsonrpc !== "2.0") {
    return { kind: "error", response: jsonRpcError(id ?? null, -32600, "Invalid Request", "jsonrpc must be '2.0'") };
  }

  if (typeof method !== "string") {
    return { kind: "error", response: jsonRpcError(id ?? null, -32600, "Invalid Request", "method must be string") };
  }

  const isNotification       = id === undefined;

  /** method → handler 맵. tools/list만 sessionData를 추가 인자로 받는다. */
  const METHOD_MAP = {
    "initialize"      : () => handleInitialize(params),
    "tools/list"      : () => handleToolsList(params, sessionData),
    "tools/call"      : () => handleToolsCall(params),
    "prompts/list"    : () => handlePromptsList(params),
    "prompts/get"     : () => handlePromptsGet(params),
    "resources/list"  : () => handleResourcesList(params),
    "resources/read"  : () => handleResourcesRead(params),
  };

  try {
    if (method === "notifications/initialized") {
      return { kind: "accepted" };
    }

    const handler = METHOD_MAP[method];

    if (handler) {
      const result = await handler();

      if (isNotification) {
        return { kind: "accepted" };
      }
      return { kind: "ok", response: jsonRpcResult(id, result) };
    }

    if (isNotification) {
      return { kind: "accepted" };
    }

    return { kind: "ok", response: jsonRpcError(id, -32601, `Method not found: ${method}`) };
  } catch (err) {
    if (isNotification) {
      return { kind: "accepted" };
    }

    /** Symbolic hard gate 위반 — 전용 코드 -32003 */
    if (err instanceof SymbolicPolicyViolationError) {
      recordError(method, -32003);
      return {
        kind    : "ok",
        response: {
          jsonrpc: "2.0",
          id,
          error  : {
            code   : -32003,
            message: err.message,
            data   : {
              violations  : err.violations,
              fragmentType: err.meta?.fragmentType ?? null
            }
          }
        }
      };
    }

    logError(`[ERROR] ${method}:`, err);
    const errorCode        = err.code || -32603;
    const errorMessage     = (errorCode === -32601 || errorCode === -32602) ? err.message : "Internal error";

    // 에러 메트릭 기록
    recordError(method, errorCode);

    return { kind: "ok", response: jsonRpcError(id, errorCode, errorMessage) };
  }
}
