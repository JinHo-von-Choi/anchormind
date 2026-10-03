/**
 * SensitiveScanner - 저장 경로 민감 정보 탐지와 마스킹
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 규칙 표(sensitivePatterns.js)를 쓰기 값의 본문 필드와 키워드 배열에 적용하는 순수 함수 모음이다.
 * 일치한 문자열은 대체 값으로 바뀌고 결과에는 규칙 이름과 필드 이름만 남는다. 입력과 일치 문자열을
 * 기록하지 않으며 DB와 설정에 접근하지 않는다.
 */

import { patternsFor, SENSITIVE_RULE_PREFIX } from "./sensitivePatterns.js";

export { SENSITIVE_RULE_PREFIX };

/** 쓰기 값에서 검사하는 문자열 필드(생성은 camelCase, 갱신은 열 이름) */
export const SCANNED_TEXT_FIELDS = Object.freeze({
  create: Object.freeze(["content", "topic", "contextSummary", "goal", "outcome"]),
  update: Object.freeze(["content", "topic", "context_summary", "goal", "outcome"])
});

/** 문자열 배열로 검사하는 필드 */
export const SCANNED_ARRAY_FIELDS = Object.freeze(["keywords"]);

const compiledCache = new Map();

/**
 * 경로와 대소문자 처리별로 컴파일한 규칙 목록. 대소문자 무시 판은 같은 표의 패턴 원문에 i 플래그를 더해 만든다.
 *
 * @param {"store"|"log"} scope
 * @param {boolean}       foldCase
 * @param {boolean}       legacyOnly
 * @returns {Array<Object>}
 */
function compiledRules(scope, foldCase, legacyOnly) {
  const key    = `${scope}:${foldCase}:${legacyOnly}`;
  const cached = compiledCache.get(key);
  if (cached) return cached;

  const rules = patternsFor(scope)
    .filter((entry) => !legacyOnly || entry.legacy === true)
    .map((entry) => ({
      ...entry,
      pattern: foldCase && !entry.pattern.flags.includes("i")
        ? new RegExp(entry.pattern.source, `${entry.pattern.flags}i`)
        : entry.pattern
    }));
  compiledCache.set(key, rules);
  return rules;
}

/** 규칙 하나를 적용한다. hit는 대체가 일어날 때마다 불린다. */
function applyRule(entry, text, hit) {
  const replacement = entry.store;
  if (entry.apply) return entry.apply(text, replacement, hit);
  return text.replace(entry.pattern, (...args) => {
    if (entry.validate && !entry.validate(args[0])) return args[0];
    if (!entry.masked?.(args[0])) hit();
    return typeof replacement === "function" ? replacement(...args) : replacement;
  });
}

/**
 * 문자열 하나의 민감 정보를 표식으로 바꾼다.
 *
 * @param {string} text
 * @param {Object} [options]
 * @param {boolean} [options.foldCase]   - 대소문자를 구분하지 않고 찾는다(소문자로 정규화된 값용)
 * @param {boolean} [options.legacyOnly] - 기존 4개 규칙만 적용한다
 * @returns {{ text: string, rules: Array<{id: string, severity: string}> }}
 */
export function scanText(text, { foldCase = false, legacyOnly = false } = {}) {
  if (typeof text !== "string" || text === "") return { text, rules: [] };

  const rules = [];
  let   next  = text;
  for (const entry of compiledRules("store", foldCase, legacyOnly)) {
    let count = 0;
    next = applyRule(entry, next, () => { count++; });
    if (count > 0) rules.push({ id: entry.id, severity: entry.severity });
  }
  return { text: next, rules };
}

/**
 * 문자열의 민감 정보를 표식으로 바꾼 결과만 돌려준다. 저장 경로 마스킹의 진입점이다.
 *
 * @param {string}  text
 * @param {Object}  [options] - scanText 옵션
 * @returns {string}
 */
export function maskText(text, options) {
  return scanText(text, options).text;
}

/**
 * 쓰기 값의 본문 필드와 키워드 배열을 검사한다. 바뀐 값이 없으면 입력 객체를 그대로 돌려준다.
 *
 * @param {Object}   fields
 * @param {string[]} textFields   - 문자열 필드 이름
 * @param {string[]} [arrayFields] - 문자열 배열 필드 이름
 * @returns {{ fields: Object, findings: Array<{rule: string, severity: string, fields: string[]}> }}
 */
export function scanFields(fields, textFields, arrayFields = SCANNED_ARRAY_FIELDS) {
  const found = new Map();
  const note  = (name, rules) => {
    for (const { id, severity } of rules) {
      const entry = found.get(id) ?? { rule: id, severity, fields: [] };
      if (!entry.fields.includes(name)) entry.fields.push(name);
      found.set(id, entry);
    }
  };

  const next = { ...fields };
  for (const name of textFields) {
    const value = fields[name];
    if (typeof value !== "string") continue;
    const result = scanText(value);
    if (result.rules.length === 0) continue;
    next[name] = result.text;
    note(name, result.rules);
  }
  for (const name of arrayFields) {
    const list = fields[name];
    if (!Array.isArray(list)) continue;
    const masked = list.map((item) => {
      const result = scanText(item, { foldCase: true });
      if (result.rules.length > 0) note(name, result.rules);
      return result.text;
    });
    if (masked.some((item, i) => item !== list[i])) next[name] = masked;
  }

  if (found.size === 0) return { fields, findings: [] };
  return { fields: next, findings: [...found.values()] };
}
