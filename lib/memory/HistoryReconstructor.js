/**
 * HistoryReconstructor - case/entity 기반 서사 재구성
 *
 * 작성자: 최진호
 * 작성일: 2026-04-03
 * 수정일: 2026-04-03 (Narrative Reconstruction Phase 3: CaseEventStore 통합 — case_events/DAG 병합)
 *
 * case_id 또는 entity(topic/keywords) 기반 fragments를 시간순으로 조회하고
 * fragment_links 기반 인과 체인을 구성하여 서사를 복원한다.
 * CaseEventStore가 주입되면 case_events / case_event_edges DAG도 함께 반환한다.
 */

import { getPrimaryPool } from "../tools/db.js";
import { logWarn }        from "../logger.js";
import { keyScopeClause } from "./keyScope.js";

const SCHEMA = "agent_memory";

/** LIKE 패턴 내 와일드카드 문자(%, _, \) 이스케이프 */
function escapeLike(str) {
  return str.replace(/[%_\\]/g, "\\$&");
}

export class HistoryReconstructor {
  /**
   * @param {import("./FragmentStore.js").FragmentStore}   store
   * @param {import("./LinkStore.js").LinkStore}            linkStore
   * @param {import("./CaseEventStore.js").CaseEventStore|null} [caseEventStore=null]
   */
  constructor(store, linkStore, caseEventStore = null) {
    this.store          = store;
    this.linkStore      = linkStore;
    this.caseEventStore = caseEventStore ?? null;
  }

  /**
   * case_id 또는 entity 기반 fragments를 시간순으로 조회하고
   * fragment_links 기반 인과 체인을 구성한다.
   *
   * @param {Object}      params
   * @param {string}      [params.caseId]     - 재구성할 케이스 식별자
   * @param {string}      [params.entity]     - topic/keywords ILIKE 필터 (caseId 없을 때 사용)
   * @param {Object}      [params.timeRange]  - { from: ISO8601, to: ISO8601 }
   * @param {string}      [params.query]      - 추가 content 키워드 필터
   * @param {number}      [params.limit=100]  - 최대 반환 건수
   * @param {number|null} [params.keyId]      - API 키 격리 필터
   * @param {string|null} [params.workspace]  - 워크스페이스 격리 필터
   * @returns {Promise<{
   *   ordered_timeline:      Object[],
   *   causal_chains:         Object[],
   *   unresolved_branches:   Object[],
   *   supporting_fragments:  Object[],
   *   case_events:           Object[],
   *   event_dag:             Object[],
   *   summary:               string
   * }>}
   */
  async reconstruct(params) {
    const caseId      = params.caseId       ?? null;
    const entity      = params.entity       ?? null;
    const timeRange   = params.timeRange    ?? null;
    const query       = params.query        ?? null;
    const limit       = Math.min(params.limit ?? 100, 500);
    const keyId       = params.keyId        ?? null;
    const groupKeyIds = params.groupKeyIds  ?? (keyId != null ? [keyId] : []);
    const workspace   = params.workspace    ?? null;

    if (!caseId && !entity) {
      throw new Error("caseId 또는 entity 중 하나는 필수입니다.");
    }

    const timeline = await this._fetchTimelineParameterized({ caseId, entity, timeRange, query, limit, keyId, groupKeyIds, workspace });

    /** case_events / DAG: caseEventStore 주입 + caseId가 있을 때만 조회 */
    let case_events = [];
    let event_dag   = [];

    if (this.caseEventStore && caseId) {
      case_events = await this.caseEventStore.getByCase(caseId, { keyId }).catch(err => {
        logWarn(`[HistoryReconstructor] getByCase failed: ${err?.message}`);
        return [];
      });

      if (case_events.length > 0) {
        const eventIds = case_events.map(e => e.event_id);
        event_dag      = await this.caseEventStore.getEdgesByEvents(eventIds, keyId).catch(() => []);
      }
    }

    /** 각 이벤트에 근거 파편(evidence) 첨부 */
    if (case_events.length > 0 && this.caseEventStore) {
      await Promise.all(case_events.map(async (evt) => {
        evt.evidence = await this.caseEventStore.getEvidenceByEvent(evt.event_id, keyId).catch(() => []);
      }));
    }

    if (timeline.length === 0 && case_events.length === 0) {
      return {
        ordered_timeline    : [],
        causal_chains       : [],
        unresolved_branches : [],
        supporting_fragments: [],
        case_events         : [],
        event_dag           : [],
        summary             : "조회된 파편이 없습니다."
      };
    }

    const fragmentIds = timeline.map(f => f.id);
    const links       = await this._fetchLinks(fragmentIds);

    const causal_chains       = this._buildCausalChains(timeline, links, event_dag);
    const unresolved_branches = this._detectUnresolvedBranches(timeline, causal_chains, case_events, event_dag);

    /** 인과 체인에 포함되지 않은 파편을 supporting_fragments로 분류 */
    const chainedIds = new Set(
      causal_chains.flatMap(c => c.chain.map(n => n.id))
    );
    const supporting_fragments = timeline.filter(f => !chainedIds.has(f.id));

    const summary = this._buildSummary(timeline, causal_chains, unresolved_branches);

    return {
      ordered_timeline    : timeline,
      causal_chains,
      unresolved_branches,
      supporting_fragments,
      case_events,
      event_dag,
      summary
    };
  }

  /**
   * 파라미터 인덱스를 명시적으로 관리하는 타임라인 쿼리 (caseId 또는 entity 기반)
   *
   * @private
   */
  async _fetchTimelineParameterized({ caseId, entity, timeRange, query, limit, keyId, groupKeyIds, workspace }) {
    const pool   = getPrimaryPool();
    const params = [];

    /** $1: caseId 또는 entity */
    let scopeClause;
    if (caseId) {
      params.push(caseId);                        // $1
      scopeClause = `f.case_id = $1`;
    } else {
      params.push(`%${escapeLike(entity)}%`);       // $1
      params.push(entity.toLowerCase());          // $2
      scopeClause = `(f.topic ILIKE $1 OR f.keywords @> ARRAY[$2]::text[])`;
    }

    const nextIdx = () => params.length + 1;

    /** 시간 범위 파라미터 */
    params.push(timeRange?.from ?? null);         // $n
    const fromIdx = params.length;
    params.push(timeRange?.to ?? null);           // $n+1
    const toIdx = params.length;

    /** content 키워드 */
    let queryClause = "";
    if (query) {
      params.push(`%${escapeLike(query)}%`);
      queryClause = `AND f.content ILIKE $${params.length}`;
    }

    /** key_id 격리: master(null)는 전체 접근, API 키는 그룹 전체 매칭 */
    const keyClause = keyScopeClause(params, "f.key_id", { keyId, groupKeyIds });

    /** workspace 격리 */
    let wsClause = "";
    if (workspace) {
      params.push(workspace);
      wsClause = `AND (f.workspace = $${params.length} OR f.workspace IS NULL)`;
    }

    /** limit */
    params.push(limit);
    const limitIdx = params.length;

    const sql = `
      SELECT f.id, f.content, f.topic, f.type, f.importance, f.keywords,
             f.case_id, f.session_id, f.resolution_status, f.goal, f.outcome,
             f.phase, f.assertion_status, f.workspace, f.created_at
        FROM ${SCHEMA}.fragments f
       WHERE ${scopeClause}
         AND ($${fromIdx}::timestamptz IS NULL OR f.created_at >= $${fromIdx})
         AND ($${toIdx}::timestamptz   IS NULL OR f.created_at <= $${toIdx})
         ${queryClause}
         ${keyClause}
         ${wsClause}
         AND f.valid_to IS NULL
       ORDER BY f.created_at ASC
       LIMIT $${limitIdx}`;

    const { rows } = await pool.query(sql, params);
    return rows;
  }

  /**
   * fragment_links를 조회하여 인과 체인 구성용 링크 데이터를 반환한다.
   *
   * @private
   * @param {string[]} fragmentIds
   * @returns {Promise<Object[]>}
   */
  async _fetchLinks(fragmentIds) {
    if (!fragmentIds || fragmentIds.length === 0) return [];

    const pool         = getPrimaryPool();
    const { rows }     = await pool.query(
      `SELECT fl.from_id, fl.to_id, fl.relation_type, fl.weight
         FROM ${SCHEMA}.fragment_links fl
        WHERE fl.from_id = ANY($1)
           OR fl.to_id   = ANY($1)`,
      [fragmentIds]
    );
    return rows;
  }

  /**
   * fragment_links BFS로 caused_by / resolved_by 인과 체인을 구성한다.
   * case_event_edges의 caused_by / resolved_by 엣지도 체인 구성에 반영한다.
   *
   * @private
   * @param {Object[]} fragments
   * @param {Object[]} links      - fragment_links 행 배열 (from_id, to_id, relation_type)
   * @param {Object[]} [eventDag] - case_event_edges 행 배열 (from_event_id, to_event_id, edge_type)
   * @returns {Object[]} causal_chains 배열
   */
  _buildCausalChains(fragments, links, eventDag = []) {
    const CAUSAL_TYPES = new Set(["caused_by", "resolved_by"]);
    const fragMap      = new Map(fragments.map(f => [f.id, f]));

    /** fragment_links 인과 관계 링크 */
    const causalLinks  = links.filter(l => CAUSAL_TYPES.has(l.relation_type));

    /**
     * case_event_edges의 caused_by / resolved_by 엣지를 fragment 체인에 반영한다.
     * source_fragment_id가 있는 이벤트 쌍 간 엣지를 fragment 링크 형태로 변환한다.
     */
    const eventEdgeLinks = [];
    if (eventDag && eventDag.length > 0) {
      for (const edge of eventDag) {
        if (!CAUSAL_TYPES.has(edge.edge_type)) continue;
        /** from/to event_id를 fragment 링크로 의미상 투영 — event_id를 가상 id로 활용 */
        eventEdgeLinks.push({
          from_id      : edge.from_event_id,
          to_id        : edge.to_event_id,
          relation_type: edge.edge_type,
          weight       : edge.confidence ?? 1.0,
          _from_dag    : true
        });
      }
    }

    const allCausalLinks = [...causalLinks, ...eventEdgeLinks];
    if (allCausalLinks.length === 0) return [];

    /** 역방향 인덱스: id → outgoing causal links */
    const outgoing = new Map();
    for (const link of allCausalLinks) {
      if (!outgoing.has(link.from_id)) outgoing.set(link.from_id, []);
      outgoing.get(link.from_id).push(link);
    }

    /** 체인 시작점: causal link의 from_id 중 다른 링크의 to_id가 아닌 것 */
    const toIds   = new Set(allCausalLinks.map(l => l.to_id));
    const fromIds = [...new Set(allCausalLinks.map(l => l.from_id))];
    const roots   = fromIds.filter(id => !toIds.has(id));

    const chains = [];

    for (const rootId of roots) {
      const chain   = [];
      const visited = new Set();
      const queue   = [rootId];

      /** BFS 순회 */
      while (queue.length > 0) {
        const current = queue.shift();
        if (visited.has(current)) continue;
        visited.add(current);

        const frag = fragMap.get(current);
        if (frag) chain.push({ ...frag, _chain_position: chain.length });

        const next = outgoing.get(current) || [];
        for (const link of next) {
          if (!visited.has(link.to_id)) {
            queue.push(link.to_id);
          }
        }
      }

      if (chain.length > 0) {
        const hasResolution = chain.some(f => f.resolution_status === "resolved");
        chains.push({
          root_id    : rootId,
          chain,
          length     : chain.length,
          is_resolved: hasResolution
        });
      }
    }

    return chains;
  }

  /**
   * 미해결 브랜치를 수집한다.
   *
   * 수집 대상:
   * 1. resolution_status='open'인 fragment 중 해결된 체인에 포함되지 않은 것
   * 2. case_events 중 event_type='error_observed'이고 'resolved_by' 엣지가 없는 것
   *
   * @private
   * @param {Object[]} fragments
   * @param {Object[]} chains
   * @param {Object[]} [caseEvents=[]]
   * @param {Object[]} [eventDag=[]]
   * @returns {Object[]} unresolved_branches 배열
   */
  _detectUnresolvedBranches(fragments, chains, caseEvents = [], eventDag = []) {
    const resolvedChainIds = new Set(
      chains.filter(c => c.is_resolved).flatMap(c => c.chain.map(n => n.id))
    );

    /** fragment 기반 미해결 브랜치 */
    const fragmentBranches = fragments.filter(f =>
      f.resolution_status === "open" && !resolvedChainIds.has(f.id)
    );

    /** case_events 기반 미해결 브랜치:
     *  error_observed 이벤트 중 resolved_by 엣지의 from_event_id로 등장하지 않는 것 */
    const resolvedByFromIds = new Set(
      eventDag
        .filter(e => e.edge_type === "resolved_by")
        .map(e => e.from_event_id)
    );

    const unresolvedErrorEvents = caseEvents
      .filter(e => e.event_type === "error_observed" && !resolvedByFromIds.has(e.event_id))
      .map(e => ({ ...e, _source: "case_event" }));

    return [...fragmentBranches, ...unresolvedErrorEvents];
  }

  /**
   * 타임라인·체인·미해결 브랜치를 기반으로 요약 문자열을 생성한다.
   *
   * @private
   * @param {Object[]} timeline
   * @param {Object[]} chains
   * @param {Object[]} branches
   * @returns {string}
   */
  _buildSummary(timeline, chains, branches) {
    const total      = timeline.length;
    const first      = timeline[0]?.created_at;
    const last       = timeline[timeline.length - 1]?.created_at;
    const resolved   = chains.filter(c => c.is_resolved).length;
    const unresolved = branches.length;

    const lines = [
      `총 ${total}개 파편 (${first ? first.toISOString?.() ?? first : "-"} ~ ${last ? last.toISOString?.() ?? last : "-"})`,
      `인과 체인: ${chains.length}개 (해결됨: ${resolved}, 미해결: ${chains.length - resolved})`,
      `미해결 브랜치: ${unresolved}개`
    ];

    if (branches.length > 0) {
      lines.push(
        "미해결 항목: " +
        branches.slice(0, 3).map(b => (b.content ?? b.summary ?? "").slice(0, 60)).join(" | ")
      );
    }

    return lines.join("\n");
  }
}
