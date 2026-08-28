/**
 * EpisodeContinuityService
 *
 * reflect() 호출 시 case_events milestone을 삽입하고
 * 이전 에피소드와 preceded_by 엣지로 연결한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-04-03
 * 수정일: 2026-08-15
 */

import { getPrimaryPool } from "../../tools/db.js";
import { logWarn }        from "../../logger.js";
import { SCHEMA } from "../schema.js";

const CACHE_TTL_MS      = parseInt(process.env.EPISODE_CONTINUITY_CACHE_TTL_MS || "5000", 10);
const MAX_TRACKED_SCOPES = 1000;

/** `${agentId}:${keyId ?? 'master'}:${scopeType}:${scopeValue}` → { eventId, expiresAt } */
const lastEventCache = new Map();

/**
 * 삽입 순서 기반 LRU + TTL: 재삽입으로 최신 위치 갱신, 상한 초과 시 최고령 방출.
 * 조회 시 TTL 만료 항목은 miss로 취급되어 DB 재조회를 유도한다.
 */
function cacheLastEvent(scopeKey, eventId) {
  if (lastEventCache.has(scopeKey)) lastEventCache.delete(scopeKey);
  lastEventCache.set(scopeKey, { eventId, expiresAt: Date.now() + CACHE_TTL_MS });
  if (lastEventCache.size > MAX_TRACKED_SCOPES) {
    lastEventCache.delete(lastEventCache.keys().next().value);
  }
}

/**
 * TTL 유효 항목만 반환. 만료 항목은 제거 후 undefined(miss)로 취급한다.
 */
function readCachedEvent(scopeKey) {
  const entry = lastEventCache.get(scopeKey);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    lastEventCache.delete(scopeKey);
    return undefined;
  }
  return entry.eventId;
}

export const _cacheLastEventForTest = cacheLastEvent;
export const _readCachedEventForTest = readCachedEvent;
export const _lastEventCacheForTest  = () => lastEventCache;

/**
 * 스코프(agentId + keyId + workspace 또는 topic) 내 가장 최근 milestone_reached
 * 이벤트를 DB에서 조회한다. case_events는 workspace/topic을 직접 보유하지 않으므로
 * source_fragment_id로 fragments와 조인하여 스코프 일치를 강제한다.
 *
 * @param {import('pg').Pool} pool
 * @param {string}            agentId
 * @param {number|null}       keyId
 * @param {"workspace"|"topic"} scopeType
 * @param {string}            scopeValue
 * @returns {Promise<string|null>}
 */
async function findLastMilestoneEventId(pool, agentId, keyId, scopeType, scopeValue) {
  const scopeCondition = scopeType === "workspace"
    ? "f.workspace = $3"
    : "f.workspace IS NULL AND f.topic = $3";

  const r = await pool.query(`
    SELECT ce.event_id
    FROM ${SCHEMA}.case_events ce
    JOIN ${SCHEMA}.fragments f ON f.id = ce.source_fragment_id
    WHERE ce.event_type = 'milestone_reached'
      AND f.agent_id = $1
      AND ce.key_id IS NOT DISTINCT FROM $2
      AND ${scopeCondition}
    ORDER BY ce.created_at DESC
    LIMIT 1
  `, [agentId, keyId ?? null, scopeValue]);

  return r.rows[0]?.event_id ?? null;
}

/**
 * reflect()에서 생성된 episode 파편에 대해 milestone_reached 이벤트를 삽입하고
 * 동일 스코프(agentId + keyId + workspace, workspace 미지정 시 topic)의 이전
 * milestone과 preceded_by 엣지로 연결한다. workspace와 topic이 모두 없으면
 * 체인을 생성하지 않는다(교차 프로젝트 오연결 방지).
 *
 * idempotency_key로 중복 삽입을 방지한다 (서버 재시작 후 동일 호출 방어).
 *
 * @param {string}      episodeFragmentId  - reflect()에서 생성된 파편 ID
 * @param {string}      agentId            - 에이전트 식별자
 * @param {number|null} keyId              - API key ID (master면 null)
 * @param {string}      [sessionId]        - 세션 ID
 */
export async function linkEpisodeMilestone(episodeFragmentId, agentId, keyId, sessionId) {
  if (!episodeFragmentId) return;

  const pool = getPrimaryPool();
  if (!pool) return;

  const idempotencyKey = `milestone:${agentId}:${sessionId ?? "unknown"}:${episodeFragmentId}`;

  try {
    /** fragment summary + 체인 스코프 결정용 workspace/topic 조회 */
    const fragR = await pool.query(
      `SELECT LEFT(content, 200) AS summary, workspace, topic
       FROM ${SCHEMA}.fragments WHERE id = $1`,
      [episodeFragmentId]
    );
    const fragRow    = fragR.rows[0];
    const summary    = fragRow?.summary ?? "";
    const workspace  = fragRow?.workspace ?? null;
    const topic      = fragRow?.topic ?? null;

    /** milestone_reached 이벤트 삽입 (멱등) */
    const evR = await pool.query(`
      INSERT INTO ${SCHEMA}.case_events
        (event_type, summary, source_fragment_id, case_id, session_id, idempotency_key, key_id)
      VALUES ('milestone_reached', $1, $2, $3, $4, $5, $6)
      ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
      RETURNING event_id
    `, [
      summary,
      episodeFragmentId,
      sessionId ?? "unknown",
      sessionId ?? null,
      idempotencyKey,
      keyId ?? null
    ]);

    const eventId = evR.rows[0]?.event_id;
    if (!eventId) return; // 중복 — no-op

    /** 체인 스코프: workspace 우선, 없으면 topic, 둘 다 없으면 체인 미생성 */
    const scopeType  = workspace != null ? "workspace" : (topic != null ? "topic" : null);
    const scopeValue = scopeType === "workspace" ? workspace : topic;

    if (scopeType) {
      const scopeKey = `${agentId}:${keyId ?? "master"}:${scopeType}:${scopeValue}`;

      let prevEventId = readCachedEvent(scopeKey);
      if (prevEventId === undefined) {
        prevEventId = await findLastMilestoneEventId(pool, agentId, keyId, scopeType, scopeValue);
      }

      if (prevEventId && prevEventId !== eventId) {
        await pool.query(`
          INSERT INTO ${SCHEMA}.case_event_edges (from_event_id, to_event_id, edge_type)
          VALUES ($1, $2, 'preceded_by')
          ON CONFLICT (from_event_id, to_event_id, edge_type) DO NOTHING
        `, [prevEventId, eventId]);
      }

      cacheLastEvent(scopeKey, eventId);
    }

  } catch (err) {
    logWarn(`[EpisodeContinuity] linkEpisodeMilestone failed: ${err.message}`);
  }
}
