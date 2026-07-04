/**
 * FragmentIndex - Redis 역인덱스 관리
 *
 * 작성자: 최진호
 * 작성일: 2026-02-23
 *
 * 키 네임스페이스: frag:* (기존 cache:*, session:*, oauth:*와 분리)
 */

import { redisClient } from "../redis.js";
import { logInfo, logWarn } from "../logger.js";
import { FragmentFactory } from "./write/FragmentFactory.js";

const KW_PREFIX      = "frag:kw:";
const TOPIC_PREFIX   = "frag:tp:";
const TYPE_PREFIX    = "frag:ty:";
const RECENT_KEY     = "frag:recent";
const HOT_PREFIX     = "frag:hot:";
const SESSION_PREFIX = "frag:sess:";
const WM_PREFIX      = "frag:wm:";
const MAX_SET_SIZE   = 5000;
const HOT_CACHE_TTL  = 7200;
const WM_TTL         = 86400;
const WM_MAX_TOKENS  = 500;
const SEEN_PREFIX    = "frag:seen:";
const SEEN_TTL       = 86400;

/**
 * keyId에 따른 Redis 키 네임스페이스 접두어를 반환한다.
 * - null (master key): "_g" (global)
 * - 숫자/문자열 (DB API key): "_k{keyId}"
 *
 * @throws {Error} 배열이 전달된 경우 — 그룹 검색은 keyNsList()를 사용해야 한다.
 */
function keyNs(keyId) {
  if (Array.isArray(keyId)) {
    throw new Error(
      `keyNs() received array. Use keyNsList() for group-aware operations. Got: ${keyId}`
    );
  }
  return keyId == null ? "_g" : `_k${keyId}`;
}

/**
 * 그룹 keyId를 namespace 배열로 변환한다.
 * - null: ["_g"]
 * - 단일 값: ["_k{keyId}"]
 * - 배열: ["_k{keyId[0]}", "_k{keyId[1]}", ...]
 */
function keyNsList(keyId) {
  if (keyId == null) return ["_g"];
  if (Array.isArray(keyId)) return keyId.map(k => `_k${k}`);
  return [`_k${keyId}`];
}

export class FragmentIndex {

  /**
     * 파편을 역인덱스에 등록
     */
  async index(fragment, sessionId, keyId = null) {
    if (!redisClient || redisClient.status !== "ready") return;

    const ns       = keyNs(keyId);
    const pipeline = redisClient.pipeline();
    const now      = Date.now();

    /** 명시적 키워드 인덱싱 */
    for (const kw of (fragment.keywords || [])) {
      pipeline.sadd(`${KW_PREFIX}${ns}:${kw.toLowerCase()}`, fragment.id);
    }

    /** 콘텐츠 본문에서 추출한 용어도 인덱싱 — L1 hit rate 향상 */
    if (fragment.content) {
      const factory       = new FragmentFactory();
      const contentTerms  = factory.extractKeywords(fragment.content, 8);
      const explicitLower = new Set((fragment.keywords || []).map(k => k.toLowerCase()));
      for (const term of contentTerms) {
        if (!explicitLower.has(term)) {
          pipeline.sadd(`${KW_PREFIX}${ns}:${term}`, fragment.id);
        }
      }
    }

    pipeline.sadd(`${TOPIC_PREFIX}${ns}:${fragment.topic}`, fragment.id);
    pipeline.sadd(`${TYPE_PREFIX}${ns}:${fragment.type}`, fragment.id);
    pipeline.zadd(`${RECENT_KEY}:${ns}`, now, fragment.id);

    if (sessionId) {
      pipeline.sadd(`${SESSION_PREFIX}${sessionId}`, fragment.id);
      pipeline.expire(`${SESSION_PREFIX}${sessionId}`, 86400);
    }

    await pipeline.exec().catch(err =>
      logWarn(`[FragmentIndex] index failed: ${err.message}`)
    );
  }

  /**
     * 파편을 역인덱스에서 제거
     */
  async deindex(fragmentId, keywords, topic, type, keyId = null) {
    if (!redisClient || redisClient.status !== "ready") return;

    const ns       = keyNs(keyId);
    const pipeline = redisClient.pipeline();

    for (const kw of (keywords || [])) {
      pipeline.srem(`${KW_PREFIX}${ns}:${kw.toLowerCase()}`, fragmentId);
    }

    if (topic) pipeline.srem(`${TOPIC_PREFIX}${ns}:${topic}`, fragmentId);
    if (type)  pipeline.srem(`${TYPE_PREFIX}${ns}:${type}`, fragmentId);
    pipeline.zrem(`${RECENT_KEY}:${ns}`, fragmentId);
    pipeline.del(`${HOT_PREFIX}${ns}:${fragmentId}`);

    await pipeline.exec().catch(err =>
      logWarn(`[FragmentIndex] deindex failed: ${err.message}`)
    );
  }

  /**
   * 그룹 keyId에 대해 각 멤버 namespace에서 fetcher를 실행하고 결과를 union한다.
   * 단일 keyId면 fetcher를 직접 호출한다.
   *
   * @param {string|string[]|null} keyId
   * @param {function(ns: string): Promise<string[]>} fetcher
   * @returns {Promise<string[]>}
   */
  async _unionFromKeyNamespaces(keyId, fetcher) {
    if (!Array.isArray(keyId)) return fetcher(keyNs(keyId));
    const results = await Promise.all(keyId.map(k => fetcher(`_k${k}`)));
    const union   = new Set();
    for (const r of results) for (const id of (r ?? [])) union.add(id);
    return [...union];
  }

  /**
     * 키워드 기반 검색 (교집합 우선, 부족하면 합집합)
     * 그룹 keyId(배열)면 멤버별 교집합/합집합 후 결과 union.
     */
  async searchByKeywords(keywords, minResults = 3, keyId = null) {
    if (!redisClient || redisClient.status !== "ready" || keywords.length === 0) {
      return [];
    }

    return this._unionFromKeyNamespaces(keyId, async (ns) => {
      const keys = keywords.map(kw => `${KW_PREFIX}${ns}:${kw.toLowerCase()}`);

      /** 교집합 시도 */
      let ids = await redisClient.sinter(...keys).catch(() => []);

      /** 부족하면 합집합으로 확장 */
      if (ids.length < minResults && keys.length > 1) {
        ids = await redisClient.sunion(...keys).catch(() => []);
      }

      return ids;
    });
  }

  /**
     * 토픽 기반 검색
     * 그룹 keyId(배열)면 멤버별 smembers 후 결과 union.
     */
  async searchByTopic(topic, keyId = null) {
    if (!redisClient || redisClient.status !== "ready") return [];
    return this._unionFromKeyNamespaces(keyId, ns =>
      redisClient.smembers(`${TOPIC_PREFIX}${ns}:${topic}`).catch(() => [])
    );
  }

  /**
     * 타입 기반 검색
     * 그룹 keyId(배열)면 멤버별 smembers 후 결과 union.
     */
  async searchByType(type, keyId = null) {
    if (!redisClient || redisClient.status !== "ready") return [];
    return this._unionFromKeyNamespaces(keyId, ns =>
      redisClient.smembers(`${TYPE_PREFIX}${ns}:${type}`).catch(() => [])
    );
  }

  /**
     * 최근 접근 파편 조회
     * 그룹 keyId(배열)면 멤버별 zrevrange 후 결과 union.
     * union 이후 count 개로 잘라 반환한다.
     */
  async getRecent(count = 20, keyId = null) {
    if (!redisClient || redisClient.status !== "ready") return [];
    const ids = await this._unionFromKeyNamespaces(keyId, ns =>
      redisClient.zrevrange(`${RECENT_KEY}:${ns}`, 0, count - 1).catch(() => [])
    );
    return Array.isArray(keyId) ? ids.slice(0, count) : ids;
  }

  /**
     * Hot Cache에 파편 본문 저장
     */
  async cacheFragment(fragmentId, data, keyId = null) {
    if (!redisClient || redisClient.status !== "ready") return;
    await redisClient.setex(
      `${HOT_PREFIX}${keyNs(keyId)}:${fragmentId}`,
      HOT_CACHE_TTL,
      JSON.stringify(data)
    ).catch(() => {});
  }

  /**
     * Hot Cache에서 파편 조회
     * 그룹 keyId(배열)면 멤버 namespace를 순서대로 시도하고 첫 hit를 반환한다.
     */
  async getCachedFragment(fragmentId, keyId = null) {
    if (!redisClient || redisClient.status !== "ready") return null;

    const namespaces = Array.isArray(keyId)
      ? keyId.map(k => `_k${k}`)
      : [keyNs(keyId)];

    for (const ns of namespaces) {
      const val = await redisClient.get(`${HOT_PREFIX}${ns}:${fragmentId}`).catch(() => null);
      if (val) return JSON.parse(val);
    }
    return null;
  }

  /**
     * 세션의 파편 ID 목록 조회
     */
  async getSessionFragments(sessionId) {
    if (!redisClient || redisClient.status !== "ready") return [];
    return redisClient.smembers(`${SESSION_PREFIX}${sessionId}`).catch(() => []);
  }

  /**
     * Working Memory에 파편 추가 (세션 단위, FIFO + importance 보호)
     *
     * @param {string} sessionId - 세션 ID
     * @param {Object} fragment  - { id, content, type, importance, estimated_tokens }
     */
  async addToWorkingMemory(sessionId, fragment) {
    if (!redisClient || redisClient.status !== "ready" || !sessionId) return;

    const key = `${WM_PREFIX}${sessionId}`;

    try {
      const entry = JSON.stringify({
        id              : fragment.id,
        content         : fragment.content,
        type            : fragment.type,
        topic           : fragment.topic,
        importance      : fragment.importance || 0.5,
        estimated_tokens: fragment.estimated_tokens || Math.ceil((fragment.content || "").length / 4),
        added_at        : Date.now()
      });

      await redisClient.rpush(key, entry);
      await redisClient.expire(key, WM_TTL);

      await this._enforceWmBudget(key);
    } catch (err) {
      logWarn(`[FragmentIndex] addToWorkingMemory failed: ${err.message}`);
    }
  }

  /**
     * Working Memory 전체 조회
     *
     * @param {string} sessionId
     * @returns {Object[]} WM 파편 목록
     */
  async getWorkingMemory(sessionId) {
    if (!redisClient || redisClient.status !== "ready" || !sessionId) return [];

    const key = `${WM_PREFIX}${sessionId}`;

    try {
      const items = await redisClient.lrange(key, 0, -1);
      return items.map(item => JSON.parse(item));
    } catch (err) {
      logWarn(`[FragmentIndex] getWorkingMemory failed: ${err.message}`);
      return [];
    }
  }

  /**
     * Working Memory 토큰 예산 초과 시 FIFO 제거
     * importance > 0.8인 항목은 보호
     */
  async _enforceWmBudget(key) {
    const items   = await redisClient.lrange(key, 0, -1);
    const parsed  = items.map(item => JSON.parse(item));
    let totalToks = parsed.reduce((sum, p) => sum + (p.estimated_tokens || 0), 0);

    if (totalToks <= WM_MAX_TOKENS) return;

    const removedIndices = new Set();
    for (let i = 0; i < parsed.length && totalToks > WM_MAX_TOKENS; i++) {
      if ((parsed[i].importance || 0) > 0.8) continue;
      totalToks -= (parsed[i].estimated_tokens || 0);
      removedIndices.add(i);
    }

    if (removedIndices.size > 0) {
      const remaining = parsed.filter((_, i) => !removedIndices.has(i));

      const pipeline = redisClient.pipeline();
      pipeline.del(key);
      for (const r of remaining) {
        pipeline.rpush(key, JSON.stringify(r));
      }
      pipeline.expire(key, WM_TTL);
      await pipeline.exec();
    }
  }

  /**
     * Working Memory 삭제 (세션 종료 시)
     */
  async clearWorkingMemory(sessionId) {
    if (!redisClient || redisClient.status !== "ready" || !sessionId) return;
    await redisClient.del(`${WM_PREFIX}${sessionId}`).catch(() => {});
  }

  /**
   * Seen IDs 저장 (overwrite: 기존 Set 삭제 후 새로 저장)
   *
   * context() 호출 시 주입된 파편 ID를 기록한다.
   * 다음 context() 호출 시 overwrite되므로 리셋 별도 불필요.
   *
   * @param {string} sessionId
   * @param {string[]} ids  파편 ID 배열
   */
  async setSeenIds(sessionId, ids) {
    if (!redisClient || redisClient.status !== "ready" || !sessionId) return;
    const key = `${SEEN_PREFIX}${sessionId}`;
    try {
      const pipeline = redisClient.pipeline();
      pipeline.del(key);
      if (ids.length > 0) {
        pipeline.sadd(key, ...ids);
        pipeline.expire(key, SEEN_TTL);
      }
      await pipeline.exec();
    } catch (err) {
      logWarn(`[FragmentIndex] setSeenIds failed: ${err.message}`);
    }
  }

  /**
   * Seen IDs 조회
   *
   * @param {string} sessionId
   * @returns {Set<string>}
   */
  async getSeenIds(sessionId) {
    if (!redisClient || redisClient.status !== "ready" || !sessionId) return new Set();
    const key = `${SEEN_PREFIX}${sessionId}`;
    try {
      const ids = await redisClient.smembers(key);
      return new Set(ids);
    } catch (err) {
      logWarn(`[FragmentIndex] getSeenIds failed: ${err.message}`);
      return new Set();
    }
  }

  /**
   * Redis 인덱스 웜업 — 서버 시작 시 DB에서 최근 파편을 로드하여 캐시를 채운다.
   *
   * Redis 재시작 후 cold start로 인한 L1 miss를 줄이기 위해 사용한다.
   * 비동기 비차단: 실패해도 서버 시작을 막지 않는다.
   *
   * @param {import('pg').Pool} pool  - PostgreSQL 커넥션 풀
   * @param {number}            limit - 로드할 최대 파편 수 (기본 5000)
   * @returns {Promise<number>} 인덱싱된 파편 수
   */
  async warmup(pool, limit = 5000) {
    if (!redisClient || redisClient.status !== "ready") return 0;

    const { rows } = await pool.query(
      `SELECT id, content, topic, type, keywords, importance, key_id
       FROM agent_memory.fragments
       WHERE keywords IS NOT NULL AND array_length(keywords, 1) > 0
         AND valid_to IS NULL
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );

    const CHUNK = 50;
    for (let i = 0; i < rows.length; i += CHUNK) {
      await Promise.all(rows.slice(i, i + CHUNK).map(row => this.index(row, null, row.key_id)));
    }

    return rows.length;
  }

  /**
     * 키워드 인덱스 크기 제한 (overflow 방지)
     */
  async pruneKeywordIndexes() {
    if (!redisClient || redisClient.status !== "ready") return;

    const cursor = "0";
    const pattern = `${KW_PREFIX}*`;
    let pruned    = 0;

    try {
      const [, keys] = await redisClient.scan(cursor, "MATCH", pattern, "COUNT", 500);

      /** 모든 키의 scard를 pipeline으로 일괄 조회 */
      const scardPipeline = redisClient.pipeline();
      for (const key of keys) {
        scardPipeline.scard(key);
      }
      const scardResults = await scardPipeline.exec();

      for (let ki = 0; ki < keys.length; ki++) {
        const [scErr, size] = scardResults[ki];
        if (scErr || size <= MAX_SET_SIZE) continue;

        const members = await redisClient.srandmember(keys[ki], size - MAX_SET_SIZE);
        if (members && members.length > 0) {
          await redisClient.srem(keys[ki], ...members);
          pruned += members.length;
        }
      }
    } catch (err) {
      logWarn(`[FragmentIndex] pruneKeywordIndexes failed: ${err.message}`);
    }

    if (pruned > 0) {
      logInfo(`[FragmentIndex] Pruned ${pruned} entries from keyword indexes`);
    }
  }
}

/** 싱글톤 인스턴스 — 프로세스 내 Redis 키 공간을 단일 객체가 관리한다 */
let _instance = null;

/**
 * 프로세스 전역 FragmentIndex 싱글톤을 반환한다.
 * 최초 호출 시 인스턴스를 생성하고 이후 동일 인스턴스를 재사용한다.
 */
export function getFragmentIndex() {
  if (!_instance) _instance = new FragmentIndex();
  return _instance;
}
