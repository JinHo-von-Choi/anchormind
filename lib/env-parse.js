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
 *
 * @param {string|undefined} raw
 * @param {readonly string[]} allowed
 * @returns {{ status: "unset" } | { status: "valid", value: string } | { status: "invalid" }}
 */
export function classifyEnum(raw, allowed) {
  if (raw === undefined || raw.trim() === "") return { status: "unset" };
  if (allowed.includes(raw)) return { status: "valid", value: raw };
  return { status: "invalid" };
}
