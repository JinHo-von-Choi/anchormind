/**
 * LessonOutcomes - 교훈 적용 결과 기록과 신뢰도 판정
 *
 * 작성자: 최진호
 * 작성일: 2026-11-19
 *
 * reflect의 lessons_applied([{id, outcome}])를 lesson_outcomes(migration-083)에 남긴다. outcome은 helped, failed,
 * not_applicable이다. 같은 세션의 같은 교훈은 한 행이고, 다시 보고하면 마지막 결과로 바꾼다.
 *
 * 판정은 저장하지 않고 읽을 때 집계로 한다. fragments.support_state는 계보 처리(write/Lineage.js)가 강도 순서로
 * 덮어쓰는 열이라, 결과 상태를 같은 열에 두면 두 쓰기 경로가 서로를 지운다.
 *
 *   신뢰도      Beta(1+helped, 1+failed)의 평균. 적용 건수 n(helped+failed)과 함께 보인다
 *   contested   helped가 3 미만이면 서로 다른 세션 2곳 이상에서 failed가 나오고 failed > helped일 때,
 *               helped가 3 이상이면 failed > helped일 때. context에서 빠지고 recall에는 상태와 함께 나온다
 *   recent_failure  contested가 아니면서 마지막 결과가 failed일 때. 표지만 단다
 *
 * not_applicable은 신뢰도와 판정에 쓰지 않는다. cue 오탐 수로 자기 점검(LessonProbe)이 읽는다.
 */

import { queryWithAgentVector } from "../../tools/db.js";
import { SCHEMA }               from "../schema.js";
import { keyScopeScalar }       from "../keyScope.js";
import { lessonPredicateSql }   from "../write/LessonSummary.js";
import { logWarn }              from "../../logger.js";

/** lesson_outcomes.outcome 값 */
export const LESSON_OUTCOMES = Object.freeze(["helped", "failed", "not_applicable"]);

/** 한 reflect 호출에서 받는 결과 수 상한 */
export const LESSONS_APPLIED_MAX = 20;

/** 근거가 쌓인 교훈으로 보는 helped 수 */
export const STRONG_LESSON_HELPED = 3;

/** 근거가 적은 교훈을 contested로 보는 데 필요한 failed 세션 수 */
export const WEAK_LESSON_FAILED_SESSIONS = 2;

/**
 * lessons_applied 입력을 정규화한다. 같은 id가 여러 번 오면 마지막 항목을 쓴다.
 *
 * @param {unknown} raw
 * @returns {{entries: Array<{id: string, outcome: string}>, rejected: number}}
 */
export function normalizeLessonsApplied(raw) {
  if (!Array.isArray(raw)) return { entries: [], rejected: 0 };
  const byId   = new Map();
  let rejected = 0;
  for (const item of raw.slice(0, LESSONS_APPLIED_MAX)) {
    const id = typeof item?.id === "string" ? item.id.trim() : "";
    if (id.length === 0 || !LESSON_OUTCOMES.includes(item?.outcome)) { rejected += 1; continue; }
    byId.set(id, item.outcome);
  }
  rejected += Math.max(0, raw.length - LESSONS_APPLIED_MAX);
  return { entries: [...byId].map(([id, outcome]) => ({ id, outcome })), rejected };
}

/**
 * 교훈 적용 결과를 기록한다. 호출 키의 열린 교훈 파편만 받는다(마스터는 키 조건 없음).
 *
 * @param {Array<{id: string, outcome: string}>} entries - normalizeLessonsApplied 결과
 * @param {{sessionId: string, keyId?: string|null}} ctx
 * @returns {Promise<{recorded: Array<{id: string, outcome: string}>, ignored: number}>}
 */
export async function recordLessonOutcomes(entries, { sessionId, keyId = null }) {
  if (!Array.isArray(entries) || entries.length === 0) return { recorded: [], ignored: 0 };
  const params    = [entries.map(e => e.id), entries.map(e => e.outcome), sessionId];
  const keyFilter = keyScopeScalar(params, "f.key_id", keyId);
  const { rows }  = await queryWithAgentVector("system",
    `WITH input AS (
       SELECT * FROM unnest($1::text[], $2::text[]) AS i(id, outcome)
     ), lessons AS (
       SELECT f.id, f.key_id, i.outcome
         FROM ${SCHEMA}.fragments f JOIN input i ON i.id = f.id
        WHERE f.valid_to IS NULL AND ${lessonPredicateSql("f")}${keyFilter}
     )
     INSERT INTO ${SCHEMA}.lesson_outcomes (lesson_id, key_id, session_id, outcome)
     SELECT id, key_id, $3, outcome FROM lessons
     ON CONFLICT (lesson_id, session_id) DO UPDATE SET outcome = EXCLUDED.outcome, created_at = NOW()
     RETURNING lesson_id AS id, outcome`,
    params,
    "write"
  );
  return { recorded: rows, ignored: entries.length - rows.length };
}

/**
 * 집계에서 상태를 판정한다.
 *
 * @param {{helped: number, failed: number, failedSessions: number, last: string|null}} s
 * @returns {"contested"|"recent_failure"|null}
 */
export function lessonState({ helped, failed, failedSessions, last }) {
  const contested = helped >= STRONG_LESSON_HELPED
    ? failed > helped
    : failedSessions >= WEAK_LESSON_FAILED_SESSIONS && failed > helped;
  if (contested) return "contested";
  return last === "failed" ? "recent_failure" : null;
}

/**
 * Beta(1+helped, 1+failed)의 평균.
 *
 * @param {number} helped
 * @param {number} failed
 * @returns {number}
 */
export function lessonReliability(helped, failed) {
  return (1 + helped) / (2 + helped + failed);
}

/**
 * 교훈별 결과 집계. 결과가 없는 파편은 Map에 없다. 조회가 실패하면 빈 Map이다.
 *
 * @param {string[]} fragmentIds
 * @returns {Promise<Map<string, {helped: number, failed: number, not_applicable: number, n: number,
 *   reliability: number, state: "contested"|"recent_failure"|null}>>}
 */
export async function loadLessonOutcomeStats(fragmentIds) {
  const ids = [...new Set((fragmentIds ?? []).filter(id => typeof id === "string" && id.length > 0))];
  if (ids.length === 0) return new Map();
  try {
    const { rows } = await queryWithAgentVector("system",
      `SELECT lesson_id,
              count(*) FILTER (WHERE outcome = 'helped')::int                      AS helped,
              count(*) FILTER (WHERE outcome = 'failed')::int                      AS failed,
              count(*) FILTER (WHERE outcome = 'not_applicable')::int              AS not_applicable,
              count(DISTINCT session_id) FILTER (WHERE outcome = 'failed')::int    AS failed_sessions,
              (array_agg(outcome ORDER BY created_at DESC, id DESC)
                 FILTER (WHERE outcome <> 'not_applicable'))[1]                    AS last
         FROM ${SCHEMA}.lesson_outcomes
        WHERE lesson_id = ANY($1::text[])
        GROUP BY lesson_id`,
      [ids]
    );
    return new Map(rows.map(r => [r.lesson_id, {
      helped        : r.helped,
      failed        : r.failed,
      not_applicable: r.not_applicable,
      n             : r.helped + r.failed,
      reliability   : Number(lessonReliability(r.helped, r.failed).toFixed(3)),
      state         : lessonState({ helped: r.helped, failed: r.failed, failedSessions: r.failed_sessions, last: r.last ?? null })
    }]));
  } catch (err) {
    logWarn(`[LessonOutcomes] outcome stats lookup failed: ${err.message}`);
    return new Map();
  }
}

/**
 * 후보 파편 배열에서 contested 교훈을 뺀다. 결과 조회가 실패하면 그대로 둔다.
 *
 * @param {object[]} fragments
 * @param {Map<string, {state: string|null}>} stats - loadLessonOutcomeStats 결과
 * @returns {object[]}
 */
export function dropContested(fragments, stats) {
  if (!Array.isArray(fragments) || stats.size === 0) return fragments ?? [];
  return fragments.filter(f => stats.get(f?.id)?.state !== "contested");
}
