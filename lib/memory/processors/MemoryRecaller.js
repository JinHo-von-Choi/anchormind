/**
 * MemoryRecaller - 기억 회상 전담 클래스 (Phase 5-B 분해)
 *
 * 작성자: 최진호
 * 작성일: 2026-04-20
 * 수정일: 2026-10-03 (순위 후 예산 선택: 링크 합류, 최종 점수, 예산 선택을 한 단계에서 수행)
 *
 * 이관 대상: recall / context / graphExplore / toolFeedback / fragmentHistory
 *
 * 공개 API 계약은 원본 통합 관리자와 100% 동일하게 유지한다.
 */

import { getPrimaryPool, queryWithAgentVector } from "../../tools/db.js";
import { fragmentRowLock }       from "../write/rowLock.js";
import { MEMORY_CONFIG }         from "../../../config/memory.js";
import { GraphLinker }           from "../link/GraphLinker.js";
import { logWarn }               from "../../logger.js";
import { activateByContext }     from "../signals/SpreadingActivation.js";
import { CaseRecall }            from "../read/CaseRecall.js";
import { deriveImplicitKeywords, lexicalMatchScore, computeWorkspaceDecayFactor, parseTimeRange } from "../read/FragmentSearch.js";
import { resolveQueryProfile, applyProfileToConfig } from "../read/QueryProfile.js";
import { extractRequestCtx }                        from "../keyId.js";
import { enrichWithKeyNames }                        from "../read/KeyNameEnricher.js";
import { SearchScope, normalizeIsAnchor }            from "../read/SearchScope.js";
import { suggestTopics }                              from "../read/TopicResolver.js";
import { recallViewer, toReviewView } from "../read/ReviewVisibility.js";
import { keyScopeScalar } from "../keyScope.js";
import { SCHEMA } from "../schema.js";
import {
  byDescendingScore,
  decodeRankingCursor,
  encodeSeenCursor,
  rankingSeenKey
} from "../read/DeterministicRanking.js";
import { resolveWorkspaceScope } from "../read/WorkspaceScope.js";
import { isLiteralTrue } from "../../env-parse.js";
import { selectForRecall, partitionCandidates, exceedsBudget, fragmentTokens, RANK_CANDIDATE_LIMIT } from "../read/BudgetSelector.js";
import { lexicalOnlyLast } from "../read/LexicalSearch.js";
import { statedAtMs } from "../WorldTime.js";
import { workspaceBoundaryWarning } from "../read/WorkspaceBoundary.js";

/** recall depth별 허용 파편 유형 (type 미지정 시에만 적용) */
const DEPTH_TYPE_MAP = {
  "high-level": ["decision", "episode"],
  "tool-level": ["procedure", "error", "fact"],
};

const IRRELEVANCE_REASONS = ["not_stored", "search_miss", "scope_leak", "topic_mismatch", "other"];

/**
 * tool_feedback의 무관 판정 원인을 정규화한다.
 *
 * relevant=false인 피드백에서만 의미를 가지므로, 그 외에는 값이 실려 와도 폐기한다.
 * 허용 목록 밖의 값도 폐기하여 원인 분포 집계가 오염되지 않게 한다.
 *
 * @param {Object} params tool_feedback 인자
 * @returns {string|null}
 */
export function normalizeIrrelevanceReason(params) {
  if (!params || params.relevant !== false) return null;
  return IRRELEVANCE_REASONS.includes(params.irrelevance_reason)
    ? params.irrelevance_reason
    : null;
}

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

/**
 * recall 결과 파편에 stale 표시와 다른 작업 공간 fact 표시를 metadata로 단다.
 *
 * @param {Object} frag
 * @param {number} now
 * @param {Object} params recall 인자
 */
function annotateRecallWarnings(frag, now, params) {
  const stale    = computeStale(frag, now);
  const boundary = workspaceBoundaryWarning(frag, params);
  if (!stale && !boundary) return;
  frag.metadata = { ...(frag.metadata || {}), ...(stale ?? {}), ...(boundary ? { workspace_warning: boundary } : {}) };
}

/**
 * recall 파편 메타의 경고를 응답 필드로 옮긴다. stale 표시는 stale_warning, 다른 작업 공간 fact 표시는
 * workspace_warning이다.
 *
 * @param {Object|undefined} metadata
 * @returns {Object}
 */
export function recallWarningFields(metadata) {
  if (!metadata) return {};
  const out = {};
  if (metadata.stale) out.stale_warning = metadata.warning;
  if (metadata.workspace_warning) out.workspace_warning = metadata.workspace_warning;
  return out;
}

/**
 * 키워드·자연어·CBR 케이스 모드로 fragment 를 검색한다.
 *
 * `asOf` 가 지정되면 anchorTime 으로 변환되어 과거 시점 기준 복합 랭킹을 수행한다.
 * `caseMode=true` 일 때는 fragments 대신 `cases[]` 배열을 반환한다. 그 외 경로는
 * 결과 fragment 의 1-hop 링크와 `includeContext=true` 시 동일 세션 30분 이내
 * 인접 파편 최대 3건을 첨부한다.
 *
 * @param {Object} args - `recallDefinition.inputSchema` 의 properties.
 *   대표 키: `keywords`, `text`, `topic`, `type`, `caseMode`, `maxCases`,
 *   `tokenBudget`, `timeRange`, `affect`, `assertionStatus`, `minSimilarity`,
 *   `asOf`/`anchorTime`, `includeContext`, `includeKeywords`, `fields`,
 *   `depth`, `workspace`.
 * @returns {Promise<Object>} caseMode 분기에 따라
 *   `{ success, fragments, count, totalTokens, searchPath, _meta }` 또는
 *   `{ success, caseMode, cases, caseCount, searchPath, _meta }`.
 */
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
    if (params.isAnchor !== undefined) {
      params.isAnchor = normalizeIsAnchor(params.isAnchor);
    }
    const { agentId, keyId, groupKeyIds } = extractRequestCtx(params);
    const fragmentCount = params.fragmentCount || 0;
    const { workspace, allWorkspaces } = resolveWorkspaceScope(params);

    const decodedCursor = decodeRankingCursor(params.cursor);
    const anchorTime = decodedCursor?.anchorTime ?? params.anchorTime ?? Date.now();

    /** Spreading Activation: 대화 맥락 기반 선제적 파편 활성화 (fire-and-forget) */
    if (params.contextText && isLiteralTrue(process.env, "ENABLE_SPREADING_ACTIVATION")) {
      // iron-laws: ignore[IL-301] 선제 활성화는 부가 기능이라 recall 응답을 막지 않는다
      activateByContext(params.contextText, agentId, keyId, params.sessionId, {
        workspace,
        allWorkspaces
      }).catch(() => {});
    }

    const searchQuery = buildRecallSearchQuery(params, {
      fragmentCount, anchorTime, agentId, keyId, groupKeyIds, workspace, allWorkspaces
    });
    const scoreOf = buildRecallScorer(params, anchorTime, workspace);
    const linkCtx = { agentId, groupKeyIds, workspace, allWorkspaces };
    const pageSize = Math.min(
      params.pageSize || MEMORY_CONFIG.pagination?.defaultPageSize || 20,
      MEMORY_CONFIG.pagination?.maxPageSize || 50
    );
    const result  = await this._selectRankedWithinBudget(params, searchQuery, scoreOf, linkCtx, {
      keep  : await this._recallFilter(params),
      offset: decodedCursor?.offset ?? 0,
      seen  : decodedCursor?.seen ?? new Set(),
      pageSize,
      anchorTime,
      collectRanked: params.caseMode === true
    });

    /** stale 감지 및 메타데이터 주입 */
    const now = Date.now();
    for (const frag of result.fragments) annotateRecallWarnings(frag, now, params);

    result.fragments.forEach(publishRecallSource);
    /** 검토 열은 응답에서 지우고 검토 대기 파편에는 pending_review 표지를 단다. */
    result.fragments = result.fragments.map(toReviewView);

    /**
     * topic 정확일치로 0건이 된 경우에 한해 근접 topic 후보를 부착한다.
     * 필터 의미는 그대로 두고, 오기 여부 판단 재료만 힌트 계층에 넘긴다.
     */
    if (result.count === 0 && params.topic) {
      result._topicCandidates = await suggestTopics(
        this.store,
        {
          keyId, groupKeyIds, agentId, workspace,
          allWorkspaces,
          ...(params._isMaster === true ? { _isMaster: true } : {}),
          includePeerAgents: params.includePeerAgents === true
        },
        params.topic
      );
    }

    /**
     * CBR caseMode: 조건에 맞는 검색 결과 전체를 case_id로 묶어 상위 maxCases개 사례를 돌려준다.
     * 사례는 파편 본문이 아니라 대표 파편 요약이므로 응답 한 쪽의 pageSize, tokenBudget, cursor로 고른
     * 파편이 아니라 전체 순위 목록에서 센다.
     */
    const rankedPool = result._rankedPool;
    delete result._rankedPool;
    if (params.caseMode) {
      const caseRecall = new CaseRecall();
      const cases      = await caseRecall.buildCaseTriples(rankedPool ?? result.fragments, {
        keyId,
        groupKeyIds,
        workspace,
        allWorkspaces,
        maxCases: params.maxCases || 5,
        ...(params.includeSuperseded === true ? { includeSuperseded: true } : {}),
        ...(params.isAnchor !== undefined ? { isAnchor: params.isAnchor } : {}),
        agentId,
        ...(params._isMaster === true ? { _isMaster: true } : {}),
        includePeerAgents: params.includePeerAgents === true
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
    // iron-laws: ignore[IL-301] 힌트 생성 실패가 recall 응답을 막지 않는다
    const suggestion = await this.suggestionEngine?.suggest(params, result).catch(() => null) ?? null;
    result._suggestion = suggestion;

    return result;
  }

  /**
   * 결과 파편 조건(threshold, depth, excludeSeen)을 술어 하나로 만든다. 예산 선택과 페이지 계산 전에 적용해
   * 응답에서 빠질 파편이 예산과 페이지 위치를 차지하지 않게 한다.
   *
   * @param {Object} params
   * @returns {Promise<(fragment: Object) => boolean>}
   */
  async _recallFilter(params) {
    const checks = [];

    /** threshold: similarity가 있는 파편만 거르고 L1/L2 결과(similarity 없음)는 보존 */
    if (params.threshold !== undefined) {
      checks.push(f => f.similarity === undefined || f.similarity >= params.threshold);
    }

    /** depth: Planner/Executor 역할별 파편 유형 제한 (type 미지정 시에만 적용) */
    const allowedTypes = !params.type ? DEPTH_TYPE_MAP[params.depth] : undefined;
    if (allowedTypes) {
      const allowed = new Set(allowedTypes);
      checks.push(f => allowed.has(f.type));
    }

    /** excludeSeen: context()에서 이미 주입된 파편 제외 */
    if (params.excludeSeen !== false && params.sessionId) {
      const seenIds = await this.index.getSeenIds(params.sessionId);
      if (seenIds.size > 0) checks.push(f => !seenIds.has(f.id));
    }

    return f => checks.every(check => check(f));
  }

  /**
   * 예산 없는 검색 후보에 연결 파편을 합치고, 최종 점수(computeRecallScore)를 매긴 뒤 토큰 예산 단위의 회차로 나눠
   * 요청한 페이지를 고른다. 첫 회차는 BudgetSelector.selectForRecall이 예산 안에서 고른 집합이고(추정값으로 고르고
   * 고른 파편만 정확히 센다), 다음 회차는 앞 회차들이 고른 파편을 뺀 나머지에서 같은 방식으로 고른다. 회차 안은
   * 최종 점수 순이고 페이지는 회차 경계를 넘지 않으므로 한 페이지는 항상 예산 안이다. cursor는 이미 돌려준 파편 표지를
   * 담고, 다음 호출은 그 파편을 뺀 나머지의 첫 회차부터 고른다. 검색 후보가 호출마다 달라져도 중복이 생기지 않는다.
   * 기존 offset cursor는 회차를 이어 붙인 순서의 위치로 읽는다. 혼자서도 예산을 넘는 파편은 어느 회차에도 들어가지
   * 않으므로 totalCount에서 뺀다. totalCount는 이미 돌려준 수와 남은 수의 합이다.
   * 연결 파편의 기준은 같은 추정값으로 계산한 검색 순서 절단이 고르는 후보(baselineIds)다. 후보 전체가 예산 안이면
   * 기준은 후보 전체이고, superseded 후보가 없는 태그 없는 검색에서는 절단 경계까지 정확히 센 값을 쓴다.
   * 후보에 이미 있는 파편은 연결로 더하지 않는다.
   * 페이지에 든 검색 후보에만 검색 계층의 마무리(접근 기록, 캐시, 검색 이벤트 등)를 적용한다.
   *
   * @param {Object} params
   * @param {Object} searchQuery
   * @param {(fragment: Object) => number} scoreOf
   * @param {Object} linkCtx
   * collectRanked이면 조건에 맞는 후보 전체(이미 돌려준 파편, 예산 초과 파편 포함)를 최종 점수 순으로 _rankedPool에 싣는다.
   *
   * @param {{keep: (fragment: Object) => boolean, offset: number, seen: Set<string>, pageSize: number, anchorTime: number, collectRanked?: boolean}} page
   * @returns {Promise<Object>} finalize 결과에 count, totalCount, nextCursor, hasMore를 더한 객체
   */
  async _selectRankedWithinBudget(params, searchQuery, scoreOf, linkCtx, { keep = () => true, offset = 0, seen = new Set(), pageSize = Infinity, anchorTime, collectRanked = false } = {}) {
    const { candidates, baselineIds, exactCounts: searchCounts, tokenBudget, finalize } = await this.search.searchCandidates(searchQuery);
    const exactCounts = searchCounts ?? new Map();
    /** 어휘 채널에서만 찾은 후보는 다른 채널 후보 뒤에서 예산과 순위를 받는다. */
    const lexicalOnly = new Set(candidates.filter(f => f._lexicalOnly === true).map(f => f.id));
    const rankOf      = lexicalOnlyLast(scoreOf, f => lexicalOnly.has(f.id));
    const byRank      = byDescendingScore(rankOf);

    const seeds  = candidates.filter(f => baselineIds.has(f.id));
    const linked = params.includeLinks !== false && seeds.length > 0
      ? await this._loadLinkedFragments(seeds, params, linkCtx, candidates)
      : [];
    scoreOf.calibrate?.([...candidates, ...linked]);

    const linkedIds = new Set(linked.map(f => f.id));
    let   pool      = [...candidates, ...linked].filter(f => keep(f) && !seen.has(rankingSeenKey(f.id)));
    const binding   = exceedsBudget(pool, tokenBudget, exactCounts);
    if (binding) pool = pool.filter(f => (exactCounts.get(f) ?? fragmentTokens(f)) <= tokenBudget);

    const selectRound = (remaining, roundBaseline) => {
      const selection = selectForRecall(remaining, {
        budget   : tokenBudget,
        utilityOf: scoreOf,
        tierOf   : f => lexicalOnly.has(f.id) ? 1 : 0,
        baselineIds: roundBaseline,
        poolLimit  : RANK_CANDIDATE_LIMIT + (MEMORY_CONFIG.linkedFragmentLimit ?? 10),
        exactCounts
      });
      const round = remaining.filter(f => selection.selectedIds.has(f.id)).sort(byRank);
      /** 남은 파편이 모두 혼자서는 예산 안이므로 빈 회차 대신 최상위 하나로 진행을 보장한다. */
      return round.length > 0 ? round : [[...remaining].sort(byRank)[0]];
    };

    let remaining  = pool;
    let roundBase  = baselineIds;
    let roundStart = 0;
    let page       = [];
    const consumed = [];
    while (remaining.length > 0 && offset < pool.length) {
      const round = binding ? selectRound(remaining, roundBase) : [...remaining].sort(byRank);
      if (offset < roundStart + round.length) {
        page = round.slice(offset - roundStart, offset - roundStart + pageSize);
        consumed.push(...round.slice(0, offset - roundStart));
        break;
      }
      roundStart += round.length;
      consumed.push(...round);
      const taken = new Set(round.map(f => f.id));
      remaining   = remaining.filter(f => !taken.has(f.id));
      roundBase   = partitionCandidates(remaining.filter(f => !linkedIds.has(f.id)), {
        budget: tokenBudget, includeSuperseded: true, exactCounts
      }).baselineIds;
    }

    const inPage = new Set(page.map(f => f.id));
    const result = await finalize(candidates.filter(f => inPage.has(f.id)), {
      candidateCount: pool.length,
      budgetKept    : page.length
    });

    await appendPageLinked(result, linked.filter(f => inPage.has(f.id)), params, exactCounts);
    delete result._lexicalOnlyIds;

    result.fragments.sort(byRank);
    if (collectRanked) result._rankedPool = [...candidates, ...linked].filter(keep).sort(byRank);
    result.count      = result.fragments.length;
    result.totalCount = seen.size + pool.length;
    result.hasMore    = page.length > 0 && consumed.length + page.length < pool.length;
    result.nextCursor = result.hasMore
      ? encodeSeenCursor([...seen, ...[...consumed, ...page].map(f => rankingSeenKey(f.id))], anchorTime)
      : null;
    return result;
  }

  /**
   * 기준 파편들의 1-hop 연결 파편 가운데 범위를 통과하고 present에 없는 것을 돌려준다.
   * 범위와 파편 조건(type, topic, caseId, resolutionStatus, phase, affect, minImportance), 기간, 이미 후보에 있는
   * 파편 제외는 SQL의 LIMIT 앞에 건다. 범위 재검사(SearchScope)는 마지막 방어선이다.
   * 돌려주는 파편에는 _source="linked"를 붙인다.
   *
   * @param {Object[]} seeds   기준 파편
   * @param {Object}   params  recall 인자
   * @param {{agentId: string, groupKeyIds: *, workspace: *, allWorkspaces: boolean}} linkCtx
   * @param {Object[]} [present] 이미 결과 후보에 있는 파편(기본: seeds)
   * @returns {Promise<Object[]>}
   */
  async _loadLinkedFragments(seeds, params, { agentId, groupKeyIds, workspace, allWorkspaces }, present = seeds) {
    const existingIds = new Set(present.map(f => f.id));
    const fromIds     = seeds.map(f => f.id);
    const filters     = Object.fromEntries(
      Object.entries(recallFragmentFilters(params)).filter(([, value]) => value !== undefined)
    );
    const timeRange   = parseTimeRange(params.timeRange);

    const linkedFrags = await this.store.getLinkedFragments(
      fromIds,
      params.linkRelationType || null,
      agentId,
      groupKeyIds,
      {
        workspace,
        allWorkspaces,
        viewerKeyId: recallViewer(params, params._keyId ?? null),
        ...(params._isMaster === true ? { _isMaster: true } : {}),
        includePeerAgents: params.includePeerAgents === true,
        ...(params.includeSuperseded === true ? { includeSuperseded: true } : {}),
        ...(params.isAnchor !== undefined ? { isAnchor: params.isAnchor } : {}),
        ...(Object.keys(filters).length > 0 ? { filters } : {}),
        ...(timeRange ? { timeRange } : {}),
        excludeIds: [...existingIds]
      }
    );
    const linkedScope = SearchScope.fromQuery({
      agentId,
      workspace,
      allWorkspaces,
      ...(params._isMaster === true ? { _isMaster: true } : {}),
      includePeerAgents: params.includePeerAgents === true,
      ...(params.isAnchor !== undefined ? { isAnchor: params.isAnchor } : {}),
      ...filters,
      readRange        : params._workspaceReadRange,
      timeRange
    });
    const scopedLinkedFrags = linkedScope.isNoop()
      ? linkedFrags
      : linkedFrags.filter(fragment => linkedScope.applyTo(fragment));

    const added = [];
    for (const lf of scopedLinkedFrags) {
      if (!existingIds.has(lf.id)) {
        lf._source = "linked";
        added.push(lf);
        existingIds.add(lf.id);
      }
    }
    return added;
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
    const irrelevance = normalizeIrrelevanceReason(params);

    const result = await pool.query(
      `INSERT INTO ${SCHEMA}.tool_feedback
             (tool_name, relevant, sufficient, suggestion, context, session_id, trigger_type, search_event_id,
              irrelevance_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        params.tool_name,
        params.relevant,
        params.sufficient,
        suggestion,
        context,
        params.session_id || null,
        triggerType,
        params.search_event_id ?? null,
        irrelevance
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
        const lockParams = [fragmentIds];
        const keyFilter  = keyScopeScalar(lockParams, "key_id", keyId).trimStart();
        await queryWithAgentVector("system",
          `UPDATE ${SCHEMA}.fragments
           SET ema_activation = LEAST(1.0, GREATEST(0, COALESCE(ema_activation, 0.5) + $2)),
               ema_last_updated = NOW()
           WHERE id = ANY($1::text[])`,
          [delta],
          { lock: fragmentRowLock("feedback", `id = ANY($1) ${keyFilter}`, lockParams) }
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
    const { workspace, allWorkspaces } = resolveWorkspaceScope(params);
    if (!params.id) {
      return { error: "id is required" };
    }
    const { agentId, keyId, groupKeyIds } = extractRequestCtx(params, { groupKeyIdsFallback: 'empty' });

    /** getHistory 내부 getById에 keyId 전달 — SQL 레벨 필터로 권한 없으면 current=null */
    const result = await this.store.getHistory(
      params.id, agentId, keyId, groupKeyIds,
      {
        ...(params._isMaster === true ? { _isMaster: true } : {}),
        includePeerAgents: params.includePeerAgents === true,
        workspace,
        allWorkspaces
      }
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
    const { workspace, allWorkspaces } = resolveWorkspaceScope(params);
    if (!params.startId) {
      return { error: "startId is required" };
    }

    const { agentId, keyId, groupKeyIds } = extractRequestCtx(params, { groupKeyIdsFallback: 'empty' });
    const scopeOpts = {
      workspace,
      allWorkspaces,
      ...(params._isMaster === true ? { _isMaster: true } : {}),
      includePeerAgents: params.includePeerAgents === true
    };

    /** 시작 파편 소유권 확인 — SQL 레벨 필터로 권한 없으면 null 반환 */
    const startFrag = await this.store.getById(
      params.startId, agentId, keyId, groupKeyIds, scopeOpts
    );
    if (!startFrag) {
      return { error: "Fragment not found or no permission" };
    }

    const nodes = await this.store.getRCAChain(
      params.startId, agentId, keyId, groupKeyIds, scopeOpts
    );

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
 * 내부 origin 태그(_source)는 정렬·cursor 점수 계산용이다. 응답 전에 지우고,
 * 연결 파편만 recall_source로 남겨 응답의 source 표지로 쓴다.
 *
 * @param {Object} fragment
 */
function publishRecallSource(fragment) {
  if (fragment._source === "linked") fragment.recall_source = "linked";
  delete fragment._source;
}

/**
 * recall 인자에서 파편 조건을 뽑는다. 검색 질의와 연결 파편 조회가 같은 조건을 쓴다.
 * caseId, resolutionStatus, phase, affect는 값이 있을 때만 키를 둔다.
 *
 * @param {Object} params recall 인자
 * @returns {{type: *, topic: *, minImportance: *, caseId?: string, resolutionStatus?: string, phase?: string, affect?: *}}
 */
export function recallFragmentFilters(params) {
  return {
    type         : params.type,
    /** FragmentSearch와 같이 앞뒤 공백을 지우고, 공백만이면 조건 없음으로 둔다. */
    topic        : typeof params.topic === "string" ? (params.topic.trim() || undefined) : params.topic,
    minImportance: params.minImportance,
    ...(params.caseId           ? { caseId: params.caseId } : {}),
    ...(params.resolutionStatus ? { resolutionStatus: params.resolutionStatus } : {}),
    ...(params.phase            ? { phase: params.phase } : {}),
    ...(params.affect           ? { affect: params.affect } : {})
  };
}

/**
 * 페이지에 든 연결 파편을 검색 파편과 같이 결과에 넣는다. 토큰 합계와 키 이름 보강도 함께 반영한다.
 *
 * @param {Object}   result      finalize 결과
 * @param {Object[]} pageLinked  페이지에 든 연결 파편
 * @param {Object}   params      recall 인자
 * @param {Map}      exactCounts 파편별 정확한 토큰 수
 */
async function appendPageLinked(result, pageLinked, params, exactCounts) {
  if (pageLinked.length === 0) return;
  const linkedTokens = pageLinked.reduce((sum, f) => sum + (exactCounts.get(f) ?? fragmentTokens(f)), 0);
  result.fragments.push(...(params.includeKeyName === true ? await enrichWithKeyNames(pageLinked) : pageLinked));
  result.totalTokens = (result.totalTokens ?? 0) + linkedTokens;
}

/**
 * recall 인자를 검색 질의로 바꾼다.
 *
 * @param {Object} params recall 인자
 * @param {Object} ctx    { fragmentCount, anchorTime, agentId, keyId, groupKeyIds, workspace, allWorkspaces }
 *   keyId는 검토 대기 파편 가시성의 보는 주체다(마스터 키는 null)
 * @returns {Object}
 */
export function buildRecallSearchQuery(params, { fragmentCount, anchorTime, agentId, keyId, groupKeyIds, workspace, allWorkspaces }) {
  const { type, topic, minImportance, ...narrative } = recallFragmentFilters(params);
  return {
    keywords          : params.keywords || [],
    topic,
    type,
    text              : params.text,
    contextText       : params.contextText || undefined,
    tokenBudget       : params.tokenBudget || 1000,
    minImportance,
    includeSuperseded : params.includeSuperseded || false,
    timeRange         : params.timeRange || undefined,
    fragmentCount,                          // 하위 호환 유지
    anchorTime,                             // 시간-의미 복합 랭킹 기준
    agentId,                                // 에이전트 컨텍스트
    keyId: groupKeyIds,                     // API 키 격리 필터 (그룹 배열)
    viewerKeyId: recallViewer(params, keyId), // 검토 대기 파편은 쓴 키에게만, 주입 후보 조회는 아무에게도
    workspace,                              // 워크스페이스 필터
    allWorkspaces,                          // master 명시 전체 조회
    sessionId: params.sessionId || null,    // search_events.session_id 전파
    lexicalChannel: true,                   // 본문 어휘 채널은 recall 진입점에서만 켠다
    ...(params.isAnchor !== undefined ? { isAnchor: params.isAnchor } : {}),
    ...narrative,
    ...(params.includePeerAgents === true ? { includePeerAgents: true, _isMaster: params._isMaster === true } : {}),
    ...(params.includeKeyName === true ? { includeKeyName: true } : {}),
    ...(Array.isArray(params._workspaceReadRange) ? { readRange: params._workspaceReadRange } : {}),
    ...(params._searchSideEffects ? { sideEffects: params._searchSideEffects } : {})
    /** H2 Sparse Fieldsets: 필드 선택은 응답 프로젝션(buildRecallResponse)에서 최종 적용한다.
     *  파생 키(confidence, age_days) 산출에 원시 컬럼이 필요하므로 검색 계층에서는 자르지 않는다. */
  };
}

/**
 * recall 최종 점수 함수. 검색 결과에 includeLinks 파편이 합류한 집합을 computeRecallScore로
 * 정렬하고 예산 선택하는 데 쓴다. rerankerScore를 base로 보존하므로 cross-encoder 결과를 폐기하지
 * 않으며, topic/keyword 직접 일치를 제한된 가산항으로 반영한다.
 * lexWeight는 파편별 rerankerScore 유무로 결정된다(집합 단위 아님).
 *
 * @param {Object} params     recall 인자(keywords, topic, text 등)
 * @param {number} anchorTime 시간 근접도 기준 시각
 * @param {string|null} workspace 검색 scope workspace
 * @returns {(fragment: Object) => number}
 */
export function buildRecallScorer(params, anchorTime, workspace) {
  const lexicalQuery = {
    keywords          : params.keywords,
    topic             : params.topic,
    _implicitKeywords : deriveImplicitKeywords(params)
  };
  /** 질의 의도 프로파일의 lexical 가중치를 최종 재정렬에도 동일하게 적용한다.
   *  이 단계를 빼면 FragmentSearch에만 반영되어 최종 순위가 프로파일을 따르지 않는다. */
  const rankConfig = applyProfileToConfig(MEMORY_CONFIG, resolveQueryProfile(params));
  const rankCtx    = { lexicalQuery, anchorTime, config: rankConfig, workspace };

  /** cross-encoder 점수(0~1 sigmoid, 관련 있어도 0.2~0.3 수준)와 복합 점수(중요도/최신성/유사도, 0.5 안팎)는
   *  척도가 달라 한 줄로 정렬하면 reranker가 검증하지 않은 파편(연결 파편, 재정렬 창 밖)이 검증된 파편 위로 올라간다.
   *  calibrate()가 후보 집합의 재정렬 점수 하한을 정하면, 재정렬 점수가 없는 파편은 그 아래로 단조 사상한다
   *  (비검증 파편끼리의 순서는 유지). 재정렬 점수가 하나도 없으면 아무것도 바꾸지 않는다. */
  let rerankFloor = null;
  const scorer = fragment => {
    const score = computeRecallScore(fragment, rankCtx);
    if (rerankFloor === null || fragment.rerankerScore !== undefined) return score;
    return rerankFloor * (score / (1 + score));
  };
  scorer.calibrate = fragments => {
    let floor = Infinity;
    for (const f of fragments) {
      if (f.rerankerScore !== undefined) floor = Math.min(floor, computeRecallScore(f, rankCtx));
    }
    rerankFloor = Number.isFinite(floor) ? floor : null;
  };
  return scorer;
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
 *   6. ctx.workspace가 지정되면 최종 점수에 workspace 스코프 감쇠 배율을 곱한다.
 *      FragmentSearch가 이미 L1/L2/L3/Graph를 통과시킨 결과와 includeLinks
 *      파편이 여기서 합류하므로, 이 지점이 감쇠를 적용하는 유일한 병합점이다.
 *
 * FragmentSearch._computeRankScore와 공식 일부가 겹치나, 그쪽은 검색 레이어
 * (emaBoost 포함) 점수이고 이쪽은 검색 후 통합 정렬 점수로 책임이 다르다.
 * 의도적 분리이며 공유 모듈로 추상화하지 않는다.
 *
 * @param {Object} fragment
 * @param {Object} ctx
 *   - lexicalQuery   {Object}      keywords/topic/_implicitKeywords를 담은 질의
 *   - anchorTime     {number}      시간 근접도 기준 시각
 *   - config         {Object}      MEMORY_CONFIG
 *   - workspace      {string|null} 검색 scope workspace (미지정 시 감쇠 없음)
 * @returns {number}
 */
export function computeRecallScore(fragment, ctx) {
  const { lexicalQuery, anchorTime, config, workspace } = ctx;
  const RANK = config.ranking;

  const hasRerankerScore = fragment.rerankerScore !== undefined;

  let base;
  if (hasRerankerScore) {
    base = fragment.rerankerScore;
  } else {
    const importance = fragment.importance || 0;
    const parsed     = statedAtMs(fragment);
    const statedAt   = Number.isFinite(parsed) ? parsed : anchorTime;
    const distDays   = Math.abs(anchorTime - statedAt) / 86400000;
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

  const score = base + lexNorm * lexWeight;

  return score * computeWorkspaceDecayFactor(fragment, workspace);
}
