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

/** 제공자별 판정 결과 (outcome: sent | denied | audit_failed) */
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

/** 외부 전송 전 마스킹으로 바뀐 민감 정보 건수 */
export const llmEgressMaskedTotal = new promClient.Counter({
  name      : "memento_llm_egress_masked_total",
  help      : "외부 전송 전 마스킹한 민감 정보 일치 건수",
  labelNames: ["stage"],
  registers : [register]
});
