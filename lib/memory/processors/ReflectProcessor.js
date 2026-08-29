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
import { SCHEMA } from "../schema.js";

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

/**
 * reflect 입력 범주별 파편 사상표.
 *
 * summary는 문자열 분리 경로가 따로 있어 표에 넣지 않는다.
 */
export const REFLECT_CATEGORIES = [
  { field: "decisions",       bucket: "decisions",  type: "decision",  importance: 0.7 },
  { field: "errors_resolved", bucket: "errors",     type: "error",     importance: 0.5, prefix: "[해결됨]", resolutionStatus: "resolved" },
  { field: "new_procedures",  bucket: "procedures", type: "procedure", importance: 0.7 },
  { field: "open_questions",  bucket: "questions",  type: "fact",      importance: 0.4, prefix: "[미해결]", resolutionStatus: "open" }
];

/**
 * 그룹 파편에서 서사 요약을 만든다. 유형 표기를 앞에 붙여 나열한다.
 *
 * @param {Array<{type: string, content: string}>} fragments
 * @returns {string|null}
 */
function summarizeFragments(fragments) {
  if (!fragments || fragments.length === 0) return null;
  const TYPE_PREFIX = { decision: "[결정]", error: "[에러]", procedure: "[절차]", fact: "" };
  const parts = fragments.slice(0, 8).map(f => {
    const prefix = TYPE_PREFIX[f.type] ?? `[${f.type}]`;
    return prefix ? `${prefix} ${f.content}` : f.content;
  });
  return parts.length > 0 ? parts.join(". ") : null;
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
    const ctx = {
      sessionSrc       : `session:${params.sessionId || "unknown"}`,
      agentId          : params.agentId || "default",
      keyId            : params._keyId ?? null,
      explicitWorkspace: params.workspace ?? null,
      defaultWorkspace : params._defaultWorkspace ?? null,
      sessionId        : params.sessionId
    };

    /** 세션 파편을 workspace→case_id→topic 경계로 묶는다. */
    const sessionGroups = params.sessionId
      ? await this.sessionLinker.consolidateSessionFragments(params.sessionId, ctx.agentId, ctx.keyId)
      : null;

    const groups    = this._resolveGroups(params, ctx.explicitWorkspace, ctx.defaultWorkspace, sessionGroups);
    const breakdown = { summary: 0, decisions: 0, errors: 0, procedures: 0, questions: 0 };

    const allFragmentItems = this._collectFragmentItems(groups, ctx, breakdown);
    const { fragments, groupFragments } = await this._persistFragmentItems(allFragmentItems, groups.length, params, ctx);

    await this._recordTaskFeedback(params, breakdown);

    const autoLinkResult  = await this.sessionLinker.autoLinkSessionFragments(fragments, ctx.agentId, ctx.keyId);
    const linkSuggestions = autoLinkResult?.linkSuggestions ?? [];

    await this._queueEmbeddings(fragments);
    this._registerMorphemes(fragments);

    const groupResults = await this._buildEpisodes(groups, groupFragments, params, ctx, breakdown);
    await this._evictConsumedWorkingMemory(params, sessionGroups);

    return { fragments, count: fragments.length, breakdown, groups: groupResults, _link_suggestions: linkSuggestions };
  }

  /**
   * 그룹별로 다섯 범주의 파편 항목을 만든다.
   *
   * 범주마다 유형과 중요도, 내용 표기, 해결 상태가 다를 뿐 절차는 같다. 차이를
   * 표로 두고 절차는 한 번만 쓴다.
   *
   * @param {Array}  groups
   * @param {Object} ctx
   * @param {Object} breakdown  범주별 건수가 이 객체에 누적된다
   * @returns {Array<{f: Object, _category: string, _groupIndex: number}>}
   */
  _collectFragmentItems(groups, ctx, breakdown) {
    const items = [];
    for (let gi = 0; gi < groups.length; gi++) {
      const g         = groups[gi];
      const topic     = g.topic || "session_reflect";
      const workspace = ctx.explicitWorkspace ?? g.workspace ?? ctx.defaultWorkspace ?? null;
      const stamp     = { topic, workspace, gi, ctx };

      items.push(...this._buildSummaryItems(g, stamp, breakdown));
      for (const spec of REFLECT_CATEGORIES) {
        items.push(...this._buildCategoryItems(g, spec, stamp, breakdown));
      }
    }
    return items;
  }

  /**
   * summary는 문자열 하나로 올 수 있어 문장 분리를 거친다. 다른 범주와 절차가
   * 달라 따로 둔다.
   *
   * @returns {Array<Object>}
   */
  _buildSummaryItems(g, stamp, breakdown) {
    if (!g.summary) return [];
    const { topic, ctx } = stamp;
    const contents = Array.isArray(g.summary)
      ? g.summary.filter(s => s && s.trim().length > 0)
      : this.factory.splitAndCreate(g.summary, { topic, type: "fact", source: ctx.sessionSrc, agentId: ctx.agentId })
          .map(f => f.content);

    breakdown.summary += contents.length;
    return contents.map(item => this._stampItem(
      this.factory.create({
        content  : item.trim ? item.trim() : item,
        topic,
        type     : "fact",
        source   : ctx.sessionSrc,
        agentId  : ctx.agentId,
        sessionId: ctx.sessionId,
        caseId   : g.caseId ?? undefined
      }), "summary", stamp));
  }

  /**
   * 표에 기술된 한 범주의 항목을 만든다.
   *
   * @returns {Array<Object>}
   */
  _buildCategoryItems(g, spec, stamp, breakdown) {
    const raw = g[spec.field];
    if (!raw || raw.length === 0) return [];

    const valid   = raw.filter(isSelfContainedReflectItem);
    const skipped = raw.length - valid.length;
    if (skipped > 0) logInfo(`[Reflect] ${skipped} non-self-contained item(s) skipped in ${spec.field}`);

    const { topic, ctx } = stamp;
    breakdown[spec.bucket] += valid.length;

    return valid.map(text => this._stampItem(
      this.factory.create({
        content         : spec.prefix ? `${spec.prefix} ${text.trim()}` : text.trim(),
        topic,
        type            : spec.type,
        importance      : spec.importance,
        source          : ctx.sessionSrc,
        agentId         : ctx.agentId,
        sessionId       : ctx.sessionId,
        caseId          : g.caseId ?? undefined,
        ...(spec.resolutionStatus ? { resolutionStatus: spec.resolutionStatus } : {})
      }), spec.bucket, stamp));
  }

  /** 소유권과 워크스페이스를 파편에 찍고 배치 항목으로 감싼다. */
  _stampItem(f, category, { workspace, gi, ctx }) {
    f.agent_id  = ctx.agentId;
    f.key_id    = ctx.keyId;
    f.workspace = workspace;
    return { f, _category: category, _groupIndex: gi };
  }

  /**
   * 만든 항목을 저장한다.
   *
   * batchRememberProcessor가 주입돼 있으면 일괄 위임하고, 없으면 개별 삽입으로
   * 폴백한다. 어느 경로든 성공한 파편만 그룹별로 되돌려 준다.
   *
   * @returns {Promise<{fragments: Array, groupFragments: Array<Array>}>}
   */
  async _persistFragmentItems(items, groupCount, params, ctx) {
    const fragments      = [];
    const groupFragments = Array.from({ length: groupCount }, () => []);
    if (items.length === 0) return { fragments, groupFragments };

    const collect = (entry, groupIndex) => {
      fragments.push(entry);
      groupFragments[groupIndex].push(entry);
    };

    if (this.batchRememberProcessor) {
      await this._persistViaBatch(items, params, ctx, collect);
    } else {
      await this._persistIndividually(items, params, collect);
    }
    return { fragments, groupFragments };
  }

  /** 일괄 저장 경로. */
  async _persistViaBatch(items, params, ctx, collect) {
    const batchFragments = items.map(({ f }) => ({
      ...f,
      content         : f.content,
      type            : f.type,
      topic           : f.topic,
      keywords        : f.keywords,
      importance      : f.importance,
      source          : f.source,
      resolutionStatus: f.resolution_status,
      assertionStatus : f.assertion_status,
      sessionId       : f.session_id,
      agentId         : f.agent_id,
      workspace       : f.workspace,
      key_id          : f.key_id,
      caseId          : f.case_id
    }));

    const batchResult = await this.batchRememberProcessor.process({
      fragments        : batchFragments,
      agentId          : ctx.agentId,
      sessionId        : params.sessionId,
      _keyId           : ctx.keyId,
      workspace        : ctx.explicitWorkspace ?? ctx.defaultWorkspace ?? null,
      _defaultWorkspace: ctx.defaultWorkspace
    });

    for (let i = 0; i < batchResult.results.length; i++) {
      const r = batchResult.results[i];
      if (r.success && r.id) {
        const { f, _groupIndex } = items[i];
        collect({ id: r.id, content: f.content, type: f.type, keywords: f.keywords }, _groupIndex);
      } else if (!r.success) {
        logWarn(`[ReflectProcessor] batchRemember insert failed: ${r.error}`);
      }
    }
  }

  /** 개별 저장 폴백 경로. batchRememberProcessor 미주입 환경에서 쓰인다. */
  async _persistIndividually(items, params, collect) {
    const settled = await Promise.allSettled(
      items.map(async ({ f, _groupIndex }) => {
        const id = await this.store.insert(f);
        await this.index.index({ ...f, id }, params.sessionId, f.key_id ?? null);
        return { id, content: f.content, type: f.type, keywords: f.keywords, _groupIndex };
      })
    );
    for (const r of settled) {
      if (r.status === "fulfilled") {
        const { _groupIndex, ...entry } = r.value;
        collect(entry, _groupIndex);
      } else {
        logWarn(`[ReflectProcessor] insert failed: ${r.reason?.message}`);
      }
    }
  }

  /** 세션 단위 도구 효과성 평가를 저장한다. 실패해도 reflect는 성공으로 둔다. */
  async _recordTaskFeedback(params, breakdown) {
    if (!params.task_effectiveness) return;
    try {
      await this._saveTaskFeedback(params.sessionId || "unknown", params.task_effectiveness);
      breakdown.task_feedback = true;
    } catch (err) {
      logWarn(`[ReflectProcessor] task_feedback save failed: ${err.message}`);
      breakdown.task_feedback = false;
    }
  }

  /** reflect 파편을 우선순위 임베딩 큐에 넣는다. */
  async _queueEmbeddings(fragments) {
    const queueName = MEMORY_CONFIG.embeddingWorker.queueKey;
    for (const f of fragments) {
      if (!f.id) continue;
      await pushToQueuePriority(queueName, { fragmentId: f.id }).catch((err) => {
        logWarn(`[ReflectProcessor] embedding queue push failed: ${err.message}`);
      });
    }
  }

  /** 형태소 사전 등록. 종료 시 배수할 수 있도록 진행 중 프라미스를 들고 있는다. */
  _registerMorphemes(fragments) {
    for (const f of fragments) {
      const morphemeP = morphemeIndex.tokenize(f.content)
        .catch(() => [])
        .then(morphemes => morphemeIndex.getOrRegisterEmbeddings(morphemes))
        .catch(err => { logWarn(`[ReflectProcessor] morpheme registration failed: ${err.message}`); });

      this._morphemePromises.add(morphemeP);
      morphemeP.finally(() => this._morphemePromises.delete(morphemeP));
    }
  }

  /**
   * 그룹마다 서사 요약을 episode 파편으로 남기고 milestone 이벤트를 건다.
   *
   * 호출자가 narrative_summary를 준 그룹은 그것을 쓰고, 나머지는 자기 파편에서
   * 만들어 쓴다.
   *
   * @returns {Promise<Array>}
   */
  async _buildEpisodes(groups, groupFragments, params, ctx, breakdown) {
    const groupResults = [];

    for (let gi = 0; gi < groups.length; gi++) {
      const g         = groups[gi];
      const gFrags    = groupFragments[gi];
      const workspace = ctx.explicitWorkspace ?? g.workspace ?? ctx.defaultWorkspace ?? null;
      const narrative = g.narrativeSummary ?? summarizeFragments(gFrags);

      let episodeId = null;
      if (narrative) {
        const sessionId = params.sessionId || "unknown";
        const episode   = await this.remember({
          content              : narrative,
          type                 : "episode",
          topic                : "session_reflect",
          source               : `session:${sessionId}`,
          sessionId,
          importance           : 0.6,
          contextSummary       : this._buildEpisodeContext(params, gFrags),
          agentId              : ctx.agentId,
          _keyId               : ctx.keyId,
          workspace,
          caseId               : g.caseId ?? undefined,
          skipConflictDetection: true
        });
        episodeId = episode?.id ?? null;
        if (episodeId) breakdown.episode = (breakdown.episode || 0) + 1;
      }

      const fragmentIds = gFrags.map(f => f.id);
      if (episodeId) fragmentIds.push(episodeId);
      groupResults.push({ workspace, topic: g.topic ?? null, caseId: g.caseId ?? null, fragmentIds });

      const anchorId = episodeId ?? gFrags[0]?.id ?? null;
      if (anchorId) {
        linkEpisodeMilestone(anchorId, ctx.agentId, ctx.keyId, params.sessionId).catch(() => {});
      }
    }
    return groupResults;
  }

  /**
   * 이번 reflect가 실제로 종합한 Working Memory 항목만 걷어낸다.
   *
   * 실행 중 새로 들어온 항목과 쓰이지 않은 항목은 남긴다.
   */
  async _evictConsumedWorkingMemory(params, sessionGroups) {
    if (!params.sessionId || !sessionGroups) return;
    const consumed = [...new Set(sessionGroups.flatMap(g => g.wmItemIds ?? []))];
    if (consumed.length > 0) {
      await this.index.evictWorkingMemoryItems(params.sessionId, consumed);
    }
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
      `INSERT INTO ${SCHEMA}.task_feedback
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
