/**
 * 질의 바인딩 배열에 싣는 키 범위
 *
 * 작성자: 최진호
 * 작성일: 2026-11-04
 *
 * 키 격리 절을 만드는 도우미(lib/memory/keyScope.js)가 절에 넣은 키 id를 바인딩 배열의 기호 속성에도 적는다.
 * queryWithAgentVector(lib/tools/db.js)는 이 목록을 트랜잭션 설정 app.current_key_ids로 넘기고, 행 수준 보안 정책
 * (migration-080)이 같은 범위를 DB에서 한 번 더 건다. 기호 속성은 배열 원소가 아니라서 질의 값에는 들어가지 않는다.
 * 바인딩 배열을 펼쳐 새 배열을 만들면 목록이 따라가지 않으므로, 펼친 배열을 넘기는 호출부는 키 축을 받지 않는다.
 * 한 질의에서 도우미를 여러 번 부르면 키 목록을 합친다(정책은 앱 절보다 넓거나 같아야 결과를 바꾸지 않는다).
 * 다른 모듈을 가져오지 않는다.
 */

/** 바인딩 배열의 키 범위 기호 */
export const KEY_SCOPE_IDS = Symbol.for("memento.keyScopeIds");

/**
 * 바인딩 배열에 키 id를 더한다.
 *
 * @param {unknown[]} params
 * @param {Array<string|null|undefined>} ids
 */
export function noteKeyScope(params, ids) {
  if (!Array.isArray(params)) return;
  const prev = Array.isArray(params[KEY_SCOPE_IDS]) ? params[KEY_SCOPE_IDS] : [];
  /** 열거되지 않는 속성으로 둔다. 배열 비교(deepStrictEqual)와 펼치기에 나타나지 않는다. */
  Object.defineProperty(params, KEY_SCOPE_IDS, {
    value       : [...new Set([...prev, ...ids.filter((id) => typeof id === "string" && id !== "")])],
    writable    : true,
    configurable: true,
    enumerable  : false
  });
}

/**
 * 바인딩 배열에 적힌 키 id. 없으면 null이다.
 *
 * @param {unknown} params
 * @returns {string[]|null}
 */
export function keyScopeIdsOf(params) {
  const ids = Array.isArray(params) ? params[KEY_SCOPE_IDS] : undefined;
  return Array.isArray(ids) && ids.length > 0 ? ids : null;
}

/**
 * 키 id 목록을 app.current_key_ids 값으로 만든다. 정책이 비교하는 값과 같도록 [^a-zA-Z0-9_-]를 지우고
 * 중복을 뺀 뒤 쉼표로 잇는다. null과 undefined 원소는 뺀다. 목록이 없으면 빈 문자열이다.
 *
 * @param {unknown} ids
 * @returns {string}
 */
export function keyIdSetting(ids) {
  if (!Array.isArray(ids)) return "";
  const cleaned = ids.filter((id) => id != null).map((id) => String(id).replace(/[^a-zA-Z0-9_-]/g, ""));
  return [...new Set(cleaned.filter(Boolean))].join(",");
}
