/**
 * LexicalSearch - 본문 어휘 채널(L2b)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 * 수정일: 2026-10-04 (recall 진입점 한정, 일치 집합 상한과 질의 시간 상한, RRF 입력으로만 기여)
 *
 * 질의 text를 저장 경로와 같은 방법(LexicalTokens)으로 토큰화해 OR tsquery를 만들고, content_tokens가
 * 일치하고 키, workspace, agent 범위와 검색 필터를 통과한 파편을 LEXICAL_MATCH_CAP건까지 읽은 뒤(순서 없이
 * 처음 찾은 행) 그 안에서 ts_rank_cd 순 상위 LEXICAL_CANDIDATE_LIMIT건을 돌려준다. 일치 집합 상한이 순위
 * 계산 비용을 묶고, 질의 하나는 MEMENTO_LEXICAL_TIMEOUT_MS를 넘으면 취소된다(그 요청에서 채널을 빼고
 * memento_lexical_channel_skipped_total에 센다). ts_rank_cd는 문서 하나와 질의만 보고 전역 문서 빈도
 * 통계를 쓰지 않으므로 다른 키의 자료가 순위에 영향을 주지 않는다. content_tokens가 NULL인 행(채우기 전)은
 * 일치하지 않는다.
 *
 * 채널은 recall 진입점이 켠 질의(lexicalChannel: true)에서만 돈다. 후보는 RRF의 lexical 계층으로만 순위에
 * 기여한다(임베딩이 꺼진 대체 경로에서는 다른 계층에 없는 후보만 뒤에 붙인다). _lexicalScore(그 검색의 최고
 * ts_rank_cd 대비 0~1)는 다른 점수가 없는 어휘 전용 후보의 검색 계층 순서에만 쓰고 응답에서 지운다.
 *
 * 참여 여부는 MEMENTO_LEXICAL_CHANNEL과 LexicalSchema의 상태(열, 유효한 GIN 색인)로 정한다.
 */

import { queryWithAgentVector }                 from "../../tools/db.js";
import { lexicalChannelEnabled, lexicalTimeoutMs } from "../../config.js";
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
import { recordLexicalChannelSkipped }          from "../lexical-metrics.js";
/** 키별 채움 지표(memento_lexical_tokens_*)를 /metrics 레지스트리에 등록한다. */
import "../LexicalCoverage.js";

/** 어휘 채널 후보 상한 */
export const LEXICAL_CANDIDATE_LIMIT = 200;

/** 순위를 매기는 일치 집합의 상한. 일치 행을 이만큼 읽은 뒤 그 안에서만 ts_rank_cd를 계산한다. */
export const LEXICAL_MATCH_CAP = 1000;

/** 바깥 질의가 쓰는 열 목록(안쪽 질의의 별칭 m) */
const OUTER_COLS = SEARCH_COLS_BASE.replaceAll("f.", "m.");

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
  params.push(LEXICAL_MATCH_CAP);
  const capRef = params.length;
  params.push(LEXICAL_CANDIDATE_LIMIT);

  const sql = `SELECT ${OUTER_COLS},
                    ts_rank_cd(m.content_tokens, to_tsquery('simple', $1)) AS lexical_rank
             FROM (SELECT ${SEARCH_COLS_BASE}, f.content_tokens
                     FROM ${SCHEMA}.fragments f
                    WHERE ${conditions.join(" AND ")}
                    LIMIT $${capRef}) m
             ${deterministicOrderBy("lexical_rank DESC", "m")}
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
      const { rows }        = await this.query(options.agentId || "default", sql, params, { statementTimeoutMs: lexicalTimeoutMs() });
      return attachLexicalScores(rows);
    } catch (err) {
      const reason = err.code === "57014" ? "timeout" : "error";
      recordLexicalChannelSkipped(reason);
      logWarn(`[LexicalSearch] 어휘 채널 검색 ${reason}(${err.code ?? "no code"}), 이 검색에서는 채널을 뺀다: ${err.message}`);
      return [];
    }
  }
}

/**
 * FragmentSearch가 부르는 진입점. 질의가 어휘 채널을 켰고(lexicalChannel: true, recall 진입점만 켠다)
 * text가 있으며 저장소가 어휘 검색을 제공할 때만 조회한다. 저장 경로의 내부 검색(충돌 탐지, 자동 링크 등)은
 * 플래그를 두지 않으므로 어휘 질의를 실행하지 않는다.
 *
 * @param {{searchByLexical?: Function}} store
 * @param {Object} sq FragmentSearch의 정규화된 질의
 * @returns {Promise<Object[]>}
 */
export async function searchLexicalCandidates(store, sq) {
  if (sq.lexicalChannel !== true || !sq.text || typeof store?.searchByLexical !== "function") return [];
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
 * RRF를 쓰지 않는 대체 경로(임베딩 꺼짐)의 병합. 다른 계층에 없는 후보만 어휘 순서대로 뒤에 붙이고,
 * 이미 있는 후보는 건드리지 않는다.
 *
 * @param {Object[]} combined   (변경)
 * @param {Object[]} lexical
 * @param {string[]} searchPath (변경)
 */
export function appendLexicalCandidates(combined, lexical, searchPath) {
  if (lexical.length === 0) return;
  const seen = new Set(combined.map(fragment => fragment.id));
  for (const candidate of lexical) {
    if (seen.has(candidate.id)) continue;
    combined.push(candidate);
    seen.add(candidate.id);
  }
  searchPath.push(`Lexical:${lexical.length}`);
}
