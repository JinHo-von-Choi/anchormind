/**
 * 도구 정의 머리부: name, title, annotations
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * tools/list 가 노출하는 모든 도구의 name, title, MCP 표준 힌트를 한 곳에 둔다.
 * 각 도구 정의는 `...TOOL_HEAD.<이름>` 으로 이 값을 펼친다. 힌트는 네 값 모두 boolean 으로
 * 선언한다.
 *
 * 힌트 기준:
 *   - readOnlyHint   저장된 기억의 내용을 바꾸지 않는다. 접근 횟수, 검색 이벤트, 확인 결과
 *                    캐시 같은 부수 기록은 내용 변경으로 보지 않는다.
 *   - destructiveHint 기존 데이터를 지우거나 제자리에서 덮어쓴다. 파편 삭제(forget), 내용과
 *                    메타데이터의 제자리 덮어쓰기(amend, 이전 버전 보관 행에 is_anchor와
 *                    assertion_status가 빠지고 버전을 되돌리는 도구가 없다), 만료 삭제와
 *                    병합(memory_consolidate), 설치본 갱신(apply_update)이 해당한다.
 *                    remember와 batch_remember는 새 파편을 추가하는 것이 본래 용도이고
 *                    supersedes를 명시한 호출에서만 기존 파편의 valid_to를 닫고 importance를
 *                    절반으로 줄이므로(보관 행 없음, 만료된 파편은 amend 불가) 선택적으로
 *                    일어나는 부수 효과로 보아 false로 둔다.
 *   - idempotentHint 같은 인자로 반복 호출해도 추가 효과가 없다.
 *   - openWorldHint  서버 밖 시스템에 접근한다.
 */

const READ_ONLY = { readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: false };
const WRITE     = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

const HEADS = [
  ["remember",            "Remember: 기억 저장",                      WRITE],
  ["batch_remember",      "Batch Remember: 대량 기억 저장",            WRITE],
  ["recall",              "Recall: 저장 기억 회상(검색)",               READ_ONLY],
  ["forget",              "Forget: 기억 삭제",                        { ...WRITE, destructiveHint: true, idempotentHint: true }],
  ["link",                "Link: 파편 관계 설정",                      { ...WRITE, idempotentHint: true }],
  ["amend",               "Amend: 기억 갱신",                         { ...WRITE, destructiveHint: true }],
  ["reflect",             "Reflect: 세션 학습 영속화",                  WRITE],
  ["context",             "Context: 세션 시작 기억 주입",               READ_ONLY],
  ["tool_feedback",       "Tool Feedback: 도구 유용성 피드백",           WRITE],
  ["memory_stats",        "Memory Stats: 기억 통계 조회",               READ_ONLY],
  ["memory_consolidate",  "Memory Consolidate: 기억 유지보수",          { ...WRITE, destructiveHint: true }],
  ["graph_explore",       "Graph Explore: 인과 체인 추적",              READ_ONLY],
  ["fragment_history",    "Fragment History: 파편 변경 이력 조회",       READ_ONLY],
  ["get_skill_guide",     "Get Skill Guide: 활용 가이드 조회",           READ_ONLY],
  ["reconstruct_history", "Reconstruct History: 작업 히스토리 재구성",   READ_ONLY],
  ["search_traces",       "Search Traces: 정확 매칭 탐색",              READ_ONLY],
  ["batch_status",        "Batch Status: 일괄 저장 상태 조회",           READ_ONLY],
  ["session_rotate",      "Session Rotate: 세션 교체",                WRITE],
  ["check_update",        "Check Update: 업데이트 확인",               { ...READ_ONLY, openWorldHint: true }],
  ["apply_update",        "Apply Update: 업데이트 적용",               { ...WRITE, destructiveHint: true, openWorldHint: true }]
];

/** 도구 이름 → { name, title, annotations } */
export const TOOL_HEAD = Object.freeze(Object.fromEntries(
  HEADS.map(([name, title, annotations]) => [
    name,
    Object.freeze({ name, title, annotations: Object.freeze({ ...annotations }) })
  ])
));
