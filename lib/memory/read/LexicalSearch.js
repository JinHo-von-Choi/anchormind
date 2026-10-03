/**
 * LexicalSearch - 본문 어휘 채널(L2b)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 질의 text를 저장 경로와 같은 방법(LexicalTokens)으로 토큰화해 OR tsquery를 만들고, content_tokens가
 * 일치하는 파편 가운데 키, workspace, agent 범위와 검색 필터를 통과한 상위 LEXICAL_CANDIDATE_LIMIT건을
 * ts_rank_cd 순으로 돌려준다. ts_rank_cd는 문서 하나와 질의만 보고 전역 문서 빈도 통계를 쓰지 않으므로
 * 다른 키의 자료가 순위에 영향을 주지 않는다. content_tokens가 NULL인 행(채우기 전)은 일치하지 않는다.
 *
 * 후보에는 _lexicalScore(그 검색의 최고 ts_rank_cd 대비 0~1)를 붙인다. FragmentSearch는 이 후보를 RRF의
 * lexical 계층으로 합치고(임베딩이 꺼진 대체 경로에서는 뒤에 붙이고), recall 최종 점수는 _lexicalScore를
 * lexical 가산에 쓴다.
 *
 * 참여 여부는 MEMENTO_LEXICAL_CHANNEL과 LexicalSchema의 상태(열, GIN 색인)로 정한다.
 */

import { queryWithAgentVector }                 from "../../tools/db.js";
import { lexicalChannelEnabled }                from "../../config.js";
import { logWarn }                              from "../../logger.js";
import { SCHEMA }                               from "../schema.js";
import { keyScopeCondition }                    from "../keyScope.js";
import { liveOrClosedCondition }                from "../WorkingMemorySql.js";
import { loadLexicalSchema, lexicalParticipation, warnLexicalOnce } from "../LexicalSchema.js";
import { lexicalTokens, buildLexicalTsquery, QUERY_TERM_LIMIT }    from "../embedding/LexicalTokens.js";
import { appendWorkspaceCondition }             from "./WorkspaceScope.js";
import { agentScopeCondition, resolveAgentScope } from "./AgentScope.js";
import { normalizeIsAnchor }                    from "./SearchScope.js";
import { deterministicOrderBy }                 from "./DeterministicRanking.js";
import { SEARCH_COLS_BASE }                     from "./FragmentReader.js";
/** 키별 채움 지표(memento_lexical_tokens_*)를 /metrics 레지스트리에 등록한다. */
import "../LexicalCoverage.js";

/** 어휘 채널 후보 상한 */
export const LEXICAL_CANDIDATE_LIMIT = 200;

/** L2 검색과 같은 중요도 하한 기본값 */
const DEFAULT_MIN_IMPORTANCE = 0.1;

/** 같음 비교 필터: [질의 키, 열] */
const EQUALITY_FILTERS = Object.freeze([
  ["type", "f.type"],
  ["topic", "f.topic"],
  ["caseId", "f.case_id"],
  ["resolutionStatus", "f.resolution_status"],
  ["phase", "f.phase"]
]);

/**
 * 값을 바인딩하고 자리표시자로 조건을 더한다.
 *
 * @param {string[]}  conditions
 * @param {unknown[]} params
 * @param {string}    column    "열 연산자" 형태(예: "f.type =")
 * @param {unknown}   value
 * @param {string}    [cast]
 */
function bind(conditions, params, column, value, cast = "") {
  params.push(value);
  conditions.push(`${column} $${params.length}${cast}`);
}

/** 키, workspace, superseded 범위 조건 */
function appendScopeConditions(conditions, params, options) {
  const keyCondition = keyScopeCondition(params, "f.key_id", options.keyId || null);
  if (keyCondition) conditions.push(keyCondition);
  appendWorkspaceCondition(conditions, params, options, "f.workspace");
  conditions.push(liveOrClosedCondition(options.includeSuperseded === true, "f"));
}

/** 검색 필터 조건(중요도, 앵커, 같음 비교, 정서, 시간 범위) */
function appendFilterConditions(conditions, params, options) {
  bind(conditions, params, "f.importance >=", options.minImportance || DEFAULT_MIN_IMPORTANCE);
  const isAnchor = normalizeIsAnchor(options.isAnchor);
  if (isAnchor !== undefined) bind(conditions, params, "f.is_anchor =", isAnchor);
  for (const [key, column] of EQUALITY_FILTERS) {
    if (options[key]) bind(conditions, params, `${column} =`, options[key]);
  }
  if (Array.isArray(options.affect) && options.affect.length > 0) {
    params.push(options.affect);
    conditions.push(`f.affect = ANY($${params.length})`);
  } else if (typeof options.affect === "string" && options.affect) {
    bind(conditions, params, "f.affect =", options.affect);
  }
  if (options.timeRange?.from) bind(conditions, params, "f.created_at >=", options.timeRange.from);
  if (options.timeRange?.to)   bind(conditions, params, "f.created_at <", options.timeRange.to);
}

/**
 * 어휘 채널 SQL. tsquery와 모든 범위 값은 바인딩 값이다($1 tsquery, $2 agentId).
 *
 * @param {string} tsquery buildLexicalTsquery 결과
 * @param {Object} options FragmentSearch의 정규화된 질의(agentId, keyId, workspace, allWorkspaces,
 *   includeSuperseded, includePeerAgents, _isMaster, isAnchor, type, topic, caseId, resolutionStatus,
 *   phase, affect, timeRange, minImportance)
 * @returns {{sql: string, params: unknown[]}}
 */
export function buildLexicalSearchSql(tsquery, options = {}) {
  const agentId    = options.agentId || "default";
  const params     = [tsquery, agentId];
  const conditions = [
    "f.content_tokens @@ to_tsquery('simple', $1)",
    agentScopeCondition("$2", resolveAgentScope({ ...options, agentId }), "f.agent_id")
  ];
  appendScopeConditions(conditions, params, options);
  appendFilterConditions(conditions, params, options);
  params.push(LEXICAL_CANDIDATE_LIMIT);

  const sql = `SELECT ${SEARCH_COLS_BASE},
                    ts_rank_cd(f.content_tokens, to_tsquery('simple', $1)) AS lexical_rank
             FROM ${SCHEMA}.fragments f
             WHERE ${conditions.join(" AND ")}
             ${deterministicOrderBy("lexical_rank DESC", "f")}
             LIMIT $${params.length}`;
  return { sql, params };
}

/**
 * ts_rank_cd를 그 검색의 최고값 대비 0~1의 _lexicalScore로 바꾸고 원시 열을 지운다. 순서는 그대로다.
 *
 * @param {Array<Object & {lexical_rank: number|string}>} rows
 * @returns {Object[]}
 */
export function attachLexicalScores(rows) {
  const ranks = rows.map(row => Number(row.lexical_rank) || 0);
  const top   = Math.max(0, ...ranks);
  return rows.map(({ lexical_rank: _rank, ...row }, i) => ({ ...row, _lexicalScore: top > 0 ? ranks[i] / top : 0 }));
}

export class LexicalSearch {
  /**
   * @param {Object} [deps]
   * @param {(sql: string, params: unknown[]) => Promise<{rows: Object[]}>} [deps.run]   카탈로그 조회
   * @param {(agentId: string, sql: string, params: unknown[]) => Promise<{rows: Object[]}>} [deps.query] 검색 질의
   */
  constructor({ run, query } = {}) {
    this.run   = run   ?? ((sql, params) => queryWithAgentVector("system", sql, params));
    this.query = query ?? queryWithAgentVector;
  }

  /**
   * 어휘 채널 후보. 채널이 꺼졌거나 참여하지 않는 상태, 쓸 토큰이 없는 질의는 빈 배열이다. 조회 오류는
   * 경고로 남기고 이 검색에서만 채널을 뺀다(다른 계층의 결과는 그대로 쓴다).
   *
   * @param {string} text
   * @param {Object} options buildLexicalSearchSql의 options
   * @returns {Promise<Object[]>}
   */
  async search(text, options = {}) {
    if (!lexicalChannelEnabled()) return [];
    try {
      const { participates, reason } = lexicalParticipation(await loadLexicalSchema(this.run));
      warnLexicalOnce(reason);
      if (!participates) return [];

      const tsquery = buildLexicalTsquery(await lexicalTokens(text, QUERY_TERM_LIMIT));
      if (tsquery === null) return [];

      const { sql, params } = buildLexicalSearchSql(tsquery, options);
      const { rows }        = await this.query(options.agentId || "default", sql, params);
      return attachLexicalScores(rows);
    } catch (err) {
      logWarn(`[LexicalSearch] 어휘 채널 검색 실패(${err.code ?? "no code"}), 이 검색에서는 채널을 뺀다: ${err.message}`);
      return [];
    }
  }
}

/**
 * FragmentSearch가 부르는 진입점. 질의 text가 있고 저장소가 어휘 검색을 제공할 때만 조회한다.
 *
 * @param {{searchByLexical?: Function}} store
 * @param {Object} sq FragmentSearch의 정규화된 질의
 * @returns {Promise<Object[]>}
 */
export async function searchLexicalCandidates(store, sq) {
  if (!sq.text || typeof store?.searchByLexical !== "function") return [];
  return store.searchByLexical(sq.text, sq);
}

/**
 * RRF의 lexical 계층. 가중은 질의 프로파일의 lexicalWeightFactor다. 후보가 있으면 검색 경로에 남긴다.
 *
 * @param {Object[]} results
 * @param {{lexicalWeightFactor?: number}|null|undefined} profile
 * @param {string[]} searchPath (변경)
 * @returns {{name: string, results: Object[], weightFactor: number}}
 */
export function lexicalLayer(results, profile, searchPath) {
  if (results.length > 0) searchPath.push(`Lexical:${results.length}`);
  return { name: "lexical", results, weightFactor: profile?.lexicalWeightFactor ?? 1.0 };
}

/**
 * RRF를 쓰지 않는 대체 경로(임베딩 꺼짐)의 병합. 이미 있는 후보에는 _lexicalScore를 옮기고, 없는 후보는
 * 어휘 순서대로 뒤에 붙인다.
 *
 * @param {Object[]} combined   (변경)
 * @param {Object[]} lexical
 * @param {string[]} searchPath (변경)
 */
export function appendLexicalCandidates(combined, lexical, searchPath) {
  if (lexical.length === 0) return;
  const byId = new Map(combined.map(fragment => [fragment.id, fragment]));
  for (const candidate of lexical) {
    const existing = byId.get(candidate.id);
    if (existing) {
      existing._lexicalScore = candidate._lexicalScore;
    } else {
      combined.push(candidate);
      byId.set(candidate.id, candidate);
    }
  }
  searchPath.push(`Lexical:${lexical.length}`);
}

/**
 * 응답에서 지우기 전에 id별 _lexicalScore를 모은다.
 *
 * @param {Object[]} fragments
 * @returns {Map<string, number>}
 */
export function collectLexicalScores(fragments) {
  const scores = new Map();
  for (const fragment of fragments) {
    if (fragment._lexicalScore !== undefined) scores.set(fragment.id, fragment._lexicalScore);
  }
  return scores;
}

/**
 * collectLexicalScores로 모은 점수를 같은 id의 파편에 다시 붙인다(recall 최종 정렬용).
 *
 * @param {Object[]} fragments (변경)
 * @param {Map<string, number>|undefined} scores
 */
export function restoreLexicalScores(fragments, scores) {
  if (!scores) return;
  for (const fragment of fragments) {
    if (scores.has(fragment.id)) fragment._lexicalScore = scores.get(fragment.id);
  }
}
