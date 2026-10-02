/**
 * Circuit Breaker — LLM Provider 장애 격리
 *
 * REDIS_ENABLED=true 면 Redis(`llm:cb:` 프리픽스)로 상태를 공유하여
 * 멀티 프로세스/분산 환경에서도 동일한 breaker 상태를 유지한다.
 * Redis가 비활성화되어 있으면 in-memory Map으로 동작한다 (단일 프로세스 전용).
 *
 * 임계값 환경 변수 (Task 8에서 config.js에 추가 예정):
 *   LLM_CB_FAILURE_THRESHOLD  — 실패 횟수 임계값 (기본 5)
 *   LLM_CB_OPEN_DURATION_MS   — open 상태 지속 시간 ms (기본 60000)
 *   LLM_CB_FAILURE_WINDOW_MS  — 실패 집계 윈도우 ms (기본 60000)
 *
 * 작성자: 최진호
 * 작성일: 2026-04-16
 */

import { redisClient }      from "../../redis.js";
import { REDIS_ENABLED, LLM_CB_FAILURE_THRESHOLD, LLM_CB_OPEN_DURATION_MS, LLM_CB_FAILURE_WINDOW_MS } from "../../config.js";

// ---------------------------------------------------------------------------
// 설정값 (config.js)
// ---------------------------------------------------------------------------

const FAILURE_THRESHOLD  = LLM_CB_FAILURE_THRESHOLD;
const OPEN_DURATION_MS   = LLM_CB_OPEN_DURATION_MS;
const FAILURE_WINDOW_MS  = LLM_CB_FAILURE_WINDOW_MS;

const REDIS_PREFIX       = "llm:cb:";
const REDIS_TTL_SECONDS  = Math.ceil((OPEN_DURATION_MS + FAILURE_WINDOW_MS) / 1000) + 60;

// ---------------------------------------------------------------------------
// In-memory 상태 (Redis 비활성화 시)
// ---------------------------------------------------------------------------

/** @type {Map<string, {failures: Array<number>, openedAt: number|null}>} */
const memState = new Map();

function getMemState(name) {
  if (!memState.has(name)) {
    memState.set(name, { failures: [], openedAt: null });
  }
  return memState.get(name);
}

// ---------------------------------------------------------------------------
// Redis 기반 구현
// ---------------------------------------------------------------------------

/**
 * Redis 작업 실패는 회로차단기 자체의 장애로 치환하면 안 된다.
 * Redis가 죽거나 연결이 닫혀 있으면 회로 상태를 알 수 없으므로 보수적으로
 * "열려있지 않음"(호출 허용)을 반환하고 상태 변경은 silently skip한다.
 * 다음 호출에서 Redis가 복구되면 자동으로 재시도된다.
 */
async function redisIsOpen(name) {
  try {
    const openedAtStr = await redisClient.get(`${REDIS_PREFIX}${name}:openedAt`);
    if (!openedAtStr) return false;
    const openedAt = parseInt(openedAtStr, 10);
    if (Date.now() - openedAt >= OPEN_DURATION_MS) {
      // half-open: 자동 재시도 허용
      await redisClient.del(`${REDIS_PREFIX}${name}:openedAt`);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function redisRecordFailure(name) {
  try {
    const now     = Date.now();
    const listKey = `${REDIS_PREFIX}${name}:failures`;

    // failures 리스트에 현재 타임스탬프 push
    await redisClient.rpush(listKey, String(now));
    await redisClient.expire(listKey, REDIS_TTL_SECONDS);

    // 윈도우 밖 항목 수는 직접 trim 불가이므로 전체 조회 후 필터
    // (Redis Sorted Set이 더 적합하지만 ioredis lrange로 단순 처리)
    const raw = await redisClient.lrange ? (await redisClient.lrange(listKey, 0, -1)) : [];
    const windowStart  = now - FAILURE_WINDOW_MS;
    const recentCount  = raw.filter(ts => parseInt(ts, 10) >= windowStart).length;

    if (recentCount >= FAILURE_THRESHOLD) {
      await redisClient.setex(`${REDIS_PREFIX}${name}:openedAt`, REDIS_TTL_SECONDS, String(now));
    }
  } catch {
    // Redis 장애 시 상태 기록을 포기한다. 다음 호출에서 재시도된다.
  }
}

async function redisRecordSuccess(name) {
  try {
    await redisClient.del(`${REDIS_PREFIX}${name}:openedAt`);
    await redisClient.del(`${REDIS_PREFIX}${name}:failures`);
  } catch {}
}

async function redisReset(name) {
  try {
    await redisClient.del(`${REDIS_PREFIX}${name}:openedAt`);
    await redisClient.del(`${REDIS_PREFIX}${name}:failures`);
  } catch {}
}

// ---------------------------------------------------------------------------
// In-memory 기반 구현
// ---------------------------------------------------------------------------

function memIsOpen(name) {
  const s = getMemState(name);
  if (s.openedAt === null) return false;
  if (Date.now() - s.openedAt >= OPEN_DURATION_MS) {
    s.openedAt = null; // half-open: 재시도 허용
    return false;
  }
  return true;
}

function memRecordFailure(name) {
  const s         = getMemState(name);
  const now       = Date.now();
  const windowStart = now - FAILURE_WINDOW_MS;

  // 윈도우 밖 항목 제거
  s.failures = s.failures.filter(ts => ts >= windowStart);
  s.failures.push(now);

  if (s.failures.length >= FAILURE_THRESHOLD) {
    s.openedAt = now;
  }
}

function memRecordSuccess(name) {
  const s    = getMemState(name);
  s.failures = [];
  s.openedAt = null;
}

function memReset(name) {
  memState.delete(name);
}

// ---------------------------------------------------------------------------
// 라우팅: Redis 활성화 여부에 따라 구현체 선택
// ---------------------------------------------------------------------------

/**
 * Circuit breaker 인터페이스.
 * Redis/in-memory 구현을 자동으로 선택한다.
 *
 * 모든 메서드는 async (Redis 경로를 통합하기 위함).
 * in-memory 경로에서도 동일하게 Promise를 반환한다.
 */
export const circuitBreaker = {
  /**
   * 해당 provider의 circuit이 open 상태인지 확인한다.
   * open이면 호출을 건너뛰고 폴백으로 진행한다.
   *
   * @param {string} name - provider 이름
   * @returns {Promise<boolean>}
   */
  async isOpen(name) {
    if (REDIS_ENABLED) return redisIsOpen(name);
    return memIsOpen(name);
  },

  /**
   * 실패를 기록한다. 임계값 초과 시 circuit을 open 상태로 전환한다.
   *
   * @param {string} name
   * @returns {Promise<void>}
   */
  async recordFailure(name) {
    if (REDIS_ENABLED) return redisRecordFailure(name);
    return memRecordFailure(name);
  },

  /**
   * 성공을 기록하고 circuit을 closed 상태로 복원한다.
   *
   * @param {string} name
   * @returns {Promise<void>}
   */
  async recordSuccess(name) {
    if (REDIS_ENABLED) return redisRecordSuccess(name);
    return memRecordSuccess(name);
  },

  /**
   * 특정 provider의 circuit 상태를 강제 리셋한다 (테스트/수동 복구용).
   *
   * @param {string} name
   * @returns {Promise<void>}
   */
  async reset(name) {
    if (REDIS_ENABLED) return redisReset(name);
    return memReset(name);
  }
};
