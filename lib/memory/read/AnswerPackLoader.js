/**
 * AnswerPackLoader - 답 꾸러미 출처와 대체 체인 조회, pack 응답 조립, recall 응답 출처 열
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 검색 결과 행에는 source가 없고, 기본 검색은 valid_to가 있는 행을 빼므로 대체 체인은 검색 결과만으로
 * 만들 수 없다. 꾸러미 항목 id에 대해 두 조회를 한 번씩 한다.
 *   1. 출처: 항목 id의 source, MEMENTO_PROVENANCE=on이면 origin과 trust_tier도
 *   2. 대체 체인: superseded_by 링크(삭제되지 않은 것)의 양방향 상대 id
 * 두 조회 모두 recall과 같은 agent, 키(그룹 포함), workspace 술어를 상대 파편에 건다. 닫힌 파편도
 * 체인의 상대가 될 수 있으므로 유효성 조건은 작업 기억 행 제외만 둔다. 체인은 방향마다 상대 파편의
 * created_at 내림차순(같으면 id 오름차순)으로 PACK_CHAIN_MAX_IDS개까지 싣는다.
 *
 * 1번 조회와 범위 술어는 ProvenanceLoader에 있고, 기본 형식 recall 응답의 origin, trust_tier와
 * context의 주입 제외 판정도 같은 조회를 쓴다.
 */

import { getPrimaryPool }                         from "../../tools/db.js";
import { logWarn }                                from "../../logger.js";
import { SCHEMA }                                 from "../schema.js";
import { buildAnswerPack, PACK_CHAIN_MAX_IDS }     from "./AnswerPack.js";
import { countTokens }                            from "../write/FragmentFactory.js";
import { provenanceEnabled }                      from "../../config.js";
import { withReviewMarkers }                     from "./ReviewVisibility.js";
import { loadFragmentProvenance, scopeClause }    from "./ProvenanceLoader.js";

/**
 * 체인 행 정렬: 상대 파편 created_at 내림차순(없으면 뒤), 같으면 상대 id 오름차순.
 *
 * @param {{other_id: string, other_created_at: unknown}} a
 * @param {{other_id: string, other_created_at: unknown}} b
 * @returns {number}
 */
function compareChainRows(a, b) {
  const time = value => {
    const t = value == null ? NaN : new Date(value).getTime();
    return Number.isFinite(t) ? t : -Infinity;
  };
  const ta = time(a.other_created_at);
  const tb = time(b.other_created_at);
  if (ta !== tb) return tb > ta ? 1 : -1;
  const ia = String(a.other_id);
  const ib = String(b.other_id);
  if (ia === ib) return 0;
  return ia < ib ? -1 : 1;
}

/**
 * 꾸러미 항목의 출처와 대체 체인을 조회한다.
 *
 * @param {string[]} fragmentIds
 * @param {{agentId?: string, _isMaster?: boolean, includePeerAgents?: boolean, keyId?: string|null,
 *   groupKeyIds?: string[], workspace?: string|null, allWorkspaces?: boolean}} [scope]
 * @param {() => {query: Function}|null} [getPool]
 * @returns {Promise<Map<string, {source: string|null, origin?: string|null, supersededBy: string[],
 *   supersedes: string[]}>>} origin은 MEMENTO_PROVENANCE=on일 때만 있다
 */
export async function loadPackProvenance(fragmentIds, scope = {}, getPool = getPrimaryPool) {
  const ids = [...new Set((fragmentIds ?? []).filter(Boolean))];
  if (ids.length === 0) return new Map();
  const pool = getPool();
  if (!pool) return new Map();

  const chainParams = [ids];
  const chainScope  = scopeClause(chainParams, scope);

  const [sources, chain] = await Promise.all([
    loadFragmentProvenance(ids, scope, () => pool),
    pool.query(
      `SELECT item_id, other_id, other_created_at, direction
         FROM (
           SELECT fl.from_id AS item_id, fl.to_id AS other_id, f.created_at AS other_created_at,
                  'superseded_by'::text AS direction
             FROM ${SCHEMA}.fragment_links fl
             JOIN ${SCHEMA}.fragments f ON f.id = fl.to_id
            WHERE fl.from_id = ANY($1::text[])
              AND fl.relation_type = 'superseded_by'
              AND fl.deleted_at IS NULL
              ${chainScope}
           UNION ALL
           SELECT fl.to_id AS item_id, fl.from_id AS other_id, f.created_at AS other_created_at,
                  'supersedes'::text AS direction
             FROM ${SCHEMA}.fragment_links fl
             JOIN ${SCHEMA}.fragments f ON f.id = fl.from_id
            WHERE fl.to_id = ANY($1::text[])
              AND fl.relation_type = 'superseded_by'
              AND fl.deleted_at IS NULL
              ${chainScope}
         ) t
        ORDER BY item_id, direction, other_created_at DESC NULLS LAST, other_id`,
      chainParams
    )
  ]);

  const empty  = provenanceEnabled() ? { source: null, origin: null } : { source: null };
  const result = new Map(ids.map(id => [id, { ...empty, supersededBy: [], supersedes: [] }]));
  for (const [id, entry] of sources ?? []) {
    if (!result.has(id)) continue;
    const { trustTier: _trustTier, ...columns } = entry;
    Object.assign(result.get(id), columns);
  }
  for (const row of [...chain.rows].sort(compareChainRows)) {
    const entry = result.get(row.item_id);
    if (!entry) continue;
    const list = row.direction === "superseded_by" ? entry.supersededBy : entry.supersedes;
    if (list.length < PACK_CHAIN_MAX_IDS && !list.includes(row.other_id)) list.push(row.other_id);
  }
  return result;
}

/**
 * 기본 형식 recall 응답 파편에 origin과 trust_tier를 싣는다. MEMENTO_PROVENANCE=off이거나 값이 NULL이면
 * 싣지 않고, fields가 지정되면 거기 든 키만 싣는다. fields가 두 키를 모두 빼면 조회하지 않는다.
 * 조회가 실패하면 경고를 남기고 응답을 그대로 둔다.
 *
 * @param {object} base - buildRecallResponse 결과
 * @param {object[]} fragments - recall 결과 파편(base.fragments와 같은 순서)
 * @param {object} scope - recall과 같은 조회 범위
 * @param {{fields?: string[]}} [args] - recall 인자
 * @param {() => {query: Function}|null} [getPool]
 * @returns {Promise<object>}
 */
export async function withRecallProvenance(base, fragments, scope, args = {}, getPool = getPrimaryPool) {
  const wanted = Array.isArray(args.fields) && args.fields.length > 0 ? new Set(args.fields) : null;
  const keep   = key => wanted === null || wanted.has(key);
  if (!provenanceEnabled() || !Array.isArray(base.fragments) || base.fragments.length === 0) return base;
  if (!keep("origin") && !keep("trust_tier")) return base;
  let provenance;
  try {
    provenance = await loadFragmentProvenance((fragments ?? []).map(f => f.id), scope, getPool) ?? new Map();
  } catch (err) {
    logWarn("recall provenance lookup failed", { error: err.message, count: fragments?.length ?? 0 });
    return base;
  }
  const enrich = (projected, i) => {
    const entry = provenance.get(fragments[i]?.id);
    const extra = {
      ...(entry?.origin != null && keep("origin") ? { origin: entry.origin } : {}),
      ...(entry?.trustTier != null && keep("trust_tier") ? { trust_tier: entry.trustTier } : {})
    };
    return Object.keys(extra).length > 0 ? { ...projected, ...extra } : projected;
  };
  return { ...base, fragments: base.fragments.map(enrich) };
}

/**
 * 기본 형식 recall 응답 주석. 출처 열(withRecallProvenance)을 싣고, 검토 대기 파편에는 pending_review와
 * low_trust 표지를 단다(ReviewVisibility.withReviewMarkers).
 *
 * @param {object} base - buildRecallResponse 결과
 * @param {object[]} fragments - recall 결과 파편(base.fragments와 같은 순서)
 * @param {object} scope - recall과 같은 조회 범위
 * @param {{fields?: string[]}} [args] - recall 인자
 * @param {() => {query: Function}|null} [getPool]
 * @returns {Promise<object>}
 */
export async function withRecallAnnotations(base, fragments, scope, args = {}, getPool = getPrimaryPool) {
  return withReviewMarkers(await withRecallProvenance(base, fragments, scope, args, getPool), fragments);
}

/**
 * recall 응답을 pack 응답으로 바꾼다. fragments 대신 pack을 싣고 나머지 필드와 _meta는 유지한다.
 * 출처와 대체 체인 조회가 실패하면 경고를 남기고 체인 없이 partial=true로 만든다.
 * pack.estimatedTokens는 저장 경로와 recall 예산 선택이 쓰는 countTokens(cl100k_base)로 센다.
 *
 * @param {object} base - buildRecallResponse 결과
 * @param {object[]} fragments - recall 결과 파편(순위 순서)
 * @param {object} scope - recall과 같은 조회 범위
 * @returns {Promise<object>}
 */
export async function toPackResponse(base, fragments, scope) {
  let provenance = new Map();
  let partial    = false;
  try {
    provenance = await loadPackProvenance((fragments ?? []).map(f => f.id), scope);
  } catch (err) {
    logWarn("answer pack provenance lookup failed", { error: err.message, count: fragments?.length ?? 0 });
    partial = true;
  }
  const { fragments: _fragments, ...rest } = base;
  return { ...rest, format: "pack", pack: buildAnswerPack(fragments ?? [], { provenance, partial, countTokens }) };
}
