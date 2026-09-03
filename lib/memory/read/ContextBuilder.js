/**
 * ContextBuilder — context() 로직 전담 모듈
 *
 * 작성자: 최진호
 * 작성일: 2026-04-05
 * 수정일: 2026-06-15
 *
 * MemoryManager.context() 330줄 본문을 추출.
 * Core Memory, Working Memory, Anchor Memory를 조합하여 컨텍스트를 생성한다.
 */

import { MEMORY_CONFIG }              from "../../../config/memory.js";
import { getPrimaryPool }             from "../../tools/db.js";
import { logWarn }                    from "../../logger.js";
import { computeWorkspaceDecayFactor } from "./FragmentSearch.js";
import { keyScopeGroup } from "../keyScope.js";
import { SCHEMA } from "../schema.js";
import { byDescendingScore, compareTimestampDescThenId } from "./DeterministicRanking.js";
import { SearchScope } from "./SearchScope.js";
import { resolveWorkspaceScope } from "./WorkspaceScope.js";

/**
 * context 응답에 포함할 힌트를 생성한다.
 * AI가 다음 행동을 능동적으로 결정할 수 있도록 signal + suggestion을 제공.
 */
function buildContextHint(fragments, workspaceScope = {}) {
  const errorFrags = fragments.filter(f => f.type === "error");
  if (errorFrags.length > 0) {
    return {
      signal    : "active_errors",
      suggestion: `미해결 에러 파편 ${errorFrags.length}개 있음. 이미 해결된 항목은 forget으로 정리하세요.`,
      trigger   : "forget"
    };
  }
  if (fragments.length === 0) {
    if (workspaceScope.mode === "global_only") {
      return {
        signal    : "empty_context",
        suggestion: "전역(workspace 없음) 범위에서만 컨텍스트를 조회했으며 결과가 없습니다. workspace별 기억을 사용하려면 해당 workspace를 지정해 context를 다시 호출하세요.",
        trigger   : "context"
      };
    }
    return {
      signal    : "empty_context",
      suggestion: "저장된 기억이 없습니다. 작업 후 reflect나 remember로 중요 내용을 저장하세요.",
      trigger   : "remember"
    };
  }
  return null;
}

/**
 * anchor 고정 상단 + 비앵커 최소 슬롯 + 나머지 복합 점수 정렬 후 토큰 예산 내 슬라이스.
 * anchor와 최소 슬롯은 기존 context 보장 계약을 지키기 위해 예산보다 우선한다.
 *
 * @param {object[]} anchorFragments
 * @param {object[]} otherFragments   - core + working (anchor 제외)
 * @param {number}   tokenBudget
 * @param {{ importance: number, ema_activation: number }} weights
 * @param {string|null} [workspace]   - 지정 시 workspace 불일치·전역 파편의 정렬 우선순위를 감쇠
 * @param {object[]} [guaranteedOtherFragments] - core 유형/learning/working별 최소 보장 후보
 * @param {Set<object>|null} [selectedFragments] - 호출자가 정확한 원본 선택 집합을 받을 내부 sink
 * @returns {{ items: object[], totalTokens: number }}
 */
function buildRankedInjection(
  anchorFragments,
  otherFragments,
  tokenBudget,
  weights,
  workspace = null,
  guaranteedOtherFragments = [],
  selectedFragments = null
) {
  const { importance: wImp, ema_activation: wEma } = weights;
  const score  = f => ((f.importance ?? 0) * wImp + (f.ema_activation ?? 0) * wEma)
    * computeWorkspaceDecayFactor(f, workspace);
  const guaranteedIds  = new Set(guaranteedOtherFragments.map(f => f?.id).filter(Boolean));
  const guaranteedRefs = new Set(guaranteedOtherFragments);
  const isGuaranteed   = f => guaranteedRefs.has(f) || (f?.id && guaranteedIds.has(f.id));
  const sorted = otherFragments
    .filter(f => !isGuaranteed(f))
    .sort(byDescendingScore(score));

  const items      = [];
  let   usedTokens = 0;

  for (const f of anchorFragments) {
    selectedFragments?.add(f);
    usedTokens += Math.ceil((f.content?.length ?? 0) / 4);
    items.push({
      rank      : items.length + 1,
      score     : null,
      id        : f.id,
      type      : f.type,
      content   : f.content,
      importance: f.importance,
      anchor    : true
    });
  }

  /** 앵커가 예산을 소진해도 core/learning/working 맥락이 통째로 사라지지 않게 한다. */
  for (const f of guaranteedOtherFragments) {
    selectedFragments?.add(f);
    usedTokens += Math.ceil((f.content?.length ?? 0) / 4);
    items.push({
      rank      : items.length + 1,
      score     : +score(f).toFixed(4),
      id        : f.id,
      type      : f.type,
      content   : f.content,
      importance: f.importance,
      anchor    : false
    });
  }

  for (const f of sorted) {
    const t = Math.ceil((f.content?.length ?? 0) / 4);
    if (usedTokens + t > tokenBudget) break;
    selectedFragments?.add(f);
    usedTokens += t;
    items.push({
      rank      : items.length + 1,
      score     : +score(f).toFixed(4),
      id        : f.id,
      type      : f.type,
      content   : f.content,
      importance: f.importance,
      anchor    : false
    });
  }

  return { items, totalTokens: usedTokens };
}

/**
 * importance 동점 시 별도 결정적 정렬 계약(created_at DESC NULLS LAST, id ASC)을
 * 따라 anchor 후보를 비교한다.
 */
function compareAnchorRank(a, b) {
  const importanceDiff = (Number(b.importance) || 0) - (Number(a.importance) || 0);
  if (importanceDiff !== 0) return importanceDiff;

  const time = value => {
    if (value == null) return null;
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : null;
  };
  const aTime = time(a.created_at);
  const bTime = time(b.created_at);
  if (aTime != null || bTime != null) {
    if (aTime == null) return 1;
    if (bTime == null) return -1;
    if (aTime !== bTime) return bTime - aTime;
  }

  const aId = Buffer.from(String(a.id ?? ""), "utf8");
  const bId = Buffer.from(String(b.id ?? ""), "utf8");
  return Buffer.compare(aId, bId);
}

/**
 * workspace 예약분을 먼저 고정하고 남은 workspace/global 후보를 통합 랭킹한다.
 * DB 후보가 이미 정렬돼 있어도 동일 계약으로 다시 정렬해 입력 순서에 의존하지 않는다.
 */
export function selectAnchorFragments(workspaceCandidates, globalCandidates, {
  limit = MEMORY_CONFIG.contextInjection?.maxAnchorFragments ?? 20,
  reserve = MEMORY_CONFIG.contextInjection?.workspaceAnchorReserve ?? 10,
  workspaceApplied,
  workspaceCandidateCount = workspaceCandidates.length,
  globalCandidateCount = globalCandidates.length,
  unscopedCandidateCount = globalCandidates.length,
  workspaceCandidatesLoaded = true,
  globalCandidatesLoaded = true,
  unscopedCandidatesLoaded = true,
} = {}) {
  const maxAnchors = Math.max(0, limit);
  const effectiveReserve = workspaceApplied ? Math.min(reserve, maxAnchors) : 0;
  // global-only 호출에서는 잘못 전달된 workspace 후보도 선택 풀에 넣지 않는다.
  const rankedWorkspace = workspaceApplied
    ? [...workspaceCandidates].sort(compareAnchorRank)
    : [];
  const rankedGlobal    = [...globalCandidates].sort(compareAnchorRank);
  const reserved        = rankedWorkspace.slice(0, effectiveReserve);
  const remaining       = [
    ...rankedWorkspace.slice(reserved.length).map(fragment => ({ fragment, scope: "workspace" })),
    ...rankedGlobal.map(fragment => ({ fragment, scope: "global" })),
  ].sort((a, b) => compareAnchorRank(a.fragment, b.fragment));

  const selected = [...reserved];
  let selectedWorkspace = reserved.length;
  let selectedGlobal    = 0;
  let selectedUnscoped  = 0;
  for (const candidate of remaining) {
    if (selected.length >= maxAnchors) break;
    selected.push(candidate.fragment);
    if (candidate.scope === "workspace") selectedWorkspace++;
    else if (workspaceApplied) selectedGlobal++;
    else selectedUnscoped++;
  }

  const candidates = {
    workspace: workspaceApplied
      ? (workspaceCandidatesLoaded ? workspaceCandidateCount : null)
      : 0,
    global: workspaceApplied
      ? (globalCandidatesLoaded ? globalCandidateCount : null)
      : 0,
    unscoped: workspaceApplied
      ? 0
      : (unscopedCandidatesLoaded ? unscopedCandidateCount : null),
  };
  const countsKnown = Object.values(candidates).every(Number.isFinite);
  candidates.total = countsKnown
    ? candidates.workspace + candidates.global + candidates.unscoped
    : null;
  const selectedCounts = {
    workspace        : selectedWorkspace,
    global           : selectedGlobal,
    unscoped         : selectedUnscoped,
    reservedWorkspace: reserved.length,
    total            : selected.length,
  };
  const excluded = {
    workspace: candidates.workspace == null
      ? null
      : Math.max(0, candidates.workspace - selectedCounts.workspace),
    global: candidates.global == null
      ? null
      : Math.max(0, candidates.global - selectedCounts.global),
    unscoped: candidates.unscoped == null
      ? null
      : Math.max(0, candidates.unscoped - selectedCounts.unscoped),
  };
  excluded.total = countsKnown
    ? excluded.workspace + excluded.global + excluded.unscoped
    : null;

  const loadStatus = {
    workspace: workspaceApplied ? workspaceCandidatesLoaded : null,
    global   : workspaceApplied ? globalCandidatesLoaded : null,
    unscoped : workspaceApplied ? null : unscopedCandidatesLoaded,
  };
  const partial = Object.values(loadStatus).some(status => status === false);

  return {
    fragments: selected,
    meta     : {
      totalLimit       : maxAnchors,
      workspaceReserve : reserve,
      reserveApplied   : workspaceApplied,
      partial,
      loadStatus,
      candidates,
      selected         : selectedCounts,
      excluded,
    }
  };
}

/**
 * 유형마다 최상위 파편 하나씩을 자리 보장으로 담는다.
 *
 * 예산이 빠듯해도 각 유형이 최소 하나는 주입돼야 맥락이 한쪽으로 쏠리지 않는다.
 *
 * @returns {{guaranteed: Map, seen: Set, usedChars: number}}
 */
export function seedGuaranteed(types, typeFragMap) {
  const guaranteed = new Map();
  const seen       = new Set();
  let   usedChars  = 0;

  for (const type of types) {
    const frags = typeFragMap.get(type) || [];
    const top = frags.find(fragment => !seen.has(fragment?.id ?? fragment));
    if (!top) continue;
    guaranteed.set(type, [top]);
    seen.add(top.id ?? top);
    usedChars += (top.content || "").length;
  }
  return { guaranteed, seen, usedChars };
}

/**
 * 자리 보장에 들지 못한 나머지 후보를 모은다. 이미 담긴 파편은 뺀다.
 *
 * @returns {Array<Object>}
 */
export function collectExtras(types, typeFragMap, seen) {
  const extras = [];
  for (const type of types) {
    const frags = typeFragMap.get(type) || [];
    for (let i = 1; i < frags.length; i++) {
      const identity = frags[i]?.id ?? frags[i];
      if (seen.has(identity)) continue;
      extras.push(frags[i]);
      seen.add(identity);
    }
  }
  return extras;
}

/**
 * 온도 점수 비교기를 만든다.
 *
 * 최근에 읽혔거나 자주 읽힌 파편, 학습 추출로 들어온 파편에 가산점을 준다.
 * 워크스페이스가 다르면 감쇠한다.
 *
 * @param {string|null} workspace
 * @returns {(a: Object, b: Object) => number}
 */
export function byTemperature(workspace) {
  const boost        = MEMORY_CONFIG.contextInjection?.temperatureBoost || {};
  const warmMs       = (boost.warmWindowDays || 7) * 86400000;
  const accessThresh = boost.highAccessThreshold || 5;
  const now          = Date.now();

  const score = (frag) => {
    let s = frag.importance || 0;
    const accessedAt = frag.accessed_at ? new Date(frag.accessed_at).getTime() : 0;
    if (now - accessedAt < warmMs)                    s += boost.warmBoost || 0;
    if ((frag.access_count || 0) >= accessThresh)     s += boost.highAccessBoost || 0;
    if (frag.source === "learning_extraction")        s += boost.learningBoost || 0;
    return s * computeWorkspaceDecayFactor(frag, workspace);
  };

  return byDescendingScore(score);
}

/**
 * 파편 수 상한과 유형별 슬롯, 문자 예산 안에서 나머지를 채운다.
 *
 * 예산 경계에 걸린 파편은 남은 자리가 쓸 만큼 크면 잘라서라도 넣는다. 잘라
 * 넣은 뒤에는 더 담지 않는다.
 *
 * @returns {number} 최종 사용 문자 수
 */
export function fillWithinBudget(guaranteed, extras, { usedChars, coreCharBudget }) {
  const maxCore   = MEMORY_CONFIG.contextInjection?.maxCoreFragments || 15;
  const typeSlots = MEMORY_CONFIG.contextInjection?.typeSlots || {};

  const typeCounters = {};
  let   totalAdded   = 0;
  for (const [type, frags] of guaranteed) {
    typeCounters[type] = frags.length;
    totalAdded        += frags.length;
  }

  const put = (typeKey, frag) => {
    const arr = guaranteed.get(typeKey) || [];
    arr.push(frag);
    guaranteed.set(typeKey, arr);
    typeCounters[typeKey] = (typeCounters[typeKey] || 0) + 1;
    totalAdded++;
  };

  for (const f of extras) {
    if (totalAdded >= maxCore) break;

    const typeKey = f.type || "general";
    if ((typeCounters[typeKey] || 0) >= (typeSlots[typeKey] || 5)) continue;

    const cost = (f.content || "").length;
    if (usedChars + cost > coreCharBudget) {
      const remaining = coreCharBudget - usedChars;
      if (remaining > 80) {
        put(typeKey, { ...f, content: f.content.substring(0, remaining - 3) + "..." });
        usedChars += remaining;
      }
      break;
    }

    put(typeKey, f);
    usedChars += cost;
  }

  return usedChars;
}

/**
 * anchor > core > learning > working 순서로 ID 소유권을 정하고 섹션별 후보를 정리한다.
 * ID가 없는 임시 항목은 서로 다른 객체면 보존하되, 같은 객체 참조의 반복은 제거한다.
 *
 * @param {{anchor: object[], core: object[], learning: object[], working: object[]}} sections
 * @returns {{anchor: object[], core: object[], learning: object[], working: object[]}}
 */
export function deduplicateContextSections(sections) {
  const seen   = new Set();
  const seenRefs = new Set();
  const result = { anchor: [], core: [], learning: [], working: [] };

  for (const section of ["anchor", "core", "learning", "working"]) {
    for (const fragment of sections[section] || []) {
      if (fragment && seenRefs.has(fragment)) continue;
      if (fragment?.id && seen.has(fragment.id)) continue;
      if (fragment) seenRefs.add(fragment);
      if (fragment?.id) seen.add(fragment.id);
      result[section].push(fragment);
    }
  }

  return result;
}

/**
 * context의 기존 최소 보장 의미를 유지한다. core는 유형마다 하나, learning과
 * working은 섹션마다 하나를 앵커와 별도로 보장한다.
 *
 * @param {{core: object[], learning: object[], working: object[]}} sections
 * @param {object[]|null} guaranteedCoreFragments - seedGuaranteed가 버킷별로 고른 core 후보
 * @returns {object[]}
 */
export function collectGuaranteedContextFragments(sections, guaranteedCoreFragments = null) {
  const guaranteed = [];
  const core       = sections.core || [];
  const seenRefs   = new Set();
  const seenIds    = new Set();
  const pushUnique = fragment => {
    if (!fragment || seenRefs.has(fragment) || (fragment.id && seenIds.has(fragment.id))) return;
    seenRefs.add(fragment);
    if (fragment.id) seenIds.add(fragment.id);
    guaranteed.push(fragment);
  };

  if (Array.isArray(guaranteedCoreFragments)) {
    const coreRefs = new Set(core);
    const coreById = new Map(core.filter(f => f?.id).map(f => [f.id, f]));
    for (const candidate of guaranteedCoreFragments) {
      const retained = coreRefs.has(candidate) ? candidate : coreById.get(candidate?.id);
      pushUnique(retained);
    }
  } else {
    const coreTypes = new Set();
    for (const fragment of core) {
      const type = fragment?.type || "general";
      if (coreTypes.has(type)) continue;
      coreTypes.add(type);
      pushUnique(fragment);
    }
  }
  if (sections.learning?.length > 0) pushUnique(sections.learning[0]);
  if (sections.working?.length > 0) pushUnique(sections.working[0]);

  return guaranteed;
}

/**
 * anchor나 앞선 core provenance 버킷이 차지한 ID를 건너뛰고 각 core 버킷의
 * 첫 유효 후보를 선택한다. 상위 후보가 dedup되면 차순위가 최소 슬롯을 승계한다.
 *
 * @param {string[]} types
 * @param {Map<string, object[]>} typeFragMap
 * @param {object[]} excludedFragments
 * @returns {object[]}
 */
export function selectGuaranteedCoreFragments(types, typeFragMap, excludedFragments = []) {
  const seen = new Set(excludedFragments.map(fragment => fragment?.id ?? fragment));
  const selected = [];

  for (const type of types) {
    const candidate = (typeFragMap.get(type) || [])
      .find(fragment => !seen.has(fragment?.id ?? fragment));
    if (!candidate) continue;
    selected.push(candidate);
    seen.add(candidate.id ?? candidate);
  }

  return selected;
}

function estimateFragmentTokens(fragments) {
  return fragments.reduce(
    (sum, fragment) => sum + Math.ceil((fragment?.content?.length ?? 0) / 4),
    0
  );
}

export class ContextBuilder {
  #recall;
  #store;
  #index;
  #getPool;

  /**
   * @param {{ recall: Function, store: object, index: object, getPool?: Function }} deps
   */
  constructor({ recall, store, index, getPool }) {
    this.#recall  = recall;
    this.#store   = store;
    this.#index   = index;
    this.#getPool = getPool || getPrimaryPool;
  }

  /**
   * 컨텍스트를 조합하여 반환한다.
   * MemoryManager.context()와 동일한 시그니처 및 반환값.
   *
   * @param {Object} params
   *   - sessionId   {string} 세션 ID (선택)
   *   - tokenBudget {number} 기본 2000
   *   - types       {string[]} 로드할 유형 목록 (기본: preference, error, procedure)
   *   - structured  {boolean} 계층적 트리 구조 반환 여부
   * @returns {Object} { fragments, totalTokens, injectionText, coreTokens, wmTokens, wmCount }
   */
  async build(params) {
    const agentId     = params.agentId || "default";
    const keyId       = params._keyId ?? null;
    const groupKeyIds = params._groupKeyIds ?? (keyId ? [keyId] : null);
    const { workspace, allWorkspaces, mode: workspaceMode } = resolveWorkspaceScope(params);

    const { typeFragMap, types, coreFragments } =
      await this.#loadCoreMemory(
        params, agentId, keyId, groupKeyIds, workspace, allWorkspaces
      );

    const { wmFragments } = await this.#loadWorkingMemory(
      params, workspace, allWorkspaces
    );

    const { fragments: anchorFragments, meta: anchorSelection } =
      await this.#loadAnchorMemory(groupKeyIds, workspace, allWorkspaces);
    const learningFragments = await this.#loadLearningFragments(
      agentId, keyId, workspace, allWorkspaces
    );
    const guaranteedCoreFragments = selectGuaranteedCoreFragments(
      types, typeFragMap, anchorFragments
    );
    const prioritizedCoreFragments = deduplicateContextSections({
      anchor: [],
      core: [...guaranteedCoreFragments, ...coreFragments],
      learning: [],
      working: []
    }).core;

    const deduped = deduplicateContextSections({
      anchor  : anchorFragments,
      core    : prioritizedCoreFragments,
      learning: learningFragments,
      working : wmFragments
    });

    const others = [...deduped.core, ...deduped.learning, ...deduped.working];
    const guaranteedOthers = collectGuaranteedContextFragments(deduped, guaranteedCoreFragments);
    const selectedFragments = new Set();
    const ranked = buildRankedInjection(
      deduped.anchor,
      others,
      params.tokenBudget ?? MEMORY_CONFIG.contextInjection.defaultTokenBudget,
      MEMORY_CONFIG.contextInjection.rankWeights,
      workspace,
      guaranteedOthers,
      selectedFragments
    );
    const effective = {
      anchor  : deduped.anchor.filter(fragment => selectedFragments.has(fragment)),
      core    : deduped.core.filter(fragment => selectedFragments.has(fragment)),
      learning: deduped.learning.filter(fragment => selectedFragments.has(fragment)),
      working : deduped.working.filter(fragment => selectedFragments.has(fragment))
    };

    const dedupResult = [
      ...effective.anchor,
      ...effective.core,
      ...effective.learning,
      ...effective.working
    ];
    const lines = await this.#buildInjectionLines(
      effective.anchor,
      effective.core,
      effective.learning,
      effective.working
    );

    const anchorTokens   = estimateFragmentTokens(effective.anchor);
    const coreTokens     = estimateFragmentTokens(effective.core);
    const learningTokens = estimateFragmentTokens(effective.learning);
    const wmTokens       = estimateFragmentTokens(effective.working);
    const totalTokens    = anchorTokens + coreTokens + learningTokens + wmTokens;

    /** -- Seen IDs 저장: recall() 중복 주입 방지용 -- */
    if (params.sessionId) {
      const seenIds = dedupResult.map(f => f.id).filter(Boolean);
      await this.#index.setSeenIds(params.sessionId, seenIds);
    }

    /** -- structured=true: 계층적 트리 구조 반환 -- */
    if (params.structured === true) {
      return this.#buildStructuredResponse({
        coreFragments: effective.core,
        wmFragments: effective.working,
        anchorFragments: effective.anchor,
        learningFragments: effective.learning,
        dedupResult,
        injectionText: lines.join("\n"),
        ranked,
        totalTokens,
        anchorTokens,
        coreTokens,
        learningTokens,
        wmTokens,
        workspaceMode,
        anchorSelection
      });
    }

    const contextHint = buildContextHint(dedupResult, { mode: workspaceMode });
    return {
      fragments    : dedupResult,
      totalTokens,
      count        : dedupResult.length,
      anchorTokens,
      coreTokens,
      learningTokens,
      wmTokens,
      wmCount      : effective.working.length,
      anchorCount  : effective.anchor.length,
      learningCount: effective.learning.length,
      _anchorSelection: anchorSelection,
      injectionText: lines.join("\n"),
      ...(contextHint ? { _memento_hint: contextHint } : {})
    };
  }

  /**
   * Core Memory를 로드한다.
   * types별 병렬 recall + session_reflect + 스마트 캡 적용.
   *
   * @returns {{ typeFragMap: Map, types: string[], coreFragments: object[], usedChars: number }}
   */
  async #loadCoreMemory(params, agentId, keyId, groupKeyIds, workspace, allWorkspaces) {
    const coreBudget     = 1500;
    const coreCharBudget = coreBudget * 4;

    const { typeFragMap, types } = await this.#fetchByType(
      params, coreBudget, { agentId, keyId, groupKeyIds, workspace, allWorkspaces }
    );

    /** 유형마다 최상위 하나는 예산과 무관하게 자리를 보장한다. */
    const { guaranteed, seen, usedChars: seededChars } = seedGuaranteed(types, typeFragMap);
    const extras = collectExtras(types, typeFragMap, seen);
    extras.sort(byTemperature(workspace));

    const usedChars = fillWithinBudget(guaranteed, extras, {
      usedChars: seededChars, coreCharBudget
    });

    const coreFragments = [];
    for (const type of types) {
      const fragments = guaranteed.get(type) || [];
      coreFragments.push(...fragments);
    }

    return { typeFragMap, types, coreFragments, usedChars };
  }

  /**
   * 유형별로 병렬 회상하고, 직전 세션 요약을 별도로 덧붙인다.
   *
   * @returns {Promise<{typeFragMap: Map, types: string[]}>}
   */
  async #fetchByType(
    params, coreBudget, { agentId, keyId, groupKeyIds, workspace, allWorkspaces }
  ) {
    const types       = [...(params.types || ["preference", "error", "procedure", "decision"])];
    const typeFragMap = new Map();
    const scope       = {
      agentId,
      _keyId: keyId,
      _groupKeyIds: groupKeyIds,
      _isMaster: params._isMaster === true,
      workspace,
      allWorkspaces
    };

    await Promise.all(types.map(async type => {
      const result = await this.#recall({
        type,
        tokenBudget  : Math.max(250, Math.floor(coreBudget / types.length)),
        minImportance: 0.3,
        isAnchor     : false,
        ...scope
      });
      typeFragMap.set(type, result.fragments);
    }));

    /** 직전 세션 요약은 유형이 아니라 주제로 잡히므로 따로 부른다. */
    {
      const reflectResult = await this.#recall({
        topic        : "session_reflect",
        tokenBudget  : 300,
        minImportance: 0.3,
        isAnchor     : false,
        ...scope
      });
      if (reflectResult.fragments.length > 0) {
        typeFragMap.set("session_reflect", reflectResult.fragments);
        types.push("session_reflect");
      }
    }

    return { typeFragMap, types };
  }

  /**
   * Working Memory를 로드한다 (Redis, 최신순, 앵커 제외).
   *
   * @returns {{ wmFragments: object[], wmChars: number }}
   */
  async #loadWorkingMemory(params, workspace, allWorkspaces) {
    const wmBudget  = 800;
    let wmFragments = [];
    let wmChars     = 0;

    if (params.sessionId) {
      const wmScope = new SearchScope({ workspace, allWorkspaces });
      const wmItems = [...await this.#index.getWorkingMemory(params.sessionId)]
        /** 구버전 Redis entry는 workspace가 없어 안전하게 판정할 수 없다. */
        .filter(item => allWorkspaces || Object.hasOwn(item, "workspace"))
        .filter(item => wmScope.applyTo(item))
        .sort((a, b) => compareTimestampDescThenId(a, b, "added_at"));
      const wmCharBudget = wmBudget * 4;
      const maxWm        = MEMORY_CONFIG.contextInjection?.maxWmFragments || 10;

      for (const item of wmItems) {
        if (item.is_anchor) continue;
        if (wmFragments.length >= maxWm) break;
        const cost = (item.content || "").length;
        if (wmChars + cost > wmCharBudget) break;
        wmFragments.push(item);
        wmChars += cost;
      }
    }

    return { wmFragments, wmChars };
  }

  /**
   * Anchor Memory를 로드한다 (workspace 예약 후 잔여 통합 랭킹, 항상 포함).
   * 개수 상한은 contextInjection.maxAnchorFragments (env MEMENTO_CONTEXT_ANCHOR_LIMIT),
   * workspace 예약은 workspaceAnchorReserve가 제어한다.
   * 앵커는 토큰 예산 절삭 대상이 아니므로 이 상한이 유일한 주입량 제한이다.
   *
   * @param {string[]|null} groupKeyIds
   * @param {string|null} workspace - 지정 시 동일 workspace와 전역(NULL) 앵커만 허용
   * @returns {{fragments: object[], meta: object}}
   */
  async #loadAnchorMemory(groupKeyIds, workspace, allWorkspaces) {
    const maxAnchors = MEMORY_CONFIG.contextInjection?.maxAnchorFragments ?? 20;
    const reserve    = MEMORY_CONFIG.contextInjection?.workspaceAnchorReserve ?? 10;
    const empty = (failed = false) => selectAnchorFragments([], [], {
      limit: maxAnchors,
      reserve,
      workspaceApplied: workspace != null,
      workspaceCandidatesLoaded: !failed,
      globalCandidatesLoaded: !failed,
      unscopedCandidatesLoaded: !failed,
    });
    const publicResult = result => ({
      ...result,
      // workspace/created_at은 선택용 내부 필드다. 기존 anchor 응답 shape에는 노출하지 않는다.
      fragments: result.fragments.map(({ workspace: _workspace, created_at: _createdAt, ...fragment }) => fragment),
    });
    try {
      const pool = this.#getPool();
      // pgvector를 사용하지 않는 스토리지는 정상적인 빈 결과다.
      // 조회 실패와 구분해 partial/loadStatus를 성공 상태로 유지한다.
      if (!pool) return empty();
      const queryCandidates = async ({ workspaceValue, scope }) => {
        const anchorParams    = [];
        const anchorKeyFilter = keyScopeGroup(anchorParams, "key_id", groupKeyIds).trimStart();
        let anchorWorkspaceFilter;
        if (scope === "global") {
          anchorWorkspaceFilter = "AND workspace IS NULL";
        } else if (scope === "workspace") {
          anchorParams.push(workspaceValue);
          anchorWorkspaceFilter = `AND workspace = $${anchorParams.length}`;
        } else {
          // master의 명시적 allWorkspaces 조회만 필터 없는 후보 풀을 사용한다.
          anchorWorkspaceFilter = "";
        }
        anchorParams.push(maxAnchors);
        const result = await pool.query(
          `SELECT id, content, type, topic, importance, workspace, created_at,
                  COUNT(*) OVER() AS candidate_count
             FROM ${SCHEMA}.fragments
            WHERE is_anchor = TRUE
              AND valid_to IS NULL
              ${anchorKeyFilter}
              ${anchorWorkspaceFilter}
            ORDER BY importance DESC, created_at DESC NULLS LAST, id COLLATE "C" ASC
            LIMIT $${anchorParams.length}`,
          anchorParams
        );
        const candidateCount = Number(result.rows[0]?.candidate_count ?? result.rows.length);
        const fragments = result.rows.map(({ candidate_count: _candidateCount, ...fragment }) => fragment);
        return { fragments, candidateCount };
      };

      if (workspace == null) {
        const unscoped = await queryCandidates({
          scope: allWorkspaces ? "all" : "global"
        });
        return publicResult(selectAnchorFragments([], unscoped.fragments, {
          limit: maxAnchors,
          reserve,
          workspaceApplied: false,
          workspaceCandidateCount: 0,
          globalCandidateCount: 0,
          unscopedCandidateCount: unscoped.candidateCount,
        }));
      }
      const [workspaceSettled, globalSettled] = await Promise.allSettled([
        queryCandidates({ workspaceValue: workspace, scope: "workspace" }),
        queryCandidates({ scope: "global" }),
      ]);
      if (workspaceSettled.status === "rejected") {
        const reason = workspaceSettled.reason?.message ?? String(workspaceSettled.reason);
        logWarn(`[ContextBuilder] workspace anchor candidate load failed: ${reason}`);
      }
      if (globalSettled.status === "rejected") {
        const reason = globalSettled.reason?.message ?? String(globalSettled.reason);
        logWarn(`[ContextBuilder] global anchor candidate load failed: ${reason}`);
      }
      const workspaceResult = workspaceSettled.status === "fulfilled"
        ? workspaceSettled.value
        : { fragments: [], candidateCount: 0 };
      const globalResult = globalSettled.status === "fulfilled"
        ? globalSettled.value
        : { fragments: [], candidateCount: 0 };
      return publicResult(selectAnchorFragments(workspaceResult.fragments, globalResult.fragments, {
        limit: maxAnchors,
        reserve,
        workspaceApplied: true,
        workspaceCandidateCount: workspaceResult.candidateCount,
        globalCandidateCount: globalResult.candidateCount,
        workspaceCandidatesLoaded: workspaceSettled.status === "fulfilled",
        globalCandidatesLoaded: globalSettled.status === "fulfilled",
      }));
    } catch (err) {
      logWarn(`[ContextBuilder] anchor load failed: ${err.message}`);
    }
    return empty(true);
  }

  /**
   * non-anchor Learning 파편을 별도 섹션 후보로 로드한다 (Closed Learning Loop).
   */
  async #loadLearningFragments(agentId, keyId, workspace, allWorkspaces) {
    try {
      return await this.#store.searchBySource(
        "learning_extraction",
        agentId,
        keyId,
        5,
        { workspace, allWorkspaces, isAnchor: false }
      );
    } catch {
      return [];
    }
  }

  /**
   * 주입용 텍스트 라인 배열을 생성한다 (Anchor + Core + WM 분리).
   *
   * @returns {string[]}
   */
  async #buildInjectionLines(anchorFragments, coreFragments, learningFragments, wmFragments) {
    const lines = [];

    if (anchorFragments.length > 0) {
      lines.push("[ANCHOR MEMORY]");
      for (const f of anchorFragments) {
        lines.push(`- ${f.content}`);
      }
    }

    const coreSections = {};
    for (const f of coreFragments) {
      const key = f.type || "general";
      if (!coreSections[key]) coreSections[key] = [];
      coreSections[key].push(f.content);
    }

    if (Object.keys(coreSections).length > 0) {
      if (lines.length > 0) lines.push("");
      lines.push("[CORE MEMORY]");
      for (const [type, contents] of Object.entries(coreSections)) {
        lines.push(`[${type.toUpperCase()}]`);
        for (const c of contents) {
          lines.push(`- ${c}`);
        }
      }
    }

    if (learningFragments.length > 0) {
      if (lines.length > 0) lines.push("");
      lines.push("[LEARNING MEMORY]");
      for (const fragment of learningFragments) {
        lines.push(`- ${fragment.content}`);
      }
    }

    if (wmFragments.length > 0) {
      lines.push("");
      lines.push("[WORKING MEMORY]");
      for (const wm of wmFragments) {
        const label = wm.type ? `[${wm.type.toUpperCase()}]` : "";
        lines.push(`- ${label} ${wm.content}`);
      }
    }

    /** 미반영(unreflected) 세션 감지 힌트 */
    try {
      const { SessionActivityTracker } = await import("../processors/SessionActivityTracker.js");
      const unreflected = await SessionActivityTracker.getUnreflectedSessions(3);
      if (unreflected.length > 0) {
        lines.push("");
        lines.push("[SYSTEM HINT]");
        lines.push(`- 미반영 세션 ${unreflected.length}개 감지. 세션 종료 전 reflect()를 호출하면 학습 내용이 보존됩니다.`);
      }
    } catch { /* 무시 */ }

    return lines;
  }

  /**
   * structured=true 응답 객체를 생성한다.
   *
   * @returns {Object}
   */
  #buildStructuredResponse({
    coreFragments, wmFragments, anchorFragments, learningFragments,
    dedupResult, injectionText, ranked, totalTokens,
    anchorTokens, coreTokens, learningTokens, wmTokens,
    workspaceMode, anchorSelection
  }) {
    const coreByType = {};
    for (const f of coreFragments) {
      const key = f.type || "general";
      if (!coreByType[key]) coreByType[key] = [];
      coreByType[key].push(f);
    }

    const contextHint = buildContextHint(dedupResult, { mode: workspaceMode });

    return {
      success         : true,
      structured      : true,
      core            : {
        preferences: coreByType.preference || [],
        errors     : coreByType.error      || [],
        decisions  : coreByType.decision   || [],
        procedures : coreByType.procedure  || [],
        ...Object.fromEntries(
          Object.entries(coreByType)
            .filter(([k]) => !["preference", "error", "decision", "procedure"].includes(k))
        )
      },
      working         : {
        current_session: wmFragments
      },
      anchors         : {
        permanent: anchorFragments
      },
      learning        : {
        recent: learningFragments
      },
      fragments       : dedupResult,
      injectionText,
      totalTokens,
      count           : dedupResult.length,
      anchorTokens,
      coreTokens,
      learningTokens,
      wmTokens,
      wmCount         : wmFragments.length,
      anchorCount     : anchorFragments.length,
      learningCount   : learningFragments.length,
      _anchorSelection: anchorSelection,
      rankedInjection : ranked,
      ...(contextHint ? { _memento_hint: contextHint } : {})
    };
  }
}

/* 단위 테스트용 export */
export { buildContextHint, buildRankedInjection };
