/**
 * ReviewVisibility - 검토 대기 파편의 가시성 술어
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * review_state='pending' 파편은 쓴 키에게만 보인다. 다른 키(키 그룹 구성원 포함)와 마스터 키의 recall,
 * ANCHOR와 CORE 주입, 앵커 자동 승격에서는 빠진다. 마스터 키가 쓴 검토 대기 파편(key_id NULL)은 마스터
 * 키에게만 보인다. 이 모듈은 그 판정을 SQL 조각과 순수 함수로 만든다.
 *
 *   보는 주체(viewer)  recall을 부른 키의 id. 마스터 키는 null
 *   recall 술어        (review_state IS DISTINCT FROM 'pending' OR key_id IS NOT DISTINCT FROM $viewer)
 *   주입, 승격 술어    review_state IS DISTINCT FROM 'pending'
 *
 * 술어는 색인 조건이 아니라 걸러내기 조건이며 review_state가 NULL인 기존 행은 모두 통과한다.
 * MEMENTO_REVIEW_QUEUE=off이면 모든 조각이 비어 SQL이 바뀌지 않는다(검토 열을 읽지 않는다).
 */

import { reviewQueueEnabled }            from "../../config.js";
import { REVIEW_STATES, isPendingReview } from "../reviewState.js";
import { keyScopeNullable }               from "../keyScope.js";

const SQL_ALIAS = /^[a-z_][a-z0-9_]*$/;

/**
 * 열 이름 앞에 붙일 별칭 접두어.
 *
 * @param {string} alias - 빈 문자열이면 별칭 없음
 * @returns {string}
 */
function columnPrefix(alias) {
  if (alias === "") return "";
  if (!SQL_ALIAS.test(alias)) throw new TypeError(`invalid table alias: ${alias}`);
  return `${alias}.`;
}

/**
 * 검색 옵션에서 보는 주체를 정한다. viewerKeyId가 있으면 그 값(null은 마스터), 없으면 keyId가 단일 키이거나
 * 원소 하나인 배열일 때 그 키, 그 밖(그룹 배열, 키 없음)은 null이다. null은 마스터 키가 쓴 대기 파편만 본다.
 *
 * @param {{viewerKeyId?: string|null, keyId?: string|string[]|null}} [options]
 * @returns {string|null}
 */
export function reviewViewer(options = {}) {
  if (options.viewerKeyId !== undefined) return options.viewerKeyId ?? null;
  if (typeof options.keyId === "string") return options.keyId;
  return Array.isArray(options.keyId) && options.keyId.length === 1 ? String(options.keyId[0]) : null;
}

/**
 * 순수 판정. 검토 대기가 아니면 보이고, 검토 대기이면 쓴 키(마스터는 key_id null)에게만 보인다.
 *
 * @param {{review_state?: unknown, key_id?: string|null}|null} fragment
 * @param {string|null} viewer
 * @returns {boolean}
 */
export function isReviewVisible(fragment, viewer) {
  if (!fragment) return false;
  if (!isPendingReview(fragment)) return true;
  return (fragment.key_id ?? null) === (viewer ?? null);
}

/**
 * recall 술어를 조건 배열에 더하고 SELECT에 붙일 검토 열 조각을 돌려준다. 스위치가 off이면 아무것도
 * 더하지 않고 빈 문자열을 돌려준다.
 *
 * @param {string[]} conditions - in-place
 * @param {Array}    params     - in-place
 * @param {Object}   options    - reviewViewer 입력
 * @param {string}   [alias="f"]
 * @returns {string} ", f.review_state" 또는 ""
 */
export function appendReviewVisibility(conditions, params, options, alias = "f") {
  if (!reviewQueueEnabled()) return "";
  const p      = columnPrefix(alias);
  const viewer = reviewViewer(options);
  /** 마스터 키는 자리표시자 없이 key_id IS NULL로 쓴다. 키는 격리 생성기와 같은 NULL 동치 비교를 쓴다. */
  const writer = viewer === null
    ? `${p}key_id IS NULL`
    : keyScopeNullable(params, `${p}key_id`, viewer).replace(/^\s*AND\s+/, "");
  conditions.push(`(${p}review_state IS DISTINCT FROM '${REVIEW_STATES.PENDING}' OR ${writer})`);
  return `, ${p}review_state`;
}

/**
 * 한 번 바인딩한 recall 술어를 여러 곳(UNION 양쪽 등)에 쓰는 조각.
 *
 * @param {Array}  params  - in-place
 * @param {Object} options - reviewViewer 입력
 * @param {string} [alias="f"]
 * @returns {{clause: string, select: string, column: string}} clause는 " AND (...)", select는 ", f.review_state",
 *   column은 바깥 SELECT용 ", review_state". 스위치가 off이면 모두 빈 문자열이다
 */
export function reviewVisibilityParts(params, options, alias = "f") {
  const conditions = [];
  const select     = appendReviewVisibility(conditions, params, options, alias);
  if (conditions.length === 0) return { clause: "", select: "", column: "" };
  return { clause: ` AND ${conditions[0]}`, select, column: ", review_state" };
}

/**
 * id 조회 술어. API 키(keyId가 있음)의 조회에서만 다른 키의 검토 대기 파편을 뺀다. 마스터 키와 서버 내부
 * 조회(keyId null)는 모든 행을 본다. 스위치가 off이면 빈 문자열이다.
 *
 * @param {Array}       params - in-place
 * @param {string|null} keyId
 * @param {string}      [alias=""]
 * @returns {string} " AND (...)" 또는 ""
 */
export function reviewPointClause(params, keyId, alias = "") {
  if (keyId == null) return "";
  return reviewVisibilityParts(params, { viewerKeyId: keyId }, alias).clause;
}

/**
 * 검토 열을 함께 읽는 SELECT 조각(갱신 판정용). 요청하지 않았거나 스위치가 off이면 빈 문자열이다.
 *
 * @param {boolean} wanted
 * @returns {string} ", review_state, review_reason" 또는 ""
 */
export function reviewStateColumns(wanted) {
  return wanted && reviewQueueEnabled() ? ", review_state, review_reason" : "";
}

/**
 * ANCHOR 주입과 앵커 자동 승격에 쓰는 조건. 검토 대기 파편은 쓴 키에게도 주입되지 않는다.
 *
 * @param {string} [alias=""]
 * @returns {string} " AND review_state IS DISTINCT FROM 'pending'" 또는 ""
 */
export function notPendingReviewSql(alias = "") {
  if (!reviewQueueEnabled()) return "";
  return ` AND ${columnPrefix(alias)}review_state IS DISTINCT FROM '${REVIEW_STATES.PENDING}'`;
}

/**
 * 검색 행을 응답용으로 바꾼다. review_state 열을 지우고, 검토 대기이면 pending_review 표지를 단다.
 * 검토 열이 없는 행과 스위치가 off일 때는 그대로 돌려준다.
 *
 * @param {Object} fragment
 * @returns {Object}
 */
export function toReviewView(fragment) {
  if (!fragment || !Object.hasOwn(fragment, "review_state") || !reviewQueueEnabled()) return fragment;
  const { review_state: state, ...rest } = fragment;
  return state === REVIEW_STATES.PENDING ? { ...rest, pending_review: true } : rest;
}

/**
 * 주입 후보에서 검토 대기 파편을 뺀다(pending_review 표지 또는 review_state). 스위치가 off이면 그대로다.
 *
 * @param {Map<string, object[]>} typeFragMap
 * @returns {Map<string, object[]>}
 */
export function dropPendingReview(typeFragMap) {
  if (!reviewQueueEnabled()) return typeFragMap;
  const result = new Map();
  for (const [type, fragments] of typeFragMap) {
    result.set(type, (fragments ?? []).filter(f => f?.pending_review !== true && !isPendingReview(f)));
  }
  return result;
}

/**
 * 응답 파편에 검토 대기 표지를 단다. 검토 대기 파편은 pending_review와 낮은 신뢰 표지(low_trust)를 함께 싣는다.
 * fields 지정과 무관하게 싣는다.
 *
 * @param {Object} base     - 응답(fragments 배열)
 * @param {Object[]} fragments - 같은 순서의 검색 결과
 * @returns {Object}
 */
export function withReviewMarkers(base, fragments) {
  if (!Array.isArray(base?.fragments) || !(fragments ?? []).some(f => f?.pending_review === true)) return base;
  return {
    ...base,
    fragments: base.fragments.map((item, i) => (fragments[i]?.pending_review === true
      ? { ...item, pending_review: true, low_trust: true }
      : item))
  };
}
