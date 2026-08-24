/**
 * SessionLinker — 세션 파편 통합, 자동 링크, 사이클 감지
 *
 * 작성자: 최진호
 * 작성일: 2026-03-12
 * 수정일: 2026-08-15 (consolidateSessionFragments workspace→case_id→topic 그룹 배열 반환으로 확장)
 */

import { logWarn } from "../../logger.js";

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
   * Working Memory 항목은 대응하는 DB 파편(id 일치)이 있으면 그 그룹에 편입되고,
   * 없으면 자신의 topic만으로 별도 그룹에 귀속된다. 각 그룹이 실제로 소비한
   * Working Memory 항목 id는 wmItemIds로 반환되어 호출자가 해당 항목만 선택적으로
   * evict할 수 있게 한다.
   *
   * @param {string}      sessionId
   * @param {string}      agentId
   * @param {string|null} keyId
   * @returns {Promise<Array<object>|null>}
   */
  async consolidateSessionFragments(sessionId, agentId = "default", keyId = null, groupKeyIds = [], workspace = null) {
    if (keyId != null && (workspace == null || !Array.isArray(groupKeyIds) || groupKeyIds.length === 0)) {
      return null;
    }
    const ids     = await this.index.getSessionFragments(sessionId);
    const wmItems = await this.index.getWorkingMemory(sessionId, { keyId, workspace });

    const strictScope = workspace != null;
    const rows = ids?.length > 0
      ? await this.store.getByIds(ids, agentId, keyId, groupKeyIds, {
        strictScope,
        workspace
      })
      : [];
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
          group.errorsResolved.push(content.replace(/^\[해결됨\]\s*/i, "").trim());
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
      const group = ensureGroup(r.workspace, r.case_id, r.topic);
      classify(group, r.content, r.type);
      group.sourceFragmentIds.push(r.id);
    }

    for (const w of (wmItems || [])) {
      if (strictScope && (w.key_id !== keyId || w.workspace !== workspace)) continue;
      const row = w.id ? rowById.get(w.id) : null;
      if (row) {
        /** DB 파편으로 이미 반영된 항목 — 내용 중복 없이 evict 대상 id만 편입 */
        const group = ensureGroup(row.workspace, row.case_id, row.topic);
        if (w.id) group.wmItemIds.push(w.id);
        continue;
      }
      const group = ensureGroup(null, null, w.topic ?? null);
      classify(group, w.content, w.type || "fact");
      if (w.id) group.wmItemIds.push(w.id);
    }

    const groups = [];
    for (const group of groupsByKey.values()) {
      const summary = group.summaryParts.length > 0
        ? `세션 ${sessionId.substring(0, 8)}... 종합: ${group.summaryParts.join(" ")}`
        : (group.decisions.length || group.errorsResolved.length || group.procedures.length
          ? `세션 ${sessionId.substring(0, 8)}... 종합: 결정 ${group.decisions.length}건, 에러 해결 ${group.errorsResolved.length}건, 절차 ${group.procedures.length}건`
          : null);

      if (!summary && !group.decisions.length && !group.errorsResolved.length &&
          !group.procedures.length && !group.openQuestions.length) {
        continue;
      }

      groups.push({
        workspace        : group.workspace,
        caseId           : group.caseId,
        topic            : group.topic,
        summary,
        decisions        : [...new Set(group.decisions)],
        errors_resolved  : [...new Set(group.errorsResolved)],
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
   */
  async autoLinkSessionFragments(fragments, agentId = "default", keyId = null, groupKeyIds = [], workspace = null) {
    if (keyId != null
        && (workspace == null || !Array.isArray(groupKeyIds) || groupKeyIds.length === 0)) {
      return { linkedCount: 0, linkSuggestions: [] };
    }
    const requestedGroups = [...new Set(groupKeyIds)].sort();
    const hasExactGroups = (fragment) => {
      if (keyId == null || requestedGroups.length === 0) return true;
      const actualGroups = fragment.group_key_ids ?? fragment.groupKeyIds;
      if (!Array.isArray(actualGroups)) return false;
      const actual = [...new Set(actualGroups)].sort();
      return actual.length === requestedGroups.length
        && actual.every((groupId, index) => groupId === requestedGroups[index]);
    };
    const scopedFragments = workspace != null
      ? fragments.filter(fragment => fragment.key_id === keyId
          && fragment.workspace === workspace
          && hasExactGroups(fragment))
      : fragments;
    const errors     = scopedFragments.filter(f => f.type === "error");
    const decisions  = scopedFragments.filter(f => f.type === "decision");
    const procedures = scopedFragments.filter(f => f.type === "procedure");

    /**
     * keywords 60%+ 오버랩 계산.
     * 한쪽 keywords가 비어 있으면 content 토큰 매치로 fallback.
     */
    const keywordOverlap = (a, b) => {
      const kwA = Array.isArray(a.keywords) ? a.keywords : [];
      const kwB = Array.isArray(b.keywords) ? b.keywords : [];
      if (kwA.length > 0 && kwB.length > 0) {
        const setA   = new Set(kwA.map(k => k.toLowerCase()));
        const shared = kwB.filter(k => setA.has(k.toLowerCase())).length;
        const denom  = Math.min(kwA.length, kwB.length);
        return shared / denom;
      }
      // content 토큰 fallback
      const tokenize = (s) =>
        (s || "").toLowerCase().split(/[\s,;:!?()[\]{}"']+/).filter(t => t.length > 1);
      const tA   = new Set(tokenize(a.content));
      const tB   = tokenize(b.content);
      if (tA.size === 0 || tB.length === 0) return 0;
      const matchCount = tB.filter(t => tA.has(t)).length;
      return matchCount / Math.min(tA.size, tB.length);
    };

    /**
     * phase 전환 정합성 검사.
     * planning → debugging → verification 단방향만 허용.
     * phase 없으면 무조건 통과.
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
     * 셋 중 하나라도 실패하면 미통과.
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
     */
    const autoLinks       = [];  // schema-fit 통과 → 즉시 생성
    const linkSuggestions = [];  // schema-fit 미통과 → _meta 위임

    // errors → decisions caused_by (각 error에서 top-1 decision)
    for (const err of errors) {
      let bestDec   = null;
      let bestScore = -1;
      for (const dec of decisions) {
        const score = keywordOverlap(err, dec);
        if (score > bestScore) { bestScore = score; bestDec = dec; }
      }
      if (!bestDec) continue;

      const candidate = { fromId: err.id, toId: bestDec.id, relationType: "caused_by" };
      if (schemaFit(err, bestDec)) {
        autoLinks.push(candidate);
      } else {
        linkSuggestions.push({ ...candidate, reason: "schema_fit_failed" });
      }
    }

    // procedures → errors resolved_by (각 procedure에서 top-1 error)
    for (const proc of procedures) {
      let bestErr   = null;
      let bestScore = -1;
      for (const err of errors) {
        const score = keywordOverlap(proc, err);
        if (score > bestScore) { bestScore = score; bestErr = err; }
      }
      if (!bestErr) continue;

      const candidate = { fromId: proc.id, toId: bestErr.id, relationType: "resolved_by" };
      if (schemaFit(proc, bestErr)) {
        autoLinks.push(candidate);
      } else {
        linkSuggestions.push({ ...candidate, reason: "schema_fit_failed" });
      }
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

    return { linkedCount: validPairs.length, linkSuggestions };
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
