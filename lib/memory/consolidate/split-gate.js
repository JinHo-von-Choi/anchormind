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
 * 자식 단편이 부모의 주체(주어 앵커) 중 하나라도 담고 있는지 판정한다.
 *
 * 앵커가 비어 있으면 판정 근거가 없으므로 통과시킨다(fail-open).
 *
 * @param {string}   childText
 * @param {string[]} anchors
 * @returns {boolean}
 */
export function hasSubjectAnchor(childText, anchors) {
  if (!Array.isArray(anchors) || anchors.length === 0) return true;
  if (typeof childText !== "string" || childText.length === 0) return false;

  return anchors.some(a => typeof a === "string" && a.length > 0 && childText.includes(a));
}

/**
 * 양상(modality) 패밀리 표지.
 * 자식이 부모에 없던 패밀리를 새로 도입하면 원문에 없는 서법이 창작된 것으로 본다.
 */
const MODALITY_FAMILIES = {
  future    : /(예정이|ㄹ 것이다|할 것이다|될 것이다|전망이|계획이|방침이)/,
  intention : /(려 한다|려고 한다|하고자 한다|하겠다|하려는)/,
  conjecture: /(것으로 보인다|듯하다|추정된다|가능성이 높다|일 수 있다)/,
  obligation: /(해야 한다|하여야 한다|필요가 있다)/
};

/**
 * 텍스트가 담고 있는 양상 패밀리명을 반환한다.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function detectModalityFamilies(text) {
  if (typeof text !== "string" || text.length === 0) return [];

  return Object.entries(MODALITY_FAMILIES)
    .filter(([, re]) => re.test(text))
    .map(([name]) => name);
}

/**
 * 자식이 부모에 없던 양상 패밀리를 새로 도입했는지 판정한다.
 *
 * 같은 패밀리 안의 표현 교체("제출할 예정이다" → "제출할 것이다")는 재작성으로
 * 허용하고, 단정문에서 추측·의무·의도가 생겨난 경우만 잡는다.
 *
 * @param {string}   childText
 * @param {string[]} parentFamilies
 * @returns {string[]} 새로 도입된 패밀리명 목록
 */
export function findIntroducedModality(childText, parentFamilies) {
  const parent = new Set(Array.isArray(parentFamilies) ? parentFamilies : []);
  return detectModalityFamilies(childText).filter(family => !parent.has(family));
}

/** 수치 토큰. 소수점·자릿수 구분자를 포함한 연속 숫자를 하나로 잡는다. */
const NUMERIC_TOKEN = /\d+(?:[.,]\d+)*/g;

/** 자릿수 구분자만 제거한다. 날짜 하이픈·범위 물결표는 토큰 경계이므로 분리 상태를 유지한다. */
const normalizeAnchor = (s) => s.replace(/,/g, "");

/**
 * 원문 보존 검증에 쓸 수치 앵커를 추출한다.
 *
 * 날짜·금액·비율·측정값처럼 재작성으로 바뀌기 어려운 토큰만 대상으로 한다.
 * "2026-07-15"는 2026/07/15로, "75~85"는 75/85로 분리되므로 표현이 바뀌어도
 * 구성 숫자가 남아 있으면 보존된 것으로 판정한다. 한 자리 숫자는 우연 일치가
 * 잦아 제외한다.
 *
 * @param {string} text
 * @returns {string[]} 중복 제거된 앵커 목록
 */
export function extractNumericAnchors(text) {
  if (typeof text !== "string") return [];

  const anchors = new Set();
  for (const token of text.match(NUMERIC_TOKEN) ?? []) {
    const normalized = normalizeAnchor(token);
    if (normalized.length >= 2) anchors.add(normalized);
  }
  return [...anchors];
}

/**
 * 부모 원문의 수치 앵커 중 자식 어디에도 남지 않은 것을 반환한다.
 *
 * LLM 분할은 원문을 자르는 것이 아니라 다시 쓰므로 명제 하나가 통째로
 * 누락될 수 있다. 앵커가 하나도 없는 원문은 이 검사로 판정할 수 없으므로
 * 빈 배열을 반환한다.
 *
 * @param {string}   parentContent
 * @param {string[]} childTexts
 * @returns {string[]} 유실된 앵커 목록
 */
export function findMissingAnchors(parentContent, childTexts) {
  const anchors = extractNumericAnchors(parentContent);
  if (anchors.length === 0) return [];

  const haystack = normalizeAnchor((childTexts ?? []).join(" "));
  return anchors.filter(anchor => !haystack.includes(anchor));
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
