/**
 * LessonIndex - context 교훈 색인
 *
 * 작성자: 최진호
 * 작성일: 2026-11-19
 *
 * context 끝에 같은 범위(키, workspace)의 교훈을 cue 한 줄과 id로 싣는다. 본문은 싣지 않는다. 에이전트는 상황이
 * 맞는 줄의 id로 recall해 본문을 연다. 교훈은 reflect lessons로 저장한 procedure 파편이다(write/LessonCue.js).
 *
 *   고르기  열린 교훈 가운데 근거를 잃지 않았고(support_state revoked, stale 제외) 검토 대기가 아니며 적용 실패가 쌓이지
 *           않은(contested 아님) 것. 이미 context 본문으로 실린 교훈은 뺀다
 *   순서    적용 결과가 있으면 신뢰도(Beta 평균) 높은 순, 없으면 0.5로 보고, 같으면 최근에 만든 순
 *   상한    MEMENTO_LESSON_INDEX_LIMIT 줄, 그리고 context 토큰 예산의 남은 양
 *   스위치  MEMENTO_LESSON_INDEX(on, off, ab). ab는 세션 id 해시의 짝홀로 on과 off를 나눈다
 */

import { createHash }           from "node:crypto";
import { SCHEMA }               from "../schema.js";
import { keyScopeGroup }        from "../keyScope.js";
import { agentScopeCondition }  from "./AgentScope.js";
import { notPendingReviewSql }  from "./ReviewVisibility.js";
import { supportedSql }         from "../write/Lineage.js";
import { lessonPredicateSql, LESSON_SUMMARY_PREFIX } from "../write/LessonSummary.js";
import { loadLessonOutcomeStats } from "../signals/LessonOutcomes.js";
import { countContentTokens }   from "./BudgetSelector.js";
import { queryScoped }          from "../../tools/row-scope.js";
import { logWarn }              from "../../logger.js";
import { LESSON_INDEX_LIMIT }   from "../../config.js";
import { lessonIndexLines as lessonIndexLinesMetric } from "./experience-metrics.js";

/** 색인 후보로 먼저 꺼내는 교훈 수 */
const CANDIDATE_LIMIT = 40;

/** cue 줄 길이 상한 */
const CUE_LINE_CHARS = 120;

/**
 * 이 요청에 색인을 실을지. ab는 세션 id 해시로 나누고, 세션 id가 없으면 싣지 않는다.
 *
 * @param {"on"|"off"|"ab"} mode
 * @param {string|null|undefined} sessionId
 * @returns {{enabled: boolean, arm: "on"|"off"|null}}
 */
export function lessonIndexArm(mode, sessionId) {
  if (mode === "on")  return { enabled: true,  arm: null };
  if (mode !== "ab")  return { enabled: false, arm: null };
  if (!sessionId)     return { enabled: false, arm: "off" };
  const bucket = createHash("sha256").update(String(sessionId)).digest()[0] % 2;
  return bucket === 0 ? { enabled: true, arm: "on" } : { enabled: false, arm: "off" };
}

/**
 * 교훈 맥락 요약에서 cue 한 줄을 뽑는다. 머리말이 없으면 본문 첫 줄을 쓴다.
 *
 * @param {{context_summary?: string|null, content?: string|null}} row
 * @returns {string}
 */
export function lessonCueLine(row) {
  const summary = typeof row.context_summary === "string" ? row.context_summary : "";
  const raw     = summary.startsWith(LESSON_SUMMARY_PREFIX)
    ? summary.slice(LESSON_SUMMARY_PREFIX.length).split("\n")[0]
    : String(row.content ?? "").split("\n")[0];
  const line = raw.trim();
  return line.length > CUE_LINE_CHARS ? `${line.slice(0, CUE_LINE_CHARS)}…` : line;
}

/**
 * 후보를 고르고 줄로 만든다. 순수 함수다.
 *
 * @param {Array<{id: string, context_summary?: string, content?: string, created_at?: string|Date}>} rows - 최근 순
 * @param {Map<string, {reliability: number, n: number, state: string|null}>} stats
 * @param {{exclude?: Set<string>, limit: number, tokenRoom: number}} options
 * @returns {Array<{id: string, cue: string, reliability: number|null, n: number}>}
 */
export function selectLessonIndex(rows, stats, { exclude = new Set(), limit, tokenRoom }) {
  const ranked = rows
    .filter(r => !exclude.has(r.id) && stats.get(r.id)?.state !== "contested")
    .map((r, order) => ({ r, order, s: stats.get(r.id) }))
    .sort((a, b) => ((b.s?.reliability ?? 0.5) - (a.s?.reliability ?? 0.5)) || (a.order - b.order));
  const out = [];
  let used  = 0;
  for (const { r, s } of ranked) {
    if (out.length >= limit) break;
    const cue = lessonCueLine(r);
    if (cue.length === 0) continue;
    const cost = countContentTokens(renderLessonIndexLine({ id: r.id, cue }));
    if (used + cost > tokenRoom) break;
    used += cost;
    out.push({ id: r.id, cue, reliability: s?.n > 0 ? s.reliability : null, n: s?.n ?? 0 });
  }
  return out;
}

/**
 * 색인 한 줄.
 *
 * @param {{id: string, cue: string}} entry
 * @returns {string}
 */
export function renderLessonIndexLine({ id, cue }) {
  return `- [${id}] ${cue}`;
}

/**
 * 색인 구획 줄. 비어 있으면 빈 배열이다.
 *
 * @param {Array<{id: string, cue: string}>} entries
 * @returns {string[]}
 */
export function renderLessonIndexLines(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return [];
  return ["", "[LESSON INDEX] 상황이 맞는 줄의 id로 recall하면 교훈 본문이 나온다", ...entries.map(renderLessonIndexLine)];
}

/**
 * 교훈 색인을 불러온다. 실패하면 빈 배열이다.
 *
 * @param {{
 *   pool: import("pg").Pool|null, agentScope: object, groupKeyIds: string[]|null, workspace: string|null,
 *   allWorkspaces: boolean, exclude: Set<string>, limit: number, tokenRoom: number
 * }} options
 * @returns {Promise<Array<{id: string, cue: string, reliability: number|null, n: number}>>}
 */
export async function loadLessonIndex({ pool, agentScope, groupKeyIds, workspace, allWorkspaces, exclude, limit, tokenRoom }) {
  if (!pool || limit <= 0 || tokenRoom <= 0) return [];
  try {
    const params    = [agentScope.agentId];
    const keyFilter = keyScopeGroup(params, "f.key_id", groupKeyIds);
    let workspaceFilter = "";
    if (workspace != null) {
      params.push(workspace);
      workspaceFilter = ` AND f.workspace = $${params.length}`;
    } else if (!allWorkspaces) {
      workspaceFilter = " AND f.workspace IS NULL";
    }
    params.push(CANDIDATE_LIMIT);
    const { rows } = await queryScoped(pool,
      `SELECT f.id, f.content, f.context_summary, f.created_at
         FROM ${SCHEMA}.fragments f
        WHERE f.valid_to IS NULL
          AND ${lessonPredicateSql("f")}
          AND ${agentScopeCondition("$1", agentScope, "f.agent_id")}
          ${keyFilter}${workspaceFilter}
          AND ${supportedSql("f")}${notPendingReviewSql("f")}
        ORDER BY f.created_at DESC, f.id
        LIMIT $${params.length}`,
      params
    );
    if (rows.length === 0) return [];
    const stats = await loadLessonOutcomeStats(rows.map(r => r.id));
    return selectLessonIndex(rows, stats, { exclude, limit, tokenRoom });
  } catch (err) {
    logWarn(`[LessonIndex] lesson index load failed: ${err.message}`);
    return [];
  }
}

/**
 * context에 실을 교훈 색인 구획. 스위치와 세션으로 실을지 정하고, 줄, 토큰, 응답 메타를 돌려준다.
 *
 * @param {{mode: "on"|"off"|"ab", sessionId?: string|null, pool: import("pg").Pool|null, agentScope: object,
 *   groupKeyIds: string[]|null, workspace: string|null, allWorkspaces: boolean, exclude: Set<string>, tokenRoom: number}} options
 * @returns {Promise<{lines: string[], tokens: number, meta: Object}>}
 */
export async function buildLessonIndexSection({ mode, sessionId, ...query }) {
  const arm     = lessonIndexArm(mode, sessionId);
  const entries = arm.enabled ? await loadLessonIndex({ ...query, limit: LESSON_INDEX_LIMIT }) : [];
  if (arm.enabled) lessonIndexLinesMetric.observe(entries.length);
  const lines   = renderLessonIndexLines(entries);
  return {
    lines,
    tokens: lines.length > 0 ? countContentTokens(lines.join("\n")) : 0,
    meta  : {
      ...(entries.length > 0 ? { lessonIndex: entries } : {}),
      ...(arm.arm ? { lessonIndexArm: arm.arm } : {})
    }
  };
}
