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
import { exactScopeClause, keyScopeClause } from "../keyScope.js";

const SCHEMA = "agent_memory";

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
   * @param {number|null} opts.keyId     - API 키 격리 (null = master key, 조건 생략)
   * @param {number}      opts.maxCases  - 최대 반환 케이스 수 (기본 5, 상한 10)
   * @param {string|null} opts.workspace - workspace scope
   * @param {boolean}     opts.strictScope - exact API-key tuple mode
   * @returns {Promise<Object[]>} cases 배열
   *   [{ case_id, goal, outcome, resolution_status, events, fragment_count, relevance_score }]
   */
  async buildCaseTriples(fragments, {
    keyId = null, maxCases = 5, workspace = null, strictScope = false, groupKeyIds = []
  } = {}) {
    const pool = getPrimaryPool();
    if (!pool) {
      logWarn("[CaseRecall] DB pool unavailable — returning empty cases");
      return [];
    }

    const safeMaxCases = Math.min(maxCases, HARD_MAX_CASES);

    /** API-key pilot: input itself is a final defense against hostile/mocked rows. */
    const scopedFragments = strictScope
      ? (Array.isArray(keyId) || keyId == null || workspace == null
        ? []
        : fragments.filter(f => f?.key_id === keyId && f?.workspace === workspace))
      : fragments;

    /** 1. case_id 추출 (중복 제거, 출현 빈도 = relevance) */
    const caseCount = new Map();
    for (const f of scopedFragments) {
      if (!f.case_id) continue;
      caseCount.set(f.case_id, (caseCount.get(f.case_id) || 0) + 1);
    }
    if (caseCount.size === 0) return [];

    /** 출현 빈도순 정렬 후 상위 safeMaxCases */
    const topCaseIds = [...caseCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, safeMaxCases)
      .map(([id]) => id);

    /** 2. 각 case의 대표 파편에서 goal/outcome/resolution_status 조회 */
    const queryParams = [topCaseIds];
    let keyFilter = "";
    if (strictScope) {
      keyFilter = exactScopeClause(queryParams, "f", { keyId, workspace });
    } else {
      keyFilter = keyScopeClause(queryParams, "f.key_id", { keyId, groupKeyIds });
      if (workspace != null) {
        queryParams.push(workspace);
        keyFilter += ` AND (f.workspace = $${queryParams.length} OR f.workspace IS NULL)`;
      }
    }

    let caseFrags = [];
    try {
      const { rows } = await pool.query(
        `SELECT f.case_id, f.goal, f.outcome, f.resolution_status, f.phase,
                f.key_id, f.workspace,
                COUNT(*) OVER (PARTITION BY f.case_id) AS fragment_count
           FROM ${SCHEMA}.fragments f
          WHERE f.case_id = ANY($1)
            AND f.valid_to IS NULL
            ${keyFilter}
          ORDER BY case_id, importance DESC`,
        queryParams
      );
      caseFrags = strictScope
        ? rows.filter(f => f?.key_id === keyId && f?.workspace === workspace)
        : rows;
    } catch (err) {
      logWarn("[CaseRecall] fragments query failed", { error: err.message });
      return [];
    }

    /** 3. case_events 타임라인 조회 */
    let events = [];
    try {
      const eventParams = [topCaseIds];
      const eventScope = strictScope
        ? exactScopeClause(eventParams, "sf", { keyId, workspace })
        : (workspace != null
          ? (() => { eventParams.push(workspace); return ` AND (sf.workspace = $${eventParams.length} OR sf.workspace IS NULL)`; })()
          : "");
      const eventJoin = strictScope || workspace != null
        ? `JOIN ${SCHEMA}.fragments sf ON sf.id = ce.source_fragment_id`
        : "";
      const { rows } = await pool.query(
        `SELECT ce.case_id, ce.event_type, ce.summary, ce.created_at,
                ce.key_id, sf.workspace
           FROM ${SCHEMA}.case_events ce
           ${eventJoin}
          WHERE ce.case_id = ANY($1)
            ${eventScope}
          ORDER BY ce.case_id, ce.sequence_no ASC`,
        eventParams
      );
      events = strictScope
        ? rows.filter(e => e?.key_id === keyId && e?.workspace === workspace)
        : rows;
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
