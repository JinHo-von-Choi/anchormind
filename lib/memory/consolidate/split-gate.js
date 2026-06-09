/**
 * Split-child quality gate (pure functions, no I/O).
 *
 * 작성자: 최진호
 * 작성일: 2026-06-09
 */

/** 대명사·메타 시작 토큰. 자기완결성이 없는 자식 단편을 차단한다. */
const PRONOUN_PREFIXES = ["이 ", "그 ", "저 ", "해당 ", "이로 인해", "그로 인해", "이것", "그것", "위 ", "아래 "];

/** 허용 CJK = 한중일 통합 한자 중 한국어 한자 표기로 흔히 쓰이는 범위 밖의 혼입을 깨짐으로 본다.
 *  단순화: U+4E00–U+9FFF(한자) 또는 U+3040–U+30FF(가나)가 한국어(한글) 본문에 섞이면 reject. */
const HAN_OR_KANA = /[぀-ヿ一-鿿]/;
const HANGUL      = /[가-힣]/;
const REPLACEMENT = /�/;

/**
 * 분해 자식 단편이 저장 가능한 품질인지 판정한다.
 *
 * @param {string} text       자식 단편 본문
 * @param {string} parentType 부모 파편 타입(현재 판정에는 미사용, 시그니처 호환용)
 * @returns {boolean}
 */
export function isAcceptableSplitChild(text, parentType) {
  void parentType;
  if (typeof text !== "string") return false;
  const trimmed = text.trim();

  if (trimmed.length < 20)            return false;
  if (REPLACEMENT.test(trimmed))      return false;
  if (HANGUL.test(trimmed) && HAN_OR_KANA.test(trimmed)) return false;

  for (const prefix of PRONOUN_PREFIXES) {
    if (trimmed.startsWith(prefix)) return false;
  }
  return true;
}

/**
 * 자식 importance를 부모×0.7 상한으로 클램프한다.
 * fact 타입은 0.4 미만이면 저장 부적합으로 null을 반환한다.
 *
 * @param {number} parentImportance
 * @param {string} childType
 * @returns {number|null} 저장할 importance, 또는 차단 시 null
 */
export function clampChildImportance(parentImportance, childType) {
  const capped  = Math.round(parentImportance * 0.7 * 100) / 100;
  if (childType === "fact" && capped < 0.4) return null;
  return capped;
}
