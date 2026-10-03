/**
 * 훅 요청 인증 결과 캐시
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 훅은 세션 없이 요청마다 Bearer 키를 보낸다. 요청마다 키 조회와 그룹 조회를 하면 동시 요청에서 DB 연결을
 * 기다리는 시간이 응답 지연의 대부분이 되므로, API 키로 인증한 결과를 키 문자열의 SHA-256으로 찾아 재사용한다.
 *
 * 규칙
 *   - DB API 키로 인증한 결과만 담는다. 마스터 키(DB 조회 없음), OAuth 토큰(검증 시 수명 연장), 실패는 담지 않는다.
 *   - 보존 시간은 MCP 세션의 키 상태 재확인 주기 MEMENTO_SESSION_KEY_RECHECK_MS(기본 30000, 0이면 캐시하지 않음)와 같다.
 *   - 캐시 적중 때도 키 상태 캐시(lib/admin/key-state-cache.js)로 상태와 권한을 확인한다. 비활성이거나 삭제된 키는
 *     항목을 지우고 전체 인증을 다시 한다. 권한은 키 상태의 값으로 바꾼다. 키 상태 캐시는 같은 프로세스의 관리 라우트가
 *     키를 바꿀 때만 즉시 무효화되므로, DB 직접 변경이나 다른 프로세스의 변경은 보존 시간 안에서 늦게 반영된다.
 *   - 캐시 적중도 사용량(api_key_usage, last_used_at)을 센다. 일일 한도(daily_limit) 판정은 전체 인증 때만 하므로
 *     훅 경로의 한도 초과는 보존 시간 안에서 늦게 반영된다.
 *   - 키 문자열 자체는 담지 않는다.
 */

import crypto from "node:crypto";

const MAX_ENTRIES = 10_000;

/**
 * 요청의 인증 헤더로 캐시 키를 만든다. 인증 헤더가 없으면 null.
 *
 * @param {import("node:http").IncomingMessage} req
 * @returns {string|null}
 */
export function authCacheKey(req) {
  const bearer = req.headers?.authorization;
  const legacy = req.headers?.["memento-access-key"];
  if (!bearer && !legacy) return null;
  return crypto.createHash("sha256").update(`${bearer ?? ""}\n${legacy ?? ""}`).digest("hex");
}

/**
 * 인증 함수를 캐시로 감싼다.
 *
 * @param {object} deps
 * @param {(req: object, msg: null) => Promise<object>} deps.authenticate 전체 인증(validateAuthentication)
 * @param {(keyId: string) => Promise<{ exists: boolean, status: string|null, permissions: string[]|null }|null>} deps.keyState
 * @param {(keyId: string) => void} deps.countUsage 사용량 기록(incrementUsage)
 * @param {() => number} deps.ttlMs 보존 시간
 * @param {() => number} [deps.clock]
 * @returns {{ authenticate: (req: object) => Promise<object>, size: () => number }}
 */
export function createHookAuthCache({ authenticate, keyState, countUsage, ttlMs, clock = Date.now }) {
  const entries = new Map();

  async function fromCache(cacheKey) {
    const hit = entries.get(cacheKey);
    if (!hit) return null;
    if (hit.expiresAt <= clock()) {
      entries.delete(cacheKey);
      return null;
    }
    const state = await keyState(hit.auth.keyId);
    if (state && (!state.exists || state.status !== "active")) {
      entries.delete(cacheKey);
      return null;
    }
    countUsage(hit.auth.keyId);
    return state?.permissions ? { ...hit.auth, permissions: state.permissions } : hit.auth;
  }

  return {
    async authenticate(req) {
      const ttl      = ttlMs();
      const cacheKey = ttl > 0 ? authCacheKey(req) : null;
      if (cacheKey) {
        const cached = await fromCache(cacheKey);
        if (cached) return cached;
      }
      const auth = await authenticate(req, null);
      if (cacheKey && auth?.valid === true && typeof auth.keyId === "string" && auth.oauth !== true && auth.isMaster !== true) {
        entries.delete(cacheKey);
        entries.set(cacheKey, { auth, expiresAt: clock() + ttl });
        if (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value);
      }
      return auth;
    },
    size: () => entries.size
  };
}
