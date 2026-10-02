/**
 * 정서 태그 값 집합과 정규화
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */

/**
 * 허용되는 정서 태그 값 집합.
 * migration-034-v2.16.0-bundle의 CHECK 제약과 반드시 동기화 유지.
 */
export const VALID_AFFECT_VALUES = new Set([
  "neutral", "frustration", "confidence", "surprise", "doubt", "satisfaction"
]);

/** 허용값 외 입력은 'neutral'로 강제 */
export function sanitizeAffect(affect) {
  if (!affect || !VALID_AFFECT_VALUES.has(affect)) return "neutral";
  return affect;
}
