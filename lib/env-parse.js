/**
 * 환경 변수 원시값 판독
 *
 * lib/config.js의 envBool, envEnum과 스위치 대장(config/switches.js)이 같은 판독 규칙을 쓰도록
 * 원시 문자열을 분류하는 부분만 따로 둔다. 다른 모듈을 가져오지 않는다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */

/**
 * 불리언 원시값 분류. 공백만 있는 값은 미설정과 같고, "true"와 "false"만 유효한 값이다.
 *
 * @param {string|undefined} raw
 * @returns {{ status: "unset" } | { status: "valid", value: boolean } | { status: "invalid" }}
 */
export function classifyBool(raw) {
  if (raw === undefined || raw.trim() === "") return { status: "unset" };
  if (raw === "true")  return { status: "valid", value: true };
  if (raw === "false") return { status: "valid", value: false };
  return { status: "invalid" };
}

/**
 * 열거 원시값 분류. 공백만 있는 값은 미설정과 같고, allowed와 정확히 같은 값만 유효하다.
 * emptyOnly이면 빈 문자열만 미설정이고 공백만 있는 값은 잘못된 값이다.
 *
 * @param {string|undefined} raw
 * @param {readonly string[]} allowed
 * @param {{ emptyOnly?: boolean }} [options]
 * @returns {{ status: "unset" } | { status: "valid", value: string } | { status: "invalid" }}
 */
export function classifyEnum(raw, allowed, { emptyOnly = false } = {}) {
  if (raw === undefined || (emptyOnly ? raw === "" : raw.trim() === "")) return { status: "unset" };
  if (allowed.includes(raw)) return { status: "valid", value: raw };
  return { status: "invalid" };
}

/**
 * 호출 시점에 환경을 읽는 열거 스위치의 판독. 사용처가 이 함수로 값을 얻고, 스위치 대장의 시험이
 * 같은 함수로 대장의 적용 값을 대조한다. env는 변수 이름을 키로 하는 문자열 사전이다.
 */

/**
 * tools/call 인자 점검 방식. 빈 문자열과 미설정은 warn, off와 warn 외의 값(공백만 있는 값 포함)은 enforce.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {"off"|"warn"|"enforce"}
 */
export function readToolArgsValidation(env) {
  const mode = env.MEMENTO_TOOL_ARGS_VALIDATION || "warn";
  return mode === "off" || mode === "warn" ? mode : "enforce";
}

/**
 * OAuth 오류 리다이렉트 확인 방식. enforce만 enforce이고 그 밖의 값은 warn.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {"warn"|"enforce"}
 */
export function readOauthRedirectCheck(env) {
  return env.MEMENTO_OAUTH_REDIRECT_CHECK === "enforce" ? "enforce" : "warn";
}

/**
 * 허용 Origin 목록이 없을 때의 교차 출처 응답 방식. reflect와 allowlist만 인정하고 그 밖의 값은 observe.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {"reflect"|"observe"|"allowlist"}
 */
export function readCorsMode(env) {
  const mode = env.MEMENTO_CORS_MODE;
  return mode === "reflect" || mode === "allowlist" ? mode : "observe";
}

/**
 * X-Frame-Options 부착 여부. deny만 deny이고 그 밖의 값은 off.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {"deny"|"off"}
 */
export function readFrameOptions(env) {
  return env.MEMENTO_FRAME_OPTIONS === "deny" ? "deny" : "off";
}

/**
 * SSE 쿼리스트링 키 처리 방식. deny만 deny이고 그 밖의 값은 allow.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {"allow"|"deny"}
 */
export function readSseQueryKey(env) {
  return env.MEMENTO_SSE_QUERY_KEY === "deny" ? "deny" : "allow";
}

/**
 * 벡터 검색 인덱스 강제 힌트 사용 여부. off만 off이고 그 밖의 값은 on.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {"on"|"off"}
 */
export function readVectorForceIndex(env) {
  return env.MEMENTO_VECTOR_FORCE_INDEX === "off" ? "off" : "on";
}

/**
 * 관리 콘솔 메트릭 샘플링 여부. off만 off이고 그 밖의 값은 on.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {"on"|"off"}
 */
export function readAdminMetricsSampling(env) {
  return env.MEMENTO_ADMIN_METRICS_SAMPLING === "off" ? "off" : "on";
}

/**
 * prom-client 기본 메트릭 수집 여부. off만 off이고 그 밖의 값은 on.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {"on"|"off"}
 */
export function readMetricsDefault(env) {
  return env.MEMENTO_METRICS_DEFAULT === "off" ? "off" : "on";
}
