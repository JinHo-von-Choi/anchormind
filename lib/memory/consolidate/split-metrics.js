/**
 * 분할(splitLongFragments) skip 가시화 메트릭.
 *
 * 작성자: 최진호
 * 작성일: 2026-06-09
 *
 * reason 라벨:
 *   provider_error  — split 전용 체인이 비어 dispatchChain throw (키/바이너리 미충족)
 *   llm_error       — LLM 호출/파싱 기타 실패
 *   low_yield       — 게이트 통과 자식 수 < minItems
 *   insert_shortfall— insert 후 자식 수 < minItems (롤백됨)
 */

import promClient  from "prom-client";
import { register } from "../../metrics.js";

/** 분할 skip 건수 (reason별) */
export const splitSkippedTotal = new promClient.Counter({
  name      : "memento_consolidate_split_skipped_total",
  help      : "splitLongFragments 파편 skip 건수 (reason별)",
  labelNames: ["reason"],
  registers : [register]
});

/**
 * 분할 skip을 reason 라벨과 함께 1 증가시킨다.
 * @param {"provider_error"|"llm_error"|"low_yield"|"insert_shortfall"} reason
 */
export function recordSplitSkip(reason) {
  splitSkippedTotal.inc({ reason });
}
