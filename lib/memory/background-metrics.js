/**
 * 배경 작업 지표(링크 쓰기, 자동 링크 작업, 계층 조정, 순환 검사)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-31
 *
 *   memento_link_writes_total{producer, relation}            쓴 링크 수(삽입과 갱신)
 *   memento_link_write_duration_seconds{producer}            링크 쓰기 트랜잭션 하나의 시간
 *   memento_background_task_duration_seconds{task}           graph_linker, temporal_linker 실행 시간
 *   memento_tier_transitions_total{transition}               계층 조정 규칙별로 바꾼 파편 수
 *   memento_link_cycle_blocked_total{source}                 순환 검사로 만들지 않은 링크 수
 *
 * producer는 링크를 만든 경로다(temporal, graph_linker, auto_link, proactive, linked_to, session, other).
 */

import promClient   from "prom-client";
import { register } from "../metrics.js";

const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30];

export const linkWritesTotal = new promClient.Counter({
  name      : "memento_link_writes_total",
  help      : "쓴 링크 수(producer: 링크를 만든 경로, relation: 관계)",
  labelNames: ["producer", "relation"],
  registers : [register]
});

export const linkWriteDuration = new promClient.Histogram({
  name      : "memento_link_write_duration_seconds",
  help      : "링크 쓰기 트랜잭션 하나의 시간(producer: 링크를 만든 경로)",
  labelNames: ["producer"],
  buckets   : BUCKETS,
  registers : [register]
});

export const backgroundTaskDuration = new promClient.Histogram({
  name      : "memento_background_task_duration_seconds",
  help      : "자동 링크 작업 실행 시간(task: graph_linker, temporal_linker)",
  labelNames: ["task"],
  buckets   : BUCKETS,
  registers : [register]
});

export const deleteCleanupFailures = new promClient.Counter({
  name      : "memento_delete_cleanup_failures_total",
  help      : "파편 삭제 뒤 정리 단계 실패 수(step: copies, audit, links, linked_to, deindex)",
  labelNames: ["step"],
  registers : [register]
});

export const deadReferencesSwept = new promClient.Counter({
  name      : "memento_dead_references_swept_total",
  help      : "주기 정리가 linked_to에서 지운 없는 파편 참조 수",
  registers : [register]
});

export const tierTransitionsTotal = new promClient.Counter({
  name      : "memento_tier_transitions_total",
  help      : "계층 조정 규칙별로 바꾼 파편 수(transition: 규칙 이름)",
  labelNames: ["transition"],
  registers : [register]
});

export const linkCycleBlockedTotal = new promClient.Counter({
  name      : "memento_link_cycle_blocked_total",
  help      : "순환 검사로 만들지 않은 링크 수(source: 검사한 경로)",
  labelNames: ["source"],
  registers : [register]
});
