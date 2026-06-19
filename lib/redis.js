/**
 * Redis 클라이언트 설정
 *
 * 작성자: 최진호
 * 작성일: 2026-02-13
 * 수정일: 2026-02-13 (Phase 3: Redis Sentinel 지원 추가)
 *
 * 기능:
 * - 세션 저장소
 * - OAuth 토큰 저장소
 * - 캐싱 레이어
 * - TTL 관리
 * - Redis Sentinel 고가용성 (Phase 3)
 */

import Redis from "ioredis";
import { logInfo, logWarn, logError } from "./logger.js";
import {
  REDIS_ENABLED,
  REDIS_SENTINEL_ENABLED,
  REDIS_HOST,
  REDIS_PORT,
  REDIS_PASSWORD,
  REDIS_DB,
  REDIS_MASTER_NAME,
  REDIS_SENTINELS
} from "./config.js";
import { recordRedisSessionSaveFailure } from "./metrics.js";

/**
 * REDIS_ENABLED != "true" 시
 * 실제 연결 없이 no-op 메서드를 반환하는 stub 클라이언트.
 */
function createStubClient() {
  const noop   = async () => null;
  const noopOk = async () => "OK";
  return {
    status: "stub",
    get: noop, set: noopOk, setex: noopOk, del: noop,
    lpush: noop, rpush: noop, rpop: noop, lpop: noop,
    rpoplpush: noop, lrem: async () => 0,
    keys: async () => [], llen: async () => 0, expire: noop, ping: noopOk,
    quit: noop, disconnect: noop,
    on: () => {},
    once: () => {}, removeListener: () => {},
  };
}

/**
 * Redis 클라이언트 생성
 * - Sentinel 활성화 시: Sentinel 연결
 * - 단일 모드: 직접 연결
 */
function createRedisClient() {
  if (!REDIS_ENABLED) {
    logInfo("Redis disabled (REDIS_ENABLED != true) — using stub client");
    return createStubClient();
  }
  const commonOptions = {
    password       : REDIS_PASSWORD,
    db             : REDIS_DB,
    retryStrategy  : (times) => {
      const delay    = Math.min(times * 50, 2000);
      logWarn(`Redis reconnecting (attempt ${times}), delay ${delay}ms`);
      return delay;
    },
    maxRetriesPerRequest: 3,
    enableReadyCheck    : true,
    lazyConnect         : true
  };

  if (REDIS_SENTINEL_ENABLED) {
    // Redis Sentinel 모드
    logInfo("Initializing Redis with Sentinel", {
      masterName: REDIS_MASTER_NAME,
      sentinels : REDIS_SENTINELS
    });

    return new Redis({
      sentinels: REDIS_SENTINELS,
      name     : REDIS_MASTER_NAME,
      ...commonOptions
    });
  } else {
    // 단일 Redis 모드
    logInfo("Initializing Redis in standalone mode", {
      host: REDIS_HOST,
      port: REDIS_PORT
    });

    return new Redis({
      host: REDIS_HOST,
      port: REDIS_PORT,
      ...commonOptions
    });
  }
}

/** Redis 클라이언트 */
export const redisClient = createRedisClient();

/** 이벤트 핸들러 */
redisClient.on("connect", () => {
  logInfo("Redis client connected", {
    host: REDIS_HOST,
    port: REDIS_PORT,
    db  : REDIS_DB
  });
});

redisClient.on("ready", () => {
  logInfo("Redis client ready");
});

redisClient.on("error", (err) => {
  logError("Redis client error", err, {
    host: REDIS_HOST,
    port: REDIS_PORT
  });
});

redisClient.on("close", () => {
  logWarn("Redis client connection closed");
});

redisClient.on("reconnecting", () => {
  logInfo("Redis client reconnecting...");
});

/**
 * Redis 헬스 체크
 */
export async function checkRedisHealth() {
  try {
    await redisClient.ping();
    return { healthy: true, message: "Redis is healthy" };
  } catch (err) {
    logError("Redis health check failed", err);
    return { healthy: false, message: err.message };
  }
}

/**
 * 세션 키 생성
 */
export function getSessionKey(sessionId) {
  return `session:${sessionId}`;
}

/**
 * OAuth 코드 키 생성
 */
export function getOAuthCodeKey(code) {
  return `oauth:code:${code}`;
}

/**
 * OAuth 토큰 키 생성
 */
export function getOAuthTokenKey(token) {
  return `oauth:token:${token}`;
}

/**
 * 문서 캐시 키 생성
 */
export function getDocCacheKey(path) {
  return `cache:doc:${path}`;
}

/**
 * DB 쿼리 캐시 키 생성
 */
export function getDbCacheKey(sql, params = []) {
  const hash = Buffer.from(`${sql}:${JSON.stringify(params)}`).toString("base64");
  return `cache:db:${hash}`;
}

/**
 * 세션 저장 (TTL 포함)
 */
export async function saveSession(sessionId, sessionData, ttlSeconds) {
  try {
    const key      = getSessionKey(sessionId);
    const value    = JSON.stringify(sessionData);

    await redisClient.setex(key, ttlSeconds, value);

    logInfo("Session saved to Redis", {
      sessionId: sessionId.substring(0, 8),
      ttl      : ttlSeconds
    });

    return true;
  } catch (err) {
    logError("Failed to save session to Redis", err, { sessionId });
    recordRedisSessionSaveFailure("save");
    return false;
  }
}

/**
 * 세션 조회
 */
export async function getSession(sessionId) {
  try {
    const key      = getSessionKey(sessionId);
    const value    = await redisClient.get(key);

    if (!value) {
      return null;
    }

    return JSON.parse(value);
  } catch (err) {
    logError("Failed to get session from Redis", err, { sessionId });
    return null;
  }
}

/**
 * 세션 삭제
 */
export async function deleteSession(sessionId) {
  try {
    const key      = getSessionKey(sessionId);
    await redisClient.del(key);

    logInfo("Session deleted from Redis", {
      sessionId: sessionId.substring(0, 8)
    });

    return true;
  } catch (err) {
    logError("Failed to delete session from Redis", err, { sessionId });
    return false;
  }
}

/**
 * 세션 TTL 연장
 */
export async function extendSessionTTL(sessionId, ttlSeconds) {
  try {
    const key      = getSessionKey(sessionId);
    await redisClient.expire(key, ttlSeconds);

    return true;
  } catch (err) {
    logError("Failed to extend session TTL", err, { sessionId });
    return false;
  }
}

/**
 * 토큰-세션 역인덱스 키
 * 동일 토큰으로 여러 initialize가 들어올 때 기존 세션을 재사용하기 위함.
 */
export function getTokenSessionKey(tokenKey) {
  return `token_session:${tokenKey}`;
}

/**
 * 토큰에 세션 ID 바인딩 (TTL 포함)
 */
export async function bindTokenToSession(tokenKey, sessionId, ttlSeconds) {
  try {
    const key = getTokenSessionKey(tokenKey);
    await redisClient.setex(key, ttlSeconds, sessionId);
    return true;
  } catch (err) {
    logError("Failed to bind token to session", err, { tokenKey: tokenKey?.substring(0, 8) });
    return false;
  }
}

/**
 * 토큰에 매핑된 세션 ID 조회
 */
export async function getSessionIdByToken(tokenKey) {
  try {
    const key = getTokenSessionKey(tokenKey);
    const value = await redisClient.get(key);
    return value || null;
  } catch (err) {
    logError("Failed to get sessionId by token", err, { tokenKey: tokenKey?.substring(0, 8) });
    return null;
  }
}

/**
 * 토큰 바인딩 해제
 */
export async function unbindToken(tokenKey) {
  try {
    const key = getTokenSessionKey(tokenKey);
    await redisClient.del(key);
    return true;
  } catch (err) {
    logError("Failed to unbind token", err, { tokenKey: tokenKey?.substring(0, 8) });
    return false;
  }
}

/**
 * OAuth 코드 저장
 */
export async function saveOAuthCode(code, codeData, ttlSeconds = 600) {
  try {
    const key      = getOAuthCodeKey(code);
    const value    = JSON.stringify(codeData);

    await redisClient.setex(key, ttlSeconds, value);

    return true;
  } catch (err) {
    logError("Failed to save OAuth code to Redis", err);
    return false;
  }
}

/**
 * OAuth 코드 조회 및 삭제 (일회성)
 */
export async function consumeOAuthCode(code) {
  try {
    const key      = getOAuthCodeKey(code);
    const value    = await redisClient.get(key);

    if (!value) {
      return null;
    }

    // 사용 즉시 삭제 (일회성)
    await redisClient.del(key);

    return JSON.parse(value);
  } catch (err) {
    logError("Failed to consume OAuth code from Redis", err);
    return null;
  }
}

/**
 * OAuth 액세스 토큰 저장
 */
export async function saveOAuthToken(token, tokenData, ttlSeconds = 3600) {
  try {
    const key      = getOAuthTokenKey(token);
    const value    = JSON.stringify(tokenData);

    await redisClient.setex(key, ttlSeconds, value);

    return true;
  } catch (err) {
    logError("Failed to save OAuth token to Redis", err);
    return false;
  }
}

/**
 * OAuth 액세스 토큰 조회
 */
export async function getOAuthToken(token) {
  try {
    const key      = getOAuthTokenKey(token);
    const value    = await redisClient.get(key);

    if (!value) {
      return null;
    }

    return JSON.parse(value);
  } catch (err) {
    logError("Failed to get OAuth token from Redis", err);
    return null;
  }
}

/**
 * OAuth 액세스 토큰 삭제
 */
export async function deleteOAuthToken(token) {
  try {
    const key      = getOAuthTokenKey(token);
    await redisClient.del(key);

    return true;
  } catch (err) {
    logError("Failed to delete OAuth token from Redis", err);
    return false;
  }
}

export async function extendOAuthToken(token, ttlSeconds) {
  if (!REDIS_ENABLED) return;
  try {
    const key = getOAuthTokenKey(token);
    await redisClient.expire(key, ttlSeconds);
  } catch { /* 갱신 실패는 무시 */ }
}

/**
 * 문서 캐시 저장
 */
export async function cacheDocument(path, content, ttlSeconds = 3600) {
  try {
    const key      = getDocCacheKey(path);
    const value    = JSON.stringify({ content, cachedAt: Date.now() });

    await redisClient.setex(key, ttlSeconds, value);

    return true;
  } catch (err) {
    logError("Failed to cache document", err, { path });
    return false;
  }
}

/**
 * 문서 캐시 조회
 */
export async function getCachedDocument(path) {
  try {
    const key      = getDocCacheKey(path);
    const value    = await redisClient.get(key);

    if (!value) {
      return null;
    }

    const data     = JSON.parse(value);

    return data.content;
  } catch (err) {
    logError("Failed to get cached document", err, { path });
    return null;
  }
}

/**
 * 문서 캐시 무효화
 */
export async function invalidateDocumentCache(path) {
  try {
    const key      = getDocCacheKey(path);
    await redisClient.del(key);

    logInfo("Document cache invalidated", { path });

    return true;
  } catch (err) {
    logError("Failed to invalidate document cache", err, { path });
    return false;
  }
}

/**
 * DB 쿼리 결과 캐시
 */
export async function cacheDbQuery(sql, params, result, ttlSeconds = 300) {
  try {
    const key      = getDbCacheKey(sql, params);
    const value    = JSON.stringify({ result, cachedAt: Date.now() });

    await redisClient.setex(key, ttlSeconds, value);

    return true;
  } catch (err) {
    logError("Failed to cache DB query", err);
    return false;
  }
}

/**
 * DB 쿼리 캐시 조회
 */
export async function getCachedDbQuery(sql, params) {
  try {
    const key      = getDbCacheKey(sql, params);
    const value    = await redisClient.get(key);

    if (!value) {
      return null;
    }

    const data     = JSON.parse(value);

    return data.result;
  } catch (err) {
    logError("Failed to get cached DB query", err);
    return null;
  }
}

/**
 * 전체 캐시 무효화 (패턴 기반)
 */
export async function invalidateCacheByPattern(pattern) {
  try {
    const keys     = await redisClient.keys(pattern);

    if (keys.length > 0) {
      await redisClient.del(...keys);
      logInfo(`Cache invalidated: ${keys.length} keys deleted`, { pattern });
    }

    return keys.length;
  } catch (err) {
    logError("Failed to invalidate cache by pattern", err, { pattern });
    return 0;
  }
}

/**
 * 큐에 작업 추가 (LPUSH)
 */
export async function pushToQueue(queueName, data) {
  try {
    const key   = `queue:${queueName}`;
    const value = JSON.stringify({ ...data, queuedAt: Date.now() });
    await redisClient.lpush(key, value);
    return true;
  } catch (err) {
    logError(`Failed to push to queue ${queueName}`, err);
    return false;
  }
}

/**
 * 큐 우선순위 삽입 (RPUSH — rpop이 즉시 꺼냄)
 *
 * EmbeddingWorker는 rpop으로 꺼내므로 rpush로 넣으면 다음 배치에서 가장 먼저 처리된다.
 * reflect() 직후처럼 임베딩이 즉시 필요한 파편에 사용.
 */
export async function pushToQueuePriority(queueName, data) {
  try {
    const key   = `queue:${queueName}`;
    const value = JSON.stringify({ ...data, queuedAt: Date.now(), priority: true });
    await redisClient.rpush(key, value);
    return true;
  } catch (err) {
    logError(`Failed to priority-push to queue ${queueName}`, err);
    return false;
  }
}

/**
 * 큐에서 작업 꺼내기 (RPOP)
 */
export async function popFromQueue(queueName) {
  try {
    const key   = `queue:${queueName}`;
    const value = await redisClient.rpop(key);
    return value ? JSON.parse(value) : null;
  } catch (err) {
    logError(`Failed to pop from queue ${queueName}`, err);
    return null;
  }
}

/** 테스트 전용: 활성 redis 클라이언트 교체 (단위 테스트 fake 주입) */
let _activeClient = redisClient;
export function __setRedisClientForTest(client) { _activeClient = client; }
function _client() { return _activeClient; }

/**
 * 신뢰성 pop: 메인 큐 tail → processing 리스트 head 로 원자 이동(RPOPLPUSH).
 * 처리 성공 시 ackQueueItem(raw)로 processing 에서 제거해야 한다.
 * @param {string} queueName
 * @returns {Promise<{data: object, raw: string}|null>}
 */
export async function popFromQueueReliable(queueName) {
  try {
    const src = `queue:${queueName}`;
    const dst = `queue:${queueName}:processing`;
    const raw = await _client().rpoplpush(src, dst);
    return raw ? { data: JSON.parse(raw), raw } : null;
  } catch (err) {
    logError(`Failed reliable-pop from queue ${queueName}`, err);
    return null;
  }
}

/**
 * 처리 완료 ack: processing 리스트에서 해당 raw 항목 제거.
 *
 * LREM count=1 은 동일 raw 문자열의 첫 일치 1건만 제거한다. job 봉투는
 * 고유 jobId 를 포함하므로 정상 운영에서 동일 raw 중복은 발생하지 않는다.
 *
 * @param {string} queueName
 * @param {string} raw
 * @returns {Promise<boolean>}
 */
export async function ackQueueItem(queueName, raw) {
  try {
    const removed = await _client().lrem(`queue:${queueName}:processing`, 1, raw);
    return removed > 0;
  } catch (err) {
    logError(`Failed to ack queue item ${queueName}`, err);
    return false;
  }
}

/**
 * 기동 복구: processing 잔존 항목을 메인 큐로 되돌린다(at-least-once).
 *
 * RPOPLPUSH 로 복구분이 메인 큐 head 에 삽입되므로, 대기 중이던 항목보다
 * 먼저 재처리된다(순서 변경). 크래시 복구 용도라 엄격한 FIFO 순서는 요구되지
 * 않으며, 유실 방지(at-least-once)가 우선이다.
 *
 * @param {string} queueName
 * @returns {Promise<number>} 복구된 항목 수
 */
export async function requeueProcessing(queueName) {
  try {
    const src = `queue:${queueName}:processing`;
    const dst = `queue:${queueName}`;
    let moved = 0;
    while (true) {
      const v = await _client().rpoplpush(src, dst);
      if (v === null || v === undefined) break;
      moved++;
    }
    return moved;
  } catch (err) {
    logError(`Failed to requeue processing ${queueName}`, err);
    return 0;
  }
}

/**
 * Redis 리스트 큐 길이 조회
 * @param {string} queueName
 * @returns {Promise<number>}
 */
export async function getQueueLength(queueName) {
  const key = `memento:${queueName}`;
  if (!redisClient || redisClient.status === "stub") return 0;
  const len = await redisClient.llen(key);
  return len || 0;
}

/**
 * Redis 연결 종료
 */
export async function closeRedis() {
  try {
    await redisClient.quit();
    logInfo("Redis connection closed");
  } catch (err) {
    logError("Failed to close Redis connection", err);
  }
}

/**
 * Redis 연결 초기화 (모듈 로드 시 자동 연결되므로 ready 상태 확인만 수행)
 */
export async function connectRedis() {
  /** ioredis는 생성 즉시 연결을 시도하므로 별도 connect() 호출 불필요 */
}

/**
 * Redis 연결 종료 (closeRedis 별칭)
 */
export const disconnectRedis = closeRedis;

export default redisClient;
