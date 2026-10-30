/**
 * RecallResponseAssembler - recall 검색 결과에 붙이는 부가 조회의 조립
 *
 * 작성자: 최진호
 * 작성일: 2026-10-31
 *
 * 연결 미리보기(linked), includeContext 문맥(nearby_context, stitched_context), 상태 표지와 근거, 모순 대기
 * 여부를 만든다. 서로의 결과를 쓰지 않는 조회는 함께 띄우고, caseMode 결과에는 파편 부가 조회를 하지 않는다.
 * 응답 형태(필드 투영, 힌트, pack)는 도구 계층(lib/tools/memory.js)이 만든다.
 */

import { getPrimaryPool } from "../../tools/db.js";
import { SCHEMA } from "../schema.js";
import { logWarn } from "../../logger.js";
import { fetchLinkedFragments } from "./LinkedFragmentLoader.js";
import { applyRecallState, attachRecallEvidence } from "./FragmentStateLoader.js";
import { stitchFragment, applyStitchBudget } from "./TemporalContextStitcher.js";
import { fetchCausalLinks, fetchSessionNeighbors } from "./StitchSourceLoader.js";
import { agentScopeCondition, resolveAgentScope } from "./AgentScope.js";
import { keyScopeClause } from "../keyScope.js";
import { workspaceCondition } from "./WorkspaceScope.js";
import { reviewVisibilityParts } from "./ReviewVisibility.js";
import { recallStageDuration, timeStage } from "../stage-metrics.js";

/** 시간·인과 스티칭 대상 상한. 상위 몇 건에만 붙여 응답 토큰을 통제한다. */
const STITCH_MAX_TARGETS = 3;

/**
 * recall 결과에 부가 정보를 붙인다. result.fragments의 상태·근거·문맥 필드를 바꾼다.
 *
 * @param {Object} result - mgr.recall 결과 (in-place)
 * @param {Object} args   - recall 인자
 * @param {Object} linkedScope - 연결·문맥 조회 범위
 * @returns {Promise<{linkedMap: Map, contradictionPending: boolean}>}
 */
export async function assembleRecallExtras(result, args, linkedScope) {
  const fragments   = result.caseMode ? [] : result.fragments;
  const fragmentIds = fragments.map(f => f.id).filter(Boolean);
  const [linkedMap, contextById, contradictionPending] = await Promise.all([
    timeStage(recallStageDuration, { stage: "linked" }, () => loadLinkedPreview(fragmentIds, linkedScope, args)),
    args.includeContext
      ? timeStage(recallStageDuration, { stage: "context" }, () => loadRecallContext(fragments, linkedScope, args))
      : new Map(),
    (async () => {
      await timeStage(recallStageDuration, { stage: "state" }, async () => {
        await applyRecallState(result, args, linkedScope);
        await attachRecallEvidence(result, args, linkedScope);
      });
      return result.caseMode
        ? false
        : timeStage(recallStageDuration, { stage: "contradiction" }, () =>
          hasPendingContradictions((result.fragments ?? []).map(f => f.id).filter(Boolean), linkedScope));
    })()
  ]);

  /** 상태 주입이 파편 객체를 새로 만들 수 있으므로 문맥은 최종 파편에 id로 붙인다. */
  for (const frag of result.caseMode ? [] : result.fragments) {
    const ctx = contextById.get(frag.id);
    if (ctx?.nearby_context)   frag.nearby_context   = ctx.nearby_context;
    if (ctx?.stitched_context) frag.stitched_context = ctx.stitched_context;
  }

  return { linkedMap, contradictionPending };
}

/**
 * 응답 파편의 1-hop 연결 미리보기. includeLinks:false이면 조회하지 않는다.
 *
 * @param {string[]} fragmentIds
 * @param {Object}   scope
 * @param {Object}   args
 * @returns {Promise<Map>}
 */
async function loadLinkedPreview(fragmentIds, scope, args) {
  if (fragmentIds.length === 0 || args.includeLinks === false) return new Map();
  return fetchLinkedFragments(fragmentIds, { ...scope, relationType: args.linkRelationType ?? null })
    .catch((err) => {
      logWarn("fetchLinkedFragments failed", { error: err.message, count: fragmentIds.length });
      return new Map();
    });
}

/**
 * includeContext=true 문맥: 같은 세션의 30분 이내 파편(nearby_context)과, 시간 인접 파편·인과 링크를 묶은
 * 서사(stitched_context). 두 결과는 같은 session_id 기준 로더에서 나온다.
 *
 * 스티칭 대상은 순위 상위 N건이 아니라 "조합할 재료가 실제로 있는" 상위 N건이다. 인과 링크와 세션 인접
 * 파편은 드물게 존재하므로 순위만으로 자르면 기능이 사실상 발화하지 않는다. 예산 비율을 넘으면 축약한다.
 * 이 절삭이 없으면 스티칭이 tokenBudget을 잠식해 앵커 파편이 응답에서 밀려난다.
 *
 * @param {Object[]} fragments
 * @param {Object}   scope
 * @param {Object}   args
 * @returns {Promise<Map<string, {nearby_context?: Object[], stitched_context?: Object}>>}
 */
async function loadRecallContext(fragments, scope, args) {
  const byId = new Map();
  if (fragments.length === 0) return byId;

  const [causalMap, neighborMap] = await Promise.all([
    fetchCausalLinks(fragments.map(f => f.id), scope).catch((err) => {
      logWarn("fetchCausalLinks failed", { error: err.message });
      return new Map();
    }),
    fetchSessionNeighbors(fragments, scope).catch((err) => {
      logWarn("fetchSessionNeighbors failed", { error: err.message });
      return new Map();
    }),
  ]);

  const stitches = [];
  for (const frag of fragments) {
    const nearby = neighborMap.get(frag.id) || [];
    if (nearby.length > 0) {
      byId.set(frag.id, {
        nearby_context: nearby.slice(0, 3)
          .map(n => ({ id: n.id, content: n.content, type: n.type, created_at: n.created_at }))
      });
    }
    if (stitches.length >= STITCH_MAX_TARGETS) continue;
    const stitch = stitchFragment(frag, { nearby, linked: causalMap.get(frag.id) || [] });
    if (stitch) stitches.push({ fragmentId: frag.id, stitch });
  }

  for (const { fragmentId, stitch } of applyStitchBudget(stitches, args.tokenBudget || 1000)) {
    byId.set(fragmentId, { ...byId.get(fragmentId), stitched_context: stitch });
  }
  return byId;
}

/**
 * 반환 파편들에 미해결 contradicts 링크가 있는지 조회한다.
 * 힌트는 advisory이므로 조회 실패 시 false로 강등한다.
 *
 * @param {string[]} fragmentIds
 * @returns {Promise<boolean>}
 */
export async function hasPendingContradictions(fragmentIds, scope = {}) {
  if (!fragmentIds || fragmentIds.length === 0) return false;
  try {
    const pool = getPrimaryPool();
    if (!pool) return false;
    const agentScope = resolveAgentScope(scope);
    const params = [fragmentIds, agentScope.agentId];
    const keyClause = keyScopeClause(params, "o.key_id", {
      keyId: scope.keyId ?? null, groupKeyIds: scope.groupKeyIds
    });
    const workspaceFilter = workspaceCondition(params, scope, "o.workspace");
    const workspaceClause = workspaceFilter ? ` AND ${workspaceFilter}` : "";
    const review          = reviewVisibilityParts(params, { viewerKeyId: scope.keyId ?? null }, "o");
    const { rows } = await pool.query(
      `SELECT EXISTS (
         SELECT 1
           FROM ${SCHEMA}.fragment_links l
           JOIN ${SCHEMA}.fragments o
             ON o.id = CASE WHEN l.from_id = ANY($1) THEN l.to_id ELSE l.from_id END
          WHERE l.relation_type = 'contradicts'
            AND l.deleted_at IS NULL
            AND (l.from_id = ANY($1) OR l.to_id = ANY($1))
            AND o.valid_to IS NULL
            AND ${agentScopeCondition("$2", agentScope, "o.agent_id")}
            ${keyClause}${workspaceClause}${review.clause}
       ) AS pending`,
      params
    );
    return rows[0]?.pending === true;
  // iron-laws: ignore[IL-301] 모순 대기 확인은 힌트용이라 실패 시 없음으로 본다
  } catch {
    return false;
  }
}
