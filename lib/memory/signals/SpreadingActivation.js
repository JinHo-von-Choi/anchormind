/**
 * Spreading Activation
 * 현재 대화 맥락(contextText)에서 관련 파편을 선제적으로 활성화한다.
 * ACT-R Spreading Activation 모델 기반.
 *
 * 작성자: 최진호
 * 작성일: 2026-04-03
 */

import { getPrimaryPool }        from "../../tools/db.js";
import { fetchGraphNeighbors }   from "../read/GraphNeighborSearch.js";
import { FragmentFactory }       from "../FragmentFactory.js";

const SCHEMA        = "agent_memory";
const CACHE_TTL_MS  = 10 * 60 * 1000; // 10분
const ACTIVATION_CACHE = new Map();     // cacheKey → Set<fragId>

const activationQueue = [];
let   queueRunning    = false;

/**
 * 큐에 쌓인 ema_activation 증분 업데이트를 순차 실행한다.
 * fire-and-forget 패턴으로 호출되며, 실패해도 서비스 중단 없음.
 */
async function drainQueue() {
  if (queueRunning) return;
  queueRunning = true;
  const pool = getPrimaryPool();
  while (activationQueue.length) {
    const { ids } = activationQueue.shift();
    if (!ids?.length) continue;
    await pool.query(`
      UPDATE ${SCHEMA}.fragments
      SET ema_activation   = LEAST(1.0, COALESCE(ema_activation, 0) + 0.1),
          ema_last_updated = NOW(),
          accessed_at      = NOW(),
          access_count     = COALESCE(access_count, 0) + 1
      WHERE id = ANY($1)
    `, [ids]).catch(() => {});
  }
  queueRunning = false;
}

/**
 * 대화 맥락 텍스트에서 키워드를 추출하고, seed 파편 → 1-hop 그래프 확산을 수행한다.
 *
 * @param {string}      contextText - 현재 대화 맥락 텍스트
 * @param {string}      agentId     - 에이전트 ID
 * @param {number|null} keyId       - API 키 ID (null = master)
 * @param {string|null} sessionId   - 세션 ID (캐시 키 분리)
 * @returns {Promise<Object[]>} 활성화된 이웃 파편 배열
 */
export async function activateByContext(contextText, agentId, keyId, sessionId = null) {
  if (!contextText?.trim()) return [];

  const cacheKey = `${agentId}:${keyId ?? "master"}:${sessionId ?? "anon"}`;
  if (!ACTIVATION_CACHE.has(cacheKey)) {
    ACTIVATION_CACHE.set(cacheKey, new Set());
    setTimeout(() => ACTIVATION_CACHE.delete(cacheKey), CACHE_TTL_MS);
  }
  const seen = ACTIVATION_CACHE.get(cacheKey);

  /** 키워드 추출 — FragmentFactory.extractKeywords 재사용 */
  const factory  = new FragmentFactory();
  const keywords = factory.extractKeywords(contextText, 8);
  if (!keywords.length) return [];

  /** seed 파편 조회: keywords GIN 매칭 */
  const pool       = getPrimaryPool();
  const seedParams = [keywords, agentId];
  let   keyFilter  = "";
  if (keyId != null) {
    seedParams.push(keyId);
    keyFilter = `AND f.key_id = $${seedParams.length}`;
  }
  const seedR = await pool.query(`
    SELECT DISTINCT f.id
    FROM ${SCHEMA}.fragments f
    WHERE f.keywords && $1::text[]
      AND f.agent_id = $2
      ${keyFilter}
      AND f.valid_to IS NULL
    LIMIT 10
  `, seedParams);

  const seedIds = seedR.rows.map(r => r.id).filter(id => !seen.has(id));
  if (!seedIds.length) return [];
  seedIds.forEach(id => seen.add(id));

  /** 1-hop 그래프 확산 — fetchGraphNeighbors(seedIds, maxTotal, agentId, keyId) */
  let activated = [];
  try {
    activated = await fetchGraphNeighbors(seedIds, 10, agentId, keyId);
  } catch { /* 그래프 확산 실패 시 seed만 반환 */ }

  const allIds = [...seedIds, ...activated.map(f => f.id).filter(Boolean)];
  if (allIds.length) {
    activationQueue.push({ ids: allIds });
    setImmediate(drainQueue);
  }

  return activated;
}
