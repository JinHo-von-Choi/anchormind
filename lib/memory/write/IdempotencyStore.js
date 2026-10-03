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

/**
 * 처리 선점 기록
 *
 * 비동기 소비자(예: 훅 회고)는 같은 멱등 키의 작업을 한 번만 수행해야 하고, 수행 도중 실패하면 다시
 * 시도할 수 있어야 한다. 응답을 사후에 기록하는 위 두 함수로는 동시에 도착한 두 전달이 모두 작업을
 * 수행할 수 있으므로, 작업 전에 키를 선점한다.
 *
 * response 열의 상태: {"state":"claimed","token":<uuid>} 선점 중, {"state":"done",...} 완료.
 * 선점 뒤 staleAfterMs가 지나도록 완료나 해제가 없으면(처리 중 프로세스 종료) 다음 전달이 선점을 넘겨받는다.
 * 아래 함수는 조회와 기록 오류를 호출자에게 던진다(호출자가 재시도를 정한다).
 */

/** 선점 결과 */
export const CLAIM_RESULT = Object.freeze({ CLAIMED: "claimed", DONE: "done", BUSY: "busy" });

/**
 * 멱등 키를 선점한다.
 *
 * @param {Object} args
 * @param {string}      args.tool
 * @param {string}      args.idempotencyKey
 * @param {string|null} args.keyId
 * @param {string}      args.token         이 선점의 표지(UUID)
 * @param {number}      args.staleAfterMs  넘겨받기까지의 선점 유효 시간
 * @param {number}      args.ttlDays       기록 보존 일수(expires_at)
 * @returns {Promise<"claimed"|"done"|"busy">}
 */
export async function claimIdempotencyKey({ tool, idempotencyKey, keyId, token, staleAfterMs, ttlDays }) {
  const claimed = await queryWithAgentVector("default",
    `INSERT INTO ${SCHEMA}.idempotency_records
       (scope_key, tool, idempotency_key, response, agent_id, key_id, expires_at)
     VALUES ($1, $2, $3, jsonb_build_object('state', 'claimed', 'token', $4::text), 'default', $5,
             now() + make_interval(days => $6::int))
     ON CONFLICT (scope_key, tool, idempotency_key) DO UPDATE
        SET response   = EXCLUDED.response,
            created_at = now(),
            expires_at = EXCLUDED.expires_at
      WHERE (idempotency_records.response->>'state' = 'claimed'
             AND idempotency_records.created_at < now() - make_interval(secs => $7::double precision / 1000))
         OR idempotency_records.expires_at <= now()
     RETURNING id`,
    [scopeKeyOf(keyId), tool, idempotencyKey, token, keyId, ttlDays, staleAfterMs],
    "write"
  );
  if (claimed.rows.length > 0) return CLAIM_RESULT.CLAIMED;

  const { rows } = await queryWithAgentVector("default",
    `SELECT response->>'state' AS state FROM ${SCHEMA}.idempotency_records
      WHERE scope_key = $1 AND tool = $2 AND idempotency_key = $3`,
    [scopeKeyOf(keyId), tool, idempotencyKey]
  );
  return rows[0]?.state === "claimed" ? CLAIM_RESULT.BUSY : CLAIM_RESULT.DONE;
}

/**
 * 선점을 완료로 바꾼다. 다른 전달이 선점을 넘겨받았으면 바꾸지 않는다.
 *
 * @param {{ tool: string, idempotencyKey: string, keyId: string|null, token: string, summary: Object }} args
 *   summary: 완료 기록에 남길 값(본문 없이 건수 등)
 * @returns {Promise<boolean>} 반영 여부
 */
export async function completeIdempotencyClaim({ tool, idempotencyKey, keyId, token, summary }) {
  const result = await queryWithAgentVector("default",
    `UPDATE ${SCHEMA}.idempotency_records
        SET response = $5::jsonb || jsonb_build_object('state', 'done')
      WHERE scope_key = $1 AND tool = $2 AND idempotency_key = $3
        AND response->>'state' = 'claimed' AND response->>'token' = $4`,
    [scopeKeyOf(keyId), tool, idempotencyKey, token, JSON.stringify(summary ?? {})],
    "write"
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * 작업이 실패했을 때 선점을 풀어 다음 전달이 다시 선점할 수 있게 한다.
 *
 * @param {{ tool: string, idempotencyKey: string, keyId: string|null, token: string }} args
 * @returns {Promise<boolean>} 해제 여부
 */
export async function releaseIdempotencyClaim({ tool, idempotencyKey, keyId, token }) {
  const result = await queryWithAgentVector("default",
    `DELETE FROM ${SCHEMA}.idempotency_records
      WHERE scope_key = $1 AND tool = $2 AND idempotency_key = $3
        AND response->>'state' = 'claimed' AND response->>'token' = $4`,
    [scopeKeyOf(keyId), tool, idempotencyKey, token],
    "write"
  );
  return (result.rowCount ?? 0) > 0;
}
