/**
 * 의미 쓰기 관문 통과 표식
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * WriteGate가 돌려준 쓰기 값(생성 후보, 갱신 열)을 등록하고, FragmentWriter 의미 메서드가 그
 * 등록을 확인한다. 등록(approveGateValue)은 WriteGate만 부른다(구조 검사가 확인한다). 표식은
 * 객체 동일성으로 판정하므로 복사본에는 표식이 없다.
 */

const APPROVED = new WeakSet();

/**
 * 관문을 통과한 쓰기 값을 등록한다. WriteGate 밖에서 부르지 않는다.
 *
 * @param {Object} value
 * @returns {Object} 같은 값
 */
export function approveGateValue(value) {
  APPROVED.add(value);
  return value;
}

/**
 * 관문이 돌려준 쓰기 값인지 본다.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isGateApproved(value) {
  return typeof value === "object" && value !== null && APPROVED.has(value);
}
