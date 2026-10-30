/**
 * LinkVisibility - 링크 읽기 경로가 함께 쓰는 활성 조건, 관계 기본값, 관계 우선순위
 *
 * 작성자: 최진호
 * 작성일: 2026-10-31
 *
 * fragment_links.deleted_at이 있는 행은 지운 링크다. 일반 조회(미리보기, 후보 확장, 그래프, 스티칭, 이력,
 * 모순 확인)는 모두 활성 링크만 본다. 지운 링크를 다시 만들면 같은 (from_id, to_id) 행을 새 링크로
 * 되살린다. 유일 제약 때문에 새 행을 만들 수 없으므로, 되살리지 않으면 그 쌍의 링크가 영영 보이지 않는다.
 */

const SQL_ALIAS = /^[a-z_][a-z0-9_]*$/;

/** 링크 관계 유형 전체 */
export const LINK_RELATION_TYPES = Object.freeze([
  "related", "caused_by", "resolved_by", "part_of", "contradicts", "superseded_by", "co_retrieved", "temporal"
]);

/** linkRelationType을 지정하지 않았을 때 응답 미리보기(fragments[].linked)가 보는 관계 */
export const PREVIEW_DEFAULT_RELATIONS = Object.freeze(["resolved_by", "caused_by", "related"]);

/** linkRelationType을 지정하지 않았을 때 검색 후보 확장(includeLinks)이 보는 관계 */
export const EXPANSION_DEFAULT_RELATIONS = Object.freeze(["caused_by", "resolved_by", "related", "co_retrieved"]);

/**
 * 허용된 관계 이름이면 그대로, 아니면 null을 돌려준다.
 *
 * @param {unknown} relationType
 * @returns {string|null}
 */
export function safeRelationType(relationType) {
  return typeof relationType === "string" && LINK_RELATION_TYPES.includes(relationType) ? relationType : null;
}

/**
 * @param {string} alias
 * @returns {string}
 */
function checkedAlias(alias) {
  if (!SQL_ALIAS.test(alias)) throw new TypeError(`invalid link alias: ${alias}`);
  return alias;
}

/**
 * 활성 링크 조건(앞뒤 공백 없음).
 *
 * @param {string} alias - fragment_links 별칭
 * @returns {string}
 */
export function activeLinkCondition(alias) {
  return `${checkedAlias(alias)}.deleted_at IS NULL`;
}

/**
 * 관계 우선순위 식. resolved_by 1, caused_by 2, 나머지 3. 작을수록 앞이다.
 *
 * @param {string} alias - fragment_links 별칭
 * @returns {string}
 */
export function relationOrderSql(alias) {
  const a = checkedAlias(alias);
  return `CASE ${a}.relation_type WHEN 'resolved_by' THEN 1 WHEN 'caused_by' THEN 2 ELSE 3 END`;
}

/**
 * ON CONFLICT (from_id, to_id) DO UPDATE에서 지운 행인지 보는 조건. 표 이름으로 기존 행을 가리킨다.
 *
 * @param {string} table - 스키마를 붙인 표 이름(예: agent_memory.fragment_links)
 * @returns {string}
 */
export function deletedRowCondition(table) {
  return `${table}.deleted_at IS NOT NULL`;
}

/**
 * ON CONFLICT DO UPDATE에 붙여 지운 행을 되살리는 대입문. 앞에 쉼표를 붙여 돌려준다.
 *
 * @returns {string}
 */
export function reviveAssignments() {
  return ", deleted_at = NULL, delete_reason = NULL";
}
