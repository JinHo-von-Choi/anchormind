/**
 * LLM 외부 전송 정책 Prometheus 메트릭
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 단계(stage) 표지는 EgressPolicy.stageLabel로 고정 목록에 묶는다. 제공자 표지는 등록된 제공자 이름이다.
 */

import promClient   from "prom-client";
import { register } from "../metrics.js";

/** 제공자별 판정 결과 (outcome: sent | sent_unaudited | denied | audit_failed). sent_unaudited는 MEMENTO_OUTBOX=off로 감사 행 없이 보낸 건이다 */
export const llmEgressCallsTotal = new promClient.Counter({
  name      : "memento_llm_egress_calls_total",
  help      : "외부 전송 정책을 거친 LLM 제공자 호출 건수",
  labelNames: ["stage", "provider", "provider_class", "outcome"],
  registers : [register]
});

/** 제공자에게 보낸 프롬프트 바이트 */
export const llmEgressBytesTotal = new promClient.Counter({
  name      : "memento_llm_egress_bytes_total",
  help      : "LLM 제공자에게 보낸 프롬프트 바이트(UTF-8)",
  labelNames: ["stage", "provider_class"],
  registers : [register]
});

/** 정책 때문에 건너뛴 단계 (reason: local_only | not_approved | policy_unavailable | policy_invalid) */
export const llmEgressSkippedTotal = new promClient.Counter({
  name      : "memento_llm_egress_skipped_total",
  help      : "외부 전송 정책 때문에 건너뛴 LLM 단계 호출 건수",
  labelNames: ["stage", "reason"],
  registers : [register]
});

/** 외부 전송 전 마스킹에서 일치한 민감 정보 규칙 종류 수(호출마다 규칙 하나는 일치 횟수와 관계없이 1) */
export const llmEgressMaskedTotal = new promClient.Counter({
  name      : "memento_llm_egress_masked_total",
  help      : "외부 전송 전 마스킹에서 일치한 민감 정보 규칙 종류 수(호출당 규칙별 1)",
  labelNames: ["stage"],
  registers : [register]
});
