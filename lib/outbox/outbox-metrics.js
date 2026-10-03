/**
 * outbox 지표
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * topic 라벨은 이 프로세스에 처리기가 등록된 topic이고, 그 밖의 topic은 "other"로 묶는다.
 * 라벨 값의 수는 등록된 처리기 수 + 1을 넘지 않는다.
 *
 * 계수기
 *   memento_outbox_enqueued_total{topic}     기록한 이벤트 수(호출자 트랜잭션이 나중에 롤백한 행도 센다)
 *   memento_outbox_processed_total{topic}    처리기가 성공하고 완료로 기록한 이벤트 수
 *   memento_outbox_failed_total{topic}       처리기가 실패해 재시도를 예약한 횟수
 *   memento_outbox_dead_letter_total{topic}  dead-letter로 옮긴 이벤트 수
 *   memento_outbox_lease_lost_total          임대가 끝나 다른 작업자가 다시 점유한 뒤 도착한 완료나 실패 기록 수
 *   memento_outbox_cleaned_total             보존 기간이 지나 지운 완료 행 수
 *   memento_outbox_unhandled_total           처리기가 없는 topic이라 dead-letter(no_handler)로 옮긴 행 수
 * 게이지(작업자가 주기적으로 갱신)
 *   memento_outbox_pending                   대기 행 수(재시도 대기 포함)
 *   memento_outbox_dead_letter               dead-letter 행 수
 *   memento_outbox_lag_seconds               전달 예정 시각이 지난 대기 행 중 가장 오래된 행의 지연 초. 없으면 0
 *   memento_outbox_stats_updated_seconds     마지막 갱신 시각(유닉스 초). 작업자를 돌리지 않는 프로세스는 0으로 내보낸다
 * 분포
 *   memento_outbox_delivery_seconds{topic}   전달 예정 시각(점유 전 available_at)부터 완료 기록까지 걸린 초
 */

import promClient           from "prom-client";
import { register }         from "../metrics.js";
import { getOutboxHandler } from "./OutboxHandlers.js";

const counter = (name, help, labelNames = []) =>
  new promClient.Counter({ name, help, labelNames, registers: [register] });
const gauge   = (name, help) =>
  new promClient.Gauge({ name, help, registers: [register] });

export const outboxEnqueuedTotal   = counter("memento_outbox_enqueued_total", "outbox에 기록한 이벤트 수", ["topic"]);
export const outboxProcessedTotal  = counter("memento_outbox_processed_total", "처리를 마친 outbox 이벤트 수", ["topic"]);
export const outboxFailedTotal     = counter("memento_outbox_failed_total", "처리기 실패로 재시도를 예약한 횟수", ["topic"]);
export const outboxDeadLetterTotal = counter("memento_outbox_dead_letter_total", "dead-letter로 옮긴 outbox 이벤트 수", ["topic"]);
export const outboxLeaseLostTotal  = counter("memento_outbox_lease_lost_total", "임대를 잃은 뒤 도착해 반영되지 않은 완료나 실패 기록 수");
export const outboxCleanedTotal    = counter("memento_outbox_cleaned_total", "보존 기간이 지나 지운 완료 행 수");
export const outboxUnhandledTotal  = counter("memento_outbox_unhandled_total", "처리기가 없는 topic이라 dead-letter로 옮긴 행 수");

export const outboxPending         = gauge("memento_outbox_pending", "대기 중인 outbox 행 수");
export const outboxDeadLetter      = gauge("memento_outbox_dead_letter", "dead-letter 상태의 outbox 행 수");
export const outboxLagSeconds      = gauge("memento_outbox_lag_seconds", "전달 예정 시각이 지난 대기 행 중 가장 오래된 행의 지연 초");
export const outboxStatsUpdated    = gauge("memento_outbox_stats_updated_seconds", "outbox 게이지를 마지막으로 갱신한 시각(유닉스 초)");

export const outboxDeliverySeconds = new promClient.Histogram({
  name      : "memento_outbox_delivery_seconds",
  help      : "outbox 이벤트의 전달 예정 시각부터 완료 기록까지 걸린 초",
  labelNames: ["topic"],
  buckets   : [0.1, 0.5, 1, 2, 5, 10, 30, 60, 300, 1800],
  registers : [register]
});

/**
 * 지표용 topic 라벨. 처리기가 등록되지 않은 topic은 "other"다.
 *
 * @param {string} topic
 * @returns {string}
 */
export function topicLabel(topic) {
  return getOutboxHandler(topic) ? topic : "other";
}

/**
 * 대기, dead-letter, 지연 게이지와 갱신 시각을 기록한다.
 *
 * @param {{ pending: number, dead: number, lagSeconds: number }} stats
 * @param {number} nowMs 갱신 시각(밀리초)
 */
export function setOutboxGauges({ pending, dead, lagSeconds }, nowMs) {
  outboxPending.set(pending);
  outboxDeadLetter.set(dead);
  outboxLagSeconds.set(lagSeconds);
  outboxStatsUpdated.set(Math.floor(nowMs / 1000));
}
