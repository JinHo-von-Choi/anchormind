import { ALLOW_LEGACY_UNBOUND_AGENT_SCOPE } from "../../config.js";

/**
 * 에이전트 읽기 범위의 단일 계약.
 *
 * - agentId 미지정: default 공유 기억만
 * - agentId 지정: 해당 agent + default 공유 기억
 * - includePeerAgents: 모든 agent (상위 인증 경계에서 master 전용으로 검증)
 */
export function resolveAgentScope({ agentId, includePeerAgents = false } = {}) {
  const effectiveAgentId = typeof agentId === "string" && agentId.trim()
    ? agentId.trim()
    : "default";
  const peer = includePeerAgents === true;
  return Object.freeze({
    agentId          : effectiveAgentId,
    includePeerAgents: peer,
    agentIds         : peer
      ? null
      : [...new Set([effectiveAgentId, "default"])],
    auditLabel       : peer
      ? "all-agents"
      : (effectiveAgentId === "default" ? "default-only" : "specific+default")
  });
}

/** fragment 객체에 effective-agent 계약을 적용한다. */
export function isFragmentInAgentScope(fragment, scope) {
  if (!fragment) return false;
  /** 캐시/수화 객체에 agent metadata가 없으면 private 여부를 증명할 수 없다. */
  if (typeof fragment.agent_id !== "string" || fragment.agent_id.length === 0) return false;
  if (scope.includePeerAgents) return true;
  return scope.agentIds.includes(fragment.agent_id);
}

/**
 * SQL WHERE 조건을 만든다. scalar agentId placeholder를 유지하여 기존 쿼리의
 * 파라미터 순서를 바꾸지 않는다.
 */
export function agentScopeCondition(paramRef, scope, col = "agent_id") {
  return scope.includePeerAgents
    /** identity 범위만 완화한다. 귀속 불명(NULL) legacy row는 계속 fail-closed한다. */
    ? `(${col} IS NOT NULL AND COALESCE(${paramRef}::text, 'default') IS NOT NULL) /* peer-agent: no ${col} filter */`
    : `(${col} = ${paramRef} OR ${col} = 'default')`;
}

/** API-key 요청에서 peer 범위가 요청되면 권한 오류를 발생시킨다. */
export function assertMasterPeerScope(params = {}) {
  if (params.includePeerAgents === true && params._isMaster !== true) {
    const err = new Error("peer-agent reads are master-key only");
    err.code = "FORBIDDEN";
    throw err;
  }
  return resolveAgentScope(params);
}

/** 일반 API key는 서버에 바인딩된 agent identity 밖의 범위를 지정할 수 없다. */
export function assertAuthenticatedAgentScope(params = {}, {
  allowLegacyUnbound = ALLOW_LEGACY_UNBOUND_AGENT_SCOPE
} = {}) {
  if (params._isMaster === true) return resolveAgentScope(params);
  const scope = resolveAgentScope(params);
  if (scope.agentId !== "default" && allowLegacyUnbound !== true) {
    const err = new Error("agentId is not authorized for this API key");
    err.code = "FORBIDDEN";
    throw err;
  }
  return scope;
}
