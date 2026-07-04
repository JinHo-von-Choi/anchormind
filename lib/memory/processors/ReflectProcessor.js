/**
 * ReflectProcessor -- reflect() 로직 전담 모듈
 *
 * 작성자: 최진호
 * 작성일: 2026-04-05
 * 수정일: 2026-05-19 (autoLinkSessionFragments linkSuggestions 수신 → _link_suggestions 전파)
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
   * @returns {Object} { fragments, count, breakdown }
   */
  async process(params) {
    const fragments  = [];
    const sessionSrc = `session:${params.sessionId || "unknown"}`;
    const agentId    = params.agentId || "default";
    const keyId      = params._keyId ?? null;
    const workspace  = params.workspace ?? params._defaultWorkspace ?? null;
    const breakdown  = { summary: 0, decisions: 0, errors: 0, procedures: 0, questions: 0 };

    /** 0. sessionId가 있으면 세션 파편에서 미입력 항목 종합 */
    if (params.sessionId) {
      const consolidated = await this.sessionLinker.consolidateSessionFragments(
        params.sessionId, agentId, keyId
      );
      if (consolidated) {
        if (!params.summary && consolidated.summary)                        params.summary          = consolidated.summary;
        if (!params.decisions?.length && consolidated.decisions?.length)     params.decisions        = consolidated.decisions;
        if (!params.errors_resolved?.length && consolidated.errors_resolved?.length) params.errors_resolved = consolidated.errors_resolved;
        if (!params.new_procedures?.length && consolidated.new_procedures?.length)   params.new_procedures  = consolidated.new_procedures;
        if (!params.open_questions?.length && consolidated.open_questions?.length)    params.open_questions  = consolidated.open_questions;
      }
    }

    /**
     * 1~5. 5개 카테고리 파편을 단일 validFragments 배열로 조합.
     * 각 항목에 _category 메타를 부여해 batchRememberProcessor 위임 후 재집계.
     */
    const allFragmentItems = [];

    /** 1. summary -> fact 파편 (배열 또는 문자열 모두 처리) */
    if (params.summary) {
      const summaryItems = Array.isArray(params.summary)
        ? params.summary.filter(s => s && s.trim().length > 0)
        : this.factory.splitAndCreate(params.summary, {
            topic: "session_reflect", type: "fact", source: sessionSrc, agentId
          }).map(f => f.content);

      for (const item of summaryItems) {
        const f = this.factory.create({
          content   : item.trim ? item.trim() : item,
          topic     : "session_reflect",
          type      : "fact",
          source    : sessionSrc,
          agentId,
          sessionId : params.sessionId,
        });
        f.agent_id  = agentId;
        f.key_id    = keyId;
        f.workspace = workspace;
        allFragmentItems.push({ f, _category: "summary" });
      }
      breakdown.summary += summaryItems.length;
    }

    /** 2. decisions -> decision 파편 */
    if (params.decisions && params.decisions.length > 0) {
      const valid    = params.decisions.filter(isSelfContainedReflectItem);
      const skipped  = params.decisions.length - valid.length;
      if (skipped > 0) logInfo(`[Reflect] ${skipped} non-self-contained item(s) skipped in decisions`);
      for (const dec of valid) {
        const f = this.factory.create({
          content    : dec.trim(),
          topic      : "session_reflect",
          type       : "decision",
          importance : 0.8,
          source     : sessionSrc,
          agentId,
          sessionId  : params.sessionId,
        });
        f.agent_id  = agentId;
        f.key_id    = keyId;
        f.workspace = workspace;
        allFragmentItems.push({ f, _category: "decisions" });
      }
      breakdown.decisions += valid.length;
    }

    /** 3. errors_resolved -> error 파편 (해결됨 표시) */
    if (params.errors_resolved && params.errors_resolved.length > 0) {
      const valid    = params.errors_resolved.filter(isSelfContainedReflectItem);
      const skipped  = params.errors_resolved.length - valid.length;
      if (skipped > 0) logInfo(`[Reflect] ${skipped} non-self-contained item(s) skipped in errors_resolved`);
      for (const err of valid) {
        const f = this.factory.create({
          content          : `[해결됨] ${err.trim()}`,
          topic            : "session_reflect",
          type             : "error",
          importance       : 0.5,
          source           : sessionSrc,
          agentId,
          resolutionStatus : "resolved",
          sessionId        : params.sessionId,
        });
        f.agent_id  = agentId;
        f.key_id    = keyId;
        f.workspace = workspace;
        allFragmentItems.push({ f, _category: "errors" });
      }
      breakdown.errors += valid.length;
    }

    /** 4. new_procedures -> procedure 파편 */
    if (params.new_procedures && params.new_procedures.length > 0) {
      const valid    = params.new_procedures.filter(isSelfContainedReflectItem);
      const skipped  = params.new_procedures.length - valid.length;
      if (skipped > 0) logInfo(`[Reflect] ${skipped} non-self-contained item(s) skipped in new_procedures`);
      for (const proc of valid) {
        const f = this.factory.create({
          content    : proc.trim(),
          topic      : "session_reflect",
          type       : "procedure",
          importance : 0.7,
          source     : sessionSrc,
          agentId,
          sessionId  : params.sessionId,
        });
        f.agent_id  = agentId;
        f.key_id    = keyId;
        f.workspace = workspace;
        allFragmentItems.push({ f, _category: "procedures" });
      }
      breakdown.procedures += valid.length;
    }

    /** 5. open_questions -> fact 파편 (낮은 importance, 후속 처리용) */
    if (params.open_questions && params.open_questions.length > 0) {
      const valid    = params.open_questions.filter(isSelfContainedReflectItem);
      const skipped  = params.open_questions.length - valid.length;
      if (skipped > 0) logInfo(`[Reflect] ${skipped} non-self-contained item(s) skipped in open_questions`);
      for (const q of valid) {
        const f = this.factory.create({
          content          : `[미해결] ${q.trim()}`,
          topic            : "session_reflect",
          type             : "fact",
          importance       : 0.4,
          source           : sessionSrc,
          agentId,
          resolutionStatus : "open",
          sessionId        : params.sessionId,
        });
        f.agent_id  = agentId;
        f.key_id    = keyId;
        f.workspace = workspace;
        allFragmentItems.push({ f, _category: "questions" });
      }
      breakdown.questions += valid.length;
    }

    /**
     * batchRememberProcessor가 주입된 경우 일괄 위임 (빠른 경로).
     * 미주입(레거시 mock 환경) 시 기존 store.insert + index.index 경로로 폴백.
     */
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
        }));

        const batchResult = await this.batchRememberProcessor.process({
          fragments        : batchFragments,
          agentId,
          sessionId        : params.sessionId,
          _keyId           : keyId,
          workspace,
          _defaultWorkspace: params._defaultWorkspace ?? null,
        });

        /** 성공한 파편을 fragments 배열로 조합 */
        for (let i = 0; i < batchResult.results.length; i++) {
          const r = batchResult.results[i];
          if (r.success && r.id) {
            const { f } = allFragmentItems[i];
            fragments.push({
              id      : r.id,
              content : f.content,
              type    : f.type,
              keywords: f.keywords,
            });
          } else if (!r.success) {
            logWarn(`[ReflectProcessor] batchRemember insert failed: ${r.error}`);
          }
        }
      } else {
        /** 폴백: 기존 store.insert + index.index (batchRememberProcessor 미주입 시) */
        const settled = await Promise.allSettled(
          allFragmentItems.map(async ({ f }) => {
            const id = await this.store.insert(f);
            await this.index.index({ ...f, id }, params.sessionId, f.key_id ?? null);
            return { id, content: f.content, type: f.type, keywords: f.keywords };
          })
        );
        for (const r of settled) {
          if (r.status === "fulfilled") {
            fragments.push(r.value);
          } else {
            logWarn(`[ReflectProcessor] insert failed: ${r.reason?.message}`);
          }
        }
      }
    }

    /** 6. task_effectiveness -> task_feedback 저장 */
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
    const autoLinkResult = await this.sessionLinker.autoLinkSessionFragments(fragments, agentId, keyId);
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

    /** 7. narrative_summary -> episode 파편 (세션 서사 요약)
     *  에이전트가 전달하면 그대로 사용, 없으면 summary에서 자동 생성. */
    let narrativeSummary = params.narrative_summary ?? null;
    if (!narrativeSummary && fragments.length > 0) {
      const TYPE_PREFIX = { decision: "[결정]", error: "[에러]", procedure: "[절차]", fact: "" };
      const parts       = fragments.slice(0, 8).map(f => {
        const prefix = TYPE_PREFIX[f.type] ?? `[${f.type}]`;
        return prefix ? `${prefix} ${f.content}` : f.content;
      });
      if (parts.length > 0) {
        narrativeSummary = parts.join(". ");
      }
    }
    if (narrativeSummary) {
      const sessionId = params.sessionId || "unknown";
      await this.remember({
        content               : narrativeSummary,
        type                  : "episode",
        topic                 : "session_reflect",
        source                : `session:${sessionId}`,
        sessionId             : sessionId,
        importance            : 0.6,
        contextSummary        : this._buildEpisodeContext(params, fragments),
        agentId,
        _keyId                : keyId,
        skipConflictDetection : true,
      });
      breakdown.episode = 1;
    }

    /** 7.5. Episode Continuity -- milestone_reached 이벤트 + preceded_by 엣지 (fire-and-forget) */
    if (fragments.length > 0) {
      const episodeId = fragments.find(f => f.type === "episode")?.id ?? fragments[0]?.id;
      if (episodeId) {
        linkEpisodeMilestone(episodeId, agentId, keyId, params.sessionId).catch(() => {});
      }
    }

    /** 8. Working Memory 정리 (세션 종료) */
    if (params.sessionId) {
      await this.index.clearWorkingMemory(params.sessionId);
    }

    return { fragments, count: fragments.length, breakdown, _link_suggestions: linkSuggestions };
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

    await pool.query(
      `INSERT INTO agent_memory.task_feedback
             (session_id, overall_success, tool_highlights, tool_pain_points)
       VALUES ($1, $2, $3, $4)`,
      [
        sessionId,
        effectiveness.overall_success || false,
        effectiveness.tool_highlights || [],
        effectiveness.tool_pain_points || []
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
