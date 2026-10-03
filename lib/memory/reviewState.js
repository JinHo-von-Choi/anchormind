/**
 * reviewState - 검토 대기열의 상태, 방식, 키 표지
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * fragments.review_state 값, 검토 방식(off, flagged, all), 키 권한 목록에 두는 검토 방식 표지를
 * 쓰기 경로와 읽기 경로가 함께 쓰도록 한곳에 둔다. DB, 설정, 환경 변수에 닿지 않는다.
 *
 *   review_state  NULL      검토 대상 아님(기존 행 포함). 모두에게 보인다
 *                 pending   검토 대기. 쓴 키에게만 보이고 주입, 다른 키, 앵커 승격에서 빠진다
 *                 approved  승인. 모두에게 보인다
 *                 rejected  거절. valid_to가 함께 설정되어 만료 파편으로 다룬다
 */

/** fragments.review_state 값 */
export const REVIEW_STATES = Object.freeze({
  PENDING : "pending",
  APPROVED: "approved",
  REJECTED: "rejected"
});

/** 검토 방식. off는 표지를 달지 않고, flagged는 규칙에 걸린 쓰기만, all은 모든 쓰기를 검토 대기로 둔다. */
export const REVIEW_MODES = Object.freeze(["off", "flagged", "all"]);

/** 키에 표지가 없을 때의 검토 방식 */
export const DEFAULT_REVIEW_MODE = "flagged";

/**
 * 키 권한 목록에 두는 검토 방식 표지. 표지가 없으면 기본 방식(flagged)이다. 두 표지를 함께 둘 수 없다.
 * 도구 권한(read, write)을 넓히지 않는다.
 */
export const REVIEW_MODE_PERMISSIONS = Object.freeze({
  review_off: "off",
  review_all: "all"
});

/**
 * 키 권한 목록의 검토 방식. 표지가 없거나 마스터 키이면 null(기본 방식)이다.
 *
 * @param {unknown} permissions
 * @param {boolean} [isMaster]
 * @returns {"off"|"all"|null}
 */
export function keyReviewMode(permissions, isMaster = false) {
  if (isMaster === true || !Array.isArray(permissions)) return null;
  const marker = Object.keys(REVIEW_MODE_PERMISSIONS).find((name) => permissions.includes(name));
  return marker ? REVIEW_MODE_PERMISSIONS[marker] : null;
}

/**
 * 받을 수 있는 검토 방식 값만 돌려준다. 그 밖은 null이다.
 *
 * @param {unknown} value
 * @returns {"off"|"flagged"|"all"|null}
 */
export function reviewModeOrNull(value) {
  return typeof value === "string" && REVIEW_MODES.includes(value) ? value : null;
}

/**
 * 검토 대기 파편인지 본다.
 *
 * @param {{review_state?: unknown}|null|undefined} fragment
 * @returns {boolean}
 */
export function isPendingReview(fragment) {
  return fragment?.review_state === REVIEW_STATES.PENDING;
}
