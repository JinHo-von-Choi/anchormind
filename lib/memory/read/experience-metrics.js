/**
 * 경험 신호 지표
 *
 * 작성자: 최진호
 * 작성일: 2026-11-19
 *
 *   memento_injection_tokens{tool}                 context와 recall이 응답에 실은 기억 토큰
 *   memento_context_shadow_diff{comparison}        표본 context 요청에서 다른 방식으로 골랐을 때 선택이 달라진 파편 수
 *     ema_off       최종 선택 가중치에서 EMA를 뺐을 때(importance 1.0, EMA 0)
 *     use_signal    온도 정렬 가산점을 사용 사건으로 줬을 때
 *     no_boost      온도 정렬의 최근, 빈도 가산점을 모두 뺐을 때
 *   memento_context_contested_excluded_total       실패가 쌓여 context 후보에서 뺀 교훈 수
 *   memento_context_lesson_index_lines             context에 실은 교훈 색인 줄 수
 */

import promClient   from "prom-client";
import { register } from "../../metrics.js";

/** 응답에 실은 기억 토큰 */
export const injectionTokens = new promClient.Histogram({
  name      : "memento_injection_tokens",
  help      : "context와 recall이 응답에 실은 기억 토큰",
  labelNames: ["tool"],
  buckets   : [0, 100, 250, 500, 1000, 2000, 4000, 8000],
  registers : [register]
});

/** 비교 방식별 선택 차이 */
export const contextShadowDiff = new promClient.Histogram({
  name      : "memento_context_shadow_diff",
  help      : "표본 context 요청에서 다른 방식으로 골랐을 때 선택이 달라진 파편 수",
  labelNames: ["comparison"],
  buckets   : [0, 1, 2, 3, 5, 8, 13],
  registers : [register]
});

/** context 후보에서 뺀 contested 교훈 수 */
export const contestedExcludedTotal = new promClient.Counter({
  name     : "memento_context_contested_excluded_total",
  help     : "적용 실패가 쌓여 context 후보에서 뺀 교훈 수",
  registers: [register]
});

/** context 교훈 색인 줄 수 */
export const lessonIndexLines = new promClient.Histogram({
  name     : "memento_context_lesson_index_lines",
  help     : "context에 실은 교훈 색인 줄 수",
  buckets  : [0, 1, 2, 4, 8, 16],
  registers: [register]
});

/**
 * 응답 토큰을 기록한다. 숫자가 아니면 기록하지 않는다.
 *
 * @param {"context"|"recall"} tool
 * @param {number} tokens
 */
export function recordInjectionTokens(tool, tokens) {
  if (Number.isFinite(tokens) && tokens >= 0) injectionTokens.observe({ tool }, tokens);
}

/**
 * 비교 결과를 기록한다.
 *
 * @param {"ema_off"|"use_signal"|"no_boost"} comparison
 * @param {number} diff
 */
export function recordShadowDiff(comparison, diff) {
  if (Number.isFinite(diff) && diff >= 0) contextShadowDiff.observe({ comparison }, diff);
}

/**
 * 두 선택 집합의 대칭 차이 가운데 한쪽 크기(바뀐 자리 수).
 *
 * @param {Iterable<string>} a
 * @param {Iterable<string>} b
 * @returns {number}
 */
export function selectionDiff(a, b) {
  const right = new Set(b);
  let diff = 0;
  for (const id of new Set(a)) if (!right.has(id)) diff += 1;
  return diff;
}
