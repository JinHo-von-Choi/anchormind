/**
 * 세션 사용 시 API 키 상태 재확인 캐시
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * MCP 세션은 수명 동안 저장된 identity를 쓴다. 키가 비활성화되거나 삭제되거나
 * 권한이 바뀌면 그 사실을 세션 사용 시점에 반영하기 위해 키 상태를 짧은 주기로
 * 다시 읽는다. 주기는 MEMENTO_SESSION_KEY_RECHECK_MS(기본 30000, 0이면 재확인 안 함).
 */

import { getKeyAuthState } from "./ApiKeyStore.js";
import { logWarn }         from "../logger.js";

const DEFAULT_RECHECK_MS = 30_000;
const MAX_ENTRIES        = 10_000;
const cache              = new Map();

/**
 * 재확인 주기(ms). 호출 시점의 환경 변수를 읽는다.
 * @returns {number}
 */
export function keyStateRecheckMs() {
  const raw = process.env.MEMENTO_SESSION_KEY_RECHECK_MS;
  if (raw === undefined || raw === "") return DEFAULT_RECHECK_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_RECHECK_MS;
}

/**
 * 키 상태를 캐시 주기 안에서 재사용해 돌려준다.
 * 재확인이 꺼져 있으면 null. 조회가 실패하면 기록하고 직전 값(없으면 null)을 돌려준다.
 * null은 "판정 불가"이며 호출자는 세션의 저장된 identity를 그대로 쓴다.
 *
 * @param {string} keyId
 * @param {number} [now]
 * @returns {Promise<{ exists: boolean, status: string|null, permissions: string[]|null }|null>}
 */
export async function getCachedKeyState(keyId, now = Date.now()) {
  const ttl = keyStateRecheckMs();
  if (ttl === 0 || !keyId) return null;

  const hit = cache.get(keyId);
  if (hit && hit.expiresAt > now) return hit.state;

  try {
    const state = await getKeyAuthState(keyId);
    cache.delete(keyId);
    cache.set(keyId, { state, expiresAt: now + ttl });
    if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
    return state;
  } catch (err) {
    logWarn(`[Session] key state lookup failed: ${err.message}`);
    return hit ? hit.state : null;
  }
}

/**
 * 키 상태 변경 직후 캐시 항목을 지운다.
 * @param {string} keyId
 */
export function invalidateKeyState(keyId) {
  cache.delete(keyId);
}

/**
 * 세션이 더 쓰일 수 없는 키 상태인지 판정한다.
 * @param {{ exists: boolean, status: string|null }|null} state
 * @returns {boolean}
 */
export function isKeyStateRevoked(state) {
  return state !== null && (state.exists !== true || state.status !== "active");
}
