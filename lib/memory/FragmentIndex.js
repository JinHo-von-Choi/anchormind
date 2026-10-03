/**
 * FragmentIndex - Redis 역인덱스 관리
 *
 * 작성자: 최진호
 * 작성일: 2026-02-23
 * 수정일: 2026-08-15 (evictWorkingMemoryItems: WM id 집합 단위 원자적 부분 evict 추가)
 * 수정일: 2026-10-03 (Redis가 준비되지 않았을 때 작업 기억을 PostgreSQL 행으로 읽고 지우는 대체 경로)
 *
 * 키 네임스페이스: frag:* (기존 cache:*, session:*, oauth:*와 분리)
 */

import { redisClient } from "../redis.js";
import { logInfo, logWarn } from "../logger.js";
import { wmPgFallbackEnabled, wmFallbackMaxRows } from "../config.js";
import { FragmentFactory } from "./write/FragmentFactory.js";
import { SCHEMA } from "./schema.js";
import {
  WM_TTL_SECONDS,
  WM_MAX_TOKENS,
  selectBudgetEvictionIndices,
  listWorkingMemoryRows,
  evictWorkingMemoryRows,
  clearWorkingMemoryRows,
  enforceWorkingMemoryRowBudget,
  trimWorkingMemoryRowsOfKey,
  mergeWorkingMemoryItems
} from "./WorkingMemoryRows.js";

const KW_PREFIX      = "frag:kw:";
const TOPIC_PREFIX   = "frag:tp:";
const TYPE_PREFIX    = "frag:ty:";
const RECENT_KEY     = "frag:recent";
const HOT_PREFIX     = "frag:hot:";
const SESSION_PREFIX = "frag:sess:";
const WM_PREFIX      = "frag:wm:";
const MAX_SET_SIZE   = 5000;
const HOT_CACHE_TTL  = 7200;
const WM_TTL         = WM_TTL_SECONDS;
const SEEN_PREFIX    = "frag:seen:";
const SEEN_TTL       = 86400;

/**
 * Working Memory 리스트에서 ARGV에 지정된 id 집합만 필터링해 재기록하는 Lua 스크립트.
 * KEYS[1] = WM 리스트 키, ARGV[1] = TTL(초), ARGV[2..] = evict할 항목 id.
 * 리스트 전체를 읽어 evict 대상이 아닌 항목만 남기고 단일 왕복 내에서 원자적으로 교체한다.
 */
const EVICT_WM_ITEMS_SCRIPT = `
local key = KEYS[1]
local ttl = tonumber(ARGV[1])
local toEvict = {}
for i = 2, #ARGV do toEvict[ARGV[i]] = true end

local items   = redis.call('LRANGE', key, 0, -1)
local kept    = {}
local evicted = 0

for i = 1, #items do
  local ok, parsed = pcall(cjson.decode, items[i])
  if ok and parsed.id ~= nil and toEvict[parsed.id] then
    evicted = evicted + 1
  else
    kept[#kept + 1] = items[i]
  end
end

if evicted > 0 then
  redis.call('DEL', key)
  if #kept > 0 then
    redis.call('RPUSH', key, unpack(kept))
    redis.call('EXPIRE', key, ttl)
  end
end

return evicted
`;

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
function _keyNsList(keyId) {
  if (keyId == null) return ["_g"];
  if (Array.isArray(keyId)) return keyId.map(k => `_k${k}`);
  return [`_k${keyId}`];
}

export class FragmentIndex {

  /**
     * 파편을 역인덱스에 등록
     */
  async index(fragment, sessionId, keyId = null, opts = {}) {
    if (!redisClient || redisClient.status === "stub") return;
    if (redisClient.status !== "ready") {
      if (opts.strict === true) throw new Error(`Redis index unavailable (${redisClient.status})`);
      return;
    }

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

    try {
      const replies = await pipeline.exec();
      const replyError = replies?.find?.(([err]) => err)?.[0];
      if (replyError) throw replyError;
    } catch (err) {
      if (opts.strict === true) throw err;
      logWarn(`[FragmentIndex] index failed: ${err.message}`);
    }
  }

  /**
     * 파편을 역인덱스에서 제거
     */
  async deindex(fragmentId, keywords, topic, type, keyId = null, opts = {}) {
    if (!redisClient || redisClient.status === "stub") return;
    if (redisClient.status !== "ready") {
      if (opts.strict === true) throw new Error(`Redis index unavailable (${redisClient.status})`);
      return;
    }

    const ns       = keyNs(keyId);
    const pipeline = redisClient.pipeline();

    for (const kw of (keywords || [])) {
      pipeline.srem(`${KW_PREFIX}${ns}:${kw.toLowerCase()}`, fragmentId);
    }

    if (topic) pipeline.srem(`${TOPIC_PREFIX}${ns}:${topic}`, fragmentId);
    if (type)  pipeline.srem(`${TYPE_PREFIX}${ns}:${type}`, fragmentId);
    pipeline.zrem(`${RECENT_KEY}:${ns}`, fragmentId);
    pipeline.del(`${HOT_PREFIX}${ns}:${fragmentId}`);

    try {
      const replies = await pipeline.exec();
      const replyError = replies?.find?.(([err]) => err)?.[0];
      if (replyError) throw replyError;
    } catch (err) {
      if (opts.strict === true) throw err;
      logWarn(`[FragmentIndex] deindex failed: ${err.message}`);
    }
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
     * 작업 기억이 지금 쓰는 저장소. Redis가 준비되어 있으면 redis, 아니고 대체 경로가
     * 켜져 있으면 postgres, 둘 다 아니면 none. 값이 바뀌면 한 번 기록한다.
     *
     * @returns {"redis"|"postgres"|"none"}
     */
  workingMemoryBackend() {
    const backend = redisClient?.status === "ready"
      ? "redis"
      : (wmPgFallbackEnabled() ? "postgres" : "none");
    if (backend !== this._loggedWmBackend) {
      this._loggedWmBackend = backend;
      logInfo(`[WorkingMemory] backend=${backend}`);
    }
    return backend;
  }

  /**
     * Working Memory에 파편 추가 (세션 단위, FIFO + importance 보호)
     *
     * Redis에 넣었으면 true. Redis가 준비되지 않았거나 쓰기에 실패하면 false이며, 호출자가
     * 대체 경로(PostgreSQL 작업 기억 행)로 저장할지 정한다.
     *
     * @param {string} sessionId - 세션 ID
     * @param {Object} fragment  - { id, content, type, importance, estimated_tokens }
     * @returns {Promise<boolean>}
     */
  async addToWorkingMemory(sessionId, fragment) {
    if (!sessionId || this.workingMemoryBackend() !== "redis") return false;
    const key = `${WM_PREFIX}${sessionId}`;
    let stored = false;

    try {
      const hasKey = Object.prototype.hasOwnProperty.call(fragment, "key_id");
      const hasWorkspace = Object.prototype.hasOwnProperty.call(fragment, "workspace");
      if (typeof fragment.agent_id !== "string" || !hasKey || !hasWorkspace) {
        throw new Error("Working Memory fragment requires resolved agent/key/workspace metadata");
      }
      const entry = JSON.stringify({
        id              : fragment.id,
        content         : fragment.content,
        type            : fragment.type,
        topic           : fragment.topic,
        agent_id        : fragment.agent_id,
        workspace       : fragment.workspace ?? null,
        key_id          : fragment.key_id,
        importance      : fragment.importance || 0.5,
        estimated_tokens: fragment.estimated_tokens || Math.ceil((fragment.content || "").length / 4),
        added_at        : Date.now()
      });

      await redisClient.rpush(key, entry);
      stored = true;
      await redisClient.expire(key, WM_TTL);

      await this._enforceWmBudget(key);
    } catch (err) {
      logWarn(`[FragmentIndex] addToWorkingMemory failed: ${err.message}`);
    }
    return stored;
  }

  /**
     * Working Memory 전체 조회
     *
     * @param {string} sessionId
     * @returns {Object[]} WM 파편 목록
     */
  async getWorkingMemory(sessionId) {
    if (!sessionId) return [];
    const redisItems = this.workingMemoryBackend() === "redis" ? await this._readRedisWorkingMemory(sessionId) : [];
    if (!wmPgFallbackEnabled()) return redisItems;
    return mergeWorkingMemoryItems(redisItems, await listWorkingMemoryRows(sessionId));
  }

  /**
     * Redis 작업 기억 리스트 조회. 실패하면 경고를 남기고 빈 목록을 돌려준다.
     */
  async _readRedisWorkingMemory(sessionId) {
    try {
      const items = await redisClient.lrange(`${WM_PREFIX}${sessionId}`, 0, -1);
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
    const evicted = selectBudgetEvictionIndices(parsed, { maxTokens: WM_MAX_TOKENS });

    if (evicted.size > 0) {
      const remaining = parsed.filter((_, i) => !evicted.has(i));

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
    if (!sessionId) return;
    if (redisClient?.status === "ready") {
      await redisClient.del(`${WM_PREFIX}${sessionId}`).catch(() => {});
    }
    if (wmPgFallbackEnabled()) await clearWorkingMemoryRows(sessionId);
  }

  /**
   * 대체 경로로 기록한 작업 기억 행의 세션당 보관량을 상한 안으로 줄인다.
   *
   * @param {string} sessionId
   * @returns {Promise<number>} 지운 행 수
   */
  async enforceFallbackWorkingMemoryBudget(sessionId) {
    return enforceWorkingMemoryRowBudget(sessionId);
  }

  /**
   * 새 작업 기억 행을 쓰기 전에 그 키의 행 수를 상한 안으로 줄인다. 오래된 행부터 지운다.
   *
   * @param {string|null} keyId
   * @returns {Promise<number>} 지운 행 수
   */
  async enforceFallbackKeyCap(keyId) {
    return trimWorkingMemoryRowsOfKey(keyId, wmFallbackMaxRows() - 1);
  }

  /**
   * Working Memory에서 지정된 항목 id 집합만 원자적으로 evict한다.
   *
   * reflect가 실제로 종합에 사용한 항목만 제거하고, 그 사이 유입된 신규 WM
   * 항목이나 타 그룹 소비분은 보존해야 하므로 전체 리스트를 지우는 대신
   * Lua 스크립트로 목록을 한 번의 왕복에서 필터링·재기록한다.
   *
   * @param {string}   sessionId
   * @param {string[]} ids - evict할 WM 항목 id 목록 (fragment id)
   * @returns {Promise<number>} evict된 항목 수
   */
  async evictWorkingMemoryItems(sessionId, ids) {
    if (!sessionId) return 0;
    const targetIds = [...new Set((ids || []).filter(Boolean))];
    if (targetIds.length === 0) return 0;
    const fromRows = wmPgFallbackEnabled() ? await evictWorkingMemoryRows(sessionId, targetIds) : 0;
    if (this.workingMemoryBackend() !== "redis") return fromRows;

    const key = `${WM_PREFIX}${sessionId}`;

    try {
      /** ioredis EVAL 커맨드 — Redis 서버에서 실행되는 Lua 스크립트이며 Node 프로세스 내 임의 코드 실행이 아니다 */
      const evicted = await redisClient.eval(
        EVICT_WM_ITEMS_SCRIPT,
        1,
        key,
        WM_TTL,
        ...targetIds
      );
      return fromRows + (Number(evicted) || 0);
    } catch (err) {
      logWarn(`[FragmentIndex] evictWorkingMemoryItems failed: ${err.message}`);
      return fromRows;
    }
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
       FROM ${SCHEMA}.fragments
       WHERE keywords IS NOT NULL AND array_length(keywords, 1) > 0
         AND valid_to IS NULL
       ORDER BY created_at DESC, id ASC
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

/**
 * 삭제·폐기된 파편 행들을 역인덱스와 핫 캐시에서 걷어낸다.
 * rows 는 id, keywords, topic, type, key_id 를 가진 RETURNING 결과다.
 * DB 쓰기는 이미 확정된 뒤이므로 한 행의 실패는 경고로 남기고 나머지 행을 계속 처리한다.
 *
 * @param {{id: string, keywords?: string[], topic?: string, type?: string, key_id?: string|null}[]} rows
 * @returns {Promise<void>}
 */
export async function deindexRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return;
  const index = getFragmentIndex();
  await Promise.all(rows.map(r =>
    Promise.resolve()
      .then(() => index.deindex(r.id, r.keywords, r.topic, r.type, r.key_id ?? null))
      .catch(err => logWarn(`[FragmentIndex] deindexRows failed id=${r.id}: ${err.message}`))
  ));
}
