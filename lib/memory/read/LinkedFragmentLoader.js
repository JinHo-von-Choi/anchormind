/**
 * LinkedFragmentLoader - recall 결과에 1-hop 링크 파편 조회
 *
 * 작성자: 최진호
 * 작성일: 2026-03-28
 *
 * 모든 결과 파편 ID를 1회 쿼리로 조회하여 from_id별 상위 3개 링크를 반환한다.
 * 나가는 활성 링크만 본다. relationType을 주면 그 관계만, 없으면 resolved_by·caused_by·related만 고르고
 * resolved_by → caused_by → 가중치 순으로 자른다. 관계 조건은 LIMIT 앞에 둔다.
 */

import { getPrimaryPool } from "../../tools/db.js";
import { SCHEMA } from "../schema.js";
import { reviewVisibilityParts } from "./ReviewVisibility.js";
import { keyScopeClause } from "../keyScope.js";
import { workspaceCondition } from "./WorkspaceScope.js";
import { agentScopeCondition, resolveAgentScope } from "./AgentScope.js";
import { liveOrClosedCondition } from "../WorkingMemorySql.js";
import {
  PREVIEW_DEFAULT_RELATIONS, activeLinkCondition, relationOrderSql, safeRelationType
} from "../link/LinkVisibility.js";

/**
 * 주어진 파편 ID 배열에 대해 1-hop 연결 파편을 조회한다.
 *
 * @param {string[]} fragmentIds - 조회 대상 파편 ID 배열
 * @param {{agentId?: string, includePeerAgents?: boolean, keyId?: string|null,
 *   groupKeyIds?: string[], workspace?: string|null, allWorkspaces?: boolean,
 *   isAnchor?: boolean, includeSuperseded?: boolean, relationType?: string|null}} [scope]
 *   true=앵커만, false=비앵커만, 미지정=혼합. includeSuperseded=true이면 만료 파편도 허용.
 *   relationType은 허용된 관계 이름일 때만 쓰고 그 밖의 값은 미지정과 같다.
 * @returns {Promise<Map<string, Array<{id: string, relation_type: string, preview: string}>>>}
 *          from_id -> [linked fragment] (최대 3개씩)
 */
export async function fetchLinkedFragments(fragmentIds, scope = {}) {
  if (!fragmentIds || fragmentIds.length === 0) return new Map();

  const pool = getPrimaryPool();
  const agentScope = resolveAgentScope(scope);
  const params = [fragmentIds, agentScope.agentId];
  const keyClause = keyScopeClause(params, "f.key_id", {
    keyId      : scope.keyId ?? null,
    groupKeyIds: scope.groupKeyIds
  });
  const workspaceFilter = workspaceCondition(params, scope, "f.workspace");
  const workspaceClause = workspaceFilter ? ` AND ${workspaceFilter}` : "";
  const anchorClause = scope.isAnchor === undefined
    ? ""
    : `AND f.is_anchor = $${params.push(scope.isAnchor)}`;
  const validClause = `AND ${liveOrClosedCondition(scope.includeSuperseded === true, "f")}`;
  /** 다른 키의 검토 대기 파편은 미리보기에도 나오지 않는다. 보는 주체는 호출 키다. */
  const review      = reviewVisibilityParts(params, { viewerKeyId: scope.keyId ?? null });
  const relation    = safeRelationType(scope.relationType);
  const relations   = relation ? [relation] : [...PREVIEW_DEFAULT_RELATIONS];
  const relationIdx = params.push(relations);
  /** 링크만 먼저 관계 우선순위 → 가중치 순으로 정렬하고, 그 순서대로 파편을 하나씩 조회해 조건을 통과한 3건에서
   *  멈춘다. 링크와 파편을 한 번에 조인해 정렬하면 시드의 링크 수만큼 파편을 조회한다. OFFSET 0은 두 하위 질의가
   *  바깥 질의로 펼쳐지지 않게 막는다. */
  const { rows } = await pool.query(
    `SELECT sub.from_id, sub.to_id, sub.relation_type, sub.preview
       FROM unnest($1::text[]) AS fid(id)
       CROSS JOIN LATERAL (
         SELECT l.from_id, l.to_id, l.relation_type, f.preview
           FROM (
             SELECT fl.from_id, fl.to_id, fl.relation_type, fl.weight, ${relationOrderSql("fl")} AS relation_rank
               FROM ${SCHEMA}.fragment_links fl
              WHERE fl.from_id = fid.id
                AND ${activeLinkCondition("fl")}
                AND fl.relation_type = ANY($${relationIdx}::text[])
              ORDER BY relation_rank, fl.weight DESC, fl.to_id
             OFFSET 0
           ) l
           CROSS JOIN LATERAL (
             SELECT LEFT(f.content, 60) AS preview
               FROM ${SCHEMA}.fragments f
              WHERE f.id = l.to_id
                ${validClause}
                AND ${agentScopeCondition("$2", agentScope, "f.agent_id")}
                ${keyClause}${workspaceClause}${anchorClause}${review.clause}
             OFFSET 0
           ) f
          ORDER BY l.relation_rank, l.weight DESC, l.to_id
          LIMIT 3
       ) sub`,
    params
  );

  const result = new Map();
  for (const row of rows) {
    const entry = {
      id           : row.to_id,
      relation_type: row.relation_type,
      preview      : row.preview
    };
    if (result.has(row.from_id)) {
      result.get(row.from_id).push(entry);
    } else {
      result.set(row.from_id, [entry]);
    }
  }

  return result;
}
