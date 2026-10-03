/**
 * 감사 표 지표
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 계수기
 *   memento_audit_enqueue_failed_total  기록하지 못한 감사 이벤트 수(규칙 위반 또는 outbox 기록 실패)
 *   memento_audit_recorded_total        admin_audit_events에 새로 기록한 행 수(재전달로 건너뛴 행은 세지 않는다)
 *   memento_audit_cleaned_total         보존 기간이 지나 지운 행 수
 */

import promClient   from "prom-client";
import { register } from "../metrics.js";

const counter = (name, help) => new promClient.Counter({ name, help, registers: [register] });

export const auditEnqueueFailedTotal = counter("memento_audit_enqueue_failed_total", "기록하지 못한 감사 이벤트 수");
export const auditRecordedTotal      = counter("memento_audit_recorded_total", "admin_audit_events에 새로 기록한 행 수");
export const auditCleanedTotal       = counter("memento_audit_cleaned_total", "보존 기간이 지나 지운 감사 행 수");
