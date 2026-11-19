/**
 * reflect와 context 파라미터 스키마 조각
 *
 * 작성자: 최진호
 * 작성일: 2026-10-20
 *
 * reflectDefinition의 lessons(상황 단서가 붙은 교훈), lessons_applied(교훈 적용 결과), task_effectiveness(도구 효과성 평가),
 * contextDefinition의 view(목록 보기), toolFeedbackDefinition의 파편 지목 인자의 inputSchema 조각이다. 정의 파일(memory-schemas.js)이 펼쳐 쓴다.
 */

export const REFLECT_LESSONS_PARAM = {
  type       : "array",
  maxItems   : 20,
  items      : {
    oneOf: [
      {
        type      : "object",
        properties: {
          cue       : { type: "string", maxLength: 300, description: "이 교훈이 적용되는 상황의 모양. 이번 작업의 사실이 아니라 다른 작업에서도 알아볼 수 있는 패턴" },
          lesson    : { type: "string", description: "그 상황에서 할 조작. 적용하고 확인할 수 있게, 대상 구성 요소를 밝혀 쓴다" },
          evidence  : { type: "string", description: "교훈이 기대는 관찰. 무엇을 바꿨을 때 실행 결과가 어떻게 달라졌는지" },
          confidence: { type: "string", enum: ["high", "medium", "low"], description: "확신도. low는 검증 전 추론으로 저장된다. 생략 시 medium" },
          evidenceIds: {
            type       : "array",
            items      : { type: "string" },
            maxItems   : 10,
            description: "교훈이 기대는 파편 id(선택). 같은 키의 파편만 계보로 남는다. 근거 파편을 forget하거나 거절(rejected)하면 " +
                         "교훈은 support_state=revoked가 되어 context 주입에서 빠지고, 근거 본문을 amend하면 stale이 된다"
          }
        },
        required  : ["cue", "lesson", "evidence"]
      },
      { type: "string", enum: ["NO_ENTRY"] }
    ]
  },
  description: "다른 작업에 옮겨 쓸 교훈 목록. 항목 1개 = 교훈 1건이며 cue, lesson, evidence가 모두 있어야 저장된다. " +
                 "교훈은 procedure 파편으로 저장되고 cue는 상황을 묻는 recall 질의와 맞춰 교훈을 되돌리는 보조 검색어가 된다. " +
                 "너무 일반적인 교훈('꼼꼼히 확인')도, 이번 작업의 사실('요금이 1월 1일 250으로 올랐다')도 아닌 중간을 쓴다. " +
                 "근거가 섞여 어느 조치가 효과였는지 가릴 수 없으면 교훈 객체 대신 배열 항목으로 문자열 \"NO_ENTRY\"를 넣는다. " +
                 "예: [{cue: 'CI가 외부 패키지 다운로드 시간 초과로 실패할 때', lesson: '실패 작업만 gh run rerun --failed로 다시 돌리고 같은 단계가 연속 실패할 때만 원인을 조사한다', evidence: 'onnxruntime nuget ETIMEDOUT 실패 2회가 재실행으로 통과', confidence: 'medium'}]"
};

export const REFLECT_LESSONS_APPLIED_PARAM = {
  type       : "array",
  maxItems   : 20,
  items      : {
    type      : "object",
    properties: {
      id     : { type: "string", description: "이번 세션에서 context나 recall로 받아 적용을 시도한 교훈 파편 id" },
      outcome: {
        type       : "string",
        enum       : ["helped", "failed", "not_applicable"],
        description: "helped=교훈대로 해서 해결됨, failed=교훈대로 했지만 해결되지 않음, not_applicable=상황이 달라 쓰지 않음"
      }
    },
    required  : ["id", "outcome"]
  },
  description: "이번 세션에 적용한 교훈과 결과(선택). 서로 다른 세션에서 실패가 쌓여 성공보다 많아진 교훈은 context에서 빠지고 " +
                 "recall에 lesson_outcome.state=contested로 나온다. 같은 세션의 같은 교훈은 한 번만 센다.",
  examples   : [[{ id: "frag-abc123", outcome: "helped" }]]
};

export const CONTEXT_VIEW_PARAM = {
  type       : "string",
  enum       : ["full", "index"],
  description: "index는 파편마다 첫 문장 60자만 담은 목록으로 고르고 주입한다. 토큰 예산도 목록 줄 길이로 세므로 " +
                 "같은 tokenBudget에 더 많은 파편이 들어간다. 필요한 파편은 id로 recall해 본문을 연다. " +
                 "목록으로만 본 파편은 recall의 이미 본 파편(excludeSeen)으로 표시하지 않는다. 기본 full.",
  examples   : ["full", "index"]
};

export const REFLECT_TASK_EFFECTIVENESS_PARAM = {
  type       : "object",
  description: "세션 전체의 도구 사용 효과성 종합 평가 (선택)",
  properties : {
    overall_success: {
      type       : "boolean",
      description: "호환 유지 필드. outcome을 함께 보내면 outcome이 우선한다."
    },
    outcome: {
      type       : "string",
      enum       : ["completed", "partial", "blocked", "abandoned", "unknown"],
      description: "작업 종료 상태. completed=요구사항 전부 충족, partial=일부만 충족, " +
                     "blocked=외부 요인으로 진행 불가, abandoned=중단, unknown=판정 불가. " +
                     "확신이 없으면 추정하지 말고 unknown을 쓸 것.",
      examples   : ["completed", "partial"]
    },
    evaluator: {
      type       : "string",
      enum       : ["agent", "automatic", "human"],
      description: "outcome 판정 주체. agent=에이전트 자기보고, " +
                     "automatic=테스트·빌드 등 자동 판정, human=사용자가 직접 확인. " +
                     "생략 시 agent로 기록된다.",
      examples   : ["agent", "automatic"]
    },
    evidence: {
      type       : "string",
      description: "outcome 판정 근거 (선택, 1000자 이내). 통과한 테스트 수, 확인한 로그, 사용자 승인 발화 등.",
      examples   : ["npm test 412건 전건 통과 후 사용자가 결과를 확인함"]
    },
    unmet_requirements: {
      type       : "array",
      items      : { type: "string" },
      description: "충족하지 못한 요구사항 목록 (선택, 최대 20건·각 200자). " +
                     "partial/blocked/abandoned일 때 무엇이 남았는지 명시한다.",
      examples   : [["Redis 클러스터 페일오버 검증 미완료"]]
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
};

/** tool_feedback의 파편 지목 인자(fragment_ids, fragment_judgments) */
export const TOOL_FEEDBACK_FRAGMENT_PARAMS = {
  fragment_ids: {
    type       : "array",
    items      : { type: "string" },
    description: "피드백 대상 파편 ID 목록 (recall 결과에서 반환된 ID). 제공 시 해당 파편의 활성화 점수가 피드백에 따라 조정된다.",
    examples   : [["frag-abc123", "frag-def456"]]
  },
  fragment_judgments: {
    type       : "array",
    maxItems   : 50,
    items      : {
      type      : "object",
      properties: { id: { type: "string" }, relevant: { type: "boolean" } },
      required  : ["id", "relevant"]
    },
    description: "실제로 쓴 파편과 쓰지 않은 파편을 따로 판정한다(선택). 주면 fragment_ids 대신 쓰고, search_event_id가 있으면 그 recall이 돌려준 파편만 받는다.",
    examples   : [[{ id: "frag-abc123", relevant: true }, { id: "frag-def456", relevant: false }]]
  }
};
