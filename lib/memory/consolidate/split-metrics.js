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
 *   anchor_loss     — 자식 합집합에 원문 수치 앵커가 빠져 원문 대체 중단
 *   subject_loss    — 자식에 부모의 주어 앵커가 하나도 남지 않아 해당 자식 폐기
 *   modality_drift  — 자식이 부모에 없던 양상(예정·추측·의무·의도)을 도입해 해당 자식 폐기
 *
 * granularity 주의: provider_error·llm_error·low_yield·insert_shortfall·anchor_loss는
 * 파편(부모) 단위로 1회 기록되지만, subject_loss·modality_drift는 자식 단위로 기록되어
 * 한 부모에서 여러 건이 누적될 수 있다. 두 계열을 같은 분모로 비교하면 안 된다.
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
 * @param {"provider_error"|"llm_error"|"low_yield"|"insert_shortfall"|"anchor_loss"|"subject_loss"|"modality_drift"} reason
 */
export function recordSplitSkip(reason) {
  splitSkippedTotal.inc({ reason });
}
