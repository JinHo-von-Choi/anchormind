/**
 * remember 중복 적중 판정, 분류, 응답 조립
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * store.insert가 같은 키 범위의 기존 파편 id를 돌려준 경우를 다룬다.
 * 분류 계수는 항상 기록하고, 확인 설정이 켜져 있을 때만 기존 파편 상태 응답을 만든다.
 */

import { isRememberDuplicateGuardEnabled } from "../../config.js";
import { logWarn }                         from "../../logger.js";
import { recordRememberDuplicate }         from "../../metrics.js";

/**
 * 저장 결과 id가 새로 만든 파편 id가 아니라 같은 키 범위의 기존 파편 id인지 판정한다.
 *
 * @param {Object}      fragment - factory.create() 결과
 * @param {string|null} id       - store.insert() 결과
 * @returns {boolean}
 */
export function isDuplicateHit(fragment, id) {
  return typeof fragment?.id === "string" && typeof id === "string" && id !== fragment.id;
}

/**
 * 중복 적중한 기존 파편이 요청 범위와 어떤 관계인지 분류한다.
 *
 * @param {Object}      fragment - 요청으로 만든 파편
 * @param {Object|null} existing - { workspace, valid_to } 또는 null
 * @returns {"same_scope"|"other_workspace"|"closed"|"unknown"}
 */
export function classifyDuplicate(fragment, existing) {
  if (!existing)                                                      return "unknown";
  if (existing.valid_to != null)                                      return "closed";
  if ((existing.workspace ?? null) !== (fragment.workspace ?? null)) return "other_workspace";
  return "same_scope";
}

/**
 * 중복 적중을 분류해 계수하고, 확인이 켜져 있으면 기존 파편 상태만 담은 응답을 만든다.
 * 확인이 꺼져 있으면 null을 돌려주고 호출부는 기존 흐름을 그대로 잇는다.
 * 상태 조회 실패는 기록하고 unknown으로 분류한다. 저장은 이미 끝나 있으므로 호출을 실패시키지 않는다.
 *
 * @param {{ getDuplicateState: Function }} store
 * @param {Object} fragment - 요청으로 만든 파편
 * @param {string} id       - 기존 파편 id
 * @param {Object} ctx
 * @param {string}      ctx.agentId
 * @param {string|null} ctx.keyId
 * @param {string}      ctx.scope   - 호출 경로가 응답에 싣는 scope 값
 * @returns {Promise<Object|null>}
 */
export async function resolveDuplicateHit(store, fragment, id, { agentId, keyId, scope }) {
  let existing = null;
  try {
    existing = await store.getDuplicateState(id, keyId, agentId);
  } catch (err) {
    logWarn(`[RememberDuplicate] state lookup failed (${id}): ${err.message}`);
  }
  const kind = classifyDuplicate(fragment, existing);
  recordRememberDuplicate(kind);
  if (!isRememberDuplicateGuardEnabled()) return null;
  return {
    id,
    keywords : existing?.keywords ?? [],
    ttl_tier : existing?.ttl_tier ?? null,
    scope,
    conflicts: [],
    existing : true,
    duplicate: kind
  };
}
