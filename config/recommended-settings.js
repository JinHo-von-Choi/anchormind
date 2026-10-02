/**
 * 운영 권장 설정 점검
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */

/**
 * 운영 권장 설정 중 적용되지 않은 항목 이름 목록. 값은 싣지 않는다.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
export function recommendedSettingsGap(env = process.env) {
  const gap = [];
  if (env.TRUST_PROXY_HOPS === undefined)                gap.push("TRUST_PROXY_HOPS");
  if (env.MEMENTO_CORS_MODE !== "allowlist")             gap.push("MEMENTO_CORS_MODE=allowlist");
  if (env.MEMENTO_FRAME_OPTIONS !== "deny")              gap.push("MEMENTO_FRAME_OPTIONS=deny");
  if (env.MEMENTO_OAUTH_REDIRECT_CHECK !== "enforce")    gap.push("MEMENTO_OAUTH_REDIRECT_CHECK=enforce");
  if (env.MEMENTO_SSE_QUERY_KEY !== "deny")              gap.push("MEMENTO_SSE_QUERY_KEY=deny");
  if (env.MEMENTO_TOOL_ARGS_VALIDATION !== "enforce")    gap.push("MEMENTO_TOOL_ARGS_VALIDATION=enforce");
  return gap;
}
