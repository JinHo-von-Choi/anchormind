/**
 * QuotaChecker — API 키별 파편 할당량 검사
 *
 * 작성자: 최진호
 * 작성일: 2026-04-04
 * 수정일: 2026-04-20 (getUsage + 10초 TTL 인메모리 캐시 추가 — M3)
 *
 * MemoryManager.remember()에서 인라인으로 처리하던 할당량 검사 트랜잭션을 추출.
 * keyId가 null(마스터 키)이면 검사를 건너뛴다.
 * 키 상한과 키가 속한 그룹의 상한(멤버 키 전체 파편 수) 가운데 남은 수가 가장 적은 것으로 판정한다.
 */

import { getPrimaryPool, withTransaction } from "../tools/db.js";
import { QUOTA_NEAR_LIMIT_MARGIN }         from "../config.js";
import { recordQuotaCachePass }            from "../metrics.js";
import { SCHEMA } from "./schema.js";
import { countLiveFragments, groupQuotaUsage, tightestQuota, lockQuota, quotaExceededError } from "./read/quotaQueries.js";
import { usageCacheGet, usageCacheSet, invalidateUsageCache, clearUsageCache } from "./quota-usage-cache.js";

/**
 * scope는 남은 수가 가장 적은 상한의 종류다(key 또는 group). 상한이 없으면 limit과 remaining이 null이다.
 * groupLimited는 키가 상한 있는 그룹에 속했는지다. 그룹 사용량은 다른 멤버의 저장으로도 줄어 캐시한 남은 수를
 * 믿을 수 없으므로, check()는 이 키를 언제나 잠금 판정한다.
 *
 * @typedef {{ limit: number|null, current: number, remaining: number|null, resetAt: null, scope?: string, groupId?: string, groupLimited?: boolean }} UsageResult
 */

/** 사용량 캐시는 quota-usage-cache.js에 있다. 기존 가져오기 경로를 위해 다시 내보낸다. */
export { invalidateUsageCache, clearUsageCache };

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

    const cached = usageCacheGet(keyId);
    if (cached) return cached;

    const pool = this.#pool || getPrimaryPool();
    if (!pool) {
      return { limit: null, current: 0, remaining: null, resetAt: null };
    }

    const result = await withTransaction(pool, async (client) => {
      await client.query("SET LOCAL app.current_agent_id = 'system'");

      const { rows: [keyRow] } = await client.query(
        `SELECT fragment_limit FROM ${SCHEMA}.api_keys WHERE id = $1`,
        [keyId]
      );
      const keyLimit = keyRow?.fragment_limit ?? null;
      const current  = keyLimit === null ? 0 : await countLiveFragments(client, keyId);
      const groups   = await groupQuotaUsage(client, keyId);
      const quota    = tightestQuota(keyLimit, current, groups);
      if (!quota) return { limit: null, current: 0, remaining: null, resetAt: null };
      return {
        limit: quota.limit, current: quota.current, remaining: quota.remaining, resetAt: null,
        scope: quota.scope, ...(quota.groupId ? { groupId: quota.groupId } : {}), groupLimited: groups.length > 0
      };
    });

    usageCacheSet(keyId, result);
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

    /**
     * 1차: 10초 TTL getUsage 캐시로 저비용 판정.
     * 무제한(limit=null)이거나 여유가 마진보다 크면 락 없이 통과한다.
     */
    const usage = await this.getUsage(keyId);
    if (usage.limit === null) return;
    if (usage.groupLimited !== true && usage.remaining !== null && usage.remaining > QUOTA_NEAR_LIMIT_MARGIN) {
      recordQuotaCachePass();
      return;
    }

    /** 2차: 한도 임박 — 정확성을 위해 FOR UPDATE 정밀 검사 */
    const pool = this.#pool || getPrimaryPool();
    if (!pool) return;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL app.current_agent_id = 'system'");

      const quota = await lockQuota(client, keyId);
      if (quota && quota.remaining <= 0) {
        await client.query("ROLLBACK");
        throw quotaExceededError(quota);
      }

      await client.query("COMMIT");

      /**
       * 정밀 검사 통과 — 곧이어 파편 1건이 삽입되므로 stale 카운트를 방지하기 위해
       * 캐시를 무효화한다. 다음 getUsage/check가 최신 count를 재조회한다.
       */
      invalidateUsageCache(keyId);
    } catch (err) {
      // ROLLBACK 실패만 무시하고 원래 오류를 다시 던진다
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
}
