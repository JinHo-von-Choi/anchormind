/**
 * 도구: 에이전트 기억 관리 (Fragment-Based Memory)
 *
 * 작성자: 최진호
 * 작성일: 2026-02-23
 * 수정일: 2026-03-29
 *
 * MCP 도구 핸들러
 * remember, recall, forget, link, amend, reflect, context, memory_stats, memory_consolidate, graph_explore, fragment_history
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryManager }    from "../memory/MemoryManager.js";
import { getSkillGuideOverride } from "../memory/ModeRegistry.js";
import { logAudit }         from "../utils.js";
import { logWarn }          from "../logger.js";
import { SessionActivityTracker } from "../memory/SessionActivityTracker.js";
import { getSearchMetrics } from "../memory/SearchMetrics.js";
import { getSearchObservability } from "../memory/SearchEventAnalyzer.js";
import { reconsolidate }         from "../memory/ReconsolidationEngine.js";
import { getPrimaryPool }        from "./db.js";
import { computeConfidence } from "../memory/UtilityBaseline.js";
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
  sessionRotateDefinition
} from "./memory-schemas.js";

/** ==================== 도구 핸들러 ==================== */

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

export async function tool_batchRemember(args, { onProgress = null } = {}) {
  const mgr       = MemoryManager.getInstance();
  const sessionId = args._sessionId;
  delete args._sessionId;
  if (sessionId && !args.sessionId) args.sessionId = sessionId;
  try {
    const result = await mgr.batchRemember(args, onProgress);
    await logAudit("batch_remember", {
      total    : args.fragments?.length || 0,
      inserted : result.inserted,
      skipped  : result.skipped,
      success  : true
    });
    SessionActivityTracker.record(sessionId, {
      tool: "batch_remember", inserted: result.inserted
    }).catch(() => {});
    return { success: true, ...result };
  } catch (err) {
    await logAudit("batch_remember", {
      total  : args.fragments?.length || 0,
      success: false,
      details: err.message
    });
    return { success: false, error: err.message };
  }
}

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
      /** v3.1.0: top-level _searchEventId / _memento_hint mirror 제거. _meta 단독 제공 */
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
    /** v3.1.0: top-level _searchEventId / _memento_hint mirror 제거. _meta 단독 제공 */
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

export async function tool_forget(args) {
  const mgr       = MemoryManager.getInstance();
  const sessionId = args._sessionId;
  delete args._sessionId;
  if (sessionId && !args.sessionId) args.sessionId = sessionId;
  try {
    const result = await mgr.forget(args);
    await logAudit("forget", {
      fragmentId: args.id   || "-",
      topic     : args.topic || "-",
      success   : true,
      details   : result.deleted ? `deleted ${result.deleted}` : undefined
    });
    SessionActivityTracker.record(sessionId, { tool: "forget" }).catch(() => {});
    return { success: true, ...result };
  } catch (err) {
    await logAudit("forget", {
      fragmentId: args.id || "-",
      success   : false,
      details   : err.message
    });
    return { success: false, error: err.message };
  }
}

export async function tool_link(args) {
  const mgr       = MemoryManager.getInstance();
  const sessionId = args._sessionId;
  delete args._sessionId;
  if (sessionId && !args.sessionId) args.sessionId = sessionId;
  try {
    /** Phase 3 LinkIntegrityChecker advisory: 방향성 링크 순환 사전 경고.
     * 차단하지 않음. hasCycle=true 시 checkCycle 내부에서 symbolicMetrics.recordWarning 처리.
     * fromId/toId/relationType 세 값이 모두 있어야 유의미한 체크 가능. */
    try {
      if (args.fromId && args.toId && args.relationType && mgr.linkChecker) {
        const cycleResult = await mgr.linkChecker.checkCycle(
          args.fromId,
          args.toId,
          args.relationType,
          args.agentId || "default",
          args._keyId ?? null
        );
        if (cycleResult.hasCycle) {
          logWarn("link advisory: cycle detected", {
            fromId      : args.fromId,
            toId        : args.toId,
            relationType: args.relationType,
            reason      : cycleResult.reason,
            ruleVersion : cycleResult.ruleVersion
          });
        }
      }
    } catch {
      /** fail-open: checkCycle 내부 예외는 무시하고 기존 link 경로 진행 */
    }

    const result = await mgr.link(args);
    await logAudit("link", {
      fragmentId: args.fromId || "-",
      success   : true,
      details   : `${args.fromId} -> ${args.toId}`
    });
    SessionActivityTracker.record(sessionId, { tool: "link" }).catch(() => {});
    return { success: true, ...result };
  } catch (err) {
    await logAudit("link", {
      success: false,
      details: err.message
    });
    return { success: false, error: err.message };
  }
}

export async function tool_amend(args) {
  const mgr       = MemoryManager.getInstance();
  const sessionId = args._sessionId;
  delete args._sessionId;
  if (sessionId && !args.sessionId) args.sessionId = sessionId;
  try {
    const result = await mgr.amend(args);
    await logAudit("amend", {
      fragmentId: args.id,
      success   : result.updated,
      details   : result.merged ? `merged with ${result.existingId}` : undefined
    });
    SessionActivityTracker.record(sessionId, { tool: "amend", fragmentId: args.id }).catch(() => {});
    return { success: result.updated, ...result };
  } catch (err) {
    await logAudit("amend", {
      fragmentId: args.id,
      success   : false,
      details   : err.message
    });
    return { success: false, error: err.message };
  }
}

export async function tool_reflect(args) {
  const mgr       = MemoryManager.getInstance();
  const sessionId = args._sessionId;
  delete args._sessionId;
  if (sessionId && !args.sessionId) args.sessionId = sessionId;
  try {
    const result = await mgr.reflect(args);
    await logAudit("reflect", {
      sessionId : args.sessionId,
      count     : result.count,
      success   : true
    });
    SessionActivityTracker.record(sessionId, { tool: "reflect" }).catch(() => {});
    SessionActivityTracker.markReflected(sessionId).catch(() => {});
    /** v4.2.0: _meta 블록 신설. recall/context와 동일 구조 + link_suggestions[]. */
    const { _link_suggestions, _searchEventId, _memento_hint, _suggestion, ...restResult } = result;
    return {
      success: true,
      ...restResult,
      _meta: {
        searchEventId    : _searchEventId ?? null,
        hints            : _memento_hint ? [_memento_hint] : [],
        suggestion       : _suggestion ?? undefined,
        link_suggestions : Array.isArray(_link_suggestions) ? _link_suggestions : [],
        serverTime       : serverTimeMeta()
      }
    };
  } catch (err) {
    await logAudit("reflect", {
      success: false,
      details: err.message
    });
    return { success: false, error: err.message };
  }
}

export async function tool_context(args) {
  const mgr       = MemoryManager.getInstance();
  const sessionId = args._sessionId;
  delete args._sessionId;
  if (sessionId && !args.sessionId) args.sessionId = sessionId;
  try {
    const result = await mgr.context(args);
    SessionActivityTracker.record(sessionId, { tool: "context" }).catch(() => {});
    /** v3.1.0: top-level _memento_hint mirror 제거. _meta 단독 제공 */
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

export async function tool_memoryStats(args) {
  delete args._sessionId;
  const mgr = MemoryManager.getInstance();
  try {
    const result          = await mgr.stats();
    const searchMetrics   = await getSearchMetrics();
    const searchLatencyMs = await searchMetrics.getStats();

    const { computeRollingPrecision, computeTaskSuccessRate } = await import("../memory/EvaluationMetrics.js");
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
  tools:         /^## 도구 레퍼런스[\s\S]*?(?=^## 중요도)/m,
  importance:    /^## 중요도 기본값[\s\S]*?(?=^## |$)/m,
  experiential:  /^## 경험적 기억 활용[\s\S]*?(?=^## )/m,
  cbr:           /^## CBR[\s\S]*?(?=^## )/m,
  triggers:      /^## 능동 활용 트리거[\s\S]*?(?=^## |$)/m,
  antipatterns:  /^## 안티패턴[\s\S]*/m,
};

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
