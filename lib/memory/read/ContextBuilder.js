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

/**
 * context 응답에 포함할 힌트를 생성한다.
 * AI가 다음 행동을 능동적으로 결정할 수 있도록 signal + suggestion을 제공.
 */
function buildContextHint(fragments) {
  const errorFrags = fragments.filter(f => f.type === "error");
  if (errorFrags.length > 0) {
    return {
      signal    : "active_errors",
      suggestion: `미해결 에러 파편 ${errorFrags.length}개 있음. 이미 해결된 항목은 forget으로 정리하세요.`,
      trigger   : "forget"
    };
  }
  if (fragments.length === 0) {
    return {
      signal    : "empty_context",
      suggestion: "저장된 기억이 없습니다. 작업 후 reflect나 remember로 중요 내용을 저장하세요.",
      trigger   : "remember"
    };
  }
  return null;
}

/**
 * structured=true 전용: anchor 고정 상단 + 나머지 복합 점수 정렬 후 토큰 예산 내 슬라이스.
 * injectionText 중복 제거 목적 — structured 응답에서만 호출된다.
 *
 * @param {object[]} anchorFragments
 * @param {object[]} otherFragments   - core + working (anchor 제외)
 * @param {number}   tokenBudget
 * @param {{ importance: number, ema_activation: number }} weights
 * @param {string|null} [workspace]   - 지정 시 workspace 불일치·전역 파편의 정렬 우선순위를 감쇠
 * @returns {{ items: object[], totalTokens: number }}
 */
function buildRankedInjection(anchorFragments, otherFragments, tokenBudget, weights, workspace = null) {
  const { importance: wImp, ema_activation: wEma } = weights;
  const score  = f => ((f.importance ?? 0) * wImp + (f.ema_activation ?? 0) * wEma)
    * computeWorkspaceDecayFactor(f, workspace);
  const sorted = [...otherFragments].sort((a, b) => score(b) - score(a));

  const items      = [];
  let   usedTokens = 0;

  for (const f of anchorFragments) {
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

  for (const f of sorted) {
    const t = Math.ceil((f.content?.length ?? 0) / 4);
    if (usedTokens + t > tokenBudget) break;
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
    if (frags.length === 0) continue;
    const top = frags[0];
    guaranteed.set(type, [top]);
    seen.add(top.id);
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
      if (seen.has(frags[i].id)) continue;
      extras.push(frags[i]);
      seen.add(frags[i].id);
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

  return (a, b) => score(b) - score(a);
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
    const workspace   = params.workspace ?? params._defaultWorkspace ?? null;

    const { typeFragMap, types, coreFragments, usedChars } =
      await this.#loadCoreMemory(params, agentId, keyId, groupKeyIds, workspace);

    const { wmFragments, wmChars } = await this.#loadWorkingMemory(params);

    const anchorFragments = await this.#loadAnchorMemory(groupKeyIds, workspace);

    await this.#loadLearningFragments(typeFragMap, types, agentId, keyId);

    const lines = await this.#buildInjectionLines(anchorFragments, coreFragments, wmFragments);

    const anchorChars  = anchorFragments.reduce((s, f) => s + (f.content || "").length, 0);
    const coreTokens   = Math.ceil(usedChars / 4);
    const wmTokens     = Math.ceil(wmChars / 4);
    const anchorTokens = Math.ceil(anchorChars / 4);

    /** -- 중복 제거: 동일 ID 파편은 첫 등장만 유지 -- */
    const allFragments = [...anchorFragments, ...coreFragments, ...wmFragments];
    const dedupSeen    = new Set();
    const dedupResult  = [];
    for (const f of allFragments) {
      if (f.id && dedupSeen.has(f.id)) continue;
      if (f.id) dedupSeen.add(f.id);
      dedupResult.push(f);
    }

    /** -- Seen IDs 저장: recall() 중복 주입 방지용 -- */
    if (params.sessionId) {
      const seenIds = dedupResult.map(f => f.id).filter(Boolean);
      await this.#index.setSeenIds(params.sessionId, seenIds);
    }

    /** -- structured=true: 계층적 트리 구조 반환 -- */
    if (params.structured === true) {
      return this.#buildStructuredResponse({
        params, typeFragMap, coreFragments, wmFragments, anchorFragments,
        dedupResult, anchorTokens, coreTokens, wmTokens, workspace
      });
    }

    const contextHint = buildContextHint(dedupResult);
    return {
      fragments    : dedupResult,
      totalTokens  : anchorTokens + coreTokens + wmTokens,
      count        : dedupResult.length,
      anchorTokens,
      coreTokens,
      wmTokens,
      wmCount      : wmFragments.length,
      anchorCount  : anchorFragments.length,
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
  async #loadCoreMemory(params, agentId, keyId, groupKeyIds, workspace) {
    const coreBudget     = 1500;
    const coreCharBudget = coreBudget * 4;

    const { typeFragMap, types } = await this.#fetchByType(
      params, coreBudget, { agentId, keyId, groupKeyIds, workspace }
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
      coreFragments.push(...(guaranteed.get(type) || []));
    }

    return { typeFragMap, types, coreFragments, usedChars };
  }

  /**
   * 유형별로 병렬 회상하고, 직전 세션 요약을 별도로 덧붙인다.
   *
   * @returns {Promise<{typeFragMap: Map, types: string[]}>}
   */
  async #fetchByType(params, coreBudget, { agentId, keyId, groupKeyIds, workspace }) {
    const types       = [...(params.types || ["preference", "error", "procedure", "decision"])];
    const typeFragMap = new Map();
    const scope       = { agentId, _keyId: keyId, _groupKeyIds: groupKeyIds, workspace };

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
  async #loadWorkingMemory(params) {
    const wmBudget  = 800;
    let wmFragments = [];
    let wmChars     = 0;

    if (params.sessionId) {
      const wmItems      = (await this.#index.getWorkingMemory(params.sessionId)).reverse();
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
   * Anchor Memory를 로드한다 (중요도 순 상위 N개, 항상 포함).
   * 개수 상한은 contextInjection.maxAnchorFragments (env MEMENTO_CONTEXT_ANCHOR_LIMIT).
   * 앵커는 토큰 예산 절삭 대상이 아니므로 이 상한이 유일한 주입량 제한이다.
   *
   * @param {string[]|null} groupKeyIds
   * @param {string|null} workspace - 지정 시 동일 workspace와 전역(NULL) 앵커만 허용
   * @returns {object[]}
   */
  async #loadAnchorMemory(groupKeyIds, workspace) {
    let anchorFragments = [];
    try {
      const pool = this.#getPool();
      if (pool) {
        const anchorParams    = [];
        const anchorKeyFilter = keyScopeGroup(anchorParams, "key_id", groupKeyIds).trimStart();
        let anchorWorkspaceFilter = "";
        if (workspace != null) {
          anchorParams.push(workspace);
          anchorWorkspaceFilter = `AND (workspace = $${anchorParams.length} OR workspace IS NULL)`;
        }
        const maxAnchors = MEMORY_CONFIG.contextInjection?.maxAnchorFragments || 10;
        anchorParams.push(maxAnchors);
        const anchorResult = await pool.query(
          `SELECT id, content, type, topic, importance
             FROM ${SCHEMA}.fragments
            WHERE is_anchor = TRUE
              AND valid_to IS NULL
              ${anchorKeyFilter}
              ${anchorWorkspaceFilter}
            ORDER BY importance DESC
            LIMIT $${anchorParams.length}`,
          anchorParams
        );
        anchorFragments = anchorResult.rows;
      }
    } catch (err) {
      logWarn(`[ContextBuilder] anchor load failed: ${err.message}`);
    }
    return anchorFragments;
  }

  /**
   * Learning 파편을 typeFragMap에 주입한다 (Closed Learning Loop).
   * typeFragMap과 types를 직접 변이한다.
   */
  async #loadLearningFragments(typeFragMap, types, agentId, keyId) {
    try {
      const learningFrags = await this.#store.searchBySource("learning_extraction", agentId, keyId, 5);
      if (learningFrags.length > 0) {
        typeFragMap.set("learning", learningFrags);
        types.unshift("learning");
      }
    } catch { /* learning 로딩 실패 무시 */ }
  }

  /**
   * 주입용 텍스트 라인 배열을 생성한다 (Anchor + Core + WM 분리).
   *
   * @returns {string[]}
   */
  async #buildInjectionLines(anchorFragments, coreFragments, wmFragments) {
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
    params, typeFragMap, coreFragments, wmFragments, anchorFragments,
    dedupResult, anchorTokens, coreTokens, wmTokens, workspace
  }) {
    const coreByType = {};
    for (const f of coreFragments) {
      const key = f.type || "general";
      if (!coreByType[key]) coreByType[key] = [];
      coreByType[key].push(f);
    }

    const learningFragments = typeFragMap.get("learning") || [];

    const contextHint = buildContextHint(dedupResult);
    const rankWeights = MEMORY_CONFIG.contextInjection.rankWeights;
    const anchorIds   = new Set(anchorFragments.map(f => f.id));
    const otherFrags  = dedupResult.filter(f => !anchorIds.has(f.id));
    const ranked      = buildRankedInjection(
      anchorFragments, otherFrags,
      params.tokenBudget ?? MEMORY_CONFIG.contextInjection.defaultTokenBudget,
      rankWeights,
      workspace
    );

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
      totalTokens     : anchorTokens + coreTokens + wmTokens,
      count           : dedupResult.length,
      anchorTokens,
      coreTokens,
      wmTokens,
      wmCount         : wmFragments.length,
      anchorCount     : anchorFragments.length,
      rankedInjection : ranked,
      ...(contextHint ? { _memento_hint: contextHint } : {})
    };
  }
}

/* 단위 테스트용 export */
export { buildContextHint, buildRankedInjection };
