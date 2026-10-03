/**
 * 관리 질의 workspace 범위 술어 생성기
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 관리 처리기가 기억 표(fragments와 그 파생 표)를 읽을 때 판정 범위(AdminAuthz.decide의 range)를 SQL
 * 조건 하나로 붙인다. 관리 SQL의 workspace 범위 조건은 이 함수 하나에서만 만든다.
 *   범위 전체                  TRUE
 *   workspace 목록(1개 이상)    <열> = ANY($n::text[])   (바인딩 하나를 params에 더한다)
 *   workspace 열이 없는 표      범위 전체일 때만 TRUE, 그 밖은 FALSE
 *   범위 없음, 빈 목록, 형식 오류  FALSE
 * 입력이 모자라면 빈 결과가 되는 쪽(FALSE)으로 닫힌다.
 */

/** 열 이름 형식: 소문자 식별자 하나 또는 별칭.열 */
const COLUMN_PATTERN = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/;

/** 술어 생성기 호출 형식이 틀렸을 때의 오류(코드 오류) */
export class ScopeFilterError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = "ScopeFilterError";
    this.code = "invalid_scope_filter_call";
  }
}

/**
 * 범위가 workspace 목록 형식이면 그 목록, 아니면 null.
 *
 * @param {unknown} range
 * @returns {string[]|null}
 */
function workspaceList(range) {
  if (!range || range.all !== false || !Array.isArray(range.workspaces) || range.workspaces.length === 0) return null;
  return range.workspaces.every((ws) => typeof ws === "string" && ws !== "") ? [...range.workspaces] : null;
}

/**
 * 판정 범위를 SQL 조건으로 바꾼다.
 *
 * @param {Array}       params 바인딩 배열(목록 범위일 때 하나를 더한다)
 * @param {string|null} column workspace 열(예: "workspace", "f.workspace"). 열이 없는 표는 null
 * @param {{ all: boolean, workspaces?: string[] }|null|undefined} range
 * @returns {string} "TRUE", "FALSE" 또는 ANY 비교식
 */
export function scopePredicate(params, column, range) {
  if (!Array.isArray(params)) throw new ScopeFilterError("params must be an array");
  if (column !== null && (typeof column !== "string" || !COLUMN_PATTERN.test(column))) {
    throw new ScopeFilterError("column must be null or a lowercase identifier");
  }
  if (range && range.all === true) return "TRUE";
  const list = workspaceList(range);
  if (column === null || list === null) return "FALSE";
  params.push(list);
  return `${column} = ANY($${params.length}::text[])`;
}
