/**
 * context core 주입의 신뢰 등급 제외 지표.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-04
 *
 * reason 라벨:
 *   low_trust    : 등급 1 이하
 *   missing      : 출처 조회 결과에 없는 id
 *   lookup_failed: 출처 조회 실패로 등급을 확인하지 못함
 *   unsupported  : 원본이 철회돼 근거를 잃은 파생 파편(support_state revoked, stale)
 *   directive_origin      : 출처 권한이 낮은 행동 규칙 파편을 뺌(MEMENTO_DIRECTIVE_ORIGIN_GATE=enforce)
 *   directive_origin_warn : 같은 파편을 warn에서 넣고 센 수(뺐을 수)
 */

import promClient   from "prom-client";
import { register } from "../../metrics.js";

/** core 후보에서 뺀 파편 수 (reason별) */
export const coreTrustExcludedTotal = new promClient.Counter({
  name      : "memento_context_core_trust_excluded_total",
  help      : "context core 주입에서 신뢰 등급 판정으로 뺀 파편 수",
  labelNames: ["reason"],
  registers : [register]
});

/**
 * core 후보에서 뺀 파편 수를 더한다. 0이면 기록하지 않는다.
 *
 * @param {"low_trust"|"missing"|"lookup_failed"|"unsupported"|"directive_origin"|"directive_origin_warn"} reason
 * @param {number} count
 */
export function recordCoreTrustExcluded(reason, count) {
  if (count > 0) coreTrustExcludedTotal.inc({ reason }, count);
}
