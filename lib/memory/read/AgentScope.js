import { ALLOW_LEGACY_UNBOUND_AGENT_SCOPE, reservedAgentIdsMode } from "../../config.js";
import { legacyUnboundAgentScopeTotal } from "../../metrics.js";
import { logWarn } from "../../logger.js";

export { reservedAgentIdsMode };

/** 내부 작업 전용 agentId. DB 계층(db.js)과 같은 정제 규칙을 적용한 뒤 비교한다. */
const RESERVED_AGENT_IDS = new Set(["system", "admin"]);

/**
 * 정제 후 예약 agentId와 같아지는지 판정한다(예: "sy.stem", "SYSTEM").
 * @param {unknown} agentId
 * @returns {boolean}
 */
export function isReservedAgentId(agentId) {
  if (typeof agentId !== "string") return false;
  return RESERVED_AGENT_IDS.has(agentId.replace(/[^a-zA-Z0-9_-]/g, "").toLowerCase());
}

/**
 * 에이전트 읽기 범위의 단일 계약.
 *
 * - agentId 미지정: default 공유 기억만
 * - agentId 지정: 해당 agent + default 공유 기억
 * - includePeerAgents: 모든 agent (신뢰된 _isMaster=true가 있어야 허용)
 */
export function resolveAgentScope({ agentId, includePeerAgents = false, _isMaster = false } = {}) {
  if (typeof agentId === "string" && agentId.length > 128) {
    const err = new Error("agentId must contain at most 128 characters");
    err.code = "INVALID_PARAMS";
    throw err;
  }
  if (includePeerAgents === true && _isMaster !== true) {
    const err = new Error("peer-agent reads are master-key only");
    err.code = "FORBIDDEN";
    throw err;
  }
  const effectiveAgentId = typeof agentId === "string" && agentId.trim()
    ? agentId.trim()
    : "default";
  const peer = includePeerAgents === true;
  return Object.freeze({
    _isMaster       : _isMaster === true,
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
  const keyRef = String(params._keyId ?? "none").slice(0, 8);
  if (isReservedAgentId(params.agentId)) {
    const mode = reservedAgentIdsMode();
    logWarn(`[AgentScope] reserved agentId requested: key=${keyRef} mode=${mode}`);
    if (mode === "enforce") {
      const err = new Error("agentId is reserved for internal use");
      err.code = "FORBIDDEN";
      throw err;
    }
  }
  const scope = resolveAgentScope(params);
  if (scope.agentId !== "default" && allowLegacyUnbound !== true) {
    const err = new Error("agentId is not authorized for this API key");
    err.code = "FORBIDDEN";
    throw err;
  }
  if (scope.agentId !== "default") {
    legacyUnboundAgentScopeTotal.inc();
    logWarn(`Legacy unbound agent scope compatibility used: key=${keyRef}; set MEMENTO_ALLOW_LEGACY_UNBOUND_AGENT_SCOPE=false to enforce strict agent identity`);
  }
  return scope;
}
