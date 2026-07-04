/**
 * UtilityBaseline - 앵커 파편 기준 utility 베이스라인 캐시
 *
 * 작성자: 최진호
 * 작성일: 2026-03-28
 *
 * confidence = clamp(utility_score / UTILITY_BASELINE, 0.1, 1.0)
 * 서버 시작 시 1회 계산, consolidate 사이클마다 갱신.
 */

import { getPrimaryPool } from "../../tools/db.js";
import { logInfo, logWarn } from "../../logger.js";

let _utilityBaseline = 1.0;

/**
 * 앵커 파편의 평균 utility_score를 조회하여 캐시를 갱신한다.
 *
 * @param {import("pg").Pool} [pool] - 외부에서 풀을 주입할 수 있음 (테스트용)
 */
export async function refreshUtilityBaseline(pool) {
  const p = pool || getPrimaryPool();
  try {
    const { rows } = await p.query(
      `SELECT AVG(utility_score) AS avg_util
         FROM agent_memory.fragments
        WHERE is_anchor = TRUE AND valid_to IS NULL`
    );
    const parsed = parseFloat(rows[0]?.avg_util);
    _utilityBaseline = (Number.isFinite(parsed) && parsed > 0) ? parsed : 1.0;
    logInfo(`[UtilityBaseline] refreshed: ${_utilityBaseline.toFixed(4)}`);
  } catch (err) {
    logWarn(`[UtilityBaseline] refresh failed, keeping ${_utilityBaseline}: ${err.message}`);
  }
}

/**
 * 현재 캐시된 베이스라인 값을 반환한다.
 */
export function getUtilityBaseline() {
  return _utilityBaseline;
}

/**
 * utility_score를 0.1~1.0 범위의 confidence로 변환한다.
 *
 * @param {number|null|undefined} utilityScore
 * @returns {number} 0.1 ~ 1.0
 */
export function computeConfidence(utilityScore) {
  const raw = (utilityScore || 0) / _utilityBaseline;
  return Math.max(0.1, Math.min(1.0, raw));
}
