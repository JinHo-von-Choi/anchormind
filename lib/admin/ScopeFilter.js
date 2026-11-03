/**
 * 관리 질의 workspace 범위 술어 생성기
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 관리 처리기가 기억 표(fragments와 그 파생 표)를 읽을 때 판정 범위(AdminAuthz.decide의 scope)를 SQL
 * 조건 하나로 붙인다. 관리 SQL의 범위 조건은 이 함수 하나에서만 만든다.
 *   범위 전체                  TRUE
 *   셀 목록(1개 이상)           셀마다 (<workspace 열> = $a AND <key_id 열> = ANY($b::text[]))를 OR로 잇는다.
 *                              셀의 workspace가 null이면 workspace 조건, keyIds가 null이면 키 조건을 뺀다.
 *                              키 열은 workspace 열과 같은 별칭의 key_id다(예: f.workspace → f.key_id)
 *   workspace 목록(예전 형식)   키 제한 없는 셀 목록으로 읽는다
 *   workspace 열이 없는 표      범위 전체일 때만 TRUE, 그 밖은 FALSE
 *   범위 없음, 빈 목록, 형식 오류  FALSE
 * 입력이 모자라면 빈 결과가 되는 쪽(FALSE)으로 닫힌다. 다른 바인딩이 없는 질의는 scopedQuery로 술어와 바인딩
 * 배열을 함께 만든다. fragment_links는 workspace 열이 없으므로 linkScopePredicate가 양 끝 파편이 모두 범위 안인
 * 링크만 남긴다(범위 전체는 TRUE).
 */

import { SCHEMA } from "../memory/schema.js";

/** fragments.workspace 열 이름(별칭 없음, 별칭 f) */
export const WORKSPACE_COLUMN   = "workspace";
export const F_WORKSPACE_COLUMN = "f.workspace";

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
 * 범위의 셀 목록. 형식이 틀리거나 비었으면 null(빈 결과)이다. 예전 형식(workspaces)은 키 제한 없는 셀로 읽는다.
 *
 * @param {unknown} range
 * @returns {Array<{ workspace: string|null, keyIds: string[]|null }>|null}
 */
function cellList(range) {
  if (!range || range.all !== false) return null;
  const cells = Array.isArray(range.cells)
    ? range.cells
    : (Array.isArray(range.workspaces) ? range.workspaces.map((workspace) => ({ workspace, keyIds: null })) : null);
  if (!cells || cells.length === 0) return null;
  const valid = cells.every((c) => c
    && (c.workspace === null || (typeof c.workspace === "string" && c.workspace !== ""))
    && (c.keyIds === null || (Array.isArray(c.keyIds) && c.keyIds.every((id) => typeof id === "string"))));
  return valid ? cells : null;
}

/**
 * 셀 하나의 조건.
 *
 * @param {Array} params
 * @param {string} column workspace 열
 * @param {{ workspace: string|null, keyIds: string[]|null }} cell
 * @returns {string}
 */
function cellPredicate(params, column, cell) {
  /** 키가 하나도 없는 셀은 바인딩을 더하지 않고 닫는다(쓰지 않는 바인딩은 질의 준비를 실패시킨다) */
  if (Array.isArray(cell.keyIds) && cell.keyIds.length === 0) return "FALSE";
  const parts = [];
  if (cell.workspace !== null) {
    params.push(cell.workspace);
    parts.push(`${column} = $${params.length}`);
  }
  if (cell.keyIds !== null) {
    params.push(cell.keyIds);
    parts.push(`${column.replace(/workspace$/, "key_id")} = ANY($${params.length}::text[])`);
  }
  return parts.length === 0 ? "TRUE" : `(${parts.join(" AND ")})`;
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
  const cells = cellList(range);
  if (column === null || cells === null) return "FALSE";
  if (!/(^|\.)workspace$/.test(column)) throw new ScopeFilterError("column must be a workspace column");
  return `(${cells.map((cell) => cellPredicate(params, column, cell)).join(" OR ")})`;
}

/**
 * 다른 바인딩이 없는 질의를 범위 술어와 함께 만든다. pool.query(...scopedQuery(...))로 부른다.
 *
 * @param {string|null} column
 * @param {{ all: boolean, workspaces?: string[] }|null|undefined} range
 * @param {(predicate: string) => string} build 술어를 받아 질의 문자열을 만드는 함수
 * @returns {[string, Array]} 질의와 바인딩
 */
export function scopedQuery(column, range, build) {
  const params = [];
  const text   = build(scopePredicate(params, column, range));
  return [text, params];
}

/**
 * fragment_links 행의 범위 술어. 범위 전체는 TRUE, workspace 목록은 양 끝 파편이 모두 목록 안인 링크만, 범위가
 * 없거나 형식이 틀리면 FALSE다.
 *
 * @param {Array}  params 바인딩 배열(목록 범위일 때 하나를 더한다)
 * @param {string} alias  fragment_links 별칭(예: "l")
 * @param {{ all: boolean, workspaces?: string[] }|null|undefined} range
 * @returns {string}
 */
export function linkScopePredicate(params, alias, range) {
  if (!Array.isArray(params)) throw new ScopeFilterError("params must be an array");
  if (typeof alias !== "string" || !/^[a-z_][a-z0-9_]*$/.test(alias)) throw new ScopeFilterError("alias must be a lowercase identifier");
  if (range && range.all === true) return "TRUE";
  if (cellList(range) === null) return "FALSE";
  return `EXISTS (SELECT 1 FROM ${SCHEMA}.fragments sa, ${SCHEMA}.fragments sb`
    + ` WHERE sa.id = ${alias}.from_id AND sb.id = ${alias}.to_id`
    + ` AND ${scopePredicate(params, "sa.workspace", range)} AND ${scopePredicate(params, "sb.workspace", range)})`;
}
