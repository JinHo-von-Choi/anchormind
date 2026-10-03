/**
 * LexicalTokens - 본문 어휘 채널의 토큰화와 tsquery 생성
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 * 수정일: 2026-10-04 (3자리 이상 숫자 토큰, 토큰화 입력 상한과 긴 연속 문자열 제외)
 *
 * 본문과 질의를 같은 방법으로 토큰화한다. 토큰은 MorphemeTokenizer.tokenizeLocal의 형태소
 * (한글 garu-ko, 영문 PorterStemmer 어간, 한자 jieba, 가나 kuromoji)와 3자리 이상의 숫자 연속이고,
 * 어휘 채널용으로 소문자화, 한글 호환 자모를 담은 어미 조각 제거, 글자나 숫자가 없는 조각 제거,
 * 중복 제거를 더한다. garu-ko는 한 음절 형태소를 내지 않으므로 한 음절로만 나뉘는 낱말은 토큰이 없다.
 *
 * 토큰화 비용은 입력 길이에 묶인다. 앞 TOKENIZE_MAX_CHARS자만 토큰화하고, 공백 없이 이어진 한글, 한자,
 * 가나 연속이 MAX_RUN_CHARS자를 넘는 입력은 분석기 비용이 길이에 따라 급격히 늘므로 토큰화하지 않는다
 * (본문은 NULL로 남고 질의는 어휘 채널을 쓰지 않는다).
 *
 * 본문 토큰은 공백으로 이어 to_tsvector('simple', ...)로 content_tokens에 저장하고, 질의 토큰은
 * buildLexicalTsquery로 OR 식을 만들어 to_tsquery('simple', ...)에 넘긴다. 'simple' 구성은 어간화와
 * 불용어 제거를 하지 않으므로 두 쪽이 같은 토큰을 거친다.
 */

import { tokenizeLocal, segmentByScript } from "./MorphemeTokenizer.js";

/** 본문 하나에서 저장하는 토큰 수의 상한 */
export const DOCUMENT_TOKEN_LIMIT = 4096;

/** 질의 하나의 OR 항 수 상한 */
export const QUERY_TERM_LIMIT = 32;

/** 토큰 하나의 글자 수 상한. 넘는 토큰은 버린다(tsvector 어휘소 상한 2047바이트 안). */
export const MAX_LEXEME_CHARS = 100;

/** 토큰화하는 앞부분의 글자 수 */
export const TOKENIZE_MAX_CHARS = 4000;

/** 공백 없이 이어진 한글, 한자, 가나 연속의 글자 수 상한. 넘으면 토큰화하지 않는다. */
export const MAX_RUN_CHARS = 200;

/** 토큰화하지 않은 사유 */
export const SKIP_REASONS = Object.freeze({ LONG_RUN: "long_run" });

const HANGUL_COMPAT_JAMO = /[ㄱ-ㆎ]/;
const LETTER_OR_DIGIT    = /[\p{L}\p{N}]/u;
const NUL                = "\u0000";
const LONG_NUMBER        = /\d{3,}/g;
const HEAVY_SCRIPTS      = new Set(["hangul", "han", "kana"]);

/**
 * 토큰 목록을 어휘 채널 규칙으로 정리한다. 입력 순서를 지킨다.
 *
 * @param {unknown[]} tokens
 * @param {number}    [limit=DOCUMENT_TOKEN_LIMIT]
 * @returns {string[]}
 */
export function normalizeLexicalTokens(tokens, limit = DOCUMENT_TOKEN_LIMIT) {
  if (!Array.isArray(tokens)) return [];
  const seen = new Set();
  const out  = [];
  for (const raw of tokens) {
    if (out.length >= limit) break;
    if (typeof raw !== "string") continue;
    const token = raw.replaceAll(NUL, "").trim().toLowerCase();
    if (!isUsableToken(token) || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

/**
 * @param {string} token
 * @returns {boolean}
 */
function isUsableToken(token) {
  return token.length > 0
    && token.length <= MAX_LEXEME_CHARS
    && LETTER_OR_DIGIT.test(token)
    && !HANGUL_COMPAT_JAMO.test(token);
}

/**
 * 토큰화할 입력을 정한다. 앞 TOKENIZE_MAX_CHARS자로 자르고, 공백 없이 MAX_RUN_CHARS자를 넘게 이어진
 * 한글, 한자, 가나 연속이 있으면 토큰화하지 않는다.
 *
 * @param {unknown} text
 * @returns {{text: string, skip: string|null}}
 */
export function lexicalInput(text) {
  if (typeof text !== "string" || text.trim() === "") return { text: "", skip: null };
  const head = text.slice(0, TOKENIZE_MAX_CHARS);
  const long = segmentByScript(head).some(seg => HEAVY_SCRIPTS.has(seg.script) && seg.text.length > MAX_RUN_CHARS);
  return long ? { text: "", skip: SKIP_REASONS.LONG_RUN } : { text: head, skip: null };
}

/**
 * 정리한 입력의 토큰. 형태소 토큰 뒤에 3자리 이상 숫자 연속을 더한다.
 *
 * @param {string} text lexicalInput이 돌려준 입력
 * @param {number} limit
 * @returns {Promise<string[]>}
 */
async function tokensOf(text, limit) {
  if (text === "") return [];
  const morphemes = await tokenizeLocal(text, limit);
  return normalizeLexicalTokens([...morphemes, ...(text.match(LONG_NUMBER) ?? [])], limit);
}

/**
 * 텍스트의 어휘 토큰. 토큰화하지 않는 입력(긴 연속 문자열)은 빈 배열이다.
 *
 * @param {unknown} text
 * @param {number}  [limit=DOCUMENT_TOKEN_LIMIT]
 * @returns {Promise<string[]>}
 */
export async function lexicalTokens(text, limit = DOCUMENT_TOKEN_LIMIT) {
  return tokensOf(lexicalInput(text).text, limit);
}

/**
 * to_tsvector('simple', ...)에 넘길 본문 문자열. 토큰이 없으면 빈 문자열이며 빈 tsvector가 된다
 * (NULL은 아직 채우지 않은 행과 토큰화하지 않은 본문에만 쓴다).
 *
 * @param {string[]} tokens
 * @returns {string}
 */
export function lexicalDocument(tokens) {
  return tokens.join(" ");
}

/**
 * tsquery 어휘소 하나를 작은따옴표로 감싼다. 역슬래시와 작은따옴표는 두 번 쓴다.
 *
 * @param {string} token
 * @returns {string}
 */
export function escapeTsqueryLexeme(token) {
  return `'${token.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

/**
 * 질의 토큰을 OR로 이은 to_tsquery('simple', ...) 입력. 쓸 토큰이 없으면 null.
 *
 * @param {unknown[]} tokens
 * @returns {string|null}
 */
export function buildLexicalTsquery(tokens) {
  const terms = normalizeLexicalTokens(tokens, QUERY_TERM_LIMIT);
  return terms.length === 0 ? null : terms.map(escapeTsqueryLexeme).join(" | ");
}

/**
 * 본문의 to_tsvector 입력 문자열과 토큰화하지 않은 사유. 사유가 있으면 doc은 null이다.
 *
 * @param {unknown} content
 * @returns {Promise<{doc: string|null, skip: string|null}>}
 */
export async function contentTokenResult(content) {
  const input = lexicalInput(content);
  if (input.skip) return { doc: null, skip: input.skip };
  return { doc: lexicalDocument(await tokensOf(input.text, DOCUMENT_TOKEN_LIMIT)), skip: null };
}

/**
 * 본문의 to_tsvector 입력 문자열. 토큰화하지 않는 본문은 null이다.
 *
 * @param {unknown} content
 * @returns {Promise<string|null>}
 */
export async function contentTokenDocument(content) {
  return (await contentTokenResult(content)).doc;
}
