/**
 * SessionLinker — 세션 파편 통합, 자동 링크, 사이클 감지
 *
 * 작성자: 최진호
 * 작성일: 2026-03-12
 * 수정일: 2026-09-28 (DB 파편은 출처 참조로만 쓰고 Working Memory 전용 항목만 종합)
 */

import { logWarn, logInfo } from "../../logger.js";
import { linkSuggestMinOverlap, linkSuggestMinMargin, linkSuggestMax } from "../../config.js";
import { isFragmentInAgentScope, resolveAgentScope } from "../read/AgentScope.js";

/**
 * 작업 기억 항목 중 요청의 키와 에이전트 범위에 드는 것만 고른다. 키는 같아야 하고(키 없는
 * 요청은 key_id가 없는 항목), 에이전트는 요청 agent와 default다.
 *
 * @param {Object[]}    items
 * @param {string}      agentId
 * @param {string|null} keyId
 * @returns {Object[]}
 */
export function scopeWorkingMemoryItems(items, agentId, keyId) {
  const scope = resolveAgentScope({ agentId });
  return (items || []).filter(item =>
    (item.key_id ?? null) === (keyId ?? null) && isFragmentInAgentScope(item, scope));
}

/** 연결 제안 점수 산식 버전. 산식이 바뀌면 올린다. */
const LINK_SCORE_VERSION = "overlap-v2";

const round3 = (n) => Math.round(n * 1000) / 1000;

/**
 * 오류와 그 해결책(결정 또는 절차)을 잇는 공개 규약의 연결. link 도구는
 * "에러(fromId) → 해결책(toId)"를 resolved_by로 받는다.
 *
 * @param {string} errorId
 * @param {string} solutionId
 * @returns {{fromId: string, toId: string, relationType: "resolved_by"}}
 */
export function resolutionHint(errorId, solutionId) {
  return { fromId: errorId, toId: solutionId, relationType: "resolved_by" };
}

/**
 * 제안 후보의 올바른 연결. 오류–결정 후보(caused_by)는 관계 종류를 공개 규약에 맞춰 돌려준다.
 * 절차–오류 후보는 후보 자체가 오류→절차 resolved_by라 힌트가 없다.
 *
 * @param {string} relationType
 * @param {{id: string, type: string}} source
 * @param {{id: string, type: string}} target
 * @returns {{fromId: string, toId: string, relationType: "resolved_by"}|null}
 */
export function relationHintFor(relationType, source, target) {
  if (relationType === "caused_by" && source.type === "error" && target.type === "decision") {
    return resolutionHint(source.id, target.id);
  }
  return null;
}

/**
 * 두 파편의 겹침 점수(0~1)와 산출 근거를 돌려준다.
 * 양쪽에 키워드가 있으면 소문자·중복 제거한 키워드 집합의 교집합 / 작은 쪽 크기(basis "keyword_overlap"),
 * 한쪽이라도 비어 있으면 본문 토큰 집합으로 같은 식을 쓴다(basis "content_tokens").
 *
 * @param {{keywords?: string[], content?: string}} a
 * @param {{keywords?: string[], content?: string}} b
 * @returns {{score: number, basis: "keyword_overlap"|"content_tokens"}}
 */
export function overlapScore(a, b) {
  const kwA = Array.isArray(a.keywords) ? a.keywords : [];
  const kwB = Array.isArray(b.keywords) ? b.keywords : [];
  const ratio = (setA, setB) => {
    if (setA.size === 0 || setB.size === 0) return 0;
    let shared = 0;
    for (const t of setB) if (setA.has(t)) shared++;
    return shared / Math.min(setA.size, setB.size);
  };
  if (kwA.length > 0 && kwB.length > 0) {
    const norm = (list) => new Set(list.map(k => String(k).toLowerCase()));
    return { score: ratio(norm(kwA), norm(kwB)), basis: "keyword_overlap" };
  }
  const tokenize = (s) =>
    new Set((s || "").toLowerCase().split(/[\s,;:!?()[\]{}"']+/).filter(t => t.length > 1));
  return { score: ratio(tokenize(a.content), tokenize(b.content)), basis: "content_tokens" };
}

export class SessionLinker {
  /**
   * @param {import("../write/FragmentStore.js").FragmentStore}  store
   * @param {import("../FragmentIndex.js").FragmentIndex}  index
   */
  constructor(store, index) {
    this.store = store;
    this.index = index;
  }

  /**
   * 세션의 파편들을 workspace → case_id → topic 우선순위 경계로 그룹핑하여
   * 그룹별 요약 구조 배열을 반환한다.
   *
   * topic은 비정규·누락 가능한 분류 경계일 뿐 보안 경계로 취급하지 않는다.
   * 세션 집합의 DB 파편은 이미 영속화된 것이므로 내용을 다시 종합하지 않고
   * sourceFragmentIds로만 남긴다. 새로 저장할 내용은 대응 DB 파편이 없는
   * Working Memory 항목에서만 나온다. 대응 DB 파편이 있는 Working Memory 항목은
   * 그 파편의 그룹에 wmItemIds로만 편입된다. 각 그룹이 실제로 소비한 Working
   * Memory 항목 id는 wmItemIds로 반환되어 호출자가 해당 항목만 선택적으로 evict할
   * 수 있게 한다.
   *
   * error 항목은 내용이 [해결됨]으로 시작할 때만 errors_resolved로 분류한다.
   * 그 외 error는 errors_open으로 분류한다.
   *
   * 작업 기억 항목은 세션 ID가 같아도 호출한 키(키가 없으면 키 없는 항목)와 에이전트
   * 범위(해당 agent와 default)의 것만 종합한다. 다른 키의 항목은 종합하지도 evict하지도 않는다.
   *
   * @param {string}      sessionId
   * @param {string}      agentId
   * @param {string|null} keyId
   * @returns {Promise<Array<object>|null>}
   */
  async consolidateSessionFragments(sessionId, agentId = "default", keyId = null) {
    const ids     = await this.index.getSessionFragments(sessionId);
    const wmItems = scopeWorkingMemoryItems(await this.index.getWorkingMemory(sessionId), agentId, keyId);

    const rows = ids?.length > 0 ? await this.store.getByIds(ids, agentId, keyId) : [];
    if (!rows.length && !wmItems.length) return null;

    const rowById = new Map((rows || []).map(r => [r.id, r]));
    const groupsByKey = new Map();

    const groupKey = (workspace, caseId, topic) =>
      `${workspace ?? "__none__"}::${caseId || topic || "__none__"}`;

    const ensureGroup = (workspace, caseId, topic) => {
      const key = groupKey(workspace, caseId, topic);
      let group = groupsByKey.get(key);
      if (!group) {
        group = {
          workspace        : workspace ?? null,
          caseId           : caseId ?? null,
          topic            : topic ?? null,
          decisions        : [],
          errorsResolved   : [],
          errorsOpen       : [],
          procedures       : [],
          openQuestions    : [],
          summaryParts     : [],
          sourceFragmentIds: [],
          wmItemIds        : []
        };
        groupsByKey.set(key, group);
      }
      return group;
    };

    const classify = (group, rawContent, type) => {
      const content = (rawContent || "").trim();
      if (!content) return;

      switch (type) {
        case "decision":
          group.decisions.push(content.replace(/^\[해결됨\]\s*/i, "").trim());
          break;
        case "error":
          if (/^\[해결됨\]/.test(content)) {
            group.errorsResolved.push(content.replace(/^\[해결됨\]\s*/, "").trim());
          } else {
            group.errorsOpen.push(content);
          }
          break;
        case "procedure":
          group.procedures.push(content);
          break;
        case "fact":
          if (content.includes("[미해결]")) {
            group.openQuestions.push(content.replace(/^\[미해결\]\s*/i, "").trim());
          } else {
            group.summaryParts.push(content);
          }
          break;
        default:
          group.summaryParts.push(content);
      }
    };

    for (const r of rows) {
      ensureGroup(r.workspace, r.case_id, r.topic).sourceFragmentIds.push(r.id);
    }

    for (const w of (wmItems || [])) {
      const row = w.id ? rowById.get(w.id) : null;
      if (row) {
        /** DB 파편으로 이미 반영된 항목 — 내용 중복 없이 evict 대상 id만 편입 */
        const group = ensureGroup(row.workspace, row.case_id, row.topic);
        if (w.id) group.wmItemIds.push(w.id);
        continue;
      }
      const group = ensureGroup(w.workspace ?? null, null, w.topic ?? null);
      classify(group, w.content, w.type || "fact");
      if (w.id) group.wmItemIds.push(w.id);
    }

    const groups = [];
    for (const group of groupsByKey.values()) {
      const summary = group.summaryParts.length > 0
        ? `세션 ${sessionId.substring(0, 8)}... 종합: ${group.summaryParts.join(" ")}`
        : null;

      const hasNewContent = !!summary || group.decisions.length > 0 ||
        group.errorsResolved.length > 0 || group.errorsOpen.length > 0 ||
        group.procedures.length > 0 || group.openQuestions.length > 0;

      /** 새 내용도 evict할 WM 항목도 없는 그룹은 이미 영속화된 파편뿐이다. */
      if (!hasNewContent && group.wmItemIds.length === 0) continue;

      groups.push({
        workspace        : group.workspace,
        caseId           : group.caseId,
        topic            : group.topic,
        summary,
        decisions        : [...new Set(group.decisions)],
        errors_resolved  : [...new Set(group.errorsResolved)],
        errors_open      : [...new Set(group.errorsOpen)],
        new_procedures   : [...new Set(group.procedures)],
        open_questions   : [...new Set(group.openQuestions)],
        sourceFragmentIds: group.sourceFragmentIds,
        wmItemIds        : [...new Set(group.wmItemIds)]
      });
    }

    return groups.length > 0 ? groups : null;
  }

  /**
   * 세션 파편 간 규칙 기반 자동 link 생성 (Phase 5: 배치 처리)
   *
   * candidate 페어를 sortedKey 사전식 오름차순으로 정렬하여 데드락을 회피한다.
   * wouldCreateCycle 결과는 Map 캐시로 중복 호출을 방지하고,
   * cycle을 통과한 페어 전체를 createLinks 단일 호출로 삽입한다.
   *
   * @param {Array}       fragments - reflect에서 저장된 파편 목록 [{id, type, ...}]
   * @param {string}      agentId
   * @param {string|null} keyId     - API 키 격리 (null: 마스터). cycle 검증 시 cross-tenant 경로 차단
   * @param {Object}      [opts]
   * @param {Map<string, number>} [opts.groupOf]   - 파편 id → 그룹 번호. 있으면 같은 그룹 안에서만 짝을 찾고 제안 상한도 그룹별로 센다
   * @param {number}      [opts.minOverlap]        - 제안 최소 겹침(기본 MEMENTO_LINK_SUGGEST_MIN_OVERLAP)
   * @param {number}      [opts.minMargin]         - 1위와 2위의 최소 점수 차이(기본 MEMENTO_LINK_SUGGEST_MIN_MARGIN)
   * @param {number}      [opts.maxSuggestions]    - 그룹당 제안 상한, 0이면 제한 없음(기본 MEMENTO_LINK_SUGGEST_MAX)
   * @returns {Promise<{linkedCount: number, linkSuggestions: Object[], linkSuggestionsOmitted: number}>}
   */
  async autoLinkSessionFragments(fragments, agentId = "default", keyId = null, opts = {}) {
    const errors     = fragments.filter(f => f.type === "error");
    const decisions  = fragments.filter(f => f.type === "decision");
    const procedures = fragments.filter(f => f.type === "procedure");

    const minOverlap = opts.minOverlap     ?? linkSuggestMinOverlap();
    const minMargin  = opts.minMargin      ?? linkSuggestMinMargin();
    const maxPerGrp  = opts.maxSuggestions ?? linkSuggestMax();
    const groupOf    = opts.groupOf instanceof Map ? opts.groupOf : null;

    /** 겹침 점수. 계산식은 overlapScore에 있고, 임계값은 아래 schemaFit과 제안 기준이 각각 건다. */
    const keywordOverlap = (a, b) => overlapScore(a, b).score;

    /** 그룹 정보가 있으면 같은 그룹의 파편끼리만 짝을 짓는다. 어느 쪽이든 그룹을 모르면 막지 않는다. */
    const sameGroup = (a, b) => {
      if (!groupOf) return true;
      const ga = groupOf.get(a.id);
      const gb = groupOf.get(b.id);
      return ga === undefined || gb === undefined || ga === gb;
    };

    /**
     * phase 전환 정합성 검사.
     * planning → debugging → verification 단방향만 허용.
     * phase 없으면 무조건 통과. reflect가 넘기는 파편 객체에는 phase가 없어 reflect 경로에서는 항상 통과한다.
     */
    const PHASE_ORDER = { planning: 0, debugging: 1, implementation: 1, verification: 2 };
    const phaseOk = (from, to) => {
      const pf = PHASE_ORDER[from?.phase];
      const pt = PHASE_ORDER[to?.phase];
      if (pf === undefined || pt === undefined) return true;
      return pf <= pt;
    };

    /**
     * schema-fit gate.
     * (a) 동일 caseId 또는 동일 sessionId
     * (b) 키워드 60%+ 오버랩
     * (c) phase 전환 단방향 정합
     * 셋을 모두 만족해야 통과한다(하나라도 실패하면 미통과).
     * reflect가 넘기는 파편 객체에는 caseId와 sessionId가 없어 reflect 경로에서는 (a)가 항상 실패하고
     * 모든 후보가 연결 제안으로 간다. 자동 연결은 caseId나 sessionId를 실어 부르는 호출에서만 일어난다.
     */
    const schemaFit = (from, to) => {
      // (a) caseId 또는 sessionId 인접
      const sameCase    = from.caseId && to.caseId && from.caseId === to.caseId;
      const sameSession = from.sessionId && to.sessionId && from.sessionId === to.sessionId;
      if (!sameCase && !sameSession) return false;

      // (b) 키워드 오버랩
      if (keywordOverlap(from, to) < 0.6) return false;

      // (c) phase 정합
      if (!phaseOk(from, to)) return false;

      return true;
    };

    /**
     * 1단계: errors×decisions → 각 error에 대해 top-1 decisions 매칭 (caused_by).
     *        errors×procedures → 각 procedure에 대해 top-1 errors 매칭 (resolved_by).
     * 곱집합 자동 생성 대신 1:1 매칭으로 교체하여 misgrouping 차단.
     * top-1은 점수 내림차순, 동점은 id 오름차순으로 정한다. schema-fit을 통과하면 자동 연결,
     * 아니면 겹침이 minOverlap 이상이고(minMargin이 있으면 2위와 차이도 충분할 때) 제안으로 올린다.
     */
    const autoLinks       = [];  // schema-fit 통과 → 즉시 생성
    let   linkSuggestions = [];  // schema-fit 미통과 → _meta 위임
    let   candidateCount  = 0;

    const consider = (source, targets, relationType) => {
      const ranked = targets
        .filter(t => sameGroup(source, t))
        .map(t => ({ target: t, ...overlapScore(source, t) }))
        .sort((x, y) => (y.score - x.score) || (x.target.id < y.target.id ? -1 : x.target.id > y.target.id ? 1 : 0));
      if (ranked.length === 0) return;

      const [best, second] = ranked;
      candidateCount++;
      /** resolved_by는 "에러(fromId) → 해결책(toId)"다. 절차–오류 쌍은 오류가 시작점이다. */
      const candidate = relationType === "resolved_by"
        ? { fromId: best.target.id, toId: source.id, relationType }
        : { fromId: source.id, toId: best.target.id, relationType };
      if (schemaFit(source, best.target)) {
        autoLinks.push(candidate);
        return;
      }
      if (best.score < minOverlap) return;
      const margin = second ? best.score - second.score : null;
      if (minMargin > 0 && margin !== null && margin < minMargin) return;
      const hint = relationHintFor(relationType, source, best.target);
      linkSuggestions.push({
        ...candidate,
        reason: "schema_fit_failed",
        meta  : {
          score       : round3(best.score),
          margin      : margin === null ? null : round3(margin),
          signals     : [best.basis],
          scoreVersion: LINK_SCORE_VERSION,
          ...(hint ? { relationHint: hint } : {})
        }
      });
    };

    for (const err of errors)     consider(err,  decisions, "caused_by");
    for (const proc of procedures) consider(proc, errors,    "resolved_by");

    /** 제안 상한: 그룹별로 점수가 높은 순서대로 남긴다. */
    linkSuggestions.sort((x, y) => (y.meta.score - x.meta.score) || (x.fromId < y.fromId ? -1 : x.fromId > y.fromId ? 1 : 0));
    let omitted = 0;
    if (maxPerGrp > 0) {
      const perGroup = new Map();
      linkSuggestions = linkSuggestions.filter(sug => {
        const key = groupOf?.get(sug.fromId) ?? "_";
        const n   = perGroup.get(key) ?? 0;
        if (n >= maxPerGrp) { omitted++; return false; }
        perGroup.set(key, n + 1);
        return true;
      });
    }

    /**
     * 2단계: sortedKey 부여 → 사전식 오름차순 정렬.
     * 데드락 회피의 본질적 수단.
     */
    const withKey = autoLinks.map(p => {
      const minId = p.fromId < p.toId ? p.fromId : p.toId;
      const maxId = p.fromId < p.toId ? p.toId   : p.fromId;
      return { ...p, sortedKey: `${minId}|${maxId}` };
    });
    withKey.sort((a, b) => a.sortedKey < b.sortedKey ? -1 : a.sortedKey > b.sortedKey ? 1 : 0);

    /**
     * 3단계: wouldCreateCycle Map 캐시 적용.
     */
    const cycleCache = new Map();
    const validPairs = [];

    for (const pair of withKey) {
      const cacheKey = `${pair.fromId}->${pair.toId}`;
      let   isCycle;
      if (cycleCache.has(cacheKey)) {
        isCycle = cycleCache.get(cacheKey);
      } else {
        isCycle = await this.wouldCreateCycle(pair.fromId, pair.toId, agentId, keyId);
        cycleCache.set(cacheKey, isCycle);
      }
      if (!isCycle) {
        validPairs.push({ fromId: pair.fromId, toId: pair.toId, relationType: pair.relationType });
      }
    }

    /**
     * 4단계: createLinks 단일 트랜잭션 호출.
     * 부분 실패 시 전체 롤백 후 단건 createLink fallback.
     */
    if (validPairs.length > 0) {
      try {
        await this.store.createLinks(validPairs, agentId);
      } catch (batchErr) {
        logWarn(`[SessionLinker] batch link creation failed (${batchErr.message}), falling back to individual createLink`);
        for (const pair of validPairs) {
          await this.store.createLink(pair.fromId, pair.toId, pair.relationType, agentId).catch((e) => {
            logWarn(`[SessionLinker] fallback single link creation failed: ${e.message}`);
          });
        }
      }
    }

    if (candidateCount > 0) logInfo(`[SessionLinker] link candidates=${candidateCount} auto=${validPairs.length} suggested=${linkSuggestions.length} omitted=${omitted} minOverlap=${minOverlap}`);
    return { linkedCount: validPairs.length, linkSuggestions, linkSuggestionsOmitted: omitted };
  }

  /**
   * A → B 링크 생성 시 순환 참조 발생 여부 확인 (B → A 경로 존재 시 true)
   * 재귀 CTE 단일 쿼리로 판정 (최대 20홉)
   *
   * keyId가 제공되면 LinkStore.isReachable이 동일 테넌트(또는 master NULL)
   * 경로만 탐색한다. cross-tenant fragment를 경유한 cycle path가 탐지되어
   * 링크 생성이 차단되는 보안 결함을 방지한다.
   *
   * @param {string}      fromId
   * @param {string}      toId
   * @param {string}      agentId
   * @param {string|null} keyId  - API 키 격리 (null: master 전체 경로)
   * @returns {Promise<boolean>}
   */
  async wouldCreateCycle(fromId, toId, agentId = "default", keyId = null) {
    try {
      return await this.store.isReachable(toId, fromId, agentId, keyId);
    } catch (err) {
      logWarn(`[SessionLinker] Cycle detection failed: ${err.message}`);
      return false;
    }
  }
}
