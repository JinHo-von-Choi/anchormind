/**
 * 키 격리 WHERE 절 생성기
 *
 * 작성자: 최진호
 * 수정일: 2026-08-28
 *
 * 격리 조건을 SQL 문자열로 직접 쓰는 지점이 코드 전반에 흩어져 있으면, 새 질의를
 * 쓸 때마다 어느 표현이 맞는지 다시 판단해야 한다. 판단이 갈리는 축은 셋이다.
 * 그룹 공유를 허용하는가, 전역 파편(key_id IS NULL)을 포함하는가, 마스터 키를
 * 어떻게 다루는가.
 *
 * 이 모듈은 그 세 축의 조합을 이름이 붙은 변형으로 고정한다. 호출부는 SQL을 쓰는
 * 대신 의도에 맞는 변형을 고른다. 각 변형은 기존 질의가 만들어내던 SQL과 정확히
 * 같은 문자열을 만든다. 표현을 모으는 것이 목적이며 의미를 바꾸지 않는다.
 *
 * 격리가 아닌 질의에는 쓰지 않는다. 할당량 회계, 그룹 멤버십 조회, 멱등키 범위
 * 판정은 대상이 다른 별개 연산이다.
 */

/**
 * 그룹 공유를 허용하는 표준 격리 절.
 *
 * 스칼라 키와 그룹 배열을 함께 본다. 전역 파편은 매칭하지 않는다.
 * keyId가 null이면 마스터로 보아 빈 절을 반환해 전체 접근을 허용한다.
 *
 * @param {Array}       params  바인딩 배열 (in-place로 push된다)
 * @param {string}      column  비교 대상 컬럼 (예: "f.key_id")
 * @param {Object}      scope
 * @param {string|null} scope.keyId
 * @param {string[]}    [scope.groupKeyIds]
 * @returns {string} 선행 공백을 포함한 AND 절 또는 빈 문자열
 */
export function keyScopeClause(params, column, { keyId, groupKeyIds }) {
  if (keyId == null) {
    return "";
  }
  const arr = (Array.isArray(groupKeyIds) && groupKeyIds.length > 0)
    ? groupKeyIds
    : [keyId];
  params.push(keyId, arr);
  const scalarIdx = params.length - 1;
  const arrIdx    = params.length;
  return ` AND (${column} IS NOT DISTINCT FROM $${scalarIdx} OR ${column} = ANY($${arrIdx}::text[]))`;
}

/**
 * 스칼라 키 단독 격리 절. 그룹 공유를 허용하지 않는다.
 *
 * 소유 키 본인의 파편만 대상으로 삼아야 하는 질의에 쓴다. 전역 파편은
 * 매칭하지 않는다. keyId가 null이면 빈 절을 반환한다.
 *
 * @param {Array}       params
 * @param {string}      column
 * @param {string|null} keyId
 * @returns {string}
 */
export function keyScopeScalar(params, column, keyId) {
  if (keyId == null) {
    return "";
  }
  params.push(keyId);
  return ` AND ${column} = $${params.length}`;
}

/**
 * 그룹 배열 단독 격리 절.
 *
 * 호출부가 이미 유효 키 목록을 계산해 둔 경우에 쓴다. 전역 파편은 매칭하지
 * 않는다.
 *
 * null과 빈 배열은 다르게 다룬다. null은 격리 없음이고, 빈 배열은 접근 가능한
 * 키가 하나도 없다는 뜻이므로 아무것도 매칭하지 않는 절을 낸다. 빈 배열에
 * 빈 절을 내면 격리가 풀려 전체 파편이 노출된다.
 *
 * @param {Array}         params
 * @param {string}        column
 * @param {string[]|null} keyIds
 * @returns {string}
 */
export function keyScopeGroup(params, column, keyIds) {
  if (!Array.isArray(keyIds)) {
    return "";
  }
  params.push(keyIds);
  return ` AND ${column} = ANY($${params.length}::text[])`;
}

/**
 * NULL 동치 격리 절.
 *
 * keyId가 null일 때 전역 파편(key_id IS NULL)만 매칭한다는 점에서 다른 변형과
 * 다르다. 마스터 키에 전체 접근을 주는 것이 아니라 전역 파편으로 좁히는 것이
 * 의도인 질의에만 쓴다.
 *
 * @param {Array}       params
 * @param {string}      column
 * @param {string|null} keyId
 * @returns {string}
 */
export function keyScopeNullable(params, column, keyId) {
  params.push(keyId ?? null);
  return ` AND ${column} IS NOT DISTINCT FROM $${params.length}`;
}

/**
 * 접두사 없는 격리 조건.
 *
 * 조건들을 배열에 모아 `WHERE ... AND ...`로 조립하는 호출부에 쓴다. 반환값에
 * 선행 `AND`가 없다는 점만 다르고 의미는 대응하는 변형과 같다.
 *
 * @param {Array}                params
 * @param {string}               column
 * @param {string|string[]|null} keyId  배열이면 그룹 격리, 스칼라면 단독 격리
 * @returns {string} 조건 문자열 또는 빈 문자열
 */
export function keyScopeCondition(params, column, keyId) {
  if (keyId == null) {
    return "";
  }
  if (Array.isArray(keyId)) {
    params.push(keyId);
    return `${column} = ANY($${params.length}::text[])`;
  }
  params.push(keyId);
  return `${column} = $${params.length}`;
}
