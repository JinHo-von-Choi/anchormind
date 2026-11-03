/**
 * 할당량 사용량 캐시(QuotaChecker.getUsage 결과)
 *
 * 작성자: 최진호
 * 작성일: 2026-11-04
 *
 * 키 정책을 바꾼 쪽(관리 API, CLI 알림을 받은 서버)이 DB 계층을 불러오지 않고 지울 수 있도록 캐시만 따로 둔다.
 * Map<keyId, { value: UsageResult, expiresAt: number }>, 최대 1000개, TTL 10초. 다른 모듈을 가져오지 않는다.
 */

const usageCache = new Map();
const CACHE_TTL_MS = 10_000;
const CACHE_MAX    = 1000;

/**
 * 캐시에서 유효한 값을 돌려준다. 만료된 항목은 지우고 null이다.
 *
 * @param {string} keyId
 * @returns {object|null}
 */
export function usageCacheGet(keyId) {
  const entry = usageCache.get(keyId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    usageCache.delete(keyId);
    return null;
  }
  return entry.value;
}

/**
 * 캐시에 넣는다. 상한을 넘으면 가장 오래된 항목을 뺀다(Map은 삽입 순서를 지킨다).
 *
 * @param {string} keyId
 * @param {object} value
 */
export function usageCacheSet(keyId, value) {
  if (usageCache.size >= CACHE_MAX) usageCache.delete(usageCache.keys().next().value);
  usageCache.set(keyId, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

/**
 * 키 하나의 캐시를 지운다. remember, forget, 상한 변경 뒤에 부른다.
 *
 * @param {string|null} keyId
 */
export function invalidateUsageCache(keyId) {
  if (keyId) usageCache.delete(keyId);
}

/** 시험용: 전체 캐시 초기화 */
export function clearUsageCache() {
  usageCache.clear();
}
