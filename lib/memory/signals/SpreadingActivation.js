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
import { FragmentFactory }       from "../write/FragmentFactory.js";
import { keyScopeScalar } from "../keyScope.js";
import { SCHEMA } from "../schema.js";
import { appendWorkspaceCondition } from "../read/WorkspaceScope.js";

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
    const {
      ids,
      agentId = "default",
      keyId = null,
      workspace = null,
      allWorkspaces = false,
      includePeerAgents = false
    } = activationQueue.shift();
    if (!ids?.length) continue;
    const params = [ids];
    const keyFilter = keyScopeScalar(params, "key_id", keyId).trimStart();
    const conditions = [];
    appendWorkspaceCondition(
      conditions, params, { workspace, allWorkspaces }, "workspace"
    );
    let agentFilter = "";
    if (!includePeerAgents) {
      params.push(agentId);
      agentFilter = `AND (agent_id = $${params.length} OR agent_id = 'default')`;
    }
    const workspaceFilter = conditions.length > 0 ? `AND ${conditions[0]}` : "";
    await pool.query(`
      UPDATE ${SCHEMA}.fragments
      SET ema_activation   = LEAST(1.0, COALESCE(ema_activation, 0) + 0.1),
          ema_last_updated = NOW(),
          accessed_at      = NOW(),
          access_count     = COALESCE(access_count, 0) + 1
      WHERE id = ANY($1)
        ${keyFilter}
        ${workspaceFilter}
        ${agentFilter}
    `, params).catch(() => {});
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
export async function activateByContext(
  contextText,
  agentId,
  keyId,
  sessionId = null,
  {
    workspace = null,
    allWorkspaces = false,
    includePeerAgents = false
  } = {}
) {
  if (!contextText?.trim()) return [];

  const workspaceKey = allWorkspaces
    ? "all"
    : (workspace === null ? "global" : `workspace:${workspace}`);
  const peerKey = includePeerAgents ? "peers" : "agent";
  const cacheKey = `${agentId}:${keyId ?? "master"}:${workspaceKey}:${peerKey}:${sessionId ?? "anon"}`;
  if (!ACTIVATION_CACHE.has(cacheKey)) {
    ACTIVATION_CACHE.set(cacheKey, new Set());
    setTimeout(() => ACTIVATION_CACHE.delete(cacheKey), CACHE_TTL_MS).unref?.();
  }
  const seen = ACTIVATION_CACHE.get(cacheKey);

  /** 키워드 추출 — FragmentFactory.extractKeywords 재사용 */
  const factory  = new FragmentFactory();
  const keywords = factory.extractKeywords(contextText, 8);
  if (!keywords.length) return [];

  /** seed 파편 조회: keywords GIN 매칭 */
  const pool       = getPrimaryPool();
  const seedParams = [keywords, agentId];
  const keyFilter = keyScopeScalar(seedParams, "f.key_id", keyId).trimStart();
  const workspaceConditions = [];
  appendWorkspaceCondition(
    workspaceConditions, seedParams, { workspace, allWorkspaces }, "f.workspace"
  );
  const workspaceFilter = workspaceConditions.length > 0
    ? `AND ${workspaceConditions[0]}`
    : "";
  const agentFilter = includePeerAgents
    ? "$2::text IS NOT NULL"
    : "(f.agent_id = $2 OR f.agent_id = 'default')";
  const seedR = await pool.query(`
    SELECT DISTINCT f.id
    FROM ${SCHEMA}.fragments f
    WHERE f.keywords && $1::text[]
      AND ${agentFilter}
      ${keyFilter}
      ${workspaceFilter}
      AND f.valid_to IS NULL
    LIMIT 10
  `, seedParams);

  const seedIds = seedR.rows.map(r => r.id).filter(id => !seen.has(id));
  if (!seedIds.length) return [];
  seedIds.forEach(id => seen.add(id));

  /** 1-hop 그래프 확산 — fetchGraphNeighbors(seedIds, maxTotal, agentId, keyId) */
  let activated = [];
  try {
    activated = await fetchGraphNeighbors(seedIds, 10, agentId, keyId, {
      workspace,
      allWorkspaces,
      includePeerAgents
    });
  } catch { /* 그래프 확산 실패 시 seed만 반환 */ }

  const allIds = [...seedIds, ...activated.map(f => f.id).filter(Boolean)];
  if (allIds.length) {
    activationQueue.push({
      ids: allIds,
      agentId,
      keyId,
      workspace,
      allWorkspaces,
      includePeerAgents
    });
    setImmediate(drainQueue);
  }

  return activated;
}
