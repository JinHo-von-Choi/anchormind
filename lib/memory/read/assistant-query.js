/**
 * assistant-query.js - 어시스턴트 발화 검색 쿼리 확장
 *
 * 작성자: 최진호
 * 작성일: 2026-03-28
 *
 * "어시스턴트가 뭐라고 했어?" 류의 쿼리는 파편 저장 형식(User: X / Assistant: Y)과
 * 시맨틱 갭이 크므로, 쿼리 전처리로 "Assistant:" 접두어를 삽입하여 L3 검색 정확도를 높인다.
 */

/** 어시스턴트 발화 참조 패턴 (한국어 + 영어) */
const ASSISTANT_PATTERNS_KO = [
  "어시스턴트가",
  "ai가",
  "클로드가",
  "봇이",
  "뭐라고 했",
  "뭐라고 답",
  "뭐라 했",
  "뭐라 답",
  "답변",
  "대답",
];

const ASSISTANT_PATTERNS_EN = [
  "assistant said",
  "ai said",
  "what did you say",
  "your response",
  "your answer",
  "you said",
  "you told",
  "you mentioned",
  "you replied",
  "bot said",
];

/**
 * 쿼리 텍스트가 어시스턴트 발화를 참조하는지 감지한다.
 *
 * @param {string} text - 검색 쿼리 텍스트
 * @returns {boolean}
 */
export function isAssistantQuery(text) {
  if (!text || typeof text !== "string") return false;

  const lower = text.toLowerCase();

  for (const pat of ASSISTANT_PATTERNS_KO) {
    if (lower.includes(pat)) return true;
  }

  for (const pat of ASSISTANT_PATTERNS_EN) {
    if (lower.includes(pat)) return true;
  }

  return false;
}

/**
 * 어시스턴트 발화 쿼리를 L3 시맨틱 검색에 적합한 형태로 확장한다.
 *
 * 원본 쿼리에 "Assistant:" 접두어를 추가하여 임베딩 유사도를 높인다.
 * 어시스턴트 쿼리가 아닌 경우 원본 텍스트를 그대로 반환한다.
 *
 * @param {string} text - 원본 검색 쿼리
 * @returns {{ text: string, isAssistantQuery: boolean }}
 */
export function expandAssistantQuery(text) {
  if (!isAssistantQuery(text)) {
    return { text, isAssistantQuery: false };
  }

  return {
    text             : `Assistant: ${text}`,
    isAssistantQuery : true
  };
}

/**
 * 어시스턴트 발화 쿼리일 때 검색 결과에 부스트를 적용한다.
 *
 * "Assistant:" 또는 "답변:" 포함 파편에 importance 가산점을 부여하여
 * 어시스턴트 발화 파편이 상위에 노출되도록 한다.
 *
 * @param {Object[]} fragments - 검색 결과 파편 배열
 * @param {number}   boost     - 부스트 값 (기본 0.02)
 * @returns {Object[]} 부스트 적용된 파편 배열 (원본 변경)
 */
export function boostAssistantFragments(fragments, boost = 0.02) {
  const ASSISTANT_MARKERS = ["Assistant:", "assistant:", "답변:"];

  for (const f of fragments) {
    if (!f.content) continue;
    for (const marker of ASSISTANT_MARKERS) {
      if (f.content.includes(marker)) {
        f.importance = Math.min(1.0, (f.importance || 0) + boost);
        break;
      }
    }
  }

  return fragments;
}
