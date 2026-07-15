/**
 * Prometheus 메트릭
 *
 * 작성자: 최진호
 * 작성일: 2026-02-13
 */

import prometheus        from "prom-client";

/** 레지스트리 */
export const register    = new prometheus.Registry();

/** 기본 메트릭 활성화 (CPU, 메모리 등) — 단위 테스트 환경에서 MEMENTO_METRICS_DEFAULT=off 로 비활성화 */
if (process.env.MEMENTO_METRICS_DEFAULT !== "off") {
  prometheus.collectDefaultMetrics({
    register,
    prefix: "mcp_"
  });
}

/** HTTP 요청 카운터 */
export const httpRequestsTotal = new prometheus.Counter({
  name      : "mcp_http_requests_total",
  help      : "Total number of HTTP requests",
  labelNames: ["method", "endpoint", "status"],
  registers : [register]
});

/** HTTP 요청 지속 시간 */
export const httpRequestDuration = new prometheus.Histogram({
  name      : "mcp_http_request_duration_seconds",
  help      : "HTTP request duration in seconds",
  labelNames: ["method", "endpoint", "status"],
  buckets   : [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
  registers : [register]
});

/** JSON-RPC 메서드 호출 카운터 */
export const rpcMethodCalls = new prometheus.Counter({
  name      : "mcp_rpc_method_calls_total",
  help      : "Total number of JSON-RPC method calls",
  labelNames: ["method", "success"],
  registers : [register]
});

/** JSON-RPC 메서드 지속 시간 */
export const rpcMethodDuration = new prometheus.Histogram({
  name      : "mcp_rpc_method_duration_seconds",
  help      : "JSON-RPC method duration in seconds",
  labelNames: ["method"],
  buckets   : [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
  registers : [register]
});

/** 도구 실행 카운터 */
export const toolExecutionsTotal = new prometheus.Counter({
  name      : "mcp_tool_executions_total",
  help      : "Total number of tool executions",
  labelNames: ["tool", "success"],
  registers : [register]
});

/** 도구 실행 지속 시간 */
export const toolExecutionDuration = new prometheus.Histogram({
  name      : "mcp_tool_execution_duration_seconds",
  help      : "Tool execution duration in seconds",
  labelNames: ["tool"],
  buckets   : [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 30],
  registers : [register]
});

/** 활성 세션 수 (Streamable) */
export const activeSessionsStreamable = new prometheus.Gauge({
  name     : "mcp_active_sessions_streamable",
  help     : "Number of active Streamable HTTP sessions",
  registers: [register]
});

/** 활성 세션 수 (Legacy SSE) */
export const activeSessionsLegacy = new prometheus.Gauge({
  name     : "mcp_active_sessions_legacy",
  help     : "Number of active Legacy SSE sessions",
  registers: [register]
});

/** OAuth 토큰 발급 카운터 */
export const oauthTokensIssued = new prometheus.Counter({
  name      : "mcp_oauth_tokens_issued_total",
  help      : "Total number of OAuth tokens issued",
  labelNames: ["grant_type"],
  registers : [register]
});

/** OAuth 토큰 검증 카운터 */
export const oauthTokenValidations = new prometheus.Counter({
  name      : "mcp_oauth_token_validations_total",
  help      : "Total number of OAuth token validations",
  labelNames: ["result"],
  registers : [register]
});

/** 에러 카운터 */
export const errorsTotal = new prometheus.Counter({
  name      : "mcp_errors_total",
  help      : "Total number of errors",
  labelNames: ["type", "code"],
  registers : [register]
});

/** 프로토콜 버전 협상 카운터 */
export const protocolVersionNegotiations = new prometheus.Counter({
  name      : "mcp_protocol_version_negotiations_total",
  help      : "Total number of protocol version negotiations",
  labelNames: ["requested_version", "negotiated_version"],
  registers : [register]
});

/** 인증 시도 카운터 */
export const authenticationAttempts = new prometheus.Counter({
  name      : "mcp_authentication_attempts_total",
  help      : "Total number of authentication attempts",
  labelNames: ["method", "success"],
  registers : [register]
});

/**
 * 세션 수 업데이트
 */
export function updateSessionCounts(streamableCount, legacyCount) {
  activeSessionsStreamable.set(streamableCount);
  activeSessionsLegacy.set(legacyCount);
}

/**
 * HTTP 요청 기록
 */
export function recordHttpRequest(method, endpoint, statusCode, durationSeconds) {
  httpRequestsTotal.inc({
    method,
    endpoint,
    status: statusCode
  });

  httpRequestDuration.observe({
    method,
    endpoint,
    status: statusCode
  }, durationSeconds);
}

/**
 * RPC 메서드 호출 기록
 */
export function recordRpcMethod(method, success, durationSeconds) {
  rpcMethodCalls.inc({
    method,
    success: success ? "true" : "false"
  });

  rpcMethodDuration.observe({ method }, durationSeconds);
}

/**
 * 도구 실행 기록
 */
export function recordToolExecution(toolName, success, durationSeconds) {
  toolExecutionsTotal.inc({
    tool: toolName,
    success: success ? "true" : "false"
  });

  toolExecutionDuration.observe({ tool: toolName }, durationSeconds);
}

/**
 * 에러 기록
 */
export function recordError(errorType, errorCode) {
  errorsTotal.inc({
    type: errorType,
    code: String(errorCode)
  });
}

/**
 * 프로토콜 버전 협상 기록
 */
export function recordProtocolNegotiation(requestedVersion, negotiatedVersion) {
  protocolVersionNegotiations.inc({
    requested_version: requestedVersion || "none",
    negotiated_version: negotiatedVersion
  });
}

/**
 * 인증 시도 기록
 */
export function recordAuthenticationAttempt(method, success) {
  authenticationAttempts.inc({
    method,
    success: success ? "true" : "false"
  });
}

/** 인증 거부 카운터 */
export const authDeniedTotal = new prometheus.Counter({
  name      : "memento_auth_denied_total",
  help      : "Total number of authentication denials",
  labelNames: ["reason"],
  registers : [register]
});

/** CORS 거부 카운터 */
export const corsDeniedTotal = new prometheus.Counter({
  name      : "memento_cors_denied_total",
  help      : "Total number of CORS origin denials",
  labelNames: ["reason"],
  registers : [register]
});

/** RBAC 거부 카운터 */
export const rbacDeniedTotal = new prometheus.Counter({
  name      : "memento_rbac_denied_total",
  help      : "Total number of RBAC permission denials",
  labelNames: ["tool", "reason"],
  registers : [register]
});

/** 테넌트 격리 차단 카운터 */
export const tenantIsolationBlockedTotal = new prometheus.Counter({
  name      : "memento_tenant_isolation_blocked_total",
  help      : "Total number of tenant isolation blocks",
  labelNames: ["component"],
  registers : [register]
});

/**
 * 인증 거부 기록
 */
export function recordAuthDenied(reason) {
  authDeniedTotal.inc({ reason });
}

/**
 * CORS 거부 기록
 */
export function recordCorsDenied(reason) {
  corsDeniedTotal.inc({ reason });
}

/**
 * RBAC 거부 기록
 */
export function recordRbacDenied(tool, reason) {
  rbacDeniedTotal.inc({ tool, reason });
}

/**
 * 테넌트 격리 차단 기록
 */
export function recordTenantIsolationBlocked(component) {
  tenantIsolationBlockedTotal.inc({ component });
}

/** Redis 세션 저장 실패 카운터 */
export const redisSessionSaveFailureTotal = new prometheus.Counter({
  name      : "mcp_redis_session_save_failure_total",
  help      : "Total number of Redis session save failures",
  labelNames: ["operation"],
  registers : [register]
});

/** 세션 복구 결과 카운터 */
export const sessionRecoveryTotal = new prometheus.Counter({
  name      : "mcp_session_recovery_total",
  help      : "Total number of session recovery attempts",
  labelNames: ["result"],
  registers : [register]
});

/** 세션 idle reflect 카운터 */
export const sessionIdleReflectTotal = new prometheus.Counter({
  name      : "mcp_session_idle_reflect_total",
  help      : "Total number of session idle reflect executions",
  registers : [register]
});

/**
 * Redis 세션 저장 실패 기록
 */
export function recordRedisSessionSaveFailure(operation = "save") {
  redisSessionSaveFailureTotal.inc({ operation });
}

/**
 * 세션 복구 결과 기록
 *
 * @param {"same_id_success"|"keyid_mismatch"|"not_found"|"new_session"} result
 */
export function recordSessionRecovery(result) {
  sessionRecoveryTotal.inc({ result });
}

/**
 * 세션 idle reflect 실행 기록
 */
export function recordSessionIdleReflect() {
  sessionIdleReflectTotal.inc();
}

/**
 * OAuth 토큰 발급 기록
 */
export function recordOAuthTokenIssued(grantType) {
  oauthTokensIssued.inc({ grant_type: grantType });
}

/**
 * OAuth 토큰 검증 기록
 */
export function recordOAuthTokenValidation(isValid) {
  oauthTokenValidations.inc({
    result: isValid ? "valid" : "invalid"
  });
}

/** non-API-key OAuth 거부 카운터 */
export const oauthNonApiKeyRejectedTotal = new prometheus.Counter({
  name      : "mcp_oauth_nonapikey_rejected_total",
  help      : "Total number of non-API-key OAuth authentication rejections",
  registers : [register]
});

/** name 기반 client_id 바인딩 등록 카운터 (v2.8.4) */
export const oauthBoundClientRegisteredTotal = new prometheus.Counter({
  name    : "mcp_oauth_bound_client_registered_total",
  help    : "Total number of OAuth clients registered with name-based client_id binding",
  registers: [register]
});

/** name 기반 client_id 바인딩 authorize 진입 카운터 (v2.8.4) */
export const oauthBoundClientAuthorizedTotal = new prometheus.Counter({
  name    : "mcp_oauth_bound_client_authorized_total",
  help    : "Total number of OAuth authorize requests that resolved via bound_key_id path",
  registers: [register]
});

/** name 기반 client_id 바인딩 인증 성공 카운터 (v2.8.4) */
export const oauthBoundClientAuthenticatedTotal = new prometheus.Counter({
  name    : "mcp_oauth_bound_client_authenticated_total",
  help    : "Total number of authentication successes via bound_key_id path",
  registers: [register]
});

/** OAuth auto-registration 차단 카운터 */
export const oauthAutoRegisterBlockedTotal = new prometheus.Counter({
  name      : "mcp_oauth_auto_register_blocked_total",
  help      : "Total number of blocked OAuth auto-registration attempts",
  registers : [register]
});

/**
 * non-API-key OAuth 거부 기록
 */
export function recordOAuthNonApiKeyRejected() {
  oauthNonApiKeyRejectedTotal.inc();
}

/**
 * name 기반 client_id 바인딩 등록 기록 (v2.8.4)
 */
export function recordOAuthBoundClientRegistered() {
  oauthBoundClientRegisteredTotal.inc();
}

/**
 * name 기반 client_id 바인딩 authorize 진입 기록 (v2.8.4)
 */
export function recordOAuthBoundClientAuthorized() {
  oauthBoundClientAuthorizedTotal.inc();
}

/**
 * name 기반 client_id 바인딩 인증 성공 기록 (v2.8.4)
 */
export function recordOAuthBoundClientAuthenticated() {
  oauthBoundClientAuthenticatedTotal.inc();
}

/**
 * OAuth auto-registration 차단 기록
 */
export function recordOAuthAutoRegisterBlocked() {
  oauthAutoRegisterBlockedTotal.inc();
}

/** 세션 404 카운터 (sessionId 있으나 복구 불가, 또는 expired) */
export const sessionNotFoundTotal = new prometheus.Counter({
  name      : "mcp_session_404_total",
  help      : "Total number of session-not-found (404) responses",
  registers : [register]
});

/** Origin 거부 카운터 (MCP_STRICT_ORIGIN=true 시 허용 목록 외 Origin 차단) */
export const originRejectedTotal = new prometheus.Counter({
  name      : "mcp_origin_rejected_total",
  help      : "Total number of requests rejected due to disallowed Origin header",
  labelNames: ["origin"],
  registers : [register]
});

/** 프로토콜 버전 거부 카운터 (지원하지 않는 MCP-Protocol-Version 헤더) */
export const protocolVersionRejectedTotal = new prometheus.Counter({
  name      : "mcp_protocol_version_rejected_total",
  help      : "Total number of requests rejected due to unsupported MCP-Protocol-Version header",
  labelNames: ["version"],
  registers : [register]
});

/**
 * 세션 404 기록
 */
export function recordSession404() {
  sessionNotFoundTotal.inc();
}

/**
 * Origin 거부 기록
 *
 * @param {string} origin - 거부된 Origin 값
 */
export function recordOriginRejected(origin) {
  originRejectedTotal.inc({ origin: origin || "unknown" });
}

/**
 * 프로토콜 버전 거부 기록
 *
 * @param {string} version - 거부된 MCP-Protocol-Version 헤더 값
 */
export function recordProtocolVersionRejected(version) {
  protocolVersionRejectedTotal.inc({ version: version || "unknown" });
}

/**
 * Phase 7: Batch Pool 모니터링 지표
 *
 * BatchRememberProcessor 전용 분리 풀(application_name='memento-mcp:batch')의
 * active/idle 커넥션 수를 Prometheus에 노출한다.
 * pg_stat_activity 필터 조건: application_name = 'memento-mcp:batch'
 */

/** Batch pool 활성(체크아웃) 커넥션 수 */
export const batchPoolActiveConnections = new prometheus.Gauge({
  name     : "mcp_batch_pool_active_connections",
  help     : "Number of active (checked-out) connections in the batch pool",
  registers: [register]
});

/** Batch pool 유휴 커넥션 수 */
export const batchPoolIdleConnections = new prometheus.Gauge({
  name     : "mcp_batch_pool_idle_connections",
  help     : "Number of idle connections in the batch pool",
  registers: [register]
});

/** Batch pool 대기 중인 쿼리 수 */
export const batchPoolWaitingCount = new prometheus.Gauge({
  name     : "mcp_batch_pool_waiting_count",
  help     : "Number of queries waiting for a connection in the batch pool",
  registers: [register]
});

/**
 * Batch pool 지표 갱신
 *
 * @param {{totalCount: number, idleCount: number, waitingCount: number}} stats
 */
export function recordBatchPoolStats(stats) {
  const active = (stats.totalCount || 0) - (stats.idleCount || 0);
  batchPoolActiveConnections.set(Math.max(0, active));
  batchPoolIdleConnections.set(stats.idleCount   || 0);
  batchPoolWaitingCount.set(stats.waitingCount || 0);
}

/** 임베딩 세마포어 대기 타임아웃 초과 카운터 */
export const embeddingSemaphoreWaitExceededTotal = new prometheus.Counter({
  name      : "mcp_embedding_semaphore_wait_exceeded_total",
  help      : "Total number of embedding calls that exceeded the semaphore wait timeout",
  registers : [register]
});

/** initialize 요청 IP rate limit 선차단(429) 카운터 */
export const initializeIpRateLimitedTotal = new prometheus.Counter({
  name      : "mcp_initialize_ip_rate_limited_total",
  help      : "Total number of initialize requests rejected by pre-auth IP rate limit",
  registers : [register]
});

/** Quota check 캐시 패스(정밀 락 생략) 카운터 */
export const quotaCachePassTotal = new prometheus.Counter({
  name      : "mcp_quota_cache_pass_total",
  help      : "Total number of quota checks that passed via cache without the FOR UPDATE lock",
  registers : [register]
});

/** 임베딩 세마포어 대기 초과 기록 */
export function recordEmbeddingSemaphoreWaitExceeded() {
  embeddingSemaphoreWaitExceededTotal.inc();
}

/** initialize IP rate limit 선차단 기록 */
export function recordInitializeIpRateLimited() {
  initializeIpRateLimitedTotal.inc();
}

/** Quota 캐시 패스 기록 */
export function recordQuotaCachePass() {
  quotaCachePassTotal.inc();
}
