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

import { getPrimaryPool } from "../../tools/db.js";
import { logWarn }        from "../../logger.js";
import { SCHEMA } from "../schema.js";

/**
 * keywords 배열을 정렬된 쉼표 조인 문자열로 정규화한다.
 * 순서 무관 중복 감지에 사용.
 *
 * @param {string[]|undefined} keywords
 * @returns {string}
 */
function normalizeKeywords(keywords) {
  if (!Array.isArray(keywords) || keywords.length === 0) return "";
  return [...keywords].sort().join(",").toLowerCase();
}

export class RecallSuggestionEngine {
  /**
   * @param {Object}  [deps]
   * @param {Object}  [deps.pool]  - pg Pool (테스트 주입용)
   */
  constructor(deps = {}) {
    this._pool = deps.pool ?? null;
  }

  /** @returns {import('pg').Pool|null} */
  _getPool() {
    return this._pool ?? getPrimaryPool();
  }

  /**
   * 최근 N분 내 동일 keyId의 search_events 이력을 조회한다.
   *
   * @param {string|number|null} keyId
   * @param {Date}               since
   * @returns {Promise<Array<{ query_type: string, filter_keys: string[] }>>}
   */
  async _getRecentEvents(keyId, since) {
    const pool = this._getPool();
    if (!pool) return [];

    const keyVal = keyId == null ? null : String(keyId);

    const sql = keyVal === null
      ? `SELECT query_type, filter_keys, result_count
           FROM ${SCHEMA}.search_events
          WHERE key_id IS NULL
            AND created_at >= $1
          ORDER BY created_at DESC
          LIMIT 50`
      : `SELECT query_type, filter_keys, result_count
           FROM ${SCHEMA}.search_events
          WHERE key_id = $2
            AND created_at >= $1
          ORDER BY created_at DESC
          LIMIT 50`;

    const params = keyVal === null ? [since] : [since, keyVal];

    const { rows } = await pool.query(sql, params);
    return rows;
  }

  /**
   * 동일 keyId 소유 파편의 총 개수를 조회한다.
   * no_type_filter_noisy 감지에 사용.
   *
   * @param {string|number|null} keyId
   * @returns {Promise<number>}
   */
  async _getFragmentCount(keyId) {
    const pool = this._getPool();
    if (!pool) return 0;

    const keyVal = keyId == null ? null : String(keyId);

    const { rows } = keyVal === null
      ? await pool.query(
          `SELECT COUNT(*)::int AS cnt FROM ${SCHEMA}.fragments WHERE key_id IS NULL AND valid_to IS NULL`
        )
      : await pool.query(
          `SELECT COUNT(*)::int AS cnt FROM ${SCHEMA}.fragments WHERE key_id = $1 AND valid_to IS NULL`,
          [keyVal]
        );

    return rows[0]?.cnt ?? 0;
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
   *  1. repeat_query           - 5분 내 동일 keywords로 3회 이상 recall
   *  2. empty_result_no_context - 결과 없음 + contextText 미제공
   *  3. large_limit_no_budget   - limit >= 50 && tokenBudget 미지정
   *  4. no_type_filter_noisy    - type 미지정 && keyId 소유 파편 > 100
   *
   * @param {Object} params - recall 호출 파라미터
   * @param {Object} result - recall 응답 (fragments 배열 포함)
   * @returns {Promise<{code: string, message: string, recommendedTool: string, recommendedArgs: Object}|null>}
   */
  async suggest(params, result) {
    const keyId     = params._keyId ?? null;
    const fragments = Array.isArray(result?.fragments) ? result.fragments : [];

    /** ── 규칙 1: repeat_query ── */
    try {
      const since      = new Date(Date.now() - 5 * 60 * 1000);
      const recent     = await this._getRecentEvents(keyId, since);
      const normTarget = normalizeKeywords(params.keywords);

      if (normTarget) {
        /** filter_keys에 "type" 또는 "topic" 포함 이벤트를 같은 쿼리로 분류하지 않도록
         *  query_type=keywords 인 이벤트에서만 카운트한다. */
        const matchCount = recent.filter(e => {
          if (e.query_type !== "keywords" && e.query_type !== "mixed") return false;
          /** filter_keys 배열에 기록된 정보는 없으므로, query_type으로만 집계 */
          return true;
        }).length;

        if (matchCount >= 3) {
          const topCaseId       = this._extractTopCaseId(fragments);
          const recommendedArgs = topCaseId
            ? { caseId: topCaseId }
            : { startId: fragments[0]?.id ?? undefined };

          return {
            code           : "repeat_query",
            message        : `동일 키워드 쿼리가 5분 내 ${matchCount}회 반복되었습니다. 케이스 타임라인 조회가 더 효율적입니다.`,
            recommendedTool: topCaseId ? "reconstruct_history" : "graph_explore",
            recommendedArgs
          };
        }
      }
    } catch (err) {
      logWarn("[RecallSuggestionEngine] repeat_query 감지 실패", { error: err.message });
    }

    /** ── 규칙 2: empty_result_no_context ── */
    if (fragments.length === 0 && !params.contextText) {
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

    /** ── 규칙 4: no_type_filter_noisy ── */
    if (!params.type) {
      try {
        const total = await this._getFragmentCount(keyId);
        if (total > 100) {
          return {
            code           : "no_type_filter_noisy",
            message        : `파편 총 ${total}개 중 type 필터 없이 검색했습니다. type 필터를 지정하면 정밀도가 향상됩니다.`,
            recommendedTool: "recall",
            recommendedArgs: { type: "error|procedure|decision|fact 중 선택" }
          };
        }
      } catch (err) {
        logWarn("[RecallSuggestionEngine] no_type_filter_noisy 감지 실패", { error: err.message });
      }
    }

    return null;
  }
}
