/**
 * AutoReflect - 세션 종료 시 자동 reflect 오케스트레이터
 *
 * 작성자: 최진호
 * 작성일: 2026-02-28
 *
 * 세션 종료/만료 시점에 SessionActivityTracker 로그를 기반으로
 * MemoryManager.reflect()를 자동 호출한다.
 *
 * Gemini CLI 가용 시: 활동 로그 기반 구조화 요약 생성 후 reflect
 * Gemini CLI 불가 시: 최소 fact 파편(세션 메타데이터)만 생성
 */

import { SessionActivityTracker } from "./SessionActivityTracker.js";
import { MemoryManager } from "../MemoryManager.js";
import { geminiCLIJson, isGeminiCLIAvailable } from "../../gemini.js";
import { logDebug, logInfo, logWarn } from "../../logger.js";

/** 빈 세션 판정 최소 지속시간 (밀리초) */
export const MIN_SESSION_DURATION_MS = 30_000;

/** Gemini CLI 호출 타임아웃 (밀리초)
 *
 * Phase 6: 외부 게이트웨이(claude.ai MCP 프록시) 60s 컷오프 대비 30s 마진 확보.
 * 40_000 → 30_000으로 단축. 회귀 방지용 export — tests/unit/auto-reflect.test.js가 이 값을 검증한다.
 * 절대 40_000 이상으로 되돌리지 말 것.
 */
export const GEMINI_TIMEOUT_MS = 30_000;

/**
 * 세션에 대한 자동 reflect 수행
 *
 * @param {string} sessionId
 * @param {string} [agentId="default"]
 * @returns {Promise<Object|null>} reflect 결과 또는 null
 */
export async function autoReflect(sessionId, agentId = "default") {
  if (!sessionId) return null;

  try {
    const activity = await SessionActivityTracker.getActivity(sessionId);

    /** 활동 로그가 없거나 이미 reflected 상태 */
    if (!activity || activity.reflected) return null;

    /** skip 판정: 빈 세션 또는 사용자가 이미 명시적 remember로 파편을 저장한 세션 */
    if (_shouldSkipReflect(activity)) {
      logDebug(`[AutoReflect] Skipping reflect for session: ${sessionId}`);
      await SessionActivityTracker.markReflected(sessionId);
      return { count: 0, fragments: [], skipped: true, reason: "skip_gated" };
    }

    const mgr = MemoryManager.getInstance();

    if (await isGeminiCLIAvailable()) {
      return await _reflectWithGemini(mgr, sessionId, agentId, activity);
    }

    /** Gemini 불가 시: 저품질 메타 요약 생성 방지를 위해 reflect 스킵 */
    logDebug(`[AutoReflect] Gemini CLI unavailable, skipping reflect for session: ${sessionId}`);
    await SessionActivityTracker.markReflected(sessionId);
    return { count: 0, fragments: [], skipped: true, reason: "gemini_unavailable" };
  } catch (err) {
    logWarn(`[AutoReflect] Failed for session ${sessionId}: ${err.message}`);
    return null;
  }
}

/**
 * Gemini CLI 기반 구조화 요약 reflect
 */
async function _reflectWithGemini(mgr, sessionId, agentId, activity) {
  const { systemPrompt, userPrompt } = _buildReflectPrompts(sessionId, activity);

  try {
    const result = await geminiCLIJson(userPrompt, { timeoutMs: GEMINI_TIMEOUT_MS, systemPrompt });

    /** summary 없음 또는 모든 배열이 비면 skip (프롬프트가 빈 배열 반환을 명시적으로 허용하므로) */
    const hasAnyContent = (arr) => Array.isArray(arr) && arr.length > 0;
    const isAllEmpty = !hasAnyContent(result.summary)
                       && !hasAnyContent(result.decisions)
                       && !hasAnyContent(result.errors_resolved)
                       && !hasAnyContent(result.new_procedures)
                       && !hasAnyContent(result.open_questions)
                       && !result.narrative_summary;
    if (isAllEmpty) {
      logDebug(`[AutoReflect] Gemini returned all-empty arrays for session: ${sessionId}`);
      await SessionActivityTracker.markReflected(sessionId);
      return { count: 0, fragments: [], skipped: true, reason: "gemini_empty_result" };
    }

    const reflectResult = await mgr.reflect({
      sessionId,
      agentId,
      summary:             result.summary,
      decisions:           result.decisions || [],
      errors_resolved:     result.errors_resolved || [],
      new_procedures:      result.new_procedures || [],
      open_questions:      result.open_questions || [],
      narrative_summary:   result.narrative_summary || null
    });

    /** LEARNING: 접두사 항목의 source를 learning_extraction으로 설정 */
    if (reflectResult.fragments) {
      for (const item of reflectResult.fragments) {
        if (typeof item.content === "string" && item.content.startsWith("LEARNING:")) {
          item.source  = "learning_extraction";
          item.content = item.content.replace(/^LEARNING:\s*/, "");
        }
      }
    }

    await SessionActivityTracker.markReflected(sessionId);
    logInfo(`[AutoReflect] Gemini-based reflect completed for ${sessionId}: ${reflectResult.count} fragments`);
    return reflectResult;

  } catch (err) {
    logWarn(`[AutoReflect] Gemini summarization failed, skipping reflect: ${err.message}`);
    await SessionActivityTracker.markReflected(sessionId);
    return { count: 0, fragments: [], skipped: true, reason: "gemini_error" };
  }
}

/**
 * 빈 세션 판정
 *
 * 다음 조건 중 하나라도 해당하면 빈 세션으로 간주:
 * - 세션 활동 로그(toolCalls)가 0건
 * - 생성된 파편이 0개
 * - 세션 지속시간 < 30초
 */
function _isEmptySession(activity) {
  const hasNoToolCalls = !activity.toolCalls || Object.keys(activity.toolCalls).length === 0;
  const hasNoFragments = !activity.fragments || activity.fragments.length === 0;

  let isTooShort = false;
  if (activity.startedAt && activity.lastActivity) {
    const durationMs = new Date(activity.lastActivity) - new Date(activity.startedAt);
    isTooShort       = durationMs < MIN_SESSION_DURATION_MS;
  } else {
    /** startedAt 또는 lastActivity 누락 시 지속시간 판정 불가 → 초단 세션 취급 */
    isTooShort = true;
  }

  return hasNoToolCalls || hasNoFragments || isTooShort;
}

/**
 * reflect 스킵 판정 (빈 세션 OR 사용자가 이미 명시적 remember로 파편을 저장한 세션)
 *
 * 다음 중 하나라도 해당하면 skip:
 * - activity가 null/undefined
 * - _isEmptySession이 true (toolCalls 없음 OR duration 부족)
 * - fragments 배열 길이 >= 1 (이미 의미 있는 기록이 있으므로 중복 요약 불필요)
 *
 * 주의: _isEmptySession의 hasNoFragments 조건은 여기서 재사용하지 않는다.
 * fragments=0인 세션은 Gemini 요약 대상이므로 skip false를 반환해야 한다.
 *
 * @param {Object|null} activity
 * @returns {boolean}
 */
function _shouldSkipReflect(activity) {
  if (!activity) return true;

  /** toolCalls 없음 → 의미 없는 세션 */
  const hasNoToolCalls = !activity.toolCalls || Object.keys(activity.toolCalls).length === 0;
  if (hasNoToolCalls) return true;

  /** duration < 30초 → 초단 세션 */
  let isTooShort = false;
  if (activity.startedAt && activity.lastActivity) {
    const durationMs = new Date(activity.lastActivity) - new Date(activity.startedAt);
    isTooShort       = durationMs < MIN_SESSION_DURATION_MS;
  } else {
    isTooShort = true;
  }
  if (isTooShort) return true;

  /** 사용자가 이미 명시적 remember로 파편을 저장한 세션 → 중복 요약 불필요 */
  const explicitCount = Array.isArray(activity.fragments) ? activity.fragments.length : 0;
  if (explicitCount >= 1) return true;

  return false;
}

/**
 * 세션 소요 시간 계산
 */
function _calcDuration(startedAt, lastActivity) {
  if (!startedAt || !lastActivity) return "알 수 없음";

  const ms   = new Date(lastActivity) - new Date(startedAt);
  const mins = Math.floor(ms / 60000);

  if (mins < 1) return "1분 미만";
  if (mins < 60) return `${mins}분`;

  const hours = Math.floor(mins / 60);
  const rem   = mins % 60;
  return `${hours}시간 ${rem}분`;
}

/**
 * Reflect 프롬프트 쌍 생성 (순수 함수)
 *
 * memory-schemas.js의 remember 도구 가이드와 동일한 자기완결성 5원칙을 user prompt에 주입한다.
 * system prompt는 영어로 JSON-only 출력을 엄격히 지시한다.
 *
 * @param {string} sessionId
 * @param {Object} activity - SessionActivityTracker.getActivity 반환값
 * @returns {{ systemPrompt: string, userPrompt: string }}
 */
function _buildReflectPrompts(sessionId, activity) {
  const toolEntries = Object.entries(activity.toolCalls || {});
  const toolSummary = toolEntries.length > 0
    ? toolEntries.map(([tool, count]) => `${tool}: ${count}회`).join(", ")
    : "없음";

  const kwList    = (activity.keywords || []).slice(0, 20).join(", ") || "없음";
  const fragCount = (activity.fragments || []).length;
  const duration  = _calcDuration(activity.startedAt, activity.lastActivity);

  /** System prompt — 외부 LLM이 JSON 객체만 출력하도록 엄격히 지시 */
  const systemPrompt =
    "You are a JSON object generator for AI agent session summarization. " +
    "Your ONLY output MUST be a valid JSON object matching the exact schema specified by the user. " +
    "Do NOT include markdown fences, explanations, reasoning, preambles, or ANY other text. " +
    "Output must be directly parseable by JSON.parse(). " +
    "All string values must follow the self-containment rules stated in the user prompt. " +
    "If any field has no concrete content, return an empty array for that field rather than inventing data.";

  /** User prompt — 기존 한국어 프롬프트 + 자기완결성 5원칙 그대로 유지 */
  const userPrompt = `다음 AI 에이전트 세션 활동 로그를 분석하여 구조화된 기억 파편을 생성하라.

세션 ID: ${sessionId}
소요 시간: ${duration}
도구 사용: ${toolSummary}
검색 키워드: ${kwList}
생성/접근한 파편 수: ${fragCount}

다음 JSON 형식으로 응답하라:
{
  "summary": ["세션에서 수행한 작업을 1~2문장짜리 항목으로 쪼갠 배열. 항목 1개 = 사실 1건"],
  "decisions": ["결정 1건만 서술"],
  "errors_resolved": ["원인: X → 해결: Y 형식으로 에러 1건만 서술"],
  "new_procedures": ["절차 1개만 서술"],
  "open_questions": ["미해결 질문 1건만 서술"],
  "narrative_summary": "이 세션에서 무슨 일이 있었는지 3~5문장의 서사로 작성. 사실 나열이 아니라 이야기로 써라."
}

자기완결성 5원칙 (모든 배열 항목과 narrative_summary가 모두 준수해야 함):
1) 대명사·지시어 해소 — '그것', '이 에러', '이전에', '위에서 말한' 금지. 항상 구체 고유명으로 대체한다.
2) 구체 엔티티·수치 포함 — '포트 바꿨다' 금지, '인증 서비스 포트를 8080에서 15000으로 변경' 허용.
3) 메타·자기참조 금지 — '세션 요약', '자동 요약', '도구 N회 사용', '이번 대화에서', '현재 작업 중' 같은 자기참조 문자열 생성 금지. 시스템 상태가 아니라 사실 자체만 남긴다.
4) 원자성 — 독립 주제 두 개 이상이면 배열 항목을 각각 나눈다. 한 항목에 여러 사실 나열 금지.
5) 인과 결합 예외 — 분리하면 의미가 손상되는 원인-결과, 조건-결정은 한 항목에 유지한다.

판단 테스트: 각 항목을 생성하기 전에 스스로 물어라. '이 문장을 6개월 후 처음 보는 다른 AI가 읽어도 무슨 프로젝트의 무슨 문제인지 특정할 수 있는가?' 아니라면 해당 항목을 생성하지 말고 빈 배열로 반환한다.

중요 규칙:
- 입력 로그에 구체 사실이 없으면 해당 배열을 빈 배열([])로 반환. 억지로 채우지 말 것.
- 모든 배열이 빈 배열이어도 괜찮다. 품질 없는 요약보다 빈 응답이 낫다.
- 내용이 많으면 축약하지 말고 항목 수를 늘릴 것.
- 검색 패턴이나 도구 사용 패턴에서 학습할 수 있는 인사이트가 있다면, 해당 항목 앞에 "LEARNING:" 접두사를 붙여라.`;

  return { systemPrompt, userPrompt };
}

export {
  _isEmptySession,
  _shouldSkipReflect,
  _buildReflectPrompts,
  _buildReflectPrompts as _buildGeminiPrompt
};
