/**
 * ReflectProcessor -- reflect() 로직 전담 모듈
 *
 * 작성자: 최진호
 * 작성일: 2026-04-05
 * 수정일: 2026-08-15 (sessionId 종합 경로를 workspace→case_id→topic 그룹 루프로 전환,
 *                    WM 부분 evict, 그룹별 episode 생성)
 *
 * MemoryManager.reflect() 220줄 본문을 추출.
 * summary / decisions / errors_resolved / new_procedures / open_questions를
 * 파편으로 변환·저장하고, episode 생성 및 Working Memory 정리를 수행한다.
 *
 * Phase 1 변경:
 *   기존: 5개 카테고리를 카테고리별 _insertAll로 직렬 await
 *         (_insertAll은 store.insert + index.index를 행마다 Promise.allSettled)
 *   변경: 5개 카테고리를 단일 validFragments[] 배열로 합쳐
 *         batchRememberProcessor.process()에 일괄 위임.
 *         각 항목에 _category 메타를 부여해 결과를 카테고리별로 재집계하여
 *         기존 breakdown shape(summary/decisions/errors/procedures/questions) 보존.
 *
 * 그룹 루프 변경:
 *   sessionId가 있으면 SessionLinker.consolidateSessionFragments가 반환하는
 *   workspace→case_id→topic 그룹 배열을 기준으로 그룹마다 카테고리 파편과
 *   episode를 각각 생성한다. 호출자가 명시한 summary/decisions/... params는
 *   호출자 자신의 workspace와 일치하는 그룹(primary)에만 채워지며, 다른
 *   workspace의 그룹은 세션 종합 내용을 그대로 사용한다. 파편의 workspace는
 *   그룹에서 상속하되 params.workspace가 명시되면 그것이 최우선이다.
 */

import { MEMORY_CONFIG }                       from "../../../config/memory.js";
import { pushToQueuePriority }                 from "../../redis.js";
import { logWarn, logInfo }                    from "../../logger.js";
import { MorphemeIndex }                       from "../embedding/MorphemeIndex.js";
import { linkEpisodeMilestone }                from "./EpisodeContinuityService.js";
import { getPrimaryPool }                      from "../../tools/db.js";

const morphemeIndex = new MorphemeIndex();

const REFLECT_ITEM_MIN_LEN     = 20;
const REFLECT_ITEM_MIN_LEN_KOR = 10;
const META_PREFIXES = ["이것", "그것", "위", "이번", "해당", "재작성을 통해"];
const HAS_KOREAN    = /[가-힣ㄱ-ㅎㅏ-ㅣ]/;

/**
 * reflect 배열 항목이 단독 파편으로 저장할 가치가 있는지 판정한다.
 * 한글 포함 항목은 길이 2자 이상, 비한글(영문 등)은 20자 이상이어야 통과.
 * 대명사/메타 표현으로 시작하는 항목은 길이와 무관하게 차단.
 * @param {string} item
 * @returns {boolean}
 */
export function isSelfContainedReflectItem(item) {
  if (!item || typeof item !== "string") return false;
  const t      = item.trim();
  const minLen = HAS_KOREAN.test(t) ? REFLECT_ITEM_MIN_LEN_KOR : REFLECT_ITEM_MIN_LEN;
  if (t.length < minLen) return false;
  return !META_PREFIXES.some(p => t.startsWith(p));
}

const TASK_OUTCOMES        = ["completed", "partial", "blocked", "abandoned", "unknown"];
const TASK_EVALUATORS      = ["agent", "automatic", "human"];
const EVIDENCE_MAX_LEN     = 1000;
const UNMET_MAX_ITEMS      = 20;
const UNMET_ITEM_MAX_LEN   = 200;

/**
 * reflect의 task_effectiveness를 task_feedback 컬럼 형태로 정규화한다.
 *
 * outcome이 허용 목록 밖이면 추정하지 않고 null로 떨어뜨린다(자기보고 편향 차단).
 * evaluator는 outcome이 있을 때에만 기본값 "agent"를 부여하여, 판정이 없는 행에
 * 평가 주체만 남는 상태를 만들지 않는다.
 *
 * @param {Object} [effectiveness] reflect params.task_effectiveness
 * @returns {{ outcome: string|null, evaluator: string|null, evidence: string|null,
 *             unmetRequirements: string[], overallSuccess: boolean }}
 */
export function normalizeTaskEffectiveness(effectiveness) {
  const src = effectiveness && typeof effectiveness === "object" ? effectiveness : {};

  const outcome = TASK_OUTCOMES.includes(src.outcome) ? src.outcome : null;

  let evaluator = null;
  if (outcome !== null) {
    evaluator = TASK_EVALUATORS.includes(src.evaluator) ? src.evaluator : "agent";
  }

  let evidence = null;
  if (typeof src.evidence === "string") {
    const trimmed = src.evidence.trim();
    if (trimmed.length > 0) evidence = trimmed.substring(0, EVIDENCE_MAX_LEN);
  }

  const unmetRequirements = Array.isArray(src.unmet_requirements)
    ? src.unmet_requirements
        .filter(item => typeof item === "string" && item.trim().length > 0)
        .slice(0, UNMET_MAX_ITEMS)
        .map(item => item.trim().substring(0, UNMET_ITEM_MAX_LEN))
    : [];

  let overallSuccess;
  if (typeof src.overall_success === "boolean") {
    overallSuccess = src.overall_success;
  } else if (outcome !== null) {
    overallSuccess = outcome === "completed";
  } else {
    overallSuccess = false;
  }

  return { outcome, evaluator, evidence, unmetRequirements, overallSuccess };
}

export class ReflectProcessor {
  /**
   * @param {Object} deps
   *   - store                 {FragmentStore}
   *   - index                 {FragmentIndex}
   *   - factory               {FragmentFactory}
   *   - sessionLinker         {SessionLinker}
   *   - remember              {Function} MemoryManager.remember 바인딩
   *   - batchRememberProcessor {BatchRememberProcessor}
   */
  constructor({ store, index, factory, sessionLinker, remember, batchRememberProcessor }) {
    this.store                  = store;
    this.index                  = index;
    this.factory                = factory;
    this.sessionLinker          = sessionLinker;
    this.remember               = remember;
    this.batchRememberProcessor = batchRememberProcessor ?? null;

    /**
     * 형태소 등록 drain용 Promise Set.
     * drainMorpheme()으로 테스트/graceful shutdown 시 전체 완료 대기 가능.
     */
    this._morphemePromises = new Set();
  }

  /**
   * reflect 메인 로직 실행
   *
   * @param {Object} params - reflect 파라미터 전체
   * @returns {Object} { fragments, count, breakdown, groups }
   */
  async process(params) {
    const fragments         = [];
    const sessionSrc        = `session:${params.sessionId || "unknown"}`;
    const agentId           = params.agentId || "default";
    const keyId             = params._keyId ?? null;
    const groupKeyIds       = Array.isArray(params._groupKeyIds)
      ? [...new Set(params._groupKeyIds)]
      : [];
    const explicitWorkspace = params.workspace ?? null;
    const defaultWorkspace  = params._defaultWorkspace ?? null;
    const scopeWorkspace     = explicitWorkspace ?? defaultWorkspace ?? null;
    const breakdown         = { summary: 0, decisions: 0, errors: 0, procedures: 0, questions: 0 };

    /** 인증 키가 있는 세션은 완전한 scope 없이는 master/unrestricted reflect를 하지 않는다. */
    if (keyId != null && params.sessionId
        && (scopeWorkspace == null || groupKeyIds.length === 0)) {
      return { fragments: [], count: 0, breakdown, groups: [], _link_suggestions: [] };
    }

    /** 0. sessionId가 있으면 세션 파편을 workspace→case_id→topic 경계로 그룹핑해 종합 */
    let sessionGroups = null;
    if (params.sessionId) {
      sessionGroups = await this.sessionLinker.consolidateSessionFragments(
        params.sessionId, agentId, keyId, groupKeyIds, scopeWorkspace
      );
      /** A scoped reflect may only consume groups from the requested workspace. */
      if (scopeWorkspace != null && Array.isArray(sessionGroups)) {
        sessionGroups = sessionGroups.filter(group => group.workspace === scopeWorkspace);
      }
    }

    const groups = this._resolveGroups(params, explicitWorkspace, defaultWorkspace, sessionGroups);

    /**
     * 1~5. 그룹마다 5개 카테고리 파편을 단일 validFragments 배열로 조합.
     * 각 항목에 _category와 _groupIndex 메타를 부여해 batchRememberProcessor
     * 위임 후 카테고리별·그룹별로 재집계.
     */
    const allFragmentItems = [];

    for (let gi = 0; gi < groups.length; gi++) {
      const g         = groups[gi];
      const topic     = g.topic || "session_reflect";
      const workspace = explicitWorkspace ?? g.workspace ?? defaultWorkspace ?? null;

      /** 1. summary -> fact 파편 (배열 또는 문자열 모두 처리) */
      if (g.summary) {
        const summaryItems = Array.isArray(g.summary)
          ? g.summary.filter(s => s && s.trim().length > 0)
          : this.factory.splitAndCreate(g.summary, {
              topic, type: "fact", source: sessionSrc, agentId
            }).map(f => f.content);

        for (const item of summaryItems) {
          const f = this.factory.create({
            content   : item.trim ? item.trim() : item,
            topic,
            type      : "fact",
            source    : sessionSrc,
            agentId,
            sessionId : params.sessionId,
            caseId    : g.caseId ?? undefined,
          });
          f.agent_id  = agentId;
          f.key_id    = keyId;
          f.group_key_ids = [...groupKeyIds];
          f.workspace = workspace;
          allFragmentItems.push({ f, _category: "summary", _groupIndex: gi });
        }
        breakdown.summary += summaryItems.length;
      }

      /** 2. decisions -> decision 파편 */
      if (g.decisions && g.decisions.length > 0) {
        const valid   = g.decisions.filter(isSelfContainedReflectItem);
        const skipped = g.decisions.length - valid.length;
        if (skipped > 0) logInfo(`[Reflect] ${skipped} non-self-contained item(s) skipped in decisions`);
        for (const dec of valid) {
          const f = this.factory.create({
            content    : dec.trim(),
            topic,
            type       : "decision",
            importance : 0.7,
            source     : sessionSrc,
            agentId,
            sessionId  : params.sessionId,
            caseId     : g.caseId ?? undefined,
          });
          f.agent_id  = agentId;
          f.key_id    = keyId;
          f.group_key_ids = [...groupKeyIds];
          f.workspace = workspace;
          allFragmentItems.push({ f, _category: "decisions", _groupIndex: gi });
        }
        breakdown.decisions += valid.length;
      }

      /** 3. errors_resolved -> error 파편 (해결됨 표시) */
      if (g.errors_resolved && g.errors_resolved.length > 0) {
        const valid   = g.errors_resolved.filter(isSelfContainedReflectItem);
        const skipped = g.errors_resolved.length - valid.length;
        if (skipped > 0) logInfo(`[Reflect] ${skipped} non-self-contained item(s) skipped in errors_resolved`);
        for (const err of valid) {
          const f = this.factory.create({
            content          : `[해결됨] ${err.trim()}`,
            topic,
            type             : "error",
            importance       : 0.5,
            source           : sessionSrc,
            agentId,
            resolutionStatus : "resolved",
            sessionId        : params.sessionId,
            caseId           : g.caseId ?? undefined,
          });
          f.agent_id  = agentId;
          f.key_id    = keyId;
          f.group_key_ids = [...groupKeyIds];
          f.workspace = workspace;
          allFragmentItems.push({ f, _category: "errors", _groupIndex: gi });
        }
        breakdown.errors += valid.length;
      }

      /** 4. new_procedures -> procedure 파편 */
      if (g.new_procedures && g.new_procedures.length > 0) {
        const valid   = g.new_procedures.filter(isSelfContainedReflectItem);
        const skipped = g.new_procedures.length - valid.length;
        if (skipped > 0) logInfo(`[Reflect] ${skipped} non-self-contained item(s) skipped in new_procedures`);
        for (const proc of valid) {
          const f = this.factory.create({
            content    : proc.trim(),
            topic,
            type       : "procedure",
            importance : 0.7,
            source     : sessionSrc,
            agentId,
            sessionId  : params.sessionId,
            caseId     : g.caseId ?? undefined,
          });
          f.agent_id  = agentId;
          f.key_id    = keyId;
          f.group_key_ids = [...groupKeyIds];
          f.workspace = workspace;
          allFragmentItems.push({ f, _category: "procedures", _groupIndex: gi });
        }
        breakdown.procedures += valid.length;
      }

      /** 5. open_questions -> fact 파편 (낮은 importance, 후속 처리용) */
      if (g.open_questions && g.open_questions.length > 0) {
        const valid   = g.open_questions.filter(isSelfContainedReflectItem);
        const skipped = g.open_questions.length - valid.length;
        if (skipped > 0) logInfo(`[Reflect] ${skipped} non-self-contained item(s) skipped in open_questions`);
        for (const q of valid) {
          const f = this.factory.create({
            content          : `[미해결] ${q.trim()}`,
            topic,
            type             : "fact",
            importance       : 0.4,
            source           : sessionSrc,
            agentId,
            resolutionStatus : "open",
            sessionId        : params.sessionId,
            caseId           : g.caseId ?? undefined,
          });
          f.agent_id  = agentId;
          f.key_id    = keyId;
          f.group_key_ids = [...groupKeyIds];
          f.workspace = workspace;
          allFragmentItems.push({ f, _category: "questions", _groupIndex: gi });
        }
        breakdown.questions += valid.length;
      }
    }

    /**
     * batchRememberProcessor가 주입된 경우 일괄 위임 (빠른 경로).
     * 미주입(레거시 mock 환경) 시 기존 store.insert + index.index 경로로 폴백.
     * 그룹이 서로 다른 workspace를 가져도 배치 항목마다 f.workspace가 이미
     * 스탬프돼 있으므로 단일 배치 호출로 처리한다.
     */
    const groupFragments = groups.map(() => []);

    if (allFragmentItems.length > 0) {
      if (this.batchRememberProcessor) {
        /** batchRememberProcessor.process는 fragments 배열을 받는다. content/type 등 직접 전달 */
        const batchFragments = allFragmentItems.map(({ f }) => ({
          ...f,
          content          : f.content,
          type             : f.type,
          topic            : f.topic,
          keywords         : f.keywords,
          importance       : f.importance,
          source           : f.source,
          resolutionStatus : f.resolution_status,
          assertionStatus  : f.assertion_status,
          sessionId        : f.session_id,
          agentId          : f.agent_id,
          workspace        : f.workspace,
          key_id           : f.key_id,
          caseId           : f.case_id,
        }));

        const batchResult = await this.batchRememberProcessor.process({
          fragments        : batchFragments,
          agentId,
          sessionId        : params.sessionId,
          _keyId           : keyId,
          workspace        : explicitWorkspace ?? defaultWorkspace ?? null,
          _defaultWorkspace: defaultWorkspace,
        });

        /** 성공한 파편을 fragments 배열과 소속 그룹 배열로 조합 */
        for (let i = 0; i < batchResult.results.length; i++) {
          const r = batchResult.results[i];
          if (r.success && r.id) {
            const { f, _groupIndex } = allFragmentItems[i];
            const entry = {
              id      : r.id,
              content : f.content,
              type    : f.type,
              keywords: f.keywords,
              key_id  : f.key_id,
              group_key_ids: [...groupKeyIds],
              workspace: f.workspace,
            };
            fragments.push(entry);
            groupFragments[_groupIndex].push(entry);
          } else if (!r.success) {
            logWarn(`[ReflectProcessor] batchRemember insert failed: ${r.error}`);
          }
        }
      } else {
        /** 폴백: 기존 store.insert + index.index (batchRememberProcessor 미주입 시) */
        const settled = await Promise.allSettled(
          allFragmentItems.map(async ({ f, _groupIndex }) => {
            const id = await this.store.insert(f);
            await this.index.index({ ...f, id }, params.sessionId, f.key_id ?? null);
            return { id, content: f.content, type: f.type, keywords: f.keywords,
              key_id: f.key_id, group_key_ids: [...groupKeyIds], workspace: f.workspace, _groupIndex };
          })
        );
        for (const r of settled) {
          if (r.status === "fulfilled") {
            const { _groupIndex, ...entry } = r.value;
            fragments.push(entry);
            groupFragments[_groupIndex].push(entry);
          } else {
            logWarn(`[ReflectProcessor] insert failed: ${r.reason?.message}`);
          }
        }
      }
    }

    /** 6. task_effectiveness -> task_feedback 저장 (세션 단위, 그룹 무관) */
    if (params.task_effectiveness) {
      try {
        await this._saveTaskFeedback(
          params.sessionId || "unknown",
          params.task_effectiveness
        );
        breakdown.task_feedback = true;
      } catch (err) {
        logWarn(`[ReflectProcessor] task_feedback save failed: ${err.message}`);
        breakdown.task_feedback = false;
      }
    }

    /** 6.5. 세션 파편 간 자동 link 생성 (keyId 전파로 cross-tenant cycle 경로 차단) */
    const autoLinkResult = await this.sessionLinker.autoLinkSessionFragments(
      fragments, agentId, keyId, groupKeyIds, scopeWorkspace
    );
    const linkSuggestions = autoLinkResult?.linkSuggestions ?? [];

    /** 6.7. reflect 파편 우선순위 임베딩 큐 적재 (rpush -> rpop이 즉시 처리) */
    const queueName = MEMORY_CONFIG.embeddingWorker.queueKey;
    for (const f of fragments) {
      if (f.id) {
        await pushToQueuePriority(queueName, { fragmentId: f.id }).catch((err) => {
          logWarn(`[ReflectProcessor] embedding queue push failed: ${err.message}`);
        });
      }
    }

    /** 6.8. reflect 파편 형태소 사전 등록 (fire-and-forget, drain 가능) */
    for (const f of fragments) {
      const morphemeP = morphemeIndex.tokenize(f.content)
        .catch(() => [])
        .then(morphemes => morphemeIndex.getOrRegisterEmbeddings(morphemes))
        .catch(err => { logWarn(`[ReflectProcessor] morpheme registration failed: ${err.message}`); });

      this._morphemePromises.add(morphemeP);
      morphemeP.finally(() => this._morphemePromises.delete(morphemeP));
    }

    /**
     * 7. 그룹마다 narrative_summary -> episode 파편 생성 (세션 서사 요약).
     *    primary 그룹은 호출자가 전달한 narrative_summary를 그대로 사용하고,
     *    나머지 그룹은 자신의 파편에서 자동 생성한다.
     * 7.5. Episode Continuity -- 그룹별 milestone_reached 이벤트 + preceded_by 엣지 (fire-and-forget)
     */
    const groupResults = [];
    for (let gi = 0; gi < groups.length; gi++) {
      const g         = groups[gi];
      const gFrags    = groupFragments[gi];
      const workspace = explicitWorkspace ?? g.workspace ?? defaultWorkspace ?? null;

      let narrativeSummary = g.narrativeSummary ?? null;
      if (!narrativeSummary && gFrags.length > 0) {
        const TYPE_PREFIX = { decision: "[결정]", error: "[에러]", procedure: "[절차]", fact: "" };
        const parts        = gFrags.slice(0, 8).map(f => {
          const prefix = TYPE_PREFIX[f.type] ?? `[${f.type}]`;
          return prefix ? `${prefix} ${f.content}` : f.content;
        });
        if (parts.length > 0) {
          narrativeSummary = parts.join(". ");
        }
      }

      let episodeId = null;
      if (narrativeSummary) {
        const sessionId = params.sessionId || "unknown";
        const episode = await this.remember({
          content               : narrativeSummary,
          type                  : "episode",
          topic                 : "session_reflect",
          source                : `session:${sessionId}`,
          sessionId             : sessionId,
          importance            : 0.6,
          contextSummary        : this._buildEpisodeContext(params, gFrags),
          agentId,
          _keyId                : keyId,
          _groupKeyIds          : [...groupKeyIds],
          workspace,
          caseId                : g.caseId ?? undefined,
          skipConflictDetection : true,
        });
        episodeId = episode?.id ?? null;
        if (episodeId) {
          breakdown.episode = (breakdown.episode || 0) + 1;
        }
      }

      const fragmentIds = gFrags.map(f => f.id);
      if (episodeId) fragmentIds.push(episodeId);
      groupResults.push({ workspace, topic: g.topic ?? null, caseId: g.caseId ?? null, fragmentIds });

      const anchorId = episodeId ?? gFrags[0]?.id ?? null;
      if (anchorId) {
        linkEpisodeMilestone(anchorId, agentId, keyId, params.sessionId).catch(() => {});
      }
    }

    /** 8. Working Memory 부분 evict — 이번 reflect가 실제 종합에 사용한 항목만 원자적으로 제거.
     *  실행 중 유입된 신규 WM 항목과 미소비 항목은 보존된다. */
    if (params.sessionId && sessionGroups) {
      const consumedWmIds = [...new Set(sessionGroups.flatMap(g => g.wmItemIds ?? []))];
      if (consumedWmIds.length > 0) {
        await this.index.evictWorkingMemoryItems(params.sessionId, consumedWmIds, {
          keyId: params._keyId ?? null,
          workspace: params.workspace ?? params._defaultWorkspace ?? null
        });
      }
    }

    return { fragments, count: fragments.length, breakdown, groups: groupResults, _link_suggestions: linkSuggestions };
  }

  /**
   * 그룹 배열을 구성한다.
   *
   * sessionGroups(세션 종합 결과)가 있으면 이를 기준으로 하되, 호출자가 넘긴
   * params(summary/decisions/...)는 호출자 자신의 workspace와 일치하는 그룹
   * (primary)에서만 채움 용도로 우선 적용된다 — 이미 값이 있는 필드는 덮어쓰지
   * 않는다. 일치하는 그룹이 없고 params 자체에 내용이 있으면 별도 그룹으로 추가한다.
   * sessionGroups가 없으면 params 단독으로 단일 그룹을 구성한다(레거시 경로).
   *
   * @private
   */
  _resolveGroups(params, explicitWorkspace, defaultWorkspace, sessionGroups) {
    const manualHasContent = !!(
      params.summary || params.decisions?.length || params.errors_resolved?.length ||
      params.new_procedures?.length || params.open_questions?.length || params.narrative_summary
    );

    const manualGroup = () => ({
      workspace       : explicitWorkspace ?? null,
      topic           : "session_reflect",
      caseId          : params.caseId ?? null,
      summary         : params.summary ?? null,
      decisions       : params.decisions ?? [],
      errors_resolved : params.errors_resolved ?? [],
      new_procedures  : params.new_procedures ?? [],
      open_questions  : params.open_questions ?? [],
      narrativeSummary: params.narrative_summary ?? null,
    });

    if (!sessionGroups || sessionGroups.length === 0) {
      return [manualGroup()];
    }

    const primaryIdx = sessionGroups.findIndex(g => (g.workspace ?? null) === (explicitWorkspace ?? null));

    const resolved = sessionGroups.map((g, i) => {
      const isPrimary = i === primaryIdx;
      return {
        workspace       : g.workspace ?? null,
        topic           : g.topic ?? null,
        caseId          : g.caseId ?? (isPrimary ? (params.caseId ?? null) : null),
        summary         : isPrimary && params.summary ? params.summary : g.summary,
        decisions       : isPrimary && params.decisions?.length ? params.decisions : g.decisions,
        errors_resolved : isPrimary && params.errors_resolved?.length ? params.errors_resolved : g.errors_resolved,
        new_procedures  : isPrimary && params.new_procedures?.length ? params.new_procedures : g.new_procedures,
        open_questions  : isPrimary && params.open_questions?.length ? params.open_questions : g.open_questions,
        narrativeSummary: isPrimary ? (params.narrative_summary ?? null) : null,
      };
    });

    if (primaryIdx === -1 && manualHasContent) {
      resolved.push(manualGroup());
    }

    return resolved;
  }

  /**
   * reflect에서 저장된 파편을 요약하여 episode의 contextSummary를 생성한다.
   * @private
   */
  _buildEpisodeContext(params, fragments) {
    const counts = {};
    for (const f of fragments) {
      counts[f.type] = (counts[f.type] || 0) + 1;
    }
    const parts = Object.entries(counts).map(([t, c]) => `${t} ${c}건`);

    const topics = [...new Set(fragments
      .flatMap(f => f.keywords || [])
      .filter(Boolean)
    )].slice(0, 5);

    let ctx = `세션 파편 ${fragments.length}건 저장 (${parts.join(', ')}).`;
    if (topics.length > 0) {
      ctx += ` 주요 키워드: ${topics.join(', ')}.`;
    }
    return ctx;
  }

  /**
   * task_feedback 저장 (reflect에서 호출)
   * @private
   */
  async _saveTaskFeedback(sessionId, effectiveness) {
    const pool = getPrimaryPool();
    if (!pool) return;

    const normalized = normalizeTaskEffectiveness(effectiveness);

    await pool.query(
      `INSERT INTO agent_memory.task_feedback
             (session_id, overall_success, tool_highlights, tool_pain_points,
              outcome, evaluator, evidence, unmet_requirements)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        sessionId,
        normalized.overallSuccess,
        effectiveness.tool_highlights || [],
        effectiveness.tool_pain_points || [],
        normalized.outcome,
        normalized.evaluator,
        normalized.evidence,
        normalized.unmetRequirements
      ]
    );
  }

  /**
   * 진행 중인 모든 형태소 등록 Promise가 완료될 때까지 대기.
   * 테스트 및 graceful shutdown 전용 — 프로덕션 호출 경로에서는 호출하지 않는다.
   *
   * @returns {Promise<void>}
   */
  async drainMorpheme() {
    if (this._morphemePromises.size === 0) return;
    await Promise.allSettled([...this._morphemePromises]);
  }
}
