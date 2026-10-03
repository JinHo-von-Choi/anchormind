/**
 * ProvenanceLoader - 파편 id의 출처 열 조회와 recall 범위 술어
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 꾸러미 항목, 기본 형식 recall 응답 파편, context core 후보의 출처 열(source, MEMENTO_PROVENANCE=on이면
 * origin과 trust_tier)을 한 질의로 읽는다. 질의는 recall과 같은 agent, 키(그룹 포함), workspace 술어와
 * 작업 기억 행 제외를 건다. 호출자가 풀을 넘기며 이 모듈은 DB 모듈을 가져오지 않는다.
 */

import { keyScopeClause }                         from "../keyScope.js";
import { SCHEMA }                                 from "../schema.js";
import { notWorkingMemoryRow }                    from "../WorkingMemorySql.js";
import { workspaceCondition }                     from "./WorkspaceScope.js";
import { agentScopeCondition, resolveAgentScope } from "./AgentScope.js";
import { provenanceEnabled }                      from "../../config.js";
import { originLabel }                            from "../provenance.js";

/**
 * 상대 파편 f에 거는 범위 술어. params에 값을 덧붙인다.
 *
 * @param {Array} params - $1은 항목 id 배열로 이미 들어 있어야 한다
 * @param {object} scope
 * @returns {string} AND로 시작하는 절
 */
export function scopeClause(params, scope) {
  const agentScope = resolveAgentScope(scope);
  params.push(agentScope.agentId);
  const agentClause     = `AND ${agentScopeCondition(`$${params.length}`, agentScope, "f.agent_id")}`;
  const keyClause       = keyScopeClause(params, "f.key_id", {
    keyId      : scope.keyId ?? null,
    groupKeyIds: scope.groupKeyIds
  });
  const workspaceFilter = workspaceCondition(params, scope, "f.workspace");
  const workspaceClause = workspaceFilter ? ` AND ${workspaceFilter}` : "";
  return `AND ${notWorkingMemoryRow("f")} ${agentClause}${keyClause}${workspaceClause}`;
}

/**
 * 파편 id의 출처 열을 읽는다. 항목은 source를 갖고, MEMENTO_PROVENANCE=on이면 origin(알려진 값만)과
 * trustTier(저장값, NULL 그대로)도 갖는다. 범위 밖이거나 없는 id는 결과에 없다.
 *
 * @param {string[]} fragmentIds
 * @param {object} scope - recall과 같은 조회 범위
 * @param {() => {query: Function}|null} getPool - 호출자가 쓰는 풀
 * @returns {Promise<Map<string, {source: string|null, origin?: string|null, trustTier?: number|null}>>}
 */
export async function loadFragmentProvenance(fragmentIds, scope, getPool) {
  const ids = [...new Set((fragmentIds ?? []).filter(Boolean))];
  if (ids.length === 0) return new Map();
  const pool = getPool();
  if (!pool) return new Map();

  const withProvenance = provenanceEnabled();
  const params         = [ids];
  const scopeSql       = scopeClause(params, scope);
  const { rows }       = await pool.query(
    `SELECT f.id, f.source${withProvenance ? ", f.origin, f.trust_tier" : ""}
       FROM ${SCHEMA}.fragments f
      WHERE f.id = ANY($1::text[])
        ${scopeSql}`,
    params
  );

  const result = new Map();
  for (const row of rows) {
    const entry = { source: row.source ?? null };
    if (withProvenance) Object.assign(entry, { origin: originLabel(row.origin), trustTier: row.trust_tier ?? null });
    result.set(row.id, entry);
  }
  return result;
}
