/**
 * CaseRewardBackprop - case 검증 결과를 파편 importance로 역전파
 *
 * 작성자: 최진호
 * 작성일: 2026-04-07
 *
 * verification_passed  -> evidence 파편 importance +DELTA_PASS, quality_verified=TRUE
 * verification_failed  -> evidence 파편 importance +DELTA_FAIL (음수)
 * 범위 제한: [0.0, 1.0] (DB LEAST/GREATEST로 원자적 clamp)
 *
 * 동시성 안전: evidence 파편을 id 순으로 먼저 잠그고 같은 트랜잭션에서 잠근 행만 갱신한다.
 * 동일 fragment가 여러 evidence 행에 매칭돼도 잠금 문장이 행 하나로 돌려주므로 1회만 적용한다.
 */

import { getPrimaryPool, queryWithAgentVector } from "../../tools/db.js";
import { fragmentRowLock } from "../write/rowLock.js";
import { logWarn }        from "../../logger.js";
import { keyScopeScalar } from "../keyScope.js";
import { SCHEMA } from "../schema.js";

/**
 * 매 호출 시 process.env를 평가하여 런타임 토글을 즉시 반영한다.
 * config.js의 CASE_BACKPROP_ENABLED는 외부 노출용 상수로 유지된다.
 */
function isBackpropEnabled() {
  return process.env.MEMENTO_CASE_BACKPROP_ENABLED === "true";
}

const DELTA_PASS = +0.15;
const DELTA_FAIL = -0.10;

export class CaseRewardBackprop {
  /**
   * 케이스 검증 결과를 해당 케이스 증거 파편 importance에 원자적으로 역전파한다.
   *
   * @param {string}      caseId
   * @param {string}      eventType  - 'verification_passed' | 'verification_failed'
   * @param {number|null} keyId      - API 키 격리 (NULL = 마스터, 전체 파편 대상)
   */
  async backprop(caseId, eventType, keyId) {
    if (!isBackpropEnabled()) return;
    if (eventType !== "verification_passed" && eventType !== "verification_failed") return;

    const pool = getPrimaryPool();
    if (!pool) return;

    const delta  = eventType === "verification_passed" ? DELTA_PASS : DELTA_FAIL;
    const isPass = eventType === "verification_passed";

    try {
      const lockParams = [caseId];
      const keyFilter  = keyScopeScalar(lockParams, "key_id", keyId).trimStart();
      const evidenceOf = `id IN (
          SELECT fe.fragment_id
            FROM ${SCHEMA}.fragment_evidence fe
            JOIN ${SCHEMA}.case_events ce ON ce.event_id = fe.event_id
           WHERE ce.case_id = $1
        )
        ${keyFilter}`;

      await queryWithAgentVector("system",
        `UPDATE ${SCHEMA}.fragments f
            SET importance       = LEAST(1.0, GREATEST(0.0, f.importance + $2)),
                quality_verified = CASE WHEN $3::boolean THEN TRUE ELSE f.quality_verified END
          WHERE f.id = ANY($1::text[])`,
        [delta, isPass],
        { lock: fragmentRowLock("case_reward", evidenceOf, lockParams) }
      );
    } catch (err) {
      logWarn(`[CaseRewardBackprop] backprop failed for case ${caseId}: ${err.message}`);
    }
  }
}

/** 싱글톤 (서버 수명 동안 공유) */
let _instance = null;
export function getBackprop() {
  if (!_instance) _instance = new CaseRewardBackprop();
  return _instance;
}
