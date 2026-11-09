/**
 * RecallSuggestionEngine - recall 응답에 비침습적 사용 패턴 힌트 제공
 *
 * 작성자: 최진호
 * 작성일: 2026-04-18
 *
 * Serena의 PreToolUse Hook이 강제 차단(denied)하는 방식과 달리,
 * recall 응답의 _suggestion 메타 필드에 힌트를 주입하여
 * 클라이언트가 자율적으로 더 적합한 도구를 선택할 수 있도록 안내한다.
 * 실패 시 null 반환(fail-open)으로 기존 recall 응답에 영향을 주지 않는다.
 */

import { spreadingActivationEnabled } from "../../config.js";

/** repeat_query가 호출을 세는 구간 */
const REPEAT_WINDOW_MS = 5 * 60 * 1000;
/** 구간 안에서 이 횟수에 이르면 반복으로 본다 */
const REPEAT_THRESHOLD = 3;
/** 기억해 둘 키와 keywords 조합의 상한. 넘으면 가장 오래 쓰지 않은 조합부터 지운다 */
const REPEAT_TRACK_MAX = 1000;
/** keywords와 함께 결과를 바꾸는 검색 조건. 모두 같아야 같은 질의로 센다 */
const REPEAT_QUERY_FIELDS = ["text", "topic", "type", "workspace", "caseId"];

/**
 * keywords 배열을 정렬된 쉼표 조인 문자열로 정규화한다.
 * 순서 무관 중복 감지에 사용.
 *
 * @param {string[]|undefined} keywords
 * @returns {string}
 */
function normalizeKeywords(keywords) {
  if (!Array.isArray(keywords) || keywords.length === 0) return "";
  return keywords.map(k => String(k).toLowerCase()).sort().join(",");
}

/**
 * 반복 판정에 쓰는 질의 식별 문자열.
 *
 * @param {Object} params
 * @param {string} normalizedKeywords
 * @returns {string}
 */
function repeatSignature(params, normalizedKeywords) {
  return JSON.stringify([normalizedKeywords, ...REPEAT_QUERY_FIELDS.map(f => params[f] ?? null)]);
}

export class RecallSuggestionEngine {
  /**
   * @param {Object}         [deps]
   * @param {() => number}   [deps.now] - 현재 시각(ms). 시험에서 주입한다
   */
  constructor(deps = {}) {
    this._now           = deps.now ?? Date.now;
    /** @type {Map<string, number[]>} 키와 keywords 조합별 최근 호출 시각 */
    this._recentQueries = new Map();
  }

  /**
   * 이번 호출을 기록하고 구간 안의 같은 질의 횟수를 돌려준다. search_events에 검색어가 없어 프로세스 메모리에서 센다.
   *
   * @param {string|number|null} keyId
   * @param {string}             signature
   * @returns {number}
   */
  _countRepeat(keyId, signature) {
    const entry = `${keyId ?? ""}\u0000${signature}`;
    const now   = this._now();
    const times = (this._recentQueries.get(entry) ?? []).filter(t => now - t < REPEAT_WINDOW_MS);
    times.push(now);
    this._recentQueries.delete(entry);
    this._recentQueries.set(entry, times);
    if (this._recentQueries.size > REPEAT_TRACK_MAX) {
      this._recentQueries.delete(this._recentQueries.keys().next().value);
    }
    return times.length;
  }

  /**
   * 반환된 fragments에서 가장 빈번한 case_id를 추출한다.
   *
   * @param {Array<{ case_id?: string }>} fragments
   * @returns {string|null}
   */
  _extractTopCaseId(fragments) {
    if (!Array.isArray(fragments) || fragments.length === 0) return null;

    /** @type {Map<string, number>} */
    const freq = new Map();
    for (const f of fragments) {
      if (f.case_id) freq.set(f.case_id, (freq.get(f.case_id) ?? 0) + 1);
    }
    if (freq.size === 0) return null;

    let topId    = null;
    let topCount = 0;
    for (const [id, count] of freq) {
      if (count > topCount) { topId = id; topCount = count; }
    }
    return topId;
  }

  /**
   * recall 파라미터와 결과를 분석하여 사용 패턴 힌트를 반환한다.
   *
   * 감지 규칙 (우선순위 순):
   *  1. repeat_query           - 5분 내 같은 검색 조건으로 3회 이상 recall (cursor 호출 제외)
   *  2. empty_result_no_context - 결과 없음 + contextText 미제공
   *  3. large_limit_no_budget   - limit >= 50 && tokenBudget 미지정
   *
   * @param {Object} params - recall 호출 파라미터
   * @param {Object} result - recall 응답 (fragments 배열 포함)
   * @returns {Promise<{code: string, message: string, recommendedTool: string, recommendedArgs: Object}|null>}
   */
  async suggest(params, result) {
    const keyId     = params._keyId ?? null;
    const fragments = Array.isArray(result?.fragments) ? result.fragments : [];

    /** ── 규칙 1: repeat_query ── */
    const normalized = normalizeKeywords(params.keywords);
    /** cursor 호출은 같은 검색의 다음 페이지라 반복이 아니다. */
    if (normalized && !params.cursor) {
      const repeats = this._countRepeat(keyId, repeatSignature(params, normalized));
      if (repeats >= REPEAT_THRESHOLD) {
        const topCaseId       = this._extractTopCaseId(fragments);
        const recommendedArgs = topCaseId
          ? { caseId: topCaseId }
          : { startId: fragments[0]?.id ?? undefined };

        return {
          code           : "repeat_query",
          message        : `동일 키워드 쿼리가 5분 내 ${repeats}회 반복되었습니다. 케이스 타임라인 조회가 더 효율적입니다.`,
          recommendedTool: topCaseId ? "reconstruct_history" : "graph_explore",
          recommendedArgs
        };
      }
    }

    /** ── 규칙 2: empty_result_no_context ── contextText는 SpreadingActivation이 켜진 서버에서만 효과가 있다. */
    if (fragments.length === 0 && !params.contextText && spreadingActivationEnabled()) {
      return {
        code           : "empty_result_no_context",
        message        : "검색 결과가 없습니다. contextText에 1~2문장 맥락을 추가하면 SpreadingActivation이 이웃 파편을 부스트합니다.",
        recommendedTool: "recall",
        recommendedArgs: { contextText: "(현재 작업 맥락을 1~2문장으로 기술하세요)" }
      };
    }

    /** ── 규칙 3: large_limit_no_budget ── */
    const limitVal = params.limit ?? 0;
    if (limitVal >= 50 && !params.tokenBudget) {
      return {
        code           : "large_limit_no_budget",
        message        : `limit=${limitVal}이지만 tokenBudget이 지정되지 않았습니다. 토큰 초과 응답이 발생할 수 있습니다.`,
        recommendedTool: "recall",
        recommendedArgs: { tokenBudget: 2000 }
      };
    }

    return null;
  }
}
