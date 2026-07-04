/**
 * EpisodeContinuityService
 *
 * reflect() 호출 시 case_events milestone을 삽입하고
 * 이전 에피소드와 preceded_by 엣지로 연결한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-04-03
 */

import { getPrimaryPool } from "../../tools/db.js";
import { logWarn }        from "../../logger.js";

const SCHEMA = "agent_memory";

/** `${agentId}:${keyId ?? 'master'}` → { eventId } */
const lastEventByAgent = new Map();

const MAX_TRACKED_AGENTS = 1000;

/**
 * 삽입 순서 기반 LRU: 재삽입으로 최신 위치 갱신, 상한 초과 시 최고령 방출.
 */
function rememberLastEvent(agentKey, value) {
  if (lastEventByAgent.has(agentKey)) lastEventByAgent.delete(agentKey);
  lastEventByAgent.set(agentKey, value);
  if (lastEventByAgent.size > MAX_TRACKED_AGENTS) {
    lastEventByAgent.delete(lastEventByAgent.keys().next().value);
  }
}

export const _rememberLastEventForTest = rememberLastEvent;
export const _lastEventCacheForTest    = () => lastEventByAgent;

/**
 * reflect()에서 생성된 episode 파편에 대해 milestone_reached 이벤트를 삽입하고
 * 동일 에이전트의 이전 milestone과 preceded_by 엣지로 연결한다.
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

  const agentKey       = `${agentId}:${keyId ?? "master"}`;
  const idempotencyKey = `milestone:${agentId}:${sessionId ?? "unknown"}:${episodeFragmentId}`;

  try {
    /** fragment content 조회 (summary용) */
    const fragR = await pool.query(
      `SELECT LEFT(content, 200) AS summary FROM ${SCHEMA}.fragments WHERE id = $1`,
      [episodeFragmentId]
    );
    const summary = fragR.rows[0]?.summary ?? "";

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

    /** preceded_by 엣지 연결 */
    const prev = lastEventByAgent.get(agentKey);
    if (prev?.eventId && prev.eventId !== eventId) {
      await pool.query(`
        INSERT INTO ${SCHEMA}.case_event_edges (from_event_id, to_event_id, edge_type)
        VALUES ($1, $2, 'preceded_by')
        ON CONFLICT (from_event_id, to_event_id, edge_type) DO NOTHING
      `, [prev.eventId, eventId]);
    }

    rememberLastEvent(agentKey, { eventId });

  } catch (err) {
    logWarn(`[EpisodeContinuity] linkEpisodeMilestone failed: ${err.message}`);
  }
}
