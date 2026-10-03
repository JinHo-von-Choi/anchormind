/**
 * reviewRules - 검토 대기열의 지시 덮어쓰기 문구 규칙 표
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 저장된 기억이 다음 세션의 에이전트 지시를 덮어쓰려는 문구(이전 지시 무시, 시스템 프롬프트 재정의,
 * 대화 형식 표지)만 좁게 찾는다. 일반 절차문(무엇을 무시해도 된다, 시스템 프롬프트 길이를 지킨다, 설정의
 * 이전 규칙을 바꾼다 등)은 대상이 아니다. 걸리지 않아야 하는 문장 표는 tests/unit/review-rules.test.js에 있다.
 *
 * 비교 전에 본문을 정규화한다: NFKC(전각 문자), 형식 문자(\p{Cf}, 폭 없는 공백 등) 제거, 라틴 글자와 모양이
 * 같은 키릴과 그리스 글자의 치환, 마크다운 강조 표지(*, **, __, ~~, `) 제거.
 *
 * 규칙은 g 플래그 없이 test()로만 쓴다. 결과에는 규칙 id만 남기고 일치한 문자열은 남기지 않는다.
 */

/** 부정 표현 바로 뒤의 동사는 지시가 아니라 금지다(do not ignore, 무시하지 말고). */
const KO_NOT_NEGATED = "(?!\\s*하지\\s*(?:말|않)|\\s*해서는|\\s*하면\\s*안)";

/** 라틴 글자와 모양이 같은 키릴, 그리스 글자 */
const CONFUSABLES = Object.freeze({
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "у": "y", "х": "x", "і": "i", "ј": "j", "ѕ": "s", "һ": "h", "ԁ": "d",
  "А": "A", "В": "B", "Е": "E", "К": "K", "М": "M", "Н": "H", "О": "O", "Р": "P", "С": "C", "Т": "T", "Х": "X", "І": "I",
  "ο": "o", "α": "a", "ε": "e", "ι": "i", "ν": "v", "ρ": "p", "τ": "t", "Ο": "O", "Α": "A", "Ε": "E", "Ι": "I", "Τ": "T"
});

const CONFUSABLE_PATTERN = new RegExp(`[${Object.keys(CONFUSABLES).join("")}]`, "gu");
const FORMAT_CHARS       = /\p{Cf}/gu;
const EMPHASIS_MARKS     = /\*{1,3}|_{2}|~{2}|`+/g;

/**
 * 규칙 비교용 정규화.
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeForRules(text) {
  return text
    .normalize("NFKC")
    .replace(FORMAT_CHARS, "")
    .replace(CONFUSABLE_PATTERN, (ch) => CONFUSABLES[ch])
    .replace(EMPHASIS_MARKS, "");
}

/** 규칙 표. id는 검토 사유의 세부 표기와 시험 이름에 쓴다. */
export const INSTRUCTION_OVERRIDE_RULES = Object.freeze([
  {
    id     : "ignore_previous_en",
    pattern: /(?<!\bnot\s)(?<!n't\s)\b(?:ignore|disregard|forget)\s+(?:(?:all|any|the|your|my|of|these|those)\s+)*(?:previous|prior|earlier|above|preceding|original|system)\s+(?:instructions?|prompts?|directives?|rules|guidelines|messages?|commands?)\b/i
  },
  {
    id     : "override_instructions_en",
    pattern: /(?<!\bnot\s)(?<!n't\s)\boverride\s+(?:(?:all|any|the|your|my|these|those)\s+)*(?:previous|prior|earlier|above|original|system)\s+(?:instructions?|prompts?|directives?)\b/i
  },
  {
    id     : "do_not_follow_en",
    pattern: /\b(?:do\s+not|don't|stop)\s+follow(?:ing)?\s+(?:(?:the|your|any|all)\s+)*(?:previous|prior|earlier|above|system|original)\s+(?:instructions?|prompts?|rules|directives?)\b/i
  },
  {
    id     : "new_system_prompt_en",
    pattern: /\b(?:new|updated|replacement)\s+system\s+prompt\s*:/i
  },
  {
    id     : "mode_switch_en",
    pattern: /\byou\s+are\s+now\s+(?:in\s+)?(?:developer|dan|jailbreak|unrestricted|god)\s+mode\b/i
  },
  {
    id     : "chat_template_marker",
    pattern: /<\|(?:im_start|im_end|system|begin_of_text|start_header_id|end_header_id|eot_id)\|>|<<\/?SYS>>|\[\/?INST\]/i
  },
  {
    id     : "system_tag",
    pattern: /<\/?system(?:[-_]prompt)?>|^\s*\[system\]/im
  },
  {
    id     : "ignore_previous_ko",
    pattern: new RegExp(
      "(?:이전|앞|위|원래|지금까지)\\s*(?:의\\s*)?(?:지시|지침|명령|프롬프트|규칙)(?:사항|문)?(?:들)?"
      + "\\s*(?:을|를|은|는|이|가)?\\s*(?:모두|전부|다)?\\s*(?:무시|잊|폐기|무효)" + KO_NOT_NEGATED
    )
  },
  {
    id     : "ignore_existing_ko",
    pattern: new RegExp(
      "(?:기존|모든)\\s*(?:의\\s*)?(?:지시|지침|프롬프트)(?:사항|문)?(?:들)?"
      + "\\s*(?:을|를|은|는|이|가)?\\s*(?:모두|전부|다)?\\s*(?:무시|잊)" + KO_NOT_NEGATED
    )
  },
  {
    id     : "system_prompt_override_ko",
    pattern: new RegExp("시스템\\s*프롬프트\\s*(?:을|를|은|는)?\\s*(?:무시|덮어\\s*쓰|덮어|재정의)" + KO_NOT_NEGATED)
  }
]);

/**
 * 문자열에서 걸린 규칙 id를 표 순서로 돌려준다. 문자열이 아니거나 비어 있으면 빈 배열이다.
 *
 * @param {unknown} text
 * @returns {string[]}
 */
export function matchInstructionOverride(text) {
  if (typeof text !== "string" || text === "") return [];
  const normalized = normalizeForRules(text);
  return INSTRUCTION_OVERRIDE_RULES.filter((rule) => rule.pattern.test(normalized)).map((rule) => rule.id);
}
