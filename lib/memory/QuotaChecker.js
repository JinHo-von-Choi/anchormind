/**
 * QuotaChecker — API 키별 파편 할당량 검사
 *
 * 작성자: 최진호
 * 작성일: 2026-04-04
 * 수정일: 2026-04-20 (getUsage + 10초 TTL 인메모리 캐시 추가 — M3)
 *
 * MemoryManager.remember()에서 인라인으로 처리하던 할당량 검사 트랜잭션을 추출.
 * keyId가 null(마스터 키)이면 검사를 건너뛴다.
 */

import { getPrimaryPool, withTransaction } from "../tools/db.js";

/**
 * getUsage 결과 인메모리 캐시.
 * Map<keyId, { value: UsageResult, expiresAt: number }>
 * 최대 1000개 항목, TTL 10초.
 */
const _usageCache    = new Map();
const _CACHE_TTL_MS  = 10_000;
const _CACHE_MAX     = 1000;

/**
 * @typedef {{ limit: number|null, current: number, remaining: number|null, resetAt: null }} UsageResult
 */

/**
 * 캐시에서 유효한 UsageResult를 반환한다.
 * 만료된 항목은 삭제 후 null 반환.
 *
 * @param {string} keyId
 * @returns {UsageResult|null}
 */
function _cacheGet(keyId) {
  const entry = _usageCache.get(keyId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    _usageCache.delete(keyId);
    return null;
  }
  return entry.value;
}

/**
 * 캐시에 UsageResult를 저장한다.
 * 크기 상한 초과 시 가장 오래된 항목을 축출한다.
 *
 * @param {string}      keyId
 * @param {UsageResult} value
 */
function _cacheSet(keyId, value) {
  if (_usageCache.size >= _CACHE_MAX) {
    /** Map iteration 순서는 삽입 순. 첫 번째(최고령) 항목 삭제. */
    _usageCache.delete(_usageCache.keys().next().value);
  }
  _usageCache.set(keyId, { value, expiresAt: Date.now() + _CACHE_TTL_MS });
}

/**
 * 특정 키의 캐시를 무효화한다.
 * remember / forget mutation 이후 호출하여 stale 응답을 방지한다.
 *
 * @param {string|null} keyId
 */
export function invalidateUsageCache(keyId) {
  if (keyId) _usageCache.delete(keyId);
}

/** 테스트용: 전체 캐시 초기화 */
export function clearUsageCache() { _usageCache.clear(); }

export class QuotaChecker {
  #pool = null;

  /** 테스트용 pool 주입 */
  setPool(pool) { this.#pool = pool; }

  /**
   * API 키의 현재 파편 사용량을 반환한다 (10초 TTL 캐시).
   * keyId가 null(마스터 키)이면 무제한 응답을 즉시 반환한다.
   *
   * @param {string|null} keyId
   * @returns {Promise<UsageResult>}
   */
  async getUsage(keyId) {
    if (!keyId) {
      return { limit: null, current: 0, remaining: null, resetAt: null };
    }

    const cached = _cacheGet(keyId);
    if (cached) return cached;

    const pool = this.#pool || getPrimaryPool();
    if (!pool) {
      return { limit: null, current: 0, remaining: null, resetAt: null };
    }

    const result = await withTransaction(pool, async (client) => {
      await client.query("SET LOCAL app.current_agent_id = 'system'");

      const { rows: [keyRow] } = await client.query(
        `SELECT fragment_limit FROM agent_memory.api_keys WHERE id = $1`,
        [keyId]
      );

      let result;
      if (!keyRow || keyRow.fragment_limit === null) {
        result = { limit: null, current: 0, remaining: null, resetAt: null };
      } else {
        const { rows: [countRow] } = await client.query(
          `SELECT COUNT(*)::int AS count FROM agent_memory.fragments
           WHERE key_id = $1 AND valid_to IS NULL`,
          [keyId]
        );
        const current   = countRow.count;
        const limit     = keyRow.fragment_limit;
        const remaining = Math.max(0, limit - current);
        result = { limit, current, remaining, resetAt: null };
      }

      return result;
    });

    _cacheSet(keyId, result);
    return result;
  }

  /**
   * API 키의 파편 할당량을 검사한다.
   * 초과 시 code="fragment_limit_exceeded" Error를 throw한다.
   * keyId가 null(마스터 키)이면 검사를 건너뛴다.
   *
   * @param {string|null} keyId
   */
  async check(keyId) {
    if (!keyId) return;

    const pool = this.#pool || getPrimaryPool();
    if (!pool) return;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL app.current_agent_id = 'system'");

      const { rows: [keyRow] } = await client.query(
        `SELECT fragment_limit FROM agent_memory.api_keys WHERE id = $1 FOR UPDATE`,
        [keyId]
      );

      if (keyRow && keyRow.fragment_limit !== null) {
        const { rows: [countRow] } = await client.query(
          `SELECT COUNT(*)::int AS count FROM agent_memory.fragments
           WHERE key_id = $1 AND valid_to IS NULL`,
          [keyId]
        );

        if (countRow.count >= keyRow.fragment_limit) {
          await client.query("ROLLBACK");
          const err    = new Error(
            `Fragment limit reached (${countRow.count}/${keyRow.fragment_limit}). Delete unused fragments or request a higher limit.`
          );
          err.code     = "fragment_limit_exceeded";
          err.current  = countRow.count;
          err.limit    = keyRow.fragment_limit;
          throw err;
        }
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
}
