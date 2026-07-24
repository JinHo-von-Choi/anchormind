/**
 * MemoryRecaller - 기억 회상 전담 클래스 (Phase 5-B 분해)
 *
 * 작성자: 최진호
 * 작성일: 2026-04-20
 *
 * 이관 대상: recall / context / graphExplore / toolFeedback / fragmentHistory
 *
 * 공개 API 계약은 원본 통합 관리자와 100% 동일하게 유지한다.
 */

import { getPrimaryPool }        from "../../tools/db.js";
import { MEMORY_CONFIG }         from "../../../config/memory.js";
import { GraphLinker }           from "../link/GraphLinker.js";
import { logWarn }               from "../../logger.js";
import { activateByContext }     from "../signals/SpreadingActivation.js";
import { CaseRecall }            from "../read/CaseRecall.js";
import { deriveImplicitKeywords, lexicalMatchScore } from "../read/FragmentSearch.js";
import { extractRequestCtx }                        from "../keyId.js";
import { enrichWithKeyNames }                        from "../read/KeyNameEnricher.js";

/**
 * 파편의 stale 여부를 계산한다. verified_at이 없으면 created_at으로 폴백하고,
 * 둘 다 없으면 판정을 보류하여(null) 거짓 양성을 막는다 (fail-open).
 *
 * @param {Object} frag
 * @param {number} now - Date.now()
 * @returns {null | { stale: true, warning: string, days_since_verification: number }}
 */
export function computeStale(frag, now) {
  const staleThresholds = MEMORY_CONFIG.staleThresholds;
  const staleDays = staleThresholds[frag.type] ?? staleThresholds.default;
  const ref = frag.verified_at ?? frag.created_at ?? null;
  if (!ref) {
    return null;
  }
  const daysSince = Math.floor((now - new Date(ref).getTime()) / 86400000);
  if (daysSince < staleDays) {
    return null;
  }
  return {
    stale  : true,
    warning: `[STALE_WARNING] 이 ${frag.type} 정보는 ${staleDays}일 이상 검증되지 않았습니다. (${daysSince}일 경과)`,
    days_since_verification: daysSince
  };
}

export class MemoryRecaller {
  /**
   * @param {Object} deps
   * @param {import('../write/FragmentStore.js').FragmentStore}           [deps.store]
   * @param {import('../read/FragmentSearch.js').FragmentSearch}         [deps.search]
   * @param {import('../FragmentIndex.js').FragmentIndex}           [deps.index]
   * @param {import('../CaseEventStore.js').CaseEventStore}         [deps.caseEventStore]
   * @param {import('../read/ContextBuilder.js').ContextBuilder}         [deps.contextBuilder]
   * @param {import('../read/RecallSuggestionEngine.js').RecallSuggestionEngine} [deps.suggestionEngine]
   */
  constructor({ store, search, index, caseEventStore, contextBuilder, suggestionEngine } = {}) {
    this.store            = store;
    this.search           = search;
    this.index            = index;
    this.caseEventStore   = caseEventStore;
    this.contextBuilder   = contextBuilder;
    this.suggestionEngine = suggestionEngine;
  }

  /**
   * recall - 파편 회상
   *
   * @param {Object} params
   *   - keywords        {string[]} 검색 키워드
   *   - topic           {string}   주제 필터
   *   - type            {string}   유형 필터
   *   - text            {string}   자연어 검색 (시맨틱)
   *   - tokenBudget     {number}   최대 토큰 수 (기본 1000)
   *   - includeLinks    {boolean}  연결 파편 포함 여부 (기본 true, 1-hop 제한, resolved_by/caused_by 우선)
   *   - linkRelationType {string}  연결 파편 관계 유형 필터 (미지정 시 caused_by, resolved_by, related 포함)
   *   - fragmentCount   {number}   전체 파편 수 — 100 이상 시 복합 랭킹 활성화 (기본 0)
   *   - threshold       {number}   similarity 임계값 (0~1). 미만 파편 제거. similarity 없는 파편은 보존
   * @returns {Object} { fragments, totalTokens, searchPath, count }
   */
  async recall(params) {
    const { agentId, keyId, groupKeyIds } = extractRequestCtx(params);
    const fragmentCount = params.fragmentCount || 0;
    const workspace     = params.workspace ?? params._defaultWorkspace ?? null;

    const anchorTime = params.anchorTime || Date.now();

    /** Spreading Activation: 대화 맥락 기반 선제적 파편 활성화 (fire-and-forget) */
    if (params.contextText && process.env.ENABLE_SPREADING_ACTIVATION === "true") {
      activateByContext(params.contextText, agentId, keyId, params.sessionId).catch(() => {});
    }

    const result = await this.search.search({
      keywords          : params.keywords || [],
      topic             : params.topic,
      type              : params.type,
      text              : params.text,
      tokenBudget       : params.tokenBudget || 1000,
      minImportance     : params.minImportance,
      includeSuperseded : params.includeSuperseded || false,
      timeRange         : params.timeRange || undefined,
      fragmentCount,                          // 하위 호환 유지
      anchorTime,                             // 시간-의미 복합 랭킹 기준
      agentId,                                // RLS 컨텍스트
      keyId: groupKeyIds,                     // API 키 격리 필터 (그룹 배열)
      workspace,                              // 워크스페이스 필터
      sessionId: params.sessionId || null,    // search_events.session_id 전파
      ...(params.isAnchor !== undefined ? { isAnchor: params.isAnchor } : {}),
      ...(params.caseId            ? { caseId: params.caseId } : {}),
      ...(params.resolutionStatus  ? { resolutionStatus: params.resolutionStatus } : {}),
      ...(params.phase             ? { phase: params.phase } : {}),
      ...(params.affect            ? { affect: params.affect } : {}),
      ...(params.includePeerAgents === true ? { includePeerAgents: true } : {}),
      ...(params.includeKeyName === true ? { includeKeyName: true } : {})
      /** H2 Sparse Fieldsets: 필드 선택은 응답 프로젝션(buildRecallResponse)에서 최종 적용한다.
       *  파생 키(confidence, age_days) 산출에 원시 컬럼이 필요하므로 검색 계층에서는 자르지 않는다. */
    });

    /** 연결 파편 포함 (기본 true, 1-hop 제한, fragment_links 테이블 활용) */
    const shouldIncludeLinks = params.includeLinks !== false;
    if (shouldIncludeLinks && result.fragments.length > 0) {
      const existingIds = new Set(result.fragments.map(f => f.id));
      const fromIds     = result.fragments.map(f => f.id);

      const linkedFrags = await this.store.getLinkedFragments(
        fromIds,
        params.linkRelationType || null,
        agentId,
        groupKeyIds
      );

      for (const lf of linkedFrags) {
        if (!existingIds.has(lf.id)) {
          lf._source = "linked";
          result.fragments.push(lf);
          existingIds.add(lf.id);
        }
      }
      result.count = result.fragments.length;
    }

    /**
     * 통합 최종 정렬 — FragmentSearch의 reranker/RRF 정렬 결과에 includeLinks
     * 파편이 합류한 집합을 computeRecallScore로 재정렬한다.
     * rerankerScore를 base로 보존하므로 cross-encoder 결과를 폐기하지 않으며,
     * topic/keyword 직접 일치를 제한된 가산항으로 반영한다.
     * lexWeight는 파편별 rerankerScore 유무로 결정된다(집합 단위 아님).
     */
    const lexicalQuery = {
      keywords          : params.keywords,
      topic             : params.topic,
      _implicitKeywords : deriveImplicitKeywords(params)
    };
    const rankCtx = { lexicalQuery, anchorTime, config: MEMORY_CONFIG };

    result.fragments.sort(
      (a, b) => computeRecallScore(b, rankCtx) - computeRecallScore(a, rankCtx)
    );

    /** 내부 origin 태그는 정렬 용도로만 사용 — 응답에서 제거 */
    for (const f of result.fragments) {
      if (f._source !== undefined) delete f._source;
    }

    /** stale 감지 및 메타데이터 주입 */
    const now = Date.now();
    for (const frag of result.fragments) {
      const stale = computeStale(frag, now);
      if (stale) {
        frag.metadata = { ...(frag.metadata || {}), ...stale };
      }
    }

    /** threshold 필터: similarity가 있는 파편만 필터링, L1/L2 결과(similarity 없음)는 보존 */
    if (params.threshold !== undefined) {
      result.fragments = result.fragments.filter(
        f => f.similarity === undefined || f.similarity >= params.threshold
      );
      result.count = result.fragments.length;
    }

    /** depth 필터: Planner/Executor 역할별 파편 유형 제한 (type 미지정 시에만 적용) */
    const DEPTH_TYPE_MAP = {
      "high-level": ["decision", "episode"],
      "tool-level": ["procedure", "error", "fact"],
    };
    if (params.depth && DEPTH_TYPE_MAP[params.depth] && !params.type) {
      const allowedTypes     = new Set(DEPTH_TYPE_MAP[params.depth]);
      result.fragments = result.fragments.filter(f => allowedTypes.has(f.type));
      result.count     = result.fragments.length;
    }

    /** Seen IDs 필터링: context()에서 이미 주입된 파편 제외 */
    const excludeSeen = params.excludeSeen !== false;
    if (excludeSeen && params.sessionId) {
      const seenIds = await this.index.getSeenIds(params.sessionId);
      if (seenIds.size > 0) {
        result.fragments = result.fragments.filter(f => !seenIds.has(f.id));
        result.count     = result.fragments.length;
      }
    }

    /** 페이지네이션 */
    const pageSize = Math.min(
      params.pageSize || MEMORY_CONFIG.pagination?.defaultPageSize || 20,
      MEMORY_CONFIG.pagination?.maxPageSize || 50
    );

    let   offset     = 0;
    let   anchorSnap = params.anchorTime || Date.now();
    if (params.cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(params.cursor, "base64url").toString());
        offset     = decoded.offset     || 0;
        anchorSnap = decoded.anchorTime  || anchorSnap;
      } catch { /* 잘못된 cursor 무시 */ }
    }

    const totalCount = result.fragments.length;
    const paged      = result.fragments.slice(offset, offset + pageSize);
    const hasMore    = offset + pageSize < totalCount;
    const nextCursor = hasMore
      ? Buffer.from(JSON.stringify({ offset: offset + pageSize, anchorTime: anchorSnap })).toString("base64url")
      : null;

    result.fragments  = paged;
    result.count      = paged.length;
    result.totalCount = totalCount;
    result.nextCursor = nextCursor;
    result.hasMore    = hasMore;

    /** CBR caseMode: 검색 결과 파편을 case 트리플로 변환하여 반환 */
    if (params.caseMode) {
      const caseRecall = new CaseRecall();
      const cases      = await caseRecall.buildCaseTriples(result.fragments, {
        keyId,
        maxCases: params.maxCases || 5
      });

      return {
        fragments      : result.fragments,
        count          : result.count,
        totalTokens    : result.totalTokens,
        searchPath     : result.searchPath,
        _searchEventId : result._searchEventId ?? null,
        caseMode       : true,
        cases,
        caseCount      : cases.length
      };
    }

    /** 공동 회상 파편 간 Hebbian 링크 강화 (비동기, 결과 무시) */
    if (params.sessionId && result.fragments && result.fragments.length >= 2) {
      const fragIds = result.fragments.map(f => f.id).filter(Boolean);
      new GraphLinker()
        .buildCoRetrievalLinks(fragIds, params.sessionId, agentId)
        .catch((err) => { logWarn(`[MemoryRecaller] co-retrieval link creation failed: ${err.message}`); });
    }

    /** 비침습적 사용 패턴 힌트 주입 (fail-open — 실패해도 recall 응답 무영향) */
    const suggestion = await this.suggestionEngine?.suggest(params, result).catch(() => null) ?? null;
    result._suggestion = suggestion;

    return result;
  }

  /**
   * context - 세션 시작 시 압축된 메모리 컨텍스트 주입
   *
   * Working Memory (~500토큰, append-only 꼬리):
   *   세션 내 remember(scope=session)로 저장된 파편
   *   Redis frag:wm:{sessionId}에서 로드
   *
   * @param {Object} params
   *   - agentId     {string}
   *   - sessionId   {string} 세션 ID (WM 로드용)
   *   - tokenBudget {number} 기본 2000
   *   - types       {string[]} 로드할 유형 목록 (기본: preference, error, procedure)
   * @returns {Object} { fragments, totalTokens, injectionText, coreTokens, wmTokens, wmCount }
   */
  async context(params) {
    const result = await this.contextBuilder.build(params);
    if (params.includeKeyName === true && Array.isArray(result?.fragments) && result.fragments.length > 0) {
      result.fragments = await enrichWithKeyNames(result.fragments);
    }
    return result;
  }

  /**
   * toolFeedback - 도구 유용성 피드백 저장
   *
   * @param {Object} params
   *   - tool_name    {string} 평가 대상 도구명 (필수)
   *   - relevant     {boolean} 관련성 (필수)
   *   - sufficient   {boolean} 충분성 (필수)
   *   - suggestion   {string} 개선 제안 (선택, 100자 절삭)
   *   - context      {string} 사용 맥락 (선택, 50자 절삭)
   *   - session_id   {string} 세션 ID (선택)
   *   - trigger_type {string} sampled|voluntary (기본 voluntary)
   * @returns {Object} { id, tool_name, relevant, sufficient }
   */
  async toolFeedback(params) {
    const pool = getPrimaryPool();
    if (!pool) throw new Error("DB pool not available");

    const suggestion  = params.suggestion
      ? params.suggestion.substring(0, 100)
      : null;
    const context     = params.context
      ? params.context.substring(0, 50)
      : null;
    const triggerType = params.trigger_type || "voluntary";
    const keyId       = params._keyId ?? null;

    const result = await pool.query(
      `INSERT INTO agent_memory.tool_feedback
             (tool_name, relevant, sufficient, suggestion, context, session_id, trigger_type, search_event_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        params.tool_name,
        params.relevant,
        params.sufficient,
        suggestion,
        context,
        params.session_id || null,
        triggerType,
        params.search_event_id ?? null
      ]
    );

    const fragmentIds = params.fragment_ids;
    if (fragmentIds && fragmentIds.length > 0) {
      try {
        const delta = params.relevant ? 0.1 : -0.15;
        /**
         * keyId 소유권 검사: API 키 사용자는 자신의 파편(key_id = $N)만 EMA 업데이트 가능.
         * 마스터 키(keyId = null)는 조건 없이 전체 접근.
         * 타 키 소유 파편에 대한 EMA 조작을 방지한다.
         */
        let   keyFilter = "";
        const emaParams = [delta, fragmentIds];
        if (keyId != null) {
          emaParams.push(keyId);
          keyFilter = `AND key_id = $${emaParams.length}`;
        }
        await pool.query(
          `UPDATE agent_memory.fragments
           SET ema_activation = LEAST(1.0, GREATEST(0, COALESCE(ema_activation, 0.5) + $1)),
               ema_last_updated = NOW()
           WHERE id = ANY($2) ${keyFilter}`,
          emaParams
        );
      } catch (err) {
        logWarn(`[toolFeedback] ema adjustment failed: ${err.message}`);
      }
    }

    return {
      id         : result.rows[0].id,
      tool_name  : params.tool_name,
      relevant   : params.relevant,
      sufficient : params.sufficient
    };
  }

  /**
   * fragmentHistory - 파편 변경 이력 조회
   *
   * @param {Object} params
   *   - id {string} 파편 ID (필수)
   * @returns {Object} { current, versions, superseded_by_chain }
   */
  async fragmentHistory(params) {
    if (!params.id) {
      return { error: "id is required" };
    }
    const { agentId, keyId, groupKeyIds } = extractRequestCtx(params, { groupKeyIdsFallback: 'empty' });

    /** getHistory 내부 getById에 keyId 전달 — SQL 레벨 필터로 권한 없으면 current=null */
    const result = await this.store.getHistory(
      params.id, agentId, keyId, groupKeyIds,
      { includePeerAgents: params.includePeerAgents === true }
    );
    if (!result.current) return { error: "Fragment not found or no permission" };

    return result;
  }

  /**
   * graphExplore - RCA 체인 추적
   *
   * error 파편 기점으로 caused_by, resolved_by 체인을 1-hop 추적한다.
   *
   * @param {Object} params
   *   - startId {string} 시작 파편 ID (필수)
   * @returns {Object} { startId, nodes, edges, count }
   */
  async graphExplore(params) {
    if (!params.startId) {
      return { error: "startId is required" };
    }

    const { agentId, keyId, groupKeyIds } = extractRequestCtx(params, { groupKeyIdsFallback: 'empty' });

    /** 시작 파편 소유권 확인 — SQL 레벨 필터로 권한 없으면 null 반환 */
    const startFrag = await this.store.getById(params.startId, agentId, keyId, groupKeyIds);
    if (!startFrag) {
      return { error: "Fragment not found or no permission" };
    }

    const nodes = await this.store.getRCAChain(params.startId, agentId, keyId, groupKeyIds);

    const edges = nodes
      .filter(n => n.relation_type)
      .map(n => ({
        from         : params.startId,
        to           : n.id,
        relation_type: n.relation_type
      }));

    return {
      startId: params.startId,
      nodes,
      edges,
      count  : nodes.length
    };
  }
}

/**
 * recall 최종 정렬 점수.
 *
 * FragmentSearch가 이미 reranker/RRF 정렬을 마친 결과에 includeLinks 파편이
 * 합류한 뒤의 통합 정렬용 점수다. 설계 원칙:
 *   1. rerankerScore가 있으면 그것을 base로 사용 — cross-encoder 결과를 폐기하지 않는다.
 *   2. 없으면 importance/recency/similarity 복합 점수에 unrerankedBaseDiscount(0.85)를
 *      곱해 base로 사용한다 — "reranking 미검증" 신호.
 *   3. lexical 일치는 log 스케일로 [0,1] 정규화 후 가산한다 — hard override 아님.
 *   4. lexWeight는 파편별 rerankerScore 유무로 결정한다(집합 단위 아님).
 *      rerankerScore 보유 시 0.12(미세 보정), 미보유 시 0.18(보강).
 *   5. 연결 파편(_source="linked")은 lexical 가중치를 절반으로 감쇠한다.
 *
 * FragmentSearch._computeRankScore와 공식 일부가 겹치나, 그쪽은 검색 레이어
 * (emaBoost 포함) 점수이고 이쪽은 검색 후 통합 정렬 점수로 책임이 다르다.
 * 의도적 분리이며 공유 모듈로 추상화하지 않는다.
 *
 * @param {Object} fragment
 * @param {Object} ctx
 *   - lexicalQuery   {Object}  keywords/topic/_implicitKeywords를 담은 질의
 *   - anchorTime     {number}  시간 근접도 기준 시각
 *   - config         {Object}  MEMORY_CONFIG
 * @returns {number}
 */
export function computeRecallScore(fragment, ctx) {
  const { lexicalQuery, anchorTime, config } = ctx;
  const RANK = config.ranking;

  const hasRerankerScore = fragment.rerankerScore !== undefined;

  let base;
  if (hasRerankerScore) {
    base = fragment.rerankerScore;
  } else {
    const importance = fragment.importance || 0;
    const parsed     = fragment.created_at ? new Date(fragment.created_at).getTime() : NaN;
    const createdAt  = Number.isFinite(parsed) ? parsed : Date.now();
    const distDays   = Math.abs(anchorTime - createdAt) / 86400000;
    const proximity  = Math.pow(2, -distDays / (RANK.recencyHalfLifeDays || 30));
    const similarity = fragment.similarity || 0;
    const composite  = importance * (RANK.importanceWeight || 0.4)
                     + proximity  * (RANK.recencyWeight    || 0.3)
                     + similarity * (RANK.semanticWeight   || 0.3);
    base = composite * (RANK.unrerankedBaseDiscount ?? 0.85);
  }

  const lexRaw     = lexicalMatchScore(fragment, lexicalQuery);
  const saturation = RANK.lexicalSaturation ?? 8;
  const lexNorm    = lexRaw > 0
    ? Math.min(Math.log1p(lexRaw) / Math.log1p(saturation), 1)
    : 0;

  let lexWeight = hasRerankerScore
    ? (RANK.lexicalWeightReranked ?? 0.12)
    : (RANK.lexicalWeightFallback ?? 0.18);

  if (fragment._source === "linked") {
    lexWeight *= (RANK.lexicalLinkedMultiplier ?? 0.5);
  }

  return base + lexNorm * lexWeight;
}
