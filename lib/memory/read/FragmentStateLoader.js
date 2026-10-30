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
  const { rows } = await pool.query(
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
  const { rows } = await pool.query(
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

  const [conflicts, predecessors] = await Promise.all([
    loadConflicts(ids, scope, getPool),
    includeHistory ? loadPredecessors(ids, scope, getPool) : Promise.resolve([])
  ]);

  const bySuccessor = groupHistory(predecessors, new Set(ids), maxHistory);

  const out = [];
  for (const fragment of fragments) {
    const conflictsWith = conflicts.get(fragment.id);
    const history       = bySuccessor.get(fragment.id) ?? [];
    out.push({
      ...fragment,
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
  return fields;
}

/** 근거 상태 판정에 토큰화하는 결과 파편 수 상한 */
const EVIDENCE_SCAN_MAX = 30;

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
    const fragmentTerms = await Promise.all(scanned.map(f => lexicalTokens(String(f.content ?? ""))));
    Object.assign(evidence, evidenceStatus(fragments, queryTerms ?? [], fragmentTerms.map(t => t ?? [])));
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
