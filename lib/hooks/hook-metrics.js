/**
 * 훅 엔드포인트 지표
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 계수기
 *   memento_hook_calls_total{client,event,outcome}  훅 요청 결과
 *   memento_hook_reflect_total{outcome}              회고 소비자의 이벤트 처리 결과
 *
 * 라벨 값은 기록 함수 안에서 닫힌 집합으로 바꾼다. client와 event는 허용 목록(hook-contract.js) 밖이면
 * other, outcome은 아래 목록 밖이면 error다. 따라서 calls 계수기의 시계열 수는 3 x 4 x 12를 넘지 않는다.
 */

import promClient                   from "prom-client";
import { register }                 from "../metrics.js";
import { HOOK_CLIENTS, HOOK_EVENTS } from "./hook-contract.js";

/**
 * 요청 결과
 *   context             SessionStart 응답(200)
 *   accepted            회고 이벤트 기록(202)
 *   duplicate           같은 세션과 이벤트가 이미 접수되었거나 회고되어 기록하지 않음(202)
 *   queue_full          키의 대기 회고 이벤트가 상한에 이름(429)
 *   not_found           허용 목록 밖 경로 또는 스위치 off(404)
 *   invalid             입력 계약 위반(400, 413, 415, 422, 431)
 *   sensitive_rejected  MEMENTO_SENSITIVE_SCAN=reject에서 발췌에 민감 정보가 있음(422)
 *   unauthorized        인증 실패(401)
 *   forbidden           권한 부족(403)
 *   rate_limited        요청 한도 초과(429, 키별 한도 또는 인증 실패한 IP의 한도)
 *   unavailable         인증 저장소 또는 outbox를 쓸 수 없음(503)
 *   error               그 밖의 서버 오류(500)
 */
export const HOOK_CALL_OUTCOMES = Object.freeze([
  "context", "accepted", "duplicate", "queue_full", "not_found", "invalid", "sensitive_rejected",
  "unauthorized", "forbidden", "rate_limited", "unavailable", "error"
]);

/** 회고 소비자 결과 */
export const HOOK_REFLECT_OUTCOMES = Object.freeze(["reflected", "duplicate", "busy", "rejected", "failed"]);

const OTHER = "other";

export const hookCallsTotal = new promClient.Counter({
  name      : "memento_hook_calls_total",
  help      : "훅 엔드포인트 요청 수(클라이언트, 이벤트, 결과별)",
  labelNames: ["client", "event", "outcome"],
  registers : [register]
});

export const hookReflectTotal = new promClient.Counter({
  name      : "memento_hook_reflect_total",
  help      : "훅 회고 소비자가 처리한 outbox 이벤트 수(결과별)",
  labelNames: ["outcome"],
  registers : [register]
});

/**
 * 훅 요청 하나를 센다.
 *
 * @param {unknown} client
 * @param {unknown} event
 * @param {unknown} outcome
 */
export function recordHookCall(client, event, outcome) {
  hookCallsTotal.inc({
    client : HOOK_CLIENTS.includes(client) ? client : OTHER,
    event  : HOOK_EVENTS.includes(event) ? event : OTHER,
    outcome: HOOK_CALL_OUTCOMES.includes(outcome) ? outcome : "error"
  });
}

/**
 * 회고 소비자의 처리 결과 하나를 센다.
 *
 * @param {unknown} outcome
 */
export function recordHookReflect(outcome) {
  hookReflectTotal.inc({ outcome: HOOK_REFLECT_OUTCOMES.includes(outcome) ? outcome : "failed" });
}
