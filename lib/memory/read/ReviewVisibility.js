/**
 * ReviewVisibility - 검토 대기와 거절 파편의 가시성 술어
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * review_state가 pending(검토 대기) 또는 rejected(거절)인 파편은 쓴 키에게만 보인다. 다른 키(키 그룹 구성원
 * 포함)와 마스터 키의 recall, id 조회, 이력, 연결 확장에서는 빠지고, ANCHOR와 CORE와 작업 기억 주입, 앵커
 * 자동 승격에서는 쓴 키에게도 빠진다. 마스터 키가 쓴 파편(key_id NULL)은 마스터 키에게만 보인다. 이 모듈은
 * 그 판정을 SQL 조각과 순수 함수로 만든다.
 *
 *   보는 주체(viewer)  recall을 부른 키의 id. 마스터 키는 null, 주입 경로는 REVIEW_VIEWER_NONE
 *   recall 술어        (review_state IS NULL OR review_state NOT IN ('pending','rejected')
 *                       OR key_id IS NOT DISTINCT FROM $viewer)
 *   주입, 승격 술어    (review_state IS NULL OR review_state NOT IN ('pending','rejected'))
 *
 * 술어는 색인 조건이 아니라 걸러내기 조건이며 review_state가 NULL인 기존 행은 모두 통과한다. 술어는
 * MEMENTO_REVIEW_QUEUE와 무관하게 항상 붙는다. 스위치는 새 쓰기에 표지를 다는 일만 끄며, 이미 검토 대기나
 * 거절인 파편을 다시 드러내지 않는다.
 */

import { REVIEW_STATES }    from "../reviewState.js";
import { keyScopeNullable } from "../keyScope.js";

const SQL_ALIAS = /^[a-z_][a-z0-9_]*$/;

/** 쓴 키 말고는 볼 수 없는 상태 */
export const HELD_REVIEW_STATES = Object.freeze([REVIEW_STATES.PENDING, REVIEW_STATES.REJECTED]);

/** 쓴 키에게도 보이지 않게 하는 보는 주체(주입 후보 조회) */
export const REVIEW_VIEWER_NONE = Symbol("review_viewer_none");

const HELD_SQL_LIST = HELD_REVIEW_STATES.map((state) => `'${state}'`).join(", ");

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
 * 쓴 키 말고는 볼 수 없는 상태인지 본다.
 *
 * @param {{review_state?: unknown}|null|undefined} fragment
 * @returns {boolean}
 */
export function isReviewHeld(fragment) {
  return HELD_REVIEW_STATES.includes(fragment?.review_state);
}

/**
 * 검색 옵션에서 보는 주체를 정한다. viewerKeyId가 있으면 그 값(null은 마스터, REVIEW_VIEWER_NONE은 아무도
 * 아님), 없으면 keyId가 단일 키이거나 원소 하나인 배열일 때 그 키, 그 밖(그룹 배열, 키 없음)은 null이다.
 *
 * @param {{viewerKeyId?: string|null|symbol, keyId?: string|string[]|null}} [options]
 * @returns {string|null|symbol}
 */
export function reviewViewer(options = {}) {
  if (options.viewerKeyId !== undefined) return options.viewerKeyId ?? null;
  if (typeof options.keyId === "string") return options.keyId;
  return Array.isArray(options.keyId) && options.keyId.length === 1 ? String(options.keyId[0]) : null;
}

/**
 * recall 인자에서 보는 주체를 정한다. 주입 후보 조회(excludePendingReview)는 쓴 키도 예외로 두지 않는다.
 *
 * @param {{excludePendingReview?: boolean}} params
 * @param {string|null} keyId - 호출 키(마스터는 null)
 * @returns {string|null|symbol}
 */
export function recallViewer(params, keyId) {
  return params?.excludePendingReview === true ? REVIEW_VIEWER_NONE : keyId;
}

/**
 * 순수 판정. 검토 대기나 거절이 아니면 보이고, 그렇다면 쓴 키(마스터는 key_id null)에게만 보인다.
 *
 * @param {{review_state?: unknown, key_id?: string|null}|null} fragment
 * @param {string|null|symbol} viewer
 * @returns {boolean}
 */
export function isReviewVisible(fragment, viewer) {
  if (!fragment) return false;
  if (!isReviewHeld(fragment)) return true;
  if (viewer === REVIEW_VIEWER_NONE) return false;
  return (fragment.key_id ?? null) === (viewer ?? null);
}

/**
 * 모두에게서 검토 대기와 거절 파편을 빼는 조건(별칭 포함, 앞뒤 공백 없음).
 *
 * @param {string} [alias=""]
 * @returns {string}
 */
function notHeldCondition(alias = "") {
  const p = columnPrefix(alias);
  return `(${p}review_state IS NULL OR ${p}review_state NOT IN (${HELD_SQL_LIST}))`;
}

/**
 * recall 술어를 조건 배열에 더하고 SELECT에 붙일 검토 열 조각을 돌려준다.
 *
 * @param {string[]} conditions - in-place
 * @param {Array}    params     - in-place
 * @param {Object}   options    - reviewViewer 입력
 * @param {string}   [alias="f"]
 * @returns {string} ", f.review_state"
 */
export function appendReviewVisibility(conditions, params, options, alias = "f") {
  const p      = columnPrefix(alias);
  const viewer = reviewViewer(options);
  if (viewer === REVIEW_VIEWER_NONE) {
    conditions.push(notHeldCondition(alias));
    return `, ${p}review_state`;
  }
  /** 마스터 키는 자리표시자 없이 key_id IS NULL로 쓴다. 키는 격리 생성기와 같은 NULL 동치 비교를 쓴다. */
  const writer = viewer === null
    ? `${p}key_id IS NULL`
    : keyScopeNullable(params, `${p}key_id`, viewer).replace(/^\s*AND\s+/, "");
  conditions.push(`(${p}review_state IS NULL OR ${p}review_state NOT IN (${HELD_SQL_LIST}) OR ${writer})`);
  return `, ${p}review_state`;
}

/**
 * 한 번 바인딩한 recall 술어를 여러 곳(UNION 양쪽 등)에 쓰는 조각.
 *
 * @param {Array}  params  - in-place
 * @param {Object} options - reviewViewer 입력
 * @param {string} [alias="f"]
 * @returns {{clause: string, select: string, column: string}} clause는 " AND (...)", select는 ", f.review_state",
 *   column은 바깥 SELECT용 ", review_state"
 */
export function reviewVisibilityParts(params, options, alias = "f") {
  const conditions = [];
  const select     = appendReviewVisibility(conditions, params, options, alias);
  return { clause: ` AND ${conditions[0]}`, select, column: ", review_state" };
}

/**
 * id 조회 술어. API 키(keyId가 있음)의 조회에서만 다른 키의 검토 대기와 거절 파편을 뺀다. 마스터 키와
 * 서버 내부 조회(keyId null)는 모든 행을 본다.
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
 * 검토 열을 함께 읽는 SELECT 조각(갱신 판정용). 요청하지 않았으면 빈 문자열이다.
 *
 * @param {boolean} wanted
 * @returns {string} ", review_state, review_reason" 또는 ""
 */
export function reviewStateColumns(wanted) {
  return wanted ? ", review_state, review_reason" : "";
}

/**
 * ANCHOR 주입, 작업 기억 대체 행, 앵커 자동 승격, 모순 해소 후보에 쓰는 조건. 쓴 키도 예외가 아니다.
 *
 * @param {string} [alias=""]
 * @returns {string} " AND (review_state IS NULL OR review_state NOT IN ('pending', 'rejected'))"
 */
export function notPendingReviewSql(alias = "") {
  return ` AND ${notHeldCondition(alias)}`;
}

/**
 * 주입 대상인지 본다. 검토 대기와 거절 파편(쓴 키의 작업 기억 포함)은 주입하지 않는다.
 *
 * @param {{review_state?: unknown}|null} fragment
 * @returns {boolean}
 */
export function isReviewInjectable(fragment) {
  return !isReviewHeld(fragment);
}

/**
 * 검색 행을 응답용으로 바꾼다. review_state 열을 지우고, 검토 대기이면 pending_review, 거절이면
 * review_rejected 표지를 단다. 검토 열이 없는 행은 그대로 돌려준다.
 *
 * @param {Object} fragment
 * @returns {Object}
 */
export function toReviewView(fragment) {
  if (!fragment || !Object.hasOwn(fragment, "review_state")) return fragment;
  const { review_state: state, ...rest } = fragment;
  if (state === REVIEW_STATES.PENDING)  return { ...rest, pending_review: true };
  if (state === REVIEW_STATES.REJECTED) return { ...rest, review_rejected: true };
  return rest;
}

/**
 * 주입 후보에서 검토 대기와 거절 파편을 뺀다(표지 또는 review_state).
 *
 * @param {Map<string, object[]>} typeFragMap
 * @returns {Map<string, object[]>}
 */
export function dropPendingReview(typeFragMap) {
  const result = new Map();
  for (const [type, fragments] of typeFragMap) {
    result.set(type, (fragments ?? []).filter(f => f?.pending_review !== true && f?.review_rejected !== true && !isReviewHeld(f)));
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
