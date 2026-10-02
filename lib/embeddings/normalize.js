/**
 * 임베딩 벡터 정규화
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */

/**
 * 벡터 L2 정규화 (단위 벡터 변환)
 *
 * @param {number[]} vec - 입력 벡터
 * @returns {number[]}    - 단위 벡터 (영벡터 입력 시 그대로 반환)
 */
export function normalizeL2(vec) {
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  if (!isFinite(norm) || norm === 0) return vec;
  return vec.map(v => v / norm);
}
