/**
 * 도구: 에이전트 기억 관리 (Fragment-Based Memory)
 *
 * 작성자: 최진호
 * 작성일: 2026-02-23
 * 수정일: 2026-06-15
 *
 * MCP 도구 핸들러 17종:
 *   remember, batch_remember, recall, forget, link, amend, reflect, context,
 *   tool_feedback, memory_stats, memory_consolidate, graph_explore,
 *   fragment_history, get_skill_guide, session_rotate
 * 추가로 reconstruct.js 가 reconstruct_history, search_traces 를 제공한다.
 *
 * 공통 규약:
 *   - 모든 핸들러는 `{ success: boolean, ... }` 형태의 JSON 직렬화 가능 객체를 반환한다.
 *   - 호출자가 주입한 `_sessionId`, `_keyId`, `_clientIp`, `_userAgent`,
 *     `_defaultWorkspace`, `_mode` 메타 키는 핸들러 내부에서만 사용하고
 *     사용자 args 로는 노출하지 않는다.
 *   - 검색·저장 응답은 `_meta.searchEventId`, `_meta.hints`, `_meta.suggestion`,
 *     `_meta.serverTime` 4개 키를 갖는 `_meta` 블록으로 통일된다.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryManager }    from "../memory/MemoryManager.js";
import { getSkillGuideOverride } from "../memory/ModeRegistry.js";
import { logAudit }         from "../utils.js";
import { logWarn }          from "../logger.js";
import { SessionActivityTracker } from "../memory/processors/SessionActivityTracker.js";
import { getSearchMetrics } from "../memory/signals/SearchMetrics.js";
import { getSearchObservability } from "../memory/signals/SearchEventAnalyzer.js";
import { reconsolidate }         from "../memory/ReconsolidationEngine.js";
import { getPrimaryPool }        from "./db.js";
import { computeConfidence } from "../memory/consolidate/UtilityBaseline.js";
import { fetchLinkedFragments } from "../memory/LinkedFragmentLoader.js";
import { rotateSession }        from "../sessions.js";
import { logSessionRotate }     from "../session-audit.js";
import { serverTimeMeta }       from "./serverTime.js";

/** 스키마 re-export (기존 import 호환) */
export {
  rememberDefinition,
  batchRememberDefinition,
  recallDefinition,
  forgetDefinition,
  linkDefinition,
  amendDefinition,
  reflectDefinition,
  contextDefinition,
  toolFeedbackDefinition,
  memoryStatsDefinition,
  memoryConsolidateDefinition,
  graphExploreDefinition,
  fragmentHistoryDefinition,
  getSkillGuideDefinition,
  sessionRotateDefinition,
  batchStatusDefinition
} from "./memory-schemas.js";

/** ==================== 공통 래퍼 ==================== */

/**
 * _sessionId 추출, try/catch, logAudit(성공/실패)를 캡슐화하는 고차 함수.
 *
 * @param {string}   toolName  - logAudit 에 전달할 도구 이름.
 * @param {Object}   args      - 원본 핸들러 args (변이됨: _sessionId 삭제, sessionId 주입).
 * @param {Function} handler   - async (args, sessionId) => { response, auditOnSuccess }
 *   - response: 최종 반환 객체 (success 필드 포함).
 *   - auditOnSuccess: logAudit 성공 호출에 추가할 필드 객체. falsy 면 logAudit 성공 생략.
 * @param {Object}   [failAuditExtra] - 실패 audit에 추가할 고정 필드 (fragmentId 등).
 * @returns {Promise<Object>}
 */
async function withAudit(toolName, args, handler, failAuditExtra = {}) {
  const sessionId = args._sessionId;
  delete args._sessionId;
  if (sessionId && !args.sessionId) args.sessionId = sessionId;
  try {
    const { response, auditOnSuccess } = await handler(args, sessionId);
    if (auditOnSuccess) {
      await logAudit(toolName, { success: true, ...auditOnSuccess });
    }
    return response;
  } catch (err) {
    await logAudit(toolName, {
      ...failAuditExtra,
      success: false,
      details: err.message
    });
    return { success: false, error: err.message };
  }
}

/** ==================== 도구 핸들러 ==================== */

/**
 * 자기완결적 사실 한 건을 fragment로 저장한다.
 *
 * symbolic_hard_gate 위반은 `SymbolicPolicyViolationError`로 전파되며
 * 상위 JSON-RPC 레이어에서 `-32003` 에러 코드로 매핑된다. 그 외 예외는
 * `{ success: false, error }` 형태로 흡수된다.
 *
 * @param {Object} args - `rememberDefinition.inputSchema` 의 properties.
 *   주요 키: `content`, `topic`, `type`, `keywords`, `importance`, `caseId`,
 *   `phase`, `affect`, `assertionStatus`, `resolutionStatus`, `isAnchor`,
 *   `supersedes`, `linkedTo`, `idempotencyKey`, `workspace`, `episode`,
 *   `contextSummary`, `dryRun`.
 * @returns {Promise<Object>} `{ success, id?, validation_warnings?, error?, code? }`.
 * @throws {SymbolicPolicyViolationError} symbolic 정책 차단 시 상위로 전파.
 */
export async function tool_remember(args) {
  const mgr       = MemoryManager.getInstance();
  const sessionId = args._sessionId;
  delete args._sessionId;
  if (sessionId && !args.sessionId) args.sessionId = sessionId;
  try {
    const result = await mgr.remember(args);
    await logAudit("remember", {
      topic     : args.topic,
      type      : args.type,
      fragmentId: result.id,
      success   : true
    });
    SessionActivityTracker.record(sessionId, {
      tool: "remember", keywords: args.keywords, fragmentId: result.id
    }).catch(() => {});
    return { success: true, ...result };
  } catch (err) {
    /** Symbolic hard gate: jsonrpc.js 최상위 catch가 -32003 에러로 매핑하도록 전파 */
    if (err && err.name === "SymbolicPolicyViolationError") {
      throw err;
    }
    await logAudit("remember", {
      topic  : args.topic,
      type   : args.type,
      success: false,
      details: err.message
    });
    const resp = { success: false, error: err.message };
    if (err.code)    resp.code    = err.code;
    if (err.current) resp.current = err.current;
    if (err.limit)   resp.limit   = err.limit;
    return resp;
  }
}

/**
 * 여러 fragment 를 한 호출에 일괄 저장한다. 최대 200건.
 *
 * remember 의 부가 필드(episode, contextSummary, isAnchor, supersedes,
 * linkedTo, scope)는 지원하지 않는다. 각 항목 처리 중 발생한 오류는
 * `result.skipped` 로 집계된다.
 *
 * @param {Object} args - `{ fragments: Array<rememberArgs>, dryRun?: boolean,
 *   workspace?: string }` 형태.
 * @param {Object} [options]
 * @param {Function} [options.onProgress] - `(index, total) => void` 진행 콜백.
 * @returns {Promise<Object>} `{ success, inserted, skipped, errors? }`.
 */
export async function tool_batchRemember(args, { onProgress = null } = {}) {
  const mgr   = MemoryManager.getInstance();
  const total = args.fragments?.length || 0;
  return withAudit("batch_remember", args, async (a, sessionId) => {
    const result = await mgr.batchRemember(a, onProgress);
    SessionActivityTracker.record(sessionId, {
      tool: "batch_remember", inserted: result.inserted
    }).catch(() => {});
    return {
      response      : { success: true, ...result },
      auditOnSuccess: { total, inserted: result.inserted, skipped: result.skipped }
    };
  }, { total });
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
export async function tool_recall(args) {
  const mgr       = MemoryManager.getInstance();
  const sessionId = args._sessionId;
  delete args._sessionId;
  if (sessionId && !args.sessionId) args.sessionId = sessionId;
  try {
    /**
     * asOf → anchorTime 변환: 일반 recall 경로로 통합.
     * 과거 시점 기준 복합 랭킹이 해당 시점 근접 파편을 우선 배치한다.
     */
    if (args.asOf) {
      const asOfDate = new Date(args.asOf);
      if (isNaN(asOfDate.getTime())) {
        return { success: false, error: `Invalid asOf: "${args.asOf}"` };
      }
      args.anchorTime = asOfDate.getTime();
      delete args.asOf;
    }

    const result = await mgr.recall(args);
    SessionActivityTracker.record(sessionId, {
      tool: "recall", keywords: args.keywords || [args.text?.substring(0, 30)],
      searchPath: result.searchPath
    }).catch(() => {});

    /** 1-hop 링크 파편 조회 (Task 4-2) */
    const fragmentIds = result.fragments.map(f => f.id);
    const linkedMap   = await fetchLinkedFragments(fragmentIds).catch((err) => {
      logWarn("fetchLinkedFragments failed", { error: err.message, count: fragmentIds.length });
      return new Map();
    });

    /** 시간 인접 번들링: includeContext=true 시 같은 세션의 30분 이내 파편 첨부 */
    if (args.includeContext) {
      const agentId    = args.agentId || "default";
      const keyId      = args._keyId ?? null;

      /** 고유 session_id 목록 추출 후 병렬 조회 — N+1 방지 */
      const sessionIds = [...new Set(
        result.fragments.filter(f => f.session_id).map(f => f.session_id)
      )];
      const sessionResults = await Promise.all(
        sessionIds.map(sid => mgr.store.searchBySource(`session:${sid}`, agentId, keyId))
      );
      const sessionMap = new Map(
        sessionIds.map((sid, i) => [sid, sessionResults[i]])
      );

      for (const frag of result.fragments) {
        if (frag.session_id) {
          const nearby = sessionMap.get(frag.session_id) || [];
          frag.nearby_context = nearby
            .filter(n => n.id !== frag.id)
            .filter(n => {
              const diff = Math.abs(new Date(n.created_at) - new Date(frag.created_at));
              return diff < 30 * 60 * 1000;
            })
            .slice(0, 3)
            .map(n => ({ id: n.id, content: n.content, type: n.type, created_at: n.created_at }));
        }
      }
    }

    /** caseMode 응답: cases 배열을 직접 반환 (fragments 가공 로직 우회) */
    if (result.caseMode) {
      const hint = buildRecallHint([], args);
      const searchEventId = result._searchEventId ?? null;
      /** 응답 메타는 `_meta` 블록만 제공한다 (top-level mirror 없음). */
      return {
        success   : true,
        caseMode  : true,
        cases     : result.cases,
        caseCount : result.caseCount,
        searchPath: result.searchPath,
        _meta: {
          searchEventId,
          hints      : hint ? [hint] : [],
          suggestion : result._suggestion ?? undefined,
          serverTime : serverTimeMeta()
        }
      };
    }

    const fragments = result.fragments.map(f => ({
      id          : f.id,
      content     : f.content,
      topic       : f.topic,
      type        : f.type,
      importance  : f.importance,
      created_at  : f.created_at,
      age_days    : Math.floor((Date.now() - new Date(f.created_at).getTime()) / 86400000),
      access_count: f.access_count || 0,
      confidence  : computeConfidence(f.utility_score),
      linked      : linkedMap.get(f.id) || [],
      ...(f.similarity !== undefined  ? { similarity: f.similarity }         : {}),
      ...(f.metadata?.stale           ? { stale_warning: f.metadata.warning } : {}),
      ...(args.includeKeywords        ? { keywords: f.keywords ?? [] }        : {}),
      ...(f.context_summary           ? { context_summary: f.context_summary } : {}),
      ...(f.nearby_context?.length    ? { nearby_context: f.nearby_context }   : {}),
      ...(f.workspace !== undefined    ? { workspace: f.workspace }             : {}),
      ...(f.case_id                    ? { case_id: f.case_id }                 : {}),
      ...(f.goal                       ? { goal: f.goal }                       : {}),
      ...(f.outcome                    ? { outcome: f.outcome }                 : {}),
      ...(f.phase                      ? { phase: f.phase }                     : {}),
      ...(f.resolution_status          ? { resolution_status: f.resolution_status } : {}),
      ...(f.assertion_status && f.assertion_status !== "observed" ? { assertion_status: f.assertion_status } : {}),
      /** Phase 2 Explainability: MEMENTO_SYMBOLIC_EXPLAIN=true 시 FragmentSearch가 주입 */
      ...(Array.isArray(f.explanations) && f.explanations.length > 0 ? { explanations: f.explanations } : {}),
      /** Phase 4 Soft Gating: 파편 저장 시점에 기록된 경고를 조회 시에도 노출 */
      ...(Array.isArray(f.validation_warnings) && f.validation_warnings.length > 0 ? { validation_warnings: f.validation_warnings } : {})
    }));

    const hint          = buildRecallHint(fragments, args);
    const searchEventId = result._searchEventId ?? null;
    /** 응답 메타는 `_meta` 블록만 제공한다 (top-level mirror 없음). */
    return {
      success    : true,
      fragments,
      count      : fragments.length,
      totalTokens: result.totalTokens,
      searchPath : result.searchPath,
      _meta: {
        searchEventId,
        hints      : hint ? [hint] : [],
        suggestion : result._suggestion ?? undefined,
        serverTime : serverTimeMeta()
      }
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * fragment 를 soft-delete 한다. `force=true` 면 영구 삭제.
 *
 * `id`, `topic`, `idempotencyKey`, `caseId` 중 하나 이상이 지정돼야 한다.
 * `dryRun=true` 면 실제 삭제 없이 영향받는 파편 수와 연결 링크 수만 반환한다.
 *
 * @param {Object} args - `{ id?, topic?, idempotencyKey?, caseId?, force?,
 *   dryRun?, workspace? }`.
 * @returns {Promise<Object>} `{ success, deleted, linksAffected?, dryRun? }`.
 */
export async function tool_forget(args) {
  const mgr = MemoryManager.getInstance();
  return withAudit("forget", args, async (a, sessionId) => {
    const result = await mgr.forget(a);
    SessionActivityTracker.record(sessionId, { tool: "forget" }).catch(() => {});
    return {
      response      : { success: true, ...result },
      auditOnSuccess: {
        fragmentId: a.id    || "-",
        topic     : a.topic || "-",
        details   : result.deleted ? `deleted ${result.deleted}` : undefined
      }
    };
  }, { fragmentId: args.id || "-" });
}

/**
 * 두 fragment 사이에 명시적 관계 링크를 생성한다.
 *
 * `relationType` 예: `resolved_by`, `caused_by`, `contradicts`, `part_of`,
 * `related_to`, `preceded_by`. 방향성 링크에 한해 `LinkIntegrityChecker` 가
 * 순환 advisory 를 기록한다 (fail-open, 차단하지 않음).
 *
 * @param {Object} args - `{ fromId, toId, relationType, weight?, evidence?,
 *   workspace?, dryRun? }`.
 * @returns {Promise<Object>} `{ success, linkId?, advisory?, error? }`.
 */
export async function tool_link(args) {
  const mgr = MemoryManager.getInstance();
  return withAudit("link", args, async (a, sessionId) => {
    /** Phase 3 LinkIntegrityChecker advisory: 방향성 링크 순환 사전 경고.
     * 차단하지 않음. hasCycle=true 시 checkCycle 내부에서 symbolicMetrics.recordWarning 처리.
     * fromId/toId/relationType 세 값이 모두 있어야 유의미한 체크 가능. */
    try {
      if (a.fromId && a.toId && a.relationType && mgr.linkChecker) {
        const cycleResult = await mgr.linkChecker.checkCycle(
          a.fromId,
          a.toId,
          a.relationType,
          a.agentId || "default",
          a._keyId ?? null
        );
        if (cycleResult.hasCycle) {
          logWarn("link advisory: cycle detected", {
            fromId      : a.fromId,
            toId        : a.toId,
            relationType: a.relationType,
            reason      : cycleResult.reason,
            ruleVersion : cycleResult.ruleVersion
          });
        }
      }
    } catch {
      /** fail-open: checkCycle 내부 예외는 무시하고 기존 link 경로 진행 */
    }

    const result = await mgr.link(a);
    SessionActivityTracker.record(sessionId, { tool: "link" }).catch(() => {});
    return {
      response      : { success: true, ...result },
      auditOnSuccess: { fragmentId: a.fromId || "-", details: `${a.fromId} -> ${a.toId}` }
    };
  });
}

/**
 * 기존 fragment 의 속성을 수정한다.
 *
 * 동일 내용의 파편이 이미 존재하면 자동 병합되며 `merged=true` 와 함께
 * `existingId` 가 반환된다. 주요 갱신 필드: `content`, `importance`, `keywords`,
 * `assertionStatus`(observed/inferred/verified/rejected), `resolutionStatus`,
 * `phase`, `outcome`.
 *
 * @param {Object} args - `{ id, ...updateFields, dryRun?, workspace? }`.
 * @returns {Promise<Object>} `{ success, updated, merged?, existingId? }`.
 */
export async function tool_amend(args) {
  const mgr = MemoryManager.getInstance();
  return withAudit("amend", args, async (a, sessionId) => {
    const result = await mgr.amend(a);
    SessionActivityTracker.record(sessionId, { tool: "amend", fragmentId: a.id }).catch(() => {});
    /** success 는 result.updated(boolean) — withAudit의 기본 success:true 를 덮어쓴다. */
    return {
      response      : { success: result.updated, ...result },
      auditOnSuccess: {
        fragmentId: a.id,
        success   : result.updated,
        details   : result.merged ? `merged with ${result.existingId}` : undefined
      }
    };
  }, { fragmentId: args.id });
}

/**
 * 세션 종료 시점에 요약·결정·해결된 에러·신규 절차·미해결 질문을 narrative 형태로
 * 영속화한다. recall/context 와 동일한 `_meta` 구조를 사용하며 추가로
 * `_meta.link_suggestions[]` 를 포함한다.
 *
 * @param {Object} args - `{ summary[], decisions[], errors_resolved[],
 *   new_procedures[], open_questions[], narrative_summary, sessionId,
 *   task_effectiveness?, workspace? }`.
 * @returns {Promise<Object>} `{ success, count, ..., _meta }`.
 */
export async function tool_reflect(args) {
  const mgr = MemoryManager.getInstance();
  return withAudit("reflect", args, async (a, sessionId) => {
    const result = await mgr.reflect(a);
    SessionActivityTracker.record(sessionId, { tool: "reflect" }).catch(() => {});
    SessionActivityTracker.markReflected(sessionId).catch(() => {});
    /** recall/context 와 동일한 `_meta` 블록 + `link_suggestions[]` 동봉. */
    const { _link_suggestions, _searchEventId, _memento_hint, _suggestion, ...restResult } = result;
    return {
      response: {
        success: true,
        ...restResult,
        _meta: {
          searchEventId    : _searchEventId ?? null,
          hints            : _memento_hint ? [_memento_hint] : [],
          suggestion       : _suggestion ?? undefined,
          link_suggestions : Array.isArray(_link_suggestions) ? _link_suggestions : [],
          serverTime       : serverTimeMeta()
        }
      },
      auditOnSuccess: { sessionId: a.sessionId, count: result.count }
    };
  });
}

/**
 * 세션 시작 시 호출하는 Core/Working Memory 로더.
 *
 * preference/error/procedure/decision 등 지정된 type 의 앵커 파편과 최근
 * 활성 파편을 `tokenBudget` 한도 내에서 묶어 반환한다.
 *
 * @param {Object} args - `{ tokenBudget?, types?, structured?, workspace? }`.
 * @returns {Promise<Object>} `{ success, fragments, ..., _meta }`.
 */
export async function tool_context(args) {
  const mgr       = MemoryManager.getInstance();
  const sessionId = args._sessionId;
  delete args._sessionId;
  if (sessionId && !args.sessionId) args.sessionId = sessionId;
  try {
    const result = await mgr.context(args);
    SessionActivityTracker.record(sessionId, { tool: "context" }).catch(() => {});
    /** 응답 메타는 `_meta` 블록만 제공한다. */
    const { _memento_hint, _searchEventId, _suggestion, ...restResult } = result;
    return {
      success: true,
      ...restResult,
      _meta: {
        searchEventId : _searchEventId ?? null,
        hints         : _memento_hint ? [_memento_hint] : [],
        suggestion    : _suggestion ?? undefined,
        serverTime    : serverTimeMeta()
      }
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * 직전 도구 호출 결과의 유용성을 피드백으로 기록한다.
 *
 * `relevant=true` 이면 fragment_ids 간 링크 weight 를 reinforce, false 면
 * decay 한다 (`ENABLE_RECONSOLIDATION=true` 환경 변수 활성 시).
 *
 * @param {Object} args - `{ tool_name, relevant, sufficient?, fragment_ids?,
 *   search_event_id?, reason? }`.
 * @returns {Promise<Object>} `{ success, recorded, ... }`.
 */
export async function tool_toolFeedback(args) {
  delete args._sessionId;
  const mgr = MemoryManager.getInstance();
  try {
    const result = await mgr.toolFeedback(args);
    await logAudit("tool_feedback", {
      tool_name : args.tool_name,
      relevant  : args.relevant,
      sufficient: args.sufficient,
      success   : true
    });
    // reconsolidation: fragment_ids 간 링크를 decay(relevant=false) 또는 reinforce(relevant=true)
    if (process.env.ENABLE_RECONSOLIDATION === "true" && args.fragment_ids?.length > 0) {
      const action = args.relevant === false ? "decay" : "reinforce";
      const pool   = getPrimaryPool();
      if (pool) {
        pool.query(
          `SELECT id FROM agent_memory.fragment_links
           WHERE (from_id = ANY($1) OR to_id = ANY($1))
             AND deleted_at IS NULL`,
          [args.fragment_ids]
        ).then(({ rows }) => {
          for (const row of rows) {
            reconsolidate(row.id, action, {
              triggeredBy: `tool_feedback:${args.tool_name}`,
              keyId      : args._keyId ?? null
            }).catch(() => {});
          }
        }).catch(() => {});
      }
    }
    return { success: true, ...result };
  } catch (err) {
    await logAudit("tool_feedback", {
      tool_name: args.tool_name,
      success  : false,
      details  : err.message
    });
    return { success: false, error: err.message };
  }
}

/**
 * 저장소 사용량과 검색 품질 지표를 집계해 반환한다.
 *
 * `searchLatencyMs`, rolling Precision@5, task success rate, search
 * observability(최근 30일) 를 포함한다.
 *
 * @param {Object} args - 추가 인자 없음.
 * @returns {Promise<Object>} `{ success, stats: { ..., searchLatencyMs,
 *   evaluation, searchObservability } }`.
 */
export async function tool_memoryStats(args) {
  delete args._sessionId;
  const mgr = MemoryManager.getInstance();
  try {
    const result          = await mgr.stats();
    const searchMetrics   = await getSearchMetrics();
    const searchLatencyMs = await searchMetrics.getStats();

    const { computeRollingPrecision, computeTaskSuccessRate } = await import("../memory/signals/EvaluationMetrics.js");
    const [evaluation, taskSuccess, searchObs] = await Promise.all([
      computeRollingPrecision(100).catch(() => ({ precision_at_5: null, sample_sessions: 0, sufficient_rate: null })),
      computeTaskSuccessRate(30).catch(() => ({ success_rate: null, total_sessions: 0 })),
      getSearchObservability(30).catch(() => null)
    ]);

    return {
      success: true,
      stats: {
        ...result,
        searchLatencyMs,
        evaluation: {
          rolling_precision_at_5: evaluation.precision_at_5,
          sufficient_rate        : evaluation.sufficient_rate,
          sample_sessions        : evaluation.sample_sessions,
          task_success_rate      : taskSuccess.success_rate,
          task_sessions          : taskSuccess.total_sessions
        },
        searchObservability: searchObs
      }
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * 유사 파편을 묶어 대표 파편으로 통합하는 배치 작업.
 *
 * 마스터 키 전용. API 키 호출은 즉시 거절된다.
 *
 * @param {Object} args - `{ workspace?, dryRun? }`.
 * @param {Object} [options]
 * @param {Function} [options.onProgress] - 진행 콜백.
 * @returns {Promise<Object>} `{ success, merged?, summary?, error? }`.
 */
export async function tool_memoryConsolidate(args, { onProgress = null } = {}) {
  const keyId = args._keyId ?? null;
  delete args._sessionId;
  if (keyId != null) {
    return { success: false, error: "memory_consolidate is master-key only" };
  }
  const mgr = MemoryManager.getInstance();
  try {
    const result = await mgr.consolidate(onProgress);
    await logAudit("consolidate", {
      success: true,
      details: result.summary || undefined
    });
    return { success: true, ...result };
  } catch (err) {
    await logAudit("consolidate", { success: false, details: err.message });
    return { success: false, error: err.message };
  }
}

/**
 * 시작 fragment 로부터 그래프를 N-hop 탐색해 인접 노드·링크를 반환한다.
 *
 * @param {Object} args - `{ startId, depth?, relationTypes?, limit?,
 *   includeContent?, workspace? }`.
 * @returns {Promise<Object>} `{ success, nodes, edges, error? }`.
 */
export async function tool_graphExplore(args) {
  delete args._sessionId;
  const mgr = MemoryManager.getInstance();
  try {
    const result = await mgr.graphExplore(args);
    if (result.error) {
      return { success: false, ...result };
    }
    return { success: true, ...result };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * 단일 fragment 의 amend 이력·access trace·소속 case 이벤트를 시간순으로 반환한다.
 *
 * @param {Object} args - `{ id, limit?, includeAccessLog?, workspace? }`.
 * @returns {Promise<Object>} `{ success, history, error? }`.
 */
export async function tool_fragmentHistory(args) {
  delete args._sessionId;
  const mgr = MemoryManager.getInstance();
  try {
    const result = await mgr.fragmentHistory(args);
    if (result.error) {
      return { success: false, ...result };
    }
    return { success: true, ...result };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * recall 응답에 포함할 힌트를 생성한다.
 * AI가 다음 행동을 능동적으로 결정할 수 있도록 signal + suggestion을 제공.
 */
function buildRecallHint(fragments, args) {
  if (!fragments.length) {
    return {
      signal    : "no_results",
      suggestion: "이 주제에 대한 기억이 없습니다. 중요한 내용이라면 remember로 저장하세요.",
      trigger   : "remember"
    };
  }
  const stale = fragments.filter(f => f.age_days > 30);
  if (stale.length > 0) {
    return {
      signal    : "stale_results",
      suggestion: `${stale.length}개 파편이 30일 이상 경과했습니다. 내용이 여전히 유효한지 확인 후 amend로 갱신하거나 forget으로 정리하세요.`,
      trigger   : "amend"
    };
  }
  if (fragments.length >= 5 && !args.includeContext) {
    return {
      signal    : "consider_context",
      suggestion: "관련 파편이 많습니다. includeContext=true로 재검색하면 전후관계를 함께 볼 수 있습니다.",
      trigger   : "recall"
    };
  }
  return null;
}

/** SKILL.md 섹션 매핑 */
const SKILL_SECTIONS = {
  overview:      /^## 서버 개요[\s\S]*?(?=^## )/m,
  lifecycle:     /^## 세션 생명주기 프로토콜[\s\S]*?(?=^## )/m,
  keywords:      /^## 키워드 작성 규칙[\s\S]*?(?=^## )/m,
  search:        /^## 검색 전략 의사결정 트리[\s\S]*?(?=^## )/m,
  episode:       /^## 에피소드 기억 활용[\s\S]*?(?=^## )/m,
  multiplatform: /^## 다중 플랫폼[\s\S]*?(?=^## )/m,
  codex:         /^## Codex Desktop[\s\S]*?(?=^## )/m,
  tools:         /^## 도구 레퍼런스[\s\S]*?(?=^## 중요도)/m,
  importance:    /^## 중요도 기본값[\s\S]*?(?=^## )/m,
  experiential:  /^## 경험적 기억 활용[\s\S]*?(?=^## )/m,
  cbr:           /^## CBR[\s\S]*?(?=^## )/m,
  triggers:      /^## 능동 활용 트리거[\s\S]*?(?=^## )/m,
  antipatterns:  /^## 안티패턴[\s\S]*/m,
};

/**
 * SKILL.md 의 운영 가이드를 통째로 또는 섹션 단위로 반환한다.
 *
 * Mode preset(`_mode`) 가 활성이고 `section` 인자가 없으면 모드별 override
 * 텍스트가 우선 반환된다. 지원 섹션: overview, lifecycle, keywords, search,
 * episode, multiplatform, codex, tools, importance, experiential, cbr, triggers,
 * antipatterns.
 *
 * @param {Object} args - `{ section?: string }`.
 * @returns {Promise<Object>} `{ success, content, section?, mode?, error? }`.
 */
export async function tool_getSkillGuide(args) {
  try {
    /** Mode preset override: 섹션 지정이 없을 때 override 우선 반환 */
    const mode     = args?._mode   ?? null;
    const keyId    = args?._keyId  ?? null;
    const override = getSkillGuideOverride(mode, keyId === null);
    if (override && !args?.section) {
      return { success: true, mode, content: override };
    }

    const __filename = fileURLToPath(import.meta.url);
    const skillPath  = path.resolve(path.dirname(__filename), "..", "..", "SKILL.md");
    const content    = fs.readFileSync(skillPath, "utf8");
    const section    = args?.section;

    if (section && SKILL_SECTIONS[section]) {
      const match = content.match(SKILL_SECTIONS[section]);
      if (match) return { success: true, section, content: match[0].trim() };
      return { success: false, error: `Section '${section}' not found in SKILL.md` };
    }

    return { success: true, content };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * session_rotate 도구 핸들러
 *
 * 현재 세션을 종료하고 동일 컨텍스트(keyId/workspace/permissions)를 이관한 새 세션을 발급한다.
 * rotate 이벤트는 session-audit.log에 NDJSON으로 기록된다 (sessionId 원문은 sha256 16자 해시로만 저장).
 *
 * @param {object} args  - { reason?: string, _sessionId, _keyId, _clientIp?, _userAgent? }
 * @returns {{ success: boolean, newSessionId?: string, expiresAt?: number, rotatedAt?: string, error?: string }}
 */
export async function tool_sessionRotate(args) {
  const sessionId  = args._sessionId  ?? null;
  const keyId      = args._keyId      ?? null;
  const clientIp   = args._clientIp   ?? "unknown";
  const userAgent  = args._userAgent  ?? "unknown";
  const reason     = typeof args.reason === "string" ? args.reason.slice(0, 256) : "user_request";

  if (!sessionId) {
    return { success: false, error: "No active session to rotate" };
  }

  try {
    const rotated = await rotateSession(sessionId, { reason });

    /** 감사 로그 기록 — 실패해도 rotate 결과에 영향 없음 */
    logSessionRotate({
      keyId,
      oldSessionId: rotated.oldSessionId,
      newSessionId: rotated.newSessionId,
      reason,
      clientIp,
      userAgent
    }).catch(() => {});

    return {
      success      : true,
      newSessionId : rotated.newSessionId,
      expiresAt    : rotated.expiresAt,
      rotatedAt    : new Date().toISOString()
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * async batch_remember job 의 상태를 조회한다.
 * @param {{jobId: string}} args
 * @returns {Promise<{success: boolean, jobId: string, status: object|null}>}
 */
export async function tool_batchStatus(args) {
  const { getBatchJobStatus } = await import("../redis.js");
  const status = await getBatchJobStatus(args.jobId);
  return { success: true, jobId: args.jobId, status };
}
