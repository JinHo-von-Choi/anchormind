/**
 * UseEvents - 파편 사용 사건 기록과 조회
 *
 * 작성자: 최진호
 * 작성일: 2026-11-19
 *
 * access_count와 ema_activation은 노출(recall 반환, context 주입, 그래프 확산)로 오른다. 이 모듈은 에이전트가
 * 파편 id를 직접 지목한 사건만 fragment_use_events(migration-083)에 남긴다.
 *
 *   feedback_relevant  tool_feedback에서 relevant로 판정한 파편. 행은 피드백 저장 문장이 같은 문장에서 쓴다
 *   verified           amend(assertionStatus=verified)
 *   lesson_applied     reflect lessons_applied의 helped, failed
 *   link_explicit      link 도구로 만든 링크의 양 끝
 *   evidence_cited     reflect 교훈의 evidenceIds 가운데 계보로 남은 근거 파편
 *
 * 같은 사건은 (kind, source_ref, fragment_id)로 한 번만 센다. MEMENTO_USE_SIGNAL=off이면 기록하지 않는다.
 * 기록은 응답을 기다리게 하지 않고, 실패하면 경고만 남긴다.
 */

import { queryWithAgentVector } from "../../tools/db.js";
import { SCHEMA }               from "../schema.js";
import { useSignalMode }        from "../../config.js";
import { trackBackgroundWork }  from "../../background-work.js";
import { logWarn }              from "../../logger.js";

/** fragment_use_events.kind 값 */
export const USE_KINDS = Object.freeze({
  FEEDBACK_RELEVANT: "feedback_relevant",
  VERIFIED         : "verified",
  LESSON_APPLIED   : "lesson_applied",
  LINK_EXPLICIT    : "link_explicit",
  EVIDENCE_CITED   : "evidence_cited"
});

/** 사용 사건 보존 기간(일) */
export const USE_EVENT_RETENTION_DAYS = 180;

/** 한 번에 기록하는 파편 수 상한 */
const MAX_IDS = 50;

/** source_ref 길이 상한(표 제약과 같다) */
const SOURCE_REF_MAX = 200;

/**
 * 사용 사건 기록이 켜져 있는가.
 *
 * @returns {boolean}
 */
export function useEventsEnabled() {
  return useSignalMode() !== "off";
}

/**
 * 비지 않은 문자열 id를 중복 없이 상한까지 둔다.
 *
 * @param {unknown} ids
 * @returns {string[]}
 */
export function useEventIds(ids) {
  if (!Array.isArray(ids)) return [];
  return [...new Set(ids.filter(id => typeof id === "string" && id.length > 0))].slice(0, MAX_IDS);
}

/**
 * 사용 사건 기록 문장. $1 파편 id 배열, $2 kind, $3 source_ref, $4 session_id. 있는 파편만 기록하고 key_id는 파편의
 * 값을 쓴다. 호출 경로(amend, link, reflect)가 파편 접근 권한을 이미 확인했으므로 키 조건을 다시 붙이지 않는다.
 */
export const INSERT_USE_EVENTS_SQL = `
  INSERT INTO ${SCHEMA}.fragment_use_events (fragment_id, key_id, kind, source_ref, session_id)
  SELECT f.id, f.key_id, $2, $3, $4
    FROM ${SCHEMA}.fragments f
   WHERE f.id = ANY($1::text[])
  ON CONFLICT (kind, source_ref, fragment_id) DO NOTHING`;

/**
 * 사용 사건을 기록한다. 기다리지 않는다.
 *
 * @param {string} kind - USE_KINDS 값
 * @param {string[]} fragmentIds
 * @param {{sourceRef: string, sessionId?: string|null}} ref
 * @returns {void}
 */
export function recordUseEvents(kind, fragmentIds, { sourceRef, sessionId = null }) {
  if (!useEventsEnabled()) return;
  const ids = useEventIds(fragmentIds);
  if (ids.length === 0 || typeof sourceRef !== "string" || sourceRef.length === 0) return;
  trackBackgroundWork(
    queryWithAgentVector("system", INSERT_USE_EVENTS_SQL, [ids, kind, sourceRef.slice(0, SOURCE_REF_MAX), sessionId ?? null], "write")
      .catch(err => logWarn(`[UseEvents] ${kind} record failed: ${err.message}`))
  );
}

/**
 * 파편별 사용 사건 수와 마지막 사건 시각. 조회가 실패하면 빈 Map이다.
 *
 * @param {string[]} fragmentIds
 * @returns {Promise<Map<string, {count: number, last: Date}>>}
 */
export async function loadUseStats(fragmentIds) {
  const ids = [...new Set((fragmentIds ?? []).filter(id => typeof id === "string" && id.length > 0))];
  if (ids.length === 0) return new Map();
  try {
    const { rows } = await queryWithAgentVector("system",
      `SELECT fragment_id, count(*)::int AS n, max(created_at) AS last
         FROM ${SCHEMA}.fragment_use_events
        WHERE fragment_id = ANY($1::text[])
        GROUP BY fragment_id`,
      [ids]
    );
    return new Map(rows.map(r => [r.fragment_id, { count: r.n, last: new Date(r.last) }]));
  } catch (err) {
    logWarn(`[UseEvents] use stats lookup failed: ${err.message}`);
    return new Map();
  }
}

/** 보존 기간이 지난 사용 사건을 지운다. $1 보존 일수. */
export const PURGE_OLD_USE_EVENTS_SQL = `
  DELETE FROM ${SCHEMA}.fragment_use_events
   WHERE created_at < NOW() - make_interval(days => $1)`;
