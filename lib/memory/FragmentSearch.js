/**
 * FragmentSearch - 3단 검색 엔진 (L1 Redis -> L2 PostgreSQL -> L3 pgvector)
 *
 * 작성자: 최진호
 * 작성일: 2026-02-23
 * 수정일: 2026-03-03 (RRF l1WeightFactor 설정 연결, L1 전용 파편 필터, _rrfScore 응답 노출 제거)
 * 수정일: 2026-03-03 (API 키 격리 - keyId를 L2/L3 검색 필터로 전파)
 * 수정일: 2026-03-12 (API 키 격리 - keyId를 L1/HotCache까지 전파)
 * 수정일: 2026-03-28 (어시스턴트 발화 쿼리 확장 - L3 시맨틱 검색 정확도 향상)
 * 수정일: 2026-03-29 (search() 분해 - _buildSearchQuery / _executeSearch 추출)
 *
 * 토큰 예산 기반 검색 결과 절삭으로 컨텍스트 오염 방지
 * 복합 필터: INTERSECTION(교집합) 적용, 빈 인수 시 getRecent fallback
 * text 쿼리 시 L2+L3 병렬 실행 후 Reciprocal Rank Fusion 병합
 */

import { FragmentStore }             from "./FragmentStore.js";
import { getFragmentIndex }          from "./FragmentIndex.js";
import { generateEmbedding, prepareTextForEmbedding, EMBEDDING_ENABLED } from "../tools/embedding.js";
import { MEMORY_CONFIG }             from "../../config/memory.js";
import { computeEmaRankBoost }       from "./decay.js";
import { getSearchMetrics }          from "./SearchMetrics.js";
import { logWarn }                   from "../logger.js";
import { buildSearchEvent, recordSearchEvent, classifyQueryType } from "./SearchEventRecorder.js";
import { getSearchParamAdaptor }      from "./SearchParamAdaptor.js";
import { expandAssistantQuery, boostAssistantFragments } from "./assistant-query.js";
import { fetchGraphNeighbors }       from "./GraphNeighborSearch.js";
import { countTokens }               from "./FragmentFactory.js";
import { rerank, isRerankerAvailable } from "./Reranker.js";
import { EmbeddingCache }            from "./EmbeddingCache.js";
import { redisClient }               from "../redis.js";
import { SYMBOLIC_CONFIG }           from "../../config/symbolic.js";
import { symbolicMetrics }           from "../symbolic/SymbolicMetrics.js";
import { explanationBuilder }        from "../symbolic/ExplanationBuilder.js";
import { cbrEligibility }            from "../symbolic/CbrEligibility.js";
import { MorphemeIndex }             from "./MorphemeIndex.js";

/**
 * H2 Sparse Fieldsets: 허용된 응답 필드 화이트리스트.
 * query.fields 배열이 제공되면 이 중 요청된 키만 포함하여 반환한다.
 * 알 수 없는 키는 무시(silently ignore). 미지정 시 전체 필드 반환(기존 동작).
 * @deprecated v2.12.0부터 ALLOWED_FIELDS 외 키 요청 시 경고 로그 예정
 */
const ALLOWED_FIELDS = new Set([
  "id", "content", "type", "topic", "keywords", "importance", "created_at",
  "access_count", "confidence", "linked", "explanations", "workspace",
  "context_summary", "case_id", "valid_to", "affect", "ema_activation"
]);

/**
 * 파편 객체에서 지정된 필드만 추출하여 반환한다.
 *
 * @param {Object}   fragment - 원본 파편 객체
 * @param {string[]} fields   - 포함할 필드 목록
 * @returns {Object} 필드가 제한된 파편 객체
 */
function pickFields(fragment, fields) {
  const result = {};
  for (const key of fields) {
    if (ALLOWED_FIELDS.has(key) && key in fragment) {
      result[key] = fragment[key];
    }
  }
  return result;
}

export class FragmentSearch {
  constructor() {
    this.store          = new FragmentStore();
    this.index          = getFragmentIndex();
    this.embeddingCache = new EmbeddingCache({ redis: redisClient });
    /** Phase 4: morpheme 임베딩 보조 검색에 사용. lazy 싱글톤. */
    this._morphemeIndex = new MorphemeIndex();
  }

  /**
     * 통합 검색 - 3단 폴백
     *
     * @param {Object} query
     *   - keywords    {string[]}    키워드 목록
     *   - topic       {string}      토픽
     *   - type        {string}      파편 유형
     *   - text        {string}      자연어 쿼리 (시맨틱 검색용)
     *   - tokenBudget {number}      최대 토큰 (기본 1000)
     *   - keyId       {string|null} API 키 ID (null: 마스터, string: 격리 조회)
     *   - timeRange   {Object}      시간 범위 필터 { from?: string, to?: string } (ISO 8601)
     * @returns {Object} { fragments, totalTokens, searchPath }
     */
  async search(query) {
    const _t0       = Date.now();
    const _metricsP = getSearchMetrics();
    const sq        = this._buildSearchQuery(query);

    const { combined, searchPath, l1IsFallback, layerLatency } = await this._executeSearch(sq, _metricsP);

    /** 중복 제거 */
    const unique = this._deduplicate(combined, sq.fragmentCount, sq.anchorTime);

    /** MMR 다양성 선택 (리랭커 활성 시에만) */
    const diversified = unique[0]?.rerankerScore !== undefined
      ? this._applyMMR(unique, 0.7)
      : unique;

    /** 토큰 예산 절삭 */
    const trimmed     = this._trimToTokenBudget(diversified, sq.tokenBudget);
    const totalTokens = this._estimateTokens(trimmed);

    /** I-1: _rrfScore 내부 필드를 MCP 응답에서 제거 */
    let clean = trimmed.map(({ _rrfScore, ...rest }) => rest);

    /** valid_to 필터: L1/HotCache/getByIds 경로를 포함한 모든 결과에 적용 */
    if (!sq.includeSuperseded) {
      clean = clean.filter(f => !f.valid_to);
    }

    /** 접근 횟수 증가 + Hot Cache 갱신 (비동기) */
    if (clean.length > 0) {
      const accessIds = clean.map(f => f.id);
      this.store.incrementAccess(accessIds, sq.agentId, { noEma: l1IsFallback });
      this.store.touchLinked(accessIds, sq.agentId, sq.keyId).catch(() => {});
      this._cacheFragments(clean, sq.keyId);
    }

    _metricsP.then(m => m.record("total", Date.now() - _t0)).catch(() => {});

    /**
     * Phase 1 Shadow hook: symbolic observe-only 경로.
     * 기본 플래그 false 이므로 무영향. Phase 2 이후 실제 claim/explain 로직이 여기서 소비된다.
     * 현재는 latency 관측만 fire-and-forget.
     */
    if (SYMBOLIC_CONFIG.enabled && SYMBOLIC_CONFIG.shadow) {
      symbolicMetrics.observeLatency("shadow_recall", Date.now() - _t0);
    }

    /**
     * Phase 2 Explainability: 각 fragment 에 explanations[] 필드 주입.
     * SYMBOLIC_CONFIG.explain=false 이면 no-op. rules/v1/explain.js 의 reason code 빌더 사용.
     */
    if (SYMBOLIC_CONFIG.enabled && SYMBOLIC_CONFIG.explain) {
      const _tExp = Date.now();
      clean = explanationBuilder.annotate(clean, {
        searchPath,
        layerLatency,
        query       : sq,
        caseContext : sq.caseId
      });
      symbolicMetrics.observeLatency("explain", Date.now() - _tExp);
    }

    /**
     * Phase 5 CBR Constraint Filtering: case_mode 경로(sq.caseId 존재) 에서만 적용.
     * SearchParamAdaptor 학습 신호 보호를 위해 pre-filter count 는 별도 보존하여
     * recordOutcome 에 전달한다. 차단 건수는 symbolicMetrics.recordGateBlock 에서 집계.
     */
    const rawResultCount = clean.length;
    if (SYMBOLIC_CONFIG.enabled && SYMBOLIC_CONFIG.cbrFilter && sq.caseId) {
      const _tCbr = Date.now();
      clean = await cbrEligibility.filter(clean, sq);
      symbolicMetrics.observeLatency("cbr_filter", Date.now() - _tCbr);
    }

    /** 검색 이벤트 영속화 (await: _searchEventId를 동기 반환해야 tool_feedback FK 연결 가능) */
    const _totalMs    = Date.now() - _t0;
    const searchEvent = buildSearchEvent(
      query,
      clean,
      {
        searchPath  : searchPath.join(" → "),
        sessionId   : query.sessionId || null,
        keyId       : (Array.isArray(sq.keyId) ? sq.keyId[0] : sq.keyId) ?? null,
        latencyMs   : _totalMs,
        l1IsFallback: l1IsFallback,
        l1LatencyMs : layerLatency.l1Ms  ?? null,
        l2LatencyMs : layerLatency.l2Ms  ?? null,
        l3LatencyMs : layerLatency.l3Ms  ?? null,
        graphUsed   : layerLatency.graphUsed ?? false
      }
    );
    const searchEventId = await recordSearchEvent(searchEvent).catch(() => null);

    /** SearchParamAdaptor: 결과 건수 기록 (fire-and-forget).
     *  Phase 5 CBR filter 가 적용되어도 pre-filter count 를 전달하여 학습 신호를 보호한다. */
    getSearchParamAdaptor()
      .recordOutcome(
        (Array.isArray(sq.keyId) ? sq.keyId[0] : sq.keyId) ?? null,
        classifyQueryType(query),
        new Date().getHours(),
        rawResultCount
      )
      .catch(() => {});

    /** H2 Sparse Fieldsets: query.fields 배열이 있으면 허용된 키만 pick */
    if (Array.isArray(query.fields) && query.fields.length > 0) {
      clean = clean.map(f => pickFields(f, query.fields));
    }

    return {
      fragments      : clean,
      totalTokens,
      searchPath     : searchPath.join(" → "),
      count          : clean.length,
      _searchEventId : searchEventId
    };
  }

  /**
   * 검색 파라미터를 정규화된 쿼리 객체로 변환
   *
   * @param {Object} query - 원본 검색 쿼리
   * @returns {Object} 정규화된 쿼리 (tokenBudget, agentId, keyId, anchorTime, timeRange 등)
   */
  _buildSearchQuery(query) {
    const sq = {
      ...query,
      tokenBudget       : query.tokenBudget || 1000,
      agentId           : query.agentId || "default",
      keyId             : query.keyId ?? null,
      workspace         : query.workspace ?? null,
      anchorTime        : query.anchorTime || Date.now(),
      timeRange         : parseTimeRange(query.timeRange),
      fragmentCount     : query.fragmentCount || 0,
      includeSuperseded : query.includeSuperseded || false,
      caseId            : query.caseId || undefined,
      resolutionStatus  : query.resolutionStatus || undefined,
      phase             : query.phase || undefined,
      affect            : query.affect || undefined
    };

    // SearchParamAdaptor: 학습된 minSimilarity 주입 (비동기 -> Promise로 저장, _searchL3에서 await)
    sq._adaptedSimPromise = getSearchParamAdaptor()
      .getMinSimilarity(sq.keyId, classifyQueryType(query), new Date().getHours())
      .catch(() => null);

    return sq;
  }

  /**
   * L1/L2/L3 검색 실행 + RRF 병합
   *
   * @param {Object}  sq        - _buildSearchQuery()가 반환한 정규화된 쿼리
   * @param {Promise} _metricsP - getSearchMetrics() Promise (레이턴시 기록용)
   * @returns {Promise<{ combined: Object[], searchPath: string[], l1IsFallback: boolean, layerLatency: Object }>}
   */
  async _executeSearch(sq, _metricsP) {
    const { agentId, keyId, workspace, timeRange } = sq;
    const searchPath  = [];
    const layerLatency = { l1Ms: null, l2Ms: null, l3Ms: null, temporalMs: null, graphUsed: false };

    /** L1: Redis 역인덱스 (현재 agentId 미지원, 향후 확장 고려) */
    const _t1L1                              = Date.now();
    const { ids: l1Ids, isFallback: l1IsFallback } = await this._searchL1(sq, keyId);
    layerLatency.l1Ms = Date.now() - _t1L1;
    _metricsP.then(m => m.record("L1", layerLatency.l1Ms)).catch(() => {});
    let   cached = [];

    if (l1Ids.length > 0) {
      searchPath.push(`L1:${l1Ids.length}`);
      cached = await this._tryHotCache(l1Ids, keyId);
      if (cached.length > 0) {
        searchPath.push(`HotCache:${cached.length}`);
      }
    }

    /** HotCache hit ID 집합 — L2 DB 중복 조회 방지 */
    const cacheHitIds = new Set(cached.map(f => f.id));
    const l1MissIds   = l1Ids.filter(id => !cacheHitIds.has(id));

    let combined = [];

    /** Temporal + L2 + L3 병렬 실행 후 RRF 병합 */
    if (sq.text && EMBEDDING_ENABLED) {
      const l3SearchOptions = resolveL3SearchOptions();
      const searchTasks = [
        (async () => {
          const start   = Date.now();
          const results = await this._searchL2(sq, l1MissIds, agentId, keyId, timeRange);
          layerLatency.l2Ms = Date.now() - start;
          return results;
        })(),
        (async () => {
          const start   = Date.now();
          const results = await withTimeout(
            this._searchL3(sq, agentId, keyId, timeRange, l3SearchOptions),
            l3SearchOptions.timeoutMs,
            []
          );
          layerLatency.l3Ms = Date.now() - start;
          return results;
        })(),
      ];
      if (timeRange) {
        searchTasks.push((async () => {
          const start   = Date.now();
          const results = await this._searchTemporal(sq);
          layerLatency.temporalMs = Date.now() - start;
          return results;
        })());
      }
      const [l2Results, l3Results, temporalResults = []] = await Promise.all(searchTasks);
      if (temporalResults.length > 0) {
        searchPath.push(`Temporal:${temporalResults.length}`);
      }
      _metricsP.then(m => Promise.all([
        m.record("L2", layerLatency.l2Ms),
        m.record("L3", layerLatency.l3Ms)
      ])).catch(() => {});

      searchPath.push(`L2:${l2Results.length}`);

      /** L2.5 Graph: L2 상위 파편의 1-hop 이웃 수집 */
      const graphSeedCount = MEMORY_CONFIG.graph?.seedCount || 10;
      const l2TopIds       = l2Results.slice(0, graphSeedCount).map(f => f.id);
      const graphResults  = await fetchGraphNeighbors(l2TopIds, 10, agentId, keyId).catch(() => []);
      if (graphResults.length > 0) {
        searchPath.push(`L2.5Graph:${graphResults.length}`);
        layerLatency.graphUsed = true;
      }

      searchPath.push(`L3:${l3Results.length}`);
      searchPath.push("RRF");

      // HotCache 파편을 l2Results에 병합하여 RRF 입력으로 포함
      // C-1: content 없는 L1 전용 파편 제거 / C-2: l1WeightFactor 설정값 전달
      const weights = resolveRrfLayerWeights(sq);
      const rrfLayers = [
        { name: "l1",    results: l1Ids,                    weightFactor: weights.l1 },
        { name: "l2",    results: [...cached, ...l2Results], weightFactor: weights.l2 },
        { name: "graph", results: graphResults,              weightFactor: weights.graph },
        { name: "l3",    results: l3Results,                 weightFactor: weights.l3 },
      ];
      if (temporalResults.length > 0) {
        rrfLayers.push({ name: "temporal", results: temporalResults, weightFactor: timeRange ? 2.0 : 1.0 });
      }
      combined = mergeRRF(rrfLayers, MEMORY_CONFIG.rrfSearch.k)
        .filter(f => f.content !== undefined);

      /** L4: Cross-Encoder Reranker (RRF 상위 30건 정밀 재정렬) */
      if (isRerankerAvailable() && sq.text && combined.length > 0) {
        const rerankerInput = combined.slice(0, 30);
        const reranked      = await rerank(sq.text, rerankerInput, 15).catch(() => null);
        if (reranked && reranked[0]?.rerankerScore !== undefined) {
          searchPath.push(`Rerank:${reranked.length}`);
          combined = reranked;
        }
      }
    } else {
      /** text 없는 경우: 기존 폴백 방식 유지 (keywords/topic/type만 있는 경우) */
      const fallbackTasks = [
        (async () => {
          const start   = Date.now();
          const results = await this._searchL2(sq, l1MissIds, agentId, keyId, timeRange);
          layerLatency.l2Ms = Date.now() - start;
          return results;
        })(),
      ];
      if (timeRange) {
        fallbackTasks.push((async () => {
          const start   = Date.now();
          const results = await this._searchTemporal(sq);
          layerLatency.temporalMs = Date.now() - start;
          return results;
        })());
      }
      const [l2Results, temporalResults = []] = await Promise.all(fallbackTasks);
      _metricsP.then(m => m.record("L2", layerLatency.l2Ms)).catch(() => {});
      searchPath.push(`L2:${l2Results.length}`);
      if (l2Results.length > 0) {
        combined.push(...l2Results);
      }
      if (cached.length > 0) {
        combined.push(...cached);
      }
      if (temporalResults.length > 0) {
        searchPath.push(`Temporal:${temporalResults.length}`);
        combined.push(...temporalResults);
      }
    }

    /** workspace 후처리 필터: L1 HotCache 결과는 workspace 미적용이므로 여기서 보완 */
    if (workspace) {
      combined = combined.filter(f => f.workspace === workspace || f.workspace == null);
    }

    /** Narrative Reconstruction 후처리 필터: L1/L3/Graph 경로 보완 */
    if (sq.caseId) {
      combined = combined.filter(f => f.case_id === sq.caseId);
    }
    if (sq.resolutionStatus) {
      combined = combined.filter(f => f.resolution_status === sq.resolutionStatus);
    }
    if (sq.phase) {
      combined = combined.filter(f => f.phase === sq.phase);
    }

    /** 정서 태그 후처리 필터: L1/HotCache/Graph 경로 보완 (migration-034-v2.16.0-bundle) */
    if (sq.affect) {
      const affectSet = Array.isArray(sq.affect) ? new Set(sq.affect) : new Set([sq.affect]);
      combined = combined.filter(f => affectSet.has(f.affect));
    }

    return { combined, searchPath, l1IsFallback, layerLatency };
  }

  /**
   * Temporal: 시간 범위 기반 검색 (Phase 1 — 임베딩 불필요)
   *
   * timeRange가 존재할 때만 호출된다.
   * created_at 인덱스를 활용하여 날짜 범위 후보를 추출한다.
   *
   * @param {Object} sq - 정규화된 검색 쿼리
   * @returns {Promise<Object[]>}
   */
  async _searchTemporal(sq) {
    if (!sq.timeRange) return [];

    return this.store.searchByTimeRange(
      sq.timeRange.from, sq.timeRange.to,
      {
        agentId: sq.agentId, keyId: sq.keyId, workspace: sq.workspace, limit: 30,
        ...(sq.caseId           ? { caseId: sq.caseId } : {}),
        ...(sq.resolutionStatus ? { resolutionStatus: sq.resolutionStatus } : {}),
        ...(sq.phase            ? { phase: sq.phase } : {})
      }
    );
  }

  /**
     * L1: Redis 역인덱스 검색
     *
     * 복합 필터 적용 시 INTERSECTION(교집합)으로 동작한다.
     * 단일 필터는 해당 조건의 결과를 그대로 반환한다.
     * 필터가 하나도 없으면 최근 접근 파편을 fallback으로 반환한다.
     */
  async _searchL1(query, keyId = null) {
    const sets = [];

    if (query.keywords && query.keywords.length > 0) {
      const kwIds = await this.index.searchByKeywords(query.keywords, 3, keyId);
      if (kwIds.length > 0) sets.push(new Set(kwIds));
    }

    if (query.topic) {
      const topicIds = await this.index.searchByTopic(query.topic, keyId);
      if (topicIds.length > 0) sets.push(new Set(topicIds));
    }

    if (query.type) {
      const typeIds = await this.index.searchByType(query.type, keyId);
      if (typeIds.length > 0) sets.push(new Set(typeIds));
    }

    if (sets.length === 0) {
      /** text-only 쿼리(keywords/topic/type 없음)는 L1 서비스 대상이 아니다.
       *  L2/L3가 담당하므로 폴백 없이 빈 결과를 반환한다.
       *  isFallback: false — L1 miss 메트릭을 오염시키지 않기 위해 false로 반환한다. */
      const isTextOnly = query.text && !query.keywords?.length && !query.topic && !query.type;
      if (isTextOnly) {
        return { ids: [], isFallback: false };
      }
      const ids = await this.index.getRecent(20, keyId);
      return { ids, isFallback: true };
    }

    if (sets.length === 1) {
      return { ids: [...sets[0]], isFallback: false };
    }

    return {
      ids       : [...sets[0]].filter(id => sets.slice(1).every(s => s.has(id))),
      isFallback: false
    };
  }

  /**
     * Hot Cache에서 파편 조회 시도
     */
  async _tryHotCache(ids, keyId = null) {
    const fetched = await Promise.all(
      ids.slice(0, 30).map(id => this.index.getCachedFragment(id, keyId))
    );
    return fetched.filter(f => f && f.content);
  }

  /**
     * L2: PostgreSQL 메타데이터 검색
     *
     * @param {Object}      query
     * @param {string[]}    excludeIds
     * @param {string}      agentId
     * @param {string|null} keyId - API 키 격리 필터
     */
  async _searchL2(query, excludeIds = [], agentId = "default", keyId = null, timeRange = null) {
    const options = {
      type              : query.type || undefined,
      topic             : query.topic || undefined,
      minImportance     : query.minImportance || 0.1,
      limit             : 30,
      agentId           : agentId,
      keyId             : keyId,
      workspace         : query.workspace ?? null,
      includeSuperseded : query.includeSuperseded || false,
      ...(query.isAnchor !== undefined ? { isAnchor: query.isAnchor } : {}),
      ...(timeRange ? { timeRange } : {}),
      ...(query.caseId           ? { caseId: query.caseId } : {}),
      ...(query.resolutionStatus ? { resolutionStatus: query.resolutionStatus } : {}),
      ...(query.phase            ? { phase: query.phase } : {}),
      ...(query.affect           ? { affect: query.affect } : {})
    };

    let results = [];

    if (query.keywords && query.keywords.length > 0) {
      results = await this.store.searchByKeywords(query.keywords, options);
    }

    /** topic-only PostgreSQL fallback: 키워드 결과가 없을 때 topic으로 재시도 */
    if (results.length === 0 && query.topic) {
      results = await this.store.searchByTopic(query.topic, options);
    }

    /** 추가 ID 기반 조회 (L1에서 찾은 것 중 캐시 미스분) */
    if (excludeIds.length > 0) {
      const cachedResultIds = new Set(results.map(r => r.id));
      const missingIds      = excludeIds.filter(id => !cachedResultIds.has(id));

      if (missingIds.length > 0) {
        let fetched = await this.store.getByIds(missingIds, agentId, keyId);
        /** workspace 필터: getByIds는 workspace 미지원이므로 여기서 후처리 적용 */
        if (options.workspace) {
          fetched = fetched.filter(f => f.workspace === options.workspace || f.workspace == null);
        }
        results.push(...fetched);
      }
    }

    return results;
  }

  /**
     * L3: pgvector 시맨틱 검색
     *
     * @param {Object}      query - 검색 쿼리 객체 (text, includeSuperseded 등)
     * @param {string}      agentId
     * @param {string|null} keyId - API 키 격리 필터
     */
  async _searchL3(query, agentId = "default", keyId = null, timeRange = null, searchOptions = resolveL3SearchOptions()) {
    try {
      /** 어시스턴트 발화 쿼리 확장: "Assistant:" 접두어로 시맨틱 갭 축소 */
      const { text: expandedText, isAssistantQuery: isAsstQ } = expandAssistantQuery(query.text);
      const prepared = prepareTextForEmbedding(expandedText, 500);

      /** 임베딩 캐시: hit 시 API 호출 생략 (200-500ms 절약) */
      let vec = await this.embeddingCache.get(prepared);
      if (!vec) {
        vec = await generateEmbedding(prepared);
        this.embeddingCache.set(prepared, vec);
      }
      const { minSimilarity: cfgSim, limit } = MEMORY_CONFIG.semanticSearch || {};
      const adaptedSim    = await (query._adaptedSimPromise ?? Promise.resolve(null));
      const minSimilarity = adaptedSim ?? cfgSim ?? 0.35;
      const results = await this.store.searchBySemantic(
        vec,
        limit ?? 10,
        minSimilarity,
        agentId,
        keyId,
        query.includeSuperseded || false,
        timeRange,
        query.workspace ?? null,
        null,
        false,
        searchOptions
      );

      /** 어시스턴트 쿼리일 때 "Assistant:" 포함 파편에 importance 부스트 */
      if (isAsstQ) {
        boostAssistantFragments(results);
      }

      /**
       * Phase 4 Consistency Gate: morpheme 임베딩 기반 보조 검색 sub-path.
       * query.text로 형태소 벡터를 생성하고 morpheme_indexed=true 파편만 검색한다.
       * 실패해도 기본 L3 결과는 정상 반환 (fire-and-forget 방식으로 병합).
       * morpheme_indexed 컬럼이 없으면 에러를 logWarn 후 skip.
       */
      let morphemeResults = [];
      try {
        const morphemeVec = await this._morphemeIndex.textToMorphemeVector(query.text);
        if (morphemeVec) {
          morphemeResults = await this.store.searchBySemantic(
            morphemeVec,
            Math.min(limit ?? 10, 10),
            minSimilarity,
            agentId,
            keyId,
            query.includeSuperseded || false,
            timeRange,
            query.workspace ?? null,
            null,     /* affect */
            true,     /* morphemeOnly: morpheme_indexed=true 조건 */
            searchOptions
          );
        }
      } catch (morphErr) {
        logWarn(`[FragmentSearch] L3 morpheme sub-path failed: ${morphErr.message}`);
      }

      /** 기본 L3 결과 + morpheme 결과 병합 (중복 ID는 기본 결과 우선) */
      if (morphemeResults.length > 0) {
        const seen = new Set(results.map(f => f.id));
        for (const f of morphemeResults) {
          if (!seen.has(f.id)) {
            results.push(f);
          }
        }
      }

      return results;
    } catch (err) {
      logWarn(`[FragmentSearch] L3 search failed: ${err.message}`);
      return [];
    }
  }

  /**
   * 복합 랭킹 점수 계산
   *
   * score = importance * iw + temporalProximity * rw + similarity * sw
   *
   * temporalProximity: anchorTime 기준 시간 근접도 (지수 감쇠)
   *   - anchorTime이 현재면 최근 파편이 높은 점수
   *   - anchorTime이 과거면 그 시점에 가까운 파편이 높은 점수
   */
  _computeRankScore(fragment, config, anchorTime = Date.now()) {
    const { importanceWeight, recencyWeight, semanticWeight, recencyHalfLifeDays } = config.ranking;

    const importance   = fragment.importance || 0;
    const emaBoost     = computeEmaRankBoost(fragment.ema_activation);
    const effectiveImp = Math.min(1.0, importance + emaBoost * 0.5);

    const parsed    = fragment.created_at ? new Date(fragment.created_at).getTime() : NaN;
    const createdAt = Number.isFinite(parsed) ? parsed : Date.now();
    const distDays  = Math.abs(anchorTime - createdAt) / 86400000;
    const proximity = Math.pow(2, -distDays / (recencyHalfLifeDays || 30));

    const similarity = fragment.similarity || fragment._rrfScore || 0;

    return effectiveImp * (importanceWeight || 0.4)
         + proximity    * (recencyWeight    || 0.3)
         + similarity   * (semanticWeight   || 0.3);
  }

  /**
   * 중복 제거 (id 기반) + 복합 랭킹 정렬
   *
   * activationThreshold=0 이므로 항상 복합 랭킹 적용.
   *
   * @param {Array}  fragments
   * @param {number} fragmentCount  (미사용, 하위 호환 유지)
   * @returns {Array}
   */
  _deduplicate(fragments, _fragmentCount = 0, anchorTime = Date.now()) {
    const seen = new Map();

    for (const f of fragments) {
      if (!seen.has(f.id)) {
        seen.set(f.id, f);
      } else {
        const existing = seen.get(f.id);
        if (f.similarity && (!existing.similarity || f.similarity > existing.similarity)) {
          seen.set(f.id, f);
        }
      }
    }

    const allFragments = Array.from(seen.values());

    /** rerankerScore가 있는 파편은 cross-encoder 점수 우선 사용 */
    const scoreOf = (f) => f.rerankerScore !== undefined
      ? f.rerankerScore
      : this._computeRankScore(f, MEMORY_CONFIG, anchorTime);

    return allFragments.sort((a, b) => scoreOf(b) - scoreOf(a));
  }

  /**
   * Maximal Marginal Relevance: 임베딩 기반 다양성 선택.
   * 임베딩 있는 결과만 MMR 적용, 없는 결과는 별도 슬롯으로 보장.
   */
  _applyMMR(fragments, lambda = 0.7) {
    const withEmb  = fragments.filter(f => f.similarity !== undefined);
    const noEmb    = fragments.filter(f => f.similarity === undefined);

    if (withEmb.length <= 1) return fragments;

    const selected = [withEmb[0]];
    const remaining = withEmb.slice(1);

    while (remaining.length > 0 && selected.length < withEmb.length) {
      let bestIdx   = -1;
      let bestScore = -Infinity;

      for (let i = 0; i < remaining.length; i++) {
        const candidate  = remaining[i];
        const relevance  = candidate.rerankerScore || candidate._rrfScore || 0;
        const maxSimToSelected = selected.reduce((max, s) => {
          const overlap = this._keywordOverlap(candidate, s);
          return Math.max(max, overlap);
        }, 0);
        const mmrScore = lambda * relevance - (1 - lambda) * maxSimToSelected;
        if (mmrScore > bestScore) {
          bestScore = mmrScore;
          bestIdx   = i;
        }
      }

      if (bestIdx >= 0) {
        selected.push(remaining.splice(bestIdx, 1)[0]);
      } else {
        break;
      }
    }

    return [...selected, ...noEmb];
  }

  _keywordOverlap(a, b) {
    if (!a.keywords?.length || !b.keywords?.length) return 0;
    const setA       = new Set(a.keywords);
    const intersect  = b.keywords.filter(k => setA.has(k)).length;
    return intersect / Math.max(a.keywords.length, b.keywords.length);
  }

  /**
     * 토큰 예산에 맞춰 절삭
     */
  _trimToTokenBudget(fragments, tokenBudget) {
    const result   = [];
    let usedTokens = 0;

    for (const f of fragments) {
      const cost = f.estimated_tokens || countTokens(f.content || "");
      if (usedTokens + cost > tokenBudget) break;
      usedTokens += cost;
      result.push(f);
    }

    return result;
  }

  /**
     * 토큰 수 추정
     */
  _estimateTokens(fragments) {
    return fragments.reduce((sum, f) => sum + (f.estimated_tokens || countTokens(f.content || "")), 0);
  }

  /**
     * Hot Cache에 파편 전체 데이터 저장
     */
  async _cacheFragments(fragments, keyId = null) {
    await Promise.all(
      fragments.map(f => this.index.cacheFragment(f.id, f, keyId).catch(() => {}))
    );
  }
}

/**
 * 범용 Reciprocal Rank Fusion (RRF) 병합
 *
 * 스케일이 다른 다계층 검색 결과를 순위 기반으로 공정하게 병합한다.
 * 레이어 수에 무관하게 동작하므로 temporal, morpheme 등
 * 신규 레이어 추가 시 파라미터 변경 없이 확장 가능하다.
 *
 * @param {Array<{name: string, results: Array, weightFactor: number}>} layers
 *   - results가 문자열 배열이면 ID 전용 레이어(L1)로 간주하여 {id} 형태로 정규화
 *   - results가 객체 배열이면 각 객체의 id 필드를 사용
 * @param {number} k - RRF 상수 (기본 60, 상위 랭크 과도한 부스트 방지)
 * @returns {Object[]} RRF 스코어 기준 내림차순 정렬된 파편 배열 (_rrfScore 포함)
 */
export function mergeRRF(layers, k = 60) {
  const scoreMap = new Map();

  for (const { results, weightFactor = 1.0 } of layers) {
    for (let rank = 0; rank < results.length; rank++) {
      const item  = results[rank];
      const isId  = typeof item === "string";
      const id    = isId ? item : item.id;
      const score = weightFactor / (k + rank + 1);

      if (scoreMap.has(id)) {
        scoreMap.get(id)._rrfScore += score;
      } else {
        scoreMap.set(id, isId ? { id, _rrfScore: score } : { ...item, _rrfScore: score });
      }
    }
  }

  return [...scoreMap.values()].sort((a, b) => b._rrfScore - a._rrfScore);
}

export function resolveRrfLayerWeights(query = {}, config = MEMORY_CONFIG.rrfSearch || {}) {
  const hasText = typeof query.text === "string" && query.text.trim().length > 0;
  const hasStructuredSignal =
    (Array.isArray(query.keywords) && query.keywords.some(kw => String(kw).trim())) ||
    (typeof query.topic === "string" && query.topic.trim().length > 0) ||
    (typeof query.type === "string" && query.type.trim().length > 0);
  const mixedConfig = hasText && hasStructuredSignal ? (config.mixed || {}) : {};

  return {
    l1   : numericOr(mixedConfig.l1WeightFactor, config.l1WeightFactor, 2.0),
    l2   : numericOr(mixedConfig.l2WeightFactor, config.l2WeightFactor, 1.0),
    graph: numericOr(mixedConfig.graphWeightFactor, config.graphWeightFactor, 1.5),
    l3   : numericOr(mixedConfig.l3WeightFactor, config.l3WeightFactor, 1.0)
  };
}

export function resolveL3SearchOptions(config = MEMORY_CONFIG.semanticSearch || {}) {
  return {
    timeoutMs         : clampInteger(config.timeoutMs, 1, 120000, 5000),
    statementTimeoutMs: clampInteger(config.statementTimeoutMs, 0, 120000, 4500),
    hnswEfSearch      : clampInteger(config.hnswEfSearch, 1, 1000, 80)
  };
}

export function withTimeout(promise, timeoutMs, fallbackValue) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        if (fallbackValue !== undefined) {
          resolve(fallbackValue);
          return;
        }
        reject(new Error("deadline exceeded"));
      }, timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}

function numericOr(value, fallback, defaultValue) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  const fallbackParsed = Number(fallback);
  if (Number.isFinite(fallbackParsed) && fallbackParsed >= 0) return fallbackParsed;
  return defaultValue;
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

/**
 * timeRange 파라미터 파싱 및 검증
 *
 * @param {Object|undefined} raw - { from?: string, to?: string }
 * @returns {{ from: Date|null, to: Date|null }|null}
 */
export function parseTimeRange(raw) {
  if (!raw || typeof raw !== "object") return null;

  const result = { from: null, to: null };

  if (raw.from) {
    const d = parseTemporalExpression(raw.from);
    if (!d) {
      logWarn(`[FragmentSearch] invalid timeRange.from: ${raw.from}`);
      return null;
    }
    result.from = d;
  }

  if (raw.to) {
    const d = parseTemporalExpression(raw.to);
    if (!d) {
      logWarn(`[FragmentSearch] invalid timeRange.to: ${raw.to}`);
      return null;
    }
    result.to = d;
  }

  if (!result.from && !result.to) return null;

  return result;
}

/**
 * 자연어 시간 표현을 Date로 파싱하는 순수 함수
 *
 * 지원 패턴 (한국어):
 *   - "N일 전", "N주 전", "N개월 전", "N년 전"
 *   - "오늘", "어제", "그제"/"그저께"
 *   - "이번 주", "지난 주", "이번 달", "지난 달"
 *   - "지난 월요일"~"지난 일요일"
 * ISO 8601 폴백: 위 패턴 미매칭 시 Date 생성자로 파싱
 *
 * @param {string} expr - 자연어 또는 ISO 8601 문자열
 * @param {Date}   [now] - 기준 시각 (테스트용, 기본 현재)
 * @returns {Date|null}
 */
export function parseTemporalExpression(expr, now = new Date()) {
  if (!expr || typeof expr !== "string") return null;
  const s = expr.trim();

  /** N일/주/개월/년 전 */
  const relMatch = s.match(/^(\d+)\s*(일|주|개월|달|년)\s*전$/);
  if (relMatch) {
    const n    = parseInt(relMatch[1], 10);
    const unit = relMatch[2];
    const d    = new Date(now);
    switch (unit) {
      case "일":               d.setDate(d.getDate() - n);           break;
      case "주":               d.setDate(d.getDate() - n * 7);       break;
      case "개월": case "달":  d.setMonth(d.getMonth() - n);         break;
      case "년":               d.setFullYear(d.getFullYear() - n);   break;
    }
    return _startOfDay(d);
  }

  /** 고정 키워드 */
  const keyword = s.replace(/\s+/g, "");
  switch (keyword) {
    case "오늘":     return _startOfDay(new Date(now));
    case "어제":     { const d = new Date(now); d.setDate(d.getDate() - 1); return _startOfDay(d); }
    case "그제":
    case "그저께":   { const d = new Date(now); d.setDate(d.getDate() - 2); return _startOfDay(d); }
    case "이번주":   return _startOfWeek(now, 0);
    case "지난주":   return _startOfWeek(now, -1);
    case "이번달":   return _startOfMonth(now, 0);
    case "지난달":   return _startOfMonth(now, -1);
  }

  /** 지난 X요일 */
  const dayNames = { "월요일": 1, "화요일": 2, "수요일": 3, "목요일": 4, "금요일": 5, "토요일": 6, "일요일": 0 };
  const dayMatch = s.match(/^지난\s*(월요일|화요일|수요일|목요일|금요일|토요일|일요일)$/);
  if (dayMatch) {
    const targetDay = dayNames[dayMatch[1]];
    const d         = new Date(now);
    const currentDay = d.getDay();
    let   diff       = currentDay - targetDay;
    if (diff <= 0) diff += 7;
    d.setDate(d.getDate() - diff);
    return _startOfDay(d);
  }

  /** ISO 8601 폴백 */
  const parsed = new Date(s);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function _startOfDay(d) {
  d.setHours(0, 0, 0, 0);
  return d;
}

function _startOfWeek(now, offset) {
  const d          = new Date(now);
  const currentDay = d.getDay();
  const mondayDiff = (currentDay === 0 ? -6 : 1 - currentDay) + offset * 7;
  d.setDate(d.getDate() + mondayDiff);
  return _startOfDay(d);
}

function _startOfMonth(now, offset) {
  const d = new Date(now);
  d.setMonth(d.getMonth() + offset, 1);
  return _startOfDay(d);
}
