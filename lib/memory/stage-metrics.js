/**
 * recall·remember 단계별 지연 히스토그램
 *
 * 작성자: 최진호
 * 작성일: 2026-10-31
 *
 *   memento_recall_l3_stage_duration_seconds{stage, cache}  L3(의미 검색) 안의 단계
 *     embedding : 질의 임베딩 생성(cache: hit, miss)
 *     search    : 벡터·형태소·역질의·세그먼트 조회를 함께 기다린 시간
 *   memento_recall_stage_duration_seconds{stage}             recall 도구의 검색 뒤 단계
 *     search, linked, context, state, contradiction
 *   memento_remember_stage_duration_seconds{stage}           remember 저장 경로의 단계
 *     insert, index, postprocess, conflict, autolink
 *
 * search_events.l3_latency_ms는 임베딩과 벡터 조회를 합친 값이라 어느 쪽이 느린지 가를 수 없다.
 */

import promClient   from "prom-client";
import { register } from "../metrics.js";

const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30];

export const recallL3StageDuration = new promClient.Histogram({
  name      : "memento_recall_l3_stage_duration_seconds",
  help      : "L3 의미 검색 단계별 지연(stage: embedding, search; cache: hit, miss, n/a)",
  labelNames: ["stage", "cache"],
  buckets   : BUCKETS,
  registers : [register]
});

export const recallStageDuration = new promClient.Histogram({
  name      : "memento_recall_stage_duration_seconds",
  help      : "recall 도구 단계별 지연(stage: search, linked, context, state, contradiction)",
  labelNames: ["stage"],
  buckets   : BUCKETS,
  registers : [register]
});

export const rememberStageDuration = new promClient.Histogram({
  name      : "memento_remember_stage_duration_seconds",
  help      : "remember 저장 경로 단계별 지연(stage: insert, index, postprocess, conflict, autolink)",
  labelNames: ["stage"],
  buckets   : BUCKETS,
  registers : [register]
});

/**
 * 비동기 작업을 재고 결과를 그대로 돌려준다. 실패해도 걸린 시간을 남기고 오류를 다시 던진다.
 *
 * @template T
 * @param {import("prom-client").Histogram} histogram
 * @param {Object} labels
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function timeStage(histogram, labels, fn) {
  const end = histogram.startTimer(labels);
  try {
    return await fn();
  } finally {
    end();
  }
}
