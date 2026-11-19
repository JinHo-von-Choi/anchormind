/**
 * LessonSummary - reflect 교훈 파편의 맥락 요약 형식
 *
 * 작성자: 최진호
 * 작성일: 2026-11-19
 *
 * 교훈은 procedure 파편이고 맥락 요약(context_summary)이 "상황: <cue>\n근거: <evidence>\n확신도: <confidence>"다
 * (write/LessonCue.js가 저장한다). 읽기 경로와 정리 단계는 이 머리말로 교훈을 알아본다. 임베딩이 꺼져 cue 행이 없는
 * 교훈도 같다. 이 모듈은 저장, 임베딩, 큐 모듈을 가져오지 않는다.
 */

/** 교훈 파편의 맥락 요약 머리말 */
export const LESSON_SUMMARY_PREFIX = "상황: ";

/**
 * 교훈 파편의 맥락 요약.
 *
 * @param {{cue: string, evidence: string, confidence: string}} lesson
 * @returns {string}
 */
export function lessonContextSummary({ cue, evidence, confidence }) {
  return `${LESSON_SUMMARY_PREFIX}${cue}\n근거: ${evidence}\n확신도: ${confidence}`;
}

/**
 * 교훈 파편 판정 SQL 술어. procedure이면서 맥락 요약이 교훈 머리말로 시작한다.
 *
 * @param {string} [alias]
 * @returns {string}
 */
export function lessonPredicateSql(alias = "f") {
  if (!/^[a-z_][a-z0-9_]*$/.test(alias)) throw new TypeError(`invalid alias: ${alias}`);
  return `(${alias}.type = 'procedure' AND ${alias}.context_summary LIKE '${LESSON_SUMMARY_PREFIX}%')`;
}
