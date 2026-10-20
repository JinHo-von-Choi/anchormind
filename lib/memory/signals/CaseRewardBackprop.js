/**
 * CaseRewardBackprop - case 검증 결과를 파편 importance로 역전파
 *
 * 작성자: 최진호
 * 작성일: 2026-04-07
 * 수정일: 2026-10-20 (검증 이벤트 자신의 근거만, 근거 종류와 confidence 반영)
 *
 * verification_passed  -> 그 이벤트 근거 파편 importance +DELTA_PASS x confidence,
 *                         confidence가 CONFOUNDED_MAX를 넘는 근거만 quality_verified=TRUE
 * verification_failed  -> 그 이벤트 근거 파편 importance +DELTA_FAIL x confidence (음수)
 * 범위 제한: [0.0, 1.0] (DB LEAST/GREATEST로 원자적 clamp)
 *
 * 대상은 검증 이벤트에 연결된 supports, produced_by 근거뿐이다. 같은 사례의 다른 이벤트 근거는
 * 검증이 그 파편 덕분인지 가릴 수 없으므로 건드리지 않고, contradicts 근거도 보상하지 않는다.
 * 이벤트 하나는 한 번만 기록되므로(CaseEventStore.append) 같은 검증이 두 번 보상되지 않는다.
 *
 * 동시성 안전: evidence 파편을 id 순으로 먼저 잠그고 같은 트랜잭션에서 잠근 행만 갱신한다.
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

/** 이 값 이하 confidence의 근거는 기여가 섞인(confounded) 근거로 보고 검증 완료 표지를 주지 않는다. */
export const CONFOUNDED_MAX = 0.5;

/** 보상 대상 근거 종류 */
export const REWARDED_EVIDENCE_KINDS = Object.freeze(["supports", "produced_by"]);

const KIND_LIST = REWARDED_EVIDENCE_KINDS.map((k) => `'${k}'`).join(", ");

export class CaseRewardBackprop {
  /**
   * 검증 이벤트 하나의 결과를 그 이벤트 근거 파편 importance에 원자적으로 역전파한다.
   *
   * @param {string}      eventId    - 검증 이벤트 id(case_events.event_id)
   * @param {string}      eventType  - 'verification_passed' | 'verification_failed'
   * @param {number|null} keyId      - API 키 격리 (NULL = 마스터, 전체 파편 대상)
   */
  async backprop(eventId, eventType, keyId) {
    if (!isBackpropEnabled()) return;
    if (eventType !== "verification_passed" && eventType !== "verification_failed") return;

    const pool = getPrimaryPool();
    if (!pool) return;

    const delta  = eventType === "verification_passed" ? DELTA_PASS : DELTA_FAIL;
    const isPass = eventType === "verification_passed";

    try {
      const lockParams = [eventId];
      const keyFilter  = keyScopeScalar(lockParams, "key_id", keyId).trimStart();
      const evidenceOf = `id IN (
          SELECT fe.fragment_id
            FROM ${SCHEMA}.fragment_evidence fe
           WHERE fe.event_id = $1
             AND fe.kind IN (${KIND_LIST})
        )
        ${keyFilter}`;

      await queryWithAgentVector("system",
        `UPDATE ${SCHEMA}.fragments f
            SET importance       = LEAST(1.0, GREATEST(0.0, f.importance + $3 * w.confidence)),
                quality_verified = CASE WHEN $4::boolean AND w.confidence > $5 THEN TRUE ELSE f.quality_verified END
           FROM (SELECT fe.fragment_id, MAX(fe.confidence) AS confidence
                   FROM ${SCHEMA}.fragment_evidence fe
                  WHERE fe.event_id = $2::uuid
                    AND fe.kind IN (${KIND_LIST})
                  GROUP BY fe.fragment_id) w
          WHERE f.id = ANY($1::text[])
            AND w.fragment_id = f.id`,
        [eventId, delta, isPass, CONFOUNDED_MAX],
        { lock: fragmentRowLock("case_reward", evidenceOf, lockParams) }
      );
    } catch (err) {
      logWarn(`[CaseRewardBackprop] backprop failed for event ${eventId}: ${err.message}`);
    }
  }
}

/** 싱글톤 (서버 수명 동안 공유) */
let _instance = null;
export function getBackprop() {
  if (!_instance) _instance = new CaseRewardBackprop();
  return _instance;
}
