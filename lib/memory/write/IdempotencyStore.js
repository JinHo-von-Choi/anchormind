/**
 * IdempotencyStore - 파편을 만들지 않는 쓰기 도구의 재시도 기록
 *
 * 작성자: 최진호
 * 작성일: 2026-08-28
 *
 * remember는 fragments.idempotency_key로 재호출을 흡수한다. amend와 tool_feedback은
 * 파편을 만들지 않아 키를 얹을 행이 없고, 응답을 못 받은 클라이언트가 재시도하면
 * 이력이 두 번 쌓이거나 링크 가중치가 두 번 움직인다.
 *
 * 첫 호출의 응답을 저장하고 같은 키의 재호출에 그대로 돌려준다. 저장이 실패해도
 * 도구 호출 자체는 성공으로 두어야 한다. 재시도 편의를 위한 장치가 본래 작업을
 * 막으면 손해가 더 크기 때문이다.
 */

import { queryWithAgentVector } from "../../tools/db.js";
import { logWarn }              from "../../logger.js";
import { SCHEMA } from "../schema.js";

/** 유일 제약이 NULL을 서로 다른 값으로 보지 않도록 키 범위를 정규화한다. */
function scopeKeyOf(keyId) {
  return keyId ?? "";
}

/**
 * 같은 키로 이미 처리된 호출의 응답을 찾는다.
 *
 * @param {string}      tool
 * @param {string}      idempotencyKey
 * @param {string|null} keyId
 * @param {string}      [agentId]
 * @returns {Promise<Object|null>} 첫 호출의 응답 또는 null
 */
export async function findRecordedResponse(tool, idempotencyKey, keyId = null, agentId = "default") {
  if (!idempotencyKey) return null;
  try {
    const { rows } = await queryWithAgentVector(agentId,
      `SELECT response FROM ${SCHEMA}.idempotency_records
        WHERE scope_key = $1 AND tool = $2 AND idempotency_key = $3
          AND expires_at > NOW()`,
      [scopeKeyOf(keyId), tool, idempotencyKey]
    );
    return rows[0]?.response ?? null;
  } catch (err) {
    /** 조회 실패는 "기록 없음"과 같게 다룬다. 최악의 경우 한 번 더 수행될 뿐이다. */
    logWarn(`[IdempotencyStore] 조회 실패 (${tool}): ${err.message}`);
    return null;
  }
}

/**
 * 호출 결과를 기록한다. 이미 있으면 덮어쓰지 않는다.
 *
 * @param {string}      tool
 * @param {string}      idempotencyKey
 * @param {Object}      response
 * @param {string|null} keyId
 * @param {string}      [agentId]
 * @returns {Promise<boolean>} 기록 성공 여부
 */
export async function recordResponse(tool, idempotencyKey, response, keyId = null, agentId = "default") {
  if (!idempotencyKey) return false;
  try {
    await queryWithAgentVector(agentId,
      `INSERT INTO ${SCHEMA}.idempotency_records
         (scope_key, tool, idempotency_key, response, agent_id, key_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (scope_key, tool, idempotency_key) DO NOTHING`,
      [scopeKeyOf(keyId), tool, idempotencyKey, JSON.stringify(response), agentId, keyId],
      "write"
    );
    return true;
  } catch (err) {
    /** 기록 실패가 도구 호출을 실패시키면 안 된다. 재시도 편의가 본래 작업을 막는다. */
    logWarn(`[IdempotencyStore] 기록 실패 (${tool}): ${err.message}`);
    return false;
  }
}

/**
 * 만료된 기록을 지운다. 정리 주기에서 호출한다.
 *
 * @returns {Promise<number>} 지운 건수
 */
export async function purgeExpired() {
  try {
    const result = await queryWithAgentVector("system",
      `DELETE FROM ${SCHEMA}.idempotency_records WHERE expires_at <= NOW()`, [], "write");
    return result.rowCount || 0;
  } catch (err) {
    logWarn(`[IdempotencyStore] 만료 정리 실패: ${err.message}`);
    return 0;
  }
}
