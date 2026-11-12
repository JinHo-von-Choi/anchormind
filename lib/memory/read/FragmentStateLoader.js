/**
 * FragmentStateLoader - recall 결과 파편의 상태(현재, 대체됨, 충돌) 표지와 이전 값 조회
 *
 * 작성자: 최진호
 * 작성일: 2026-10-12
 *
 * 기본 recall은 유효한 파편(valid_to IS NULL)만 돌려준다. 값이 바뀐 기억은 새 값만 보이고, 서로 맞서는
 * 두 기억이 둘 다 유효하면 어느 쪽인지 표시가 없다. 이 모듈은 결과 파편 id에 대해 두 가지를 조회한다.
 *
 *   충돌    contradicts 링크로 이어진 상대가 아직 유효하고, 사람이 한쪽을 고른 해소 기록
 *           (conflict_resolutions의 keep_left, keep_right)이 없는 경우. 결과 파편에 conflicts_with로 싣는다
 *   이전 값 superseded_by 링크로 결과 파편에 대체된 닫힌 파편. includeHistory일 때만 결과의 대체한 파편
 *           바로 뒤에 state=superseded로 끼우고, 대체한 파편에는 state=current를 단다
 *
 * 두 조회 모두 상대 파편에 recall과 같은 agent, 키(그룹 포함), workspace 술어를 건다(ProvenanceLoader.scopeClause).
 *
 * 근거 상태도 단다. 원본이 철회돼 support_state가 있는 파생 파편(lib/memory/write/Lineage.js)에는 support_state,
 * support_reason과 원본 id 목록 derived_from을 싣는다. 결과 파편 자신의 열과 계보만 읽으므로 범위 술어를 다시 걸지 않는다.
 */

import { getPrimaryPool } from "../../tools/db.js";
import { SCHEMA }         from "../schema.js";
import { scopeClause }    from "./ProvenanceLoader.js";
import { logWarn }        from "../../logger.js";
import { orderChronologically } from "../WorldTime.js";
import { lexicalTokens }       from "../embedding/LexicalTokens.js";
import { resolveAnswerIntent, evidenceStatus, buildEvidenceBundle } from "./EvidenceBundle.js";
import { loadDigests, digestWants } from "./DigestLoader.js";
import { digestEnabled }      from "../../config.js";
import { fragmentTokens }     from "./BudgetSelector.js";
import { queryScoped } from "../../tools/row-scope.js";
import { keyScopeNote } from "../keyScope.js";

/** includeHistory가 한 recall에 끼우는 이전 값 파편의 상한 */
export const HISTORY_MAX_ITEMS = 5;

/** 결과 파편 하나에 싣는 충돌 상대 id 상한 */
export const CONFLICT_MAX_IDS = 5;

/** 이전 값 파편으로 읽는 열 */
const HISTORY_COLUMNS = [
  "f.id", "f.content", "f.topic", "f.keywords", "f.type", "f.importance", "f.utility_score",
  "f.access_count", "f.created_at", "f.verified_at", "f.is_anchor", "f.valid_to", "f.agent_id",
  "f.key_id", "f.workspace", "f.case_id", "f.assertion_status", "f.affect", "f.session_id",
  "f.mention_time", "f.event_time", "f.event_time_end", "f.event_time_precision"
].join(", ");

/**
 * 결과 파편 id별 충돌 상대 id를 읽는다.
 *
 * @param {string[]} fragmentIds
 * @param {object} scope - recall과 같은 조회 범위
 * @param {() => {query: Function}|null} [getPool]
 * @returns {Promise<Map<string, string[]>>}
 */
export async function loadConflicts(fragmentIds, scope = {}, getPool = getPrimaryPool) {
  const ids = [...new Set((fragmentIds ?? []).filter(Boolean))];
  if (ids.length === 0) return new Map();
  const pool = getPool();
  if (!pool) return new Map();

  const params = [ids];
  const clause = scopeClause(params, scope);
  const { rows } = await queryScoped(pool,
    `SELECT t.item_id, t.other_id
       FROM (
         SELECT l.id AS link_id, l.from_id AS item_id, l.to_id AS other_id
           FROM ${SCHEMA}.fragment_links l
          WHERE l.relation_type = 'contradicts' AND l.deleted_at IS NULL AND l.from_id = ANY($1::text[])
         UNION ALL
         SELECT l.id AS link_id, l.to_id AS item_id, l.from_id AS other_id
           FROM ${SCHEMA}.fragment_links l
          WHERE l.relation_type = 'contradicts' AND l.deleted_at IS NULL AND l.to_id = ANY($1::text[])
       ) t
       JOIN ${SCHEMA}.fragments f ON f.id = t.other_id
      WHERE f.valid_to IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM ${SCHEMA}.conflict_resolutions r
           WHERE r.link_id = t.link_id AND r.decision IN ('keep_left', 'keep_right')
        )
        ${clause}
      ORDER BY t.item_id, t.other_id`,
    params
  );

  const result = new Map();
  for (const row of rows) {
    if (row.item_id === row.other_id) continue;
    const list = result.get(row.item_id) ?? [];
    if (list.length < CONFLICT_MAX_IDS && !list.includes(row.other_id)) list.push(row.other_id);
    result.set(row.item_id, list);
  }
  return result;
}

/**
 * 결과 파편이 대체한 닫힌 파편(이전 값)을 읽는다. 대체한 파편마다 말한 시각이 늦은 순서다.
 *
 * @param {string[]} fragmentIds
 * @param {object} scope
 * @param {() => {query: Function}|null} [getPool]
 * @returns {Promise<Array<object & {_successor_id: string}>>}
 */
export async function loadPredecessors(fragmentIds, scope = {}, getPool = getPrimaryPool) {
  const ids = [...new Set((fragmentIds ?? []).filter(Boolean))];
  if (ids.length === 0) return [];
  const pool = getPool();
  if (!pool) return [];

  const params = [ids];
  const clause = scopeClause(params, scope);
  const { rows } = await queryScoped(pool,
    `SELECT l.to_id AS _successor_id, ${HISTORY_COLUMNS}
       FROM ${SCHEMA}.fragment_links l
       JOIN ${SCHEMA}.fragments f ON f.id = l.from_id
      WHERE l.relation_type = 'superseded_by'
        AND l.deleted_at IS NULL
        AND l.to_id = ANY($1::text[])
        AND f.valid_to IS NOT NULL
        ${clause}
      ORDER BY l.to_id, COALESCE(f.mention_time, f.created_at) DESC, f.id`,
    params
  );
  return rows;
}

/**
 * 결과 파편 중 근거 상태가 있는 파편의 상태와 원본 id. 실패하면 빈 Map이고 표지 없이 응답한다.
 *
 * @param {string[]} fragmentIds - 범위 조건을 통과한 결과 파편 id
 * @param {() => {query: Function}|null} [getPool]
 * @param {object} [scope] - 결과 파편을 고른 조회 범위. 키 목록을 행 수준 보안에 넘긴다
 * @returns {Promise<Map<string, {support_state: string, support_reason: string|null, derived_from: string[]}>>}
 */
export async function loadSupport(fragmentIds, getPool = getPrimaryPool, scope = {}) {
  const ids = [...new Set((fragmentIds ?? []).filter(Boolean))];
  const pool = getPool();
  if (ids.length === 0 || !pool) return new Map();
  try {
    const params = [ids];
    keyScopeNote(params, scope);
    const { rows } = await queryScoped(pool,
      `SELECT f.id, f.support_state, f.support_reason,
              ARRAY(SELECT l.parent_id FROM ${SCHEMA}.fragment_lineage l
                     WHERE l.child_id = f.id ORDER BY l.created_at, l.parent_id) AS derived_from
         FROM ${SCHEMA}.fragments f
        WHERE f.id = ANY($1::text[]) AND f.support_state IS NOT NULL`,
      params
    );
    return new Map(rows.map(r => [r.id, {
      support_state : r.support_state,
      support_reason: r.support_reason ?? null,
      derived_from  : r.derived_from ?? []
    }]));
  } catch (err) {
    logWarn("support state lookup failed", { error: err.message, count: ids.length });
    return new Map();
  }
}

/**
 * 이전 값 행을 대체한 파편 id별로 묶는다. 이미 결과에 있는 파편은 빼고 전체 max건까지만 둔다.
 *
 * @param {object[]} rows - loadPredecessors 결과
 * @param {Set<string>} present - 결과에 이미 있는 id
 * @param {number} max
 * @returns {Map<string, object[]>}
 */
function groupHistory(rows, present, max) {
  const bySuccessor = new Map();
  let   added       = 0;
  for (const row of rows) {
    if (added >= max) break;
    if (present.has(row.id)) continue;
    const { _successor_id: successorId, ...fragment } = row;
    const list = bySuccessor.get(successorId) ?? [];
    list.push({ ...fragment, state: "superseded", superseded_by: [successorId] });
    bySuccessor.set(successorId, list);
    present.add(row.id);
    added++;
  }
  return bySuccessor;
}

/**
 * recall 결과 파편에 상태 표지를 단다. 입력 배열은 바꾸지 않는다.
 *
 * @param {object[]} fragments - 순위 순서의 결과 파편
 * @param {object} scope
 * @param {{includeHistory?: boolean, maxHistory?: number, getPool?: Function}} [options]
 * @returns {Promise<object[]>}
 */
export async function annotateFragmentState(fragments, scope = {}, {
  includeHistory = false, maxHistory = HISTORY_MAX_ITEMS, getPool = getPrimaryPool
} = {}) {
  if (!Array.isArray(fragments) || fragments.length === 0) return fragments ?? [];
  const ids = fragments.map(f => f.id).filter(Boolean);

  const [conflicts, predecessors, support] = await Promise.all([
    loadConflicts(ids, scope, getPool),
    includeHistory ? loadPredecessors(ids, scope, getPool) : Promise.resolve([]),
    loadSupport(ids, getPool, scope)
  ]);

  const bySuccessor = groupHistory(predecessors, new Set(ids), maxHistory);

  const out = [];
  for (const fragment of fragments) {
    const conflictsWith = conflicts.get(fragment.id);
    const history       = bySuccessor.get(fragment.id) ?? [];
    out.push({
      ...fragment,
      ...(support.get(fragment.id) ?? {}),
      ...(conflictsWith?.length ? { conflicts_with: conflictsWith, state: "conflict" } : {}),
      ...(history.length > 0 && !conflictsWith?.length ? { state: "current" } : {})
    });
    out.push(...history);
  }
  return out;
}

/**
 * recall 결과에 상태 표지를 달고 순서를 정한다. caseMode 결과는 그대로 둔다. 아직 유효한 충돌 상대
 * (conflicts_with), includeHistory면 대체된 이전 값, order=chronological이면 세계 시각순.
 * 표지 조회가 실패하면 경고만 남기고 결과를 그대로 둔다.
 *
 * @param {Object} result - recall 결과 (fragments, count를 바꾼다)
 * @param {Object} args   - recall 인자
 * @param {Object} scope  - recall과 같은 조회 범위
 * @returns {Promise<void>}
 */
export async function applyRecallState(result, args, scope) {
  if (result.caseMode) return;
  const before = new Set((result.fragments ?? []).map(f => f.id));
  result.fragments = await annotateFragmentState(result.fragments, scope, {
    includeHistory: args.includeHistory === true
  }).catch((err) => {
    logWarn("annotateFragmentState failed", { error: err.message, count: result.fragments.length });
    return result.fragments;
  });
  if (args.order === "chronological") result.fragments = orderChronologically(result.fragments);
  /** includeHistory로 끼운 이전 값도 응답 본문이므로 토큰 합계에 더한다. */
  const added = result.fragments.filter(f => !before.has(f.id));
  if (added.length > 0 && typeof result.totalTokens === "number") {
    result.totalTokens += added.reduce((sum, f) => sum + fragmentTokens(f), 0);
  }
  result.count = result.fragments.length;
}

/**
 * recall 응답 파편에 싣는 세계 시각(값이 있을 때만)과 상태 표지 필드.
 *
 * @param {Object} f
 * @returns {Object}
 */
export function worldTimeStateFields(f) {
  const fields = {};
  if (f.mention_time) fields.mention_time = f.mention_time;
  if (f.event_time) {
    fields.event_time           = f.event_time;
    fields.event_time_precision = f.event_time_precision ?? null;
  }
  if (f.event_time_end) fields.event_time_end = f.event_time_end;
  if (f.state) fields.state = f.state;
  if (f.superseded_by?.length) fields.superseded_by = f.superseded_by;
  if (f.conflicts_with?.length) fields.conflicts_with = f.conflicts_with;
  if (f.support_state) {
    fields.support_state  = f.support_state;
    fields.support_reason = f.support_reason ?? null;
    if (f.derived_from?.length) fields.derived_from = f.derived_from;
  }
  return fields;
}

/** 근거 상태 판정에 토큰화하는 결과 파편 수 상한 */
const EVIDENCE_SCAN_MAX = 30;

/**
 * 결과 파편의 저장된 어휘 토큰(content_tokens). recall마다 본문을 다시 형태소 분석하면 30건에 수십 ms의 CPU를
 * 이벤트 루프에서 쓴다. id는 이미 범위 조건을 통과한 결과 파편이므로 범위 조건을 다시 붙이지 않는다.
 * 실패하면 빈 Map이고 호출자가 본문을 토큰화한다.
 *
 * @param {string[]} ids
 * @param {() => import("pg").Pool} [getPool]
 * @param {object} [scope] - 결과 파편을 고른 조회 범위. 키 목록을 행 수준 보안에 넘긴다
 * @returns {Promise<Map<string, string[]>>}
 */
export async function loadStoredTokens(ids, getPool = getPrimaryPool, scope = {}) {
  const pool = getPool();
  if (!pool || ids.length === 0) return new Map();
  try {
    const params = [ids];
    keyScopeNote(params, scope);
    const { rows } = await queryScoped(pool,
      `SELECT id, tsvector_to_array(content_tokens) AS tokens FROM ${SCHEMA}.fragments
        WHERE id = ANY($1::text[]) AND content_tokens IS NOT NULL`,
      params
    );
    return new Map(rows.map((r) => [r.id, r.tokens ?? []]));
  } catch (err) {
    logWarn("stored token lookup failed", { error: err.message, count: ids.length });
    return new Map();
  }
}

/**
 * recall 결과에 질문 의도, 근거 상태, 의도별 근거 묶음, 묶음 요약을 단다(result._evidence). caseMode 결과는
 * 그대로 둔다. 토큰화가 실패하면 근거 상태 없이, 요약 조회가 실패하면 요약 없이 단다.
 *
 * @param {Object} result - applyRecallState를 거친 recall 결과
 * @param {Object} args   - recall 인자
 * @param {Object} [scope] - recall과 같은 조회 범위(묶음 요약)
 * @returns {Promise<void>}
 */
export async function attachRecallEvidence(result, args, scope = {}) {
  if (result.caseMode) return;
  const fragments  = result.fragments ?? [];
  const { intent, explicit } = resolveAnswerIntent(args);
  const truncated  = result.hasMore === true;
  const evidence   = { intent, intent_source: explicit ? "explicit" : "auto" };

  const queryText = args.text ?? (Array.isArray(args.keywords) ? args.keywords.join(" ") : "");
  try {
    const scanned       = fragments.slice(0, EVIDENCE_SCAN_MAX);
    const queryTerms    = queryText ? await lexicalTokens(queryText) : [];
    const stored        = await loadStoredTokens(scanned.map(f => f.id).filter(Boolean), getPrimaryPool, scope);
    /** 저장된 토큰이 없는 파편(백필 전, 작업 기억)만 본문을 토큰화한다 */
    const fragmentTerms = await Promise.all(scanned.map(f => stored.get(f.id) ?? lexicalTokens(String(f.content ?? ""))));
    /** 키워드로 찾은 파편은 본문에 그 낱말이 없어도 근거다. */
    const termsWithKeywords = fragmentTerms.map((terms, i) => [
      ...(terms ?? []),
      ...(Array.isArray(scanned[i].keywords) ? scanned[i].keywords.map(k => String(k).toLowerCase()) : [])
    ]);
    Object.assign(evidence, evidenceStatus(fragments, queryTerms ?? [], termsWithKeywords));
  } catch (err) {
    logWarn("recall evidence status failed", { error: err.message });
  }

  const bundle = buildEvidenceBundle(fragments, { intent, truncated });
  if (bundle) evidence.bundle = bundle;

  if (digestEnabled()) {
    const digests = await loadDigests(scope, digestWants(fragments, args, intent)).catch((err) => {
      logWarn("recall digest lookup failed", { error: err.message });
      return [];
    });
    if (digests.length > 0) evidence.digests = digests;
  }
  result._evidence = evidence;
}
