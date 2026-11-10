/**
 * remember, recall의 slot 인자 정의
 *
 * 작성자: 최진호
 * 작성일: 2026-11-10
 *
 * 현재 값 슬롯(lib/memory/write/Slot.js)의 도구 인자 스키마.
 */

export const REMEMBER_SLOT_PARAM = {
  type       : "string",
  maxLength  : 128,
  description: "값이 바뀌는 사실의 자리(\"주체.속성\", 예: \"auth-service.port\"). 같은 키, workspace, agent의 같은 slot에 먼저 저장된 " +
               "열린 파편은 이 파편이 자동으로 대체한다(응답 slot_superseded). 판정에 임베딩 유사도를 쓰지 않는다. " +
               "recall의 slot으로 현재 값을 찾는다. 소문자로 바꾸고 공백은 밑줄로 바꿔 저장한다.",
  examples   : ["auth-service.port", "user.editor"]
};

export const RECALL_SLOT_PARAM = {
  type       : "string",
  maxLength  : 128,
  description: "remember의 slot과 같은 이름. 그 자리의 현재 값(대체되지 않은 파편)을 찾는다. intent를 주지 않으면 state로 본다. " +
               "includeHistory=true면 지난 값도 함께 돌려준다.",
  examples   : ["auth-service.port"]
};
