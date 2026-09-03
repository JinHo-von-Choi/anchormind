/**
 * CaseRecall — CBR(Case-Based Reasoning) 케이스 검색
 *
 * 유사 파편에서 case_id를 추출하고, 각 case를
 * (goal, events_summary, outcome, resolution_status) 트리플로 조합하여 반환한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-04-07
 */

import { getPrimaryPool } from "../../tools/db.js";
import { logWarn }        from "../../logger.js";
import { keyScopeGroup } from "../keyScope.js";
import { SCHEMA } from "../schema.js";
import { normalizeIsAnchor } from "./SearchScope.js";
import { workspaceCondition } from "./WorkspaceScope.js";

/** 응답 크기 방어 상한 */
const HARD_MAX_CASES        = 10;
const MAX_EVENTS_PER_CASE   = 20;
const MAX_EVENT_SUMMARY_LEN = 120;

export class CaseRecall {
  /**
   * 검색된 파편 목록에서 case_id를 추출하고 케이스별 트리플을 조합한다.
   *
   * 방어 상한: 최대 10 cases x 20 events x 120자 summary = ~24KB
   *
   * @param {Object[]} fragments         - recall 검색 결과 파편 배열
   * @param {Object}   opts
   * @param {string|null} opts.keyId     - 하위 호환 단일 키 범위 (groupKeyIds 미지정 시 사용)
   * @param {string[]|null} opts.groupKeyIds - 현재 키 그룹 범위 (null = master, 조건 생략)
   * @param {string|null} opts.workspace - workspace 범위 (null = 전역 파편만)
   * @param {boolean} opts.allWorkspaces - 인증된 master의 명시적 전체 범위
   * @param {number}      opts.maxCases  - 최대 반환 케이스 수 (기본 5, 상한 10)
   * @param {boolean|null|undefined} opts.isAnchor - true=앵커만, false=비앵커만, null/미지정=혼합
   * @param {boolean}     opts.includeSuperseded - 만료된 대표 파편 포함 여부
   * @returns {Promise<Object[]>} cases 배열
   *   fragment_count는 key group/workspace/includeSuperseded/isAnchor 필터를 모두 적용한 뒤 해당
   *   case에서 대표값 후보가 된 파편 수다. 케이스의 전체 누적 파편 수가 아니다.
   *   [{ case_id, goal, outcome, resolution_status, events, fragment_count, relevance_score }]
   */
  async buildCaseTriples(
    fragments,
    {
      keyId = null,
      groupKeyIds,
      workspace = null,
      allWorkspaces = false,
      maxCases = 5,
      isAnchor,
      includeSuperseded = false
    } = {}
  ) {
    isAnchor = normalizeIsAnchor(isAnchor);
    const effectiveKeyIds = groupKeyIds ?? (keyId != null ? [keyId] : null);
    const pool = getPrimaryPool();
    if (!pool) {
      logWarn("[CaseRecall] DB pool unavailable — returning empty cases");
      return [];
    }

    const safeMaxCases = Math.min(maxCases, HARD_MAX_CASES);

    /** 1. case_id 추출 (중복 제거, 출현 빈도 = relevance) */
    const caseCount = new Map();
    for (const f of fragments) {
      if (!f.case_id) continue;
      caseCount.set(f.case_id, (caseCount.get(f.case_id) || 0) + 1);
    }
    if (caseCount.size === 0) return [];

    /** 출현 빈도순 정렬 후 상위 safeMaxCases */
    const topCaseIds = [...caseCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, safeMaxCases)
      .map(([id]) => id);

    /**
     * 2. 각 case의 대표 파편에서 goal/outcome/resolution_status 조회.
     * fragment_count도 동일 WHERE 범위를 세어 필터가 적용된 대표 후보 수를 뜻한다.
     */
    const queryParams = [topCaseIds];
    const keyFilter = keyScopeGroup(queryParams, "key_id", effectiveKeyIds).trimStart();
    const workspaceClause = workspaceCondition(
      queryParams, { workspace, allWorkspaces }, "workspace"
    );
    const workspaceFilter = workspaceClause ? `AND ${workspaceClause}` : "";
    let anchorFilter = "";
    if (isAnchor !== undefined) {
      queryParams.push(isAnchor);
      anchorFilter = `AND is_anchor = $${queryParams.length}`;
    }
    const validFilter = includeSuperseded ? "" : "AND valid_to IS NULL";

    let caseFrags;
    try {
      const { rows } = await pool.query(
        `SELECT id, case_id, goal, outcome, resolution_status, phase, is_anchor, created_at,
                COUNT(*) OVER (PARTITION BY case_id) AS fragment_count
           FROM ${SCHEMA}.fragments
          WHERE case_id = ANY($1)
            ${validFilter}
            ${keyFilter}
            ${workspaceFilter}
            ${anchorFilter}
          ORDER BY case_id, importance DESC, created_at DESC, id ASC`,
        queryParams
      );
      caseFrags = rows;
    } catch (err) {
      logWarn("[CaseRecall] fragments query failed", { error: err.message });
      return [];
    }

    /**
     * 3. case_events 타임라인 조회
     *
     * isAnchor는 현재 대표 파편을 고르는 검색 조건이지 과거 이벤트의 속성이 아니다.
     * 이벤트를 source fragment의 현재 is_anchor/valid_to와 조인해 거르면 파편의
     * 승격·강등·대체 때 이미 기록된 타임라인까지 달라진다. 선택된 case의 이벤트는
     * 독립적인 이력으로 유지하고 case_events 자체의 key group scope만 적용한다.
     */
    let events = [];
    try {
      const eventParams = [topCaseIds];
      const eventKeyFilter = keyScopeGroup(eventParams, "ce.key_id", effectiveKeyIds).trimStart();
      const eventQuery = `SELECT ce.case_id, ce.event_type, ce.summary, ce.created_at
           FROM ${SCHEMA}.case_events ce
          WHERE ce.case_id = ANY($1)
            ${eventKeyFilter}
          ORDER BY case_id, sequence_no ASC`;
      const { rows } = await pool.query(eventQuery, eventParams);
      events = rows;
    } catch (err) {
      logWarn("[CaseRecall] case_events query failed", { error: err.message });
      /** events 실패 시에도 fragment 정보만으로 트리플 구성 */
    }

    /** 4. 케이스별 트리플 조합 */
    const eventsByCase = new Map();
    for (const e of events) {
      if (!eventsByCase.has(e.case_id)) eventsByCase.set(e.case_id, []);
      eventsByCase.get(e.case_id).push({
        event_type: e.event_type,
        summary   : (e.summary || "").slice(0, MAX_EVENT_SUMMARY_LEN),
        created_at: e.created_at
      });
    }

    const cases = [];
    const seen  = new Set();
    for (const caseId of topCaseIds) {
      if (seen.has(caseId)) continue;
      seen.add(caseId);

      /** 대표 파편에서 goal/outcome 추출 (가장 높은 importance 순 — ORDER BY importance DESC) */
      const repFrags   = caseFrags.filter(f => f.case_id === caseId);
      if (repFrags.length === 0) continue;
      const goal       = repFrags.find(f => f.goal)?.goal                             || null;
      const outcome    = repFrags.find(f => f.outcome)?.outcome                       || null;
      const resolution = repFrags.find(f => f.resolution_status)?.resolution_status   || "open";
      const fragCount  = repFrags[0]?.fragment_count                                  || 0;

      cases.push({
        case_id          : caseId,
        goal,
        outcome,
        resolution_status: resolution,
        events           : (eventsByCase.get(caseId) || []).slice(0, MAX_EVENTS_PER_CASE),
        fragment_count   : Number(fragCount),
        relevance_score  : caseCount.get(caseId) || 0
      });
    }

    /** resolved 우선, 동률 시 relevance_score 내림차순 정렬 */
    cases.sort((a, b) => {
      const aResolved = a.resolution_status === "resolved";
      const bResolved = b.resolution_status === "resolved";
      if (aResolved && !bResolved) return -1;
      if (!aResolved && bResolved) return  1;
      return b.relevance_score - a.relevance_score;
    });

    return cases;
  }
}
