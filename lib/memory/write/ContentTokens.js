/**
 * ContentTokens - 저장 경로의 content_tokens 기록
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 본문을 쓰는 의미 쓰기(FragmentWriter.insertDetailed, FragmentWriter.update의 본문 변경,
 * BatchRememberProcessor의 청크 INSERT)는 같은 문장에서 content_tokens를 함께 쓴다. 값은 본문의
 * 어휘 토큰(LexicalTokens)을 공백으로 이은 문자열이고 SQL에서 to_tsvector('simple', ...)로 바꾼다.
 *
 * MEMENTO_LEXICAL_CHANNEL=off이거나 열이 없으면(마이그레이션 053 이전) 열을 쓰지 않는다. 열 존재는
 * LexicalSchema가 쓰기와 같은 연결로 읽고 기억한다.
 */

import { lexicalChannelEnabled }                          from "../../config.js";
import { loadLexicalSchema, warnLexicalOnce, LEXICAL_REASONS, LEXICAL_COLUMN } from "../LexicalSchema.js";
import { contentTokenDocument }                           from "../embedding/LexicalTokens.js";

/** INSERT 문이 예상한 모양이 아닐 때의 오류 */
export class ContentTokensSqlError extends Error {
  constructor(message) {
    super(message);
    this.name = "ContentTokensSqlError";
  }
}

const VALUES_KEYWORD = /\)(\s*VALUES\s*\()/;
const TRAILING_PAREN = /\)\s*$/;

/**
 * 문서 문자열을 tsvector로 바꾸는 SQL 식.
 *
 * @param {number} position 자리표시자 번호
 * @returns {string}
 */
export function contentTokensExpression(position) {
  return `to_tsvector('simple', $${position}::text)`;
}

/**
 * 쓰기에 실을 토큰 문서. 기록하지 않을 때는 undefined다.
 *
 * @param {(sql: string, params: unknown[]) => Promise<{rows: Object[]}>} run 쓰기와 같은 연결의 질의 함수
 * @param {unknown} content
 * @returns {Promise<string|undefined>}
 */
export async function contentTokensForWrite(run, content) {
  if (!lexicalChannelEnabled()) return undefined;
  const schema = await loadLexicalSchema(run);
  if (!schema.column) {
    warnLexicalOnce(LEXICAL_REASONS.COLUMN_MISSING);
    return undefined;
  }
  return contentTokenDocument(content);
}

/**
 * 여러 본문의 토큰 문서. 기록하지 않을 때는 undefined다.
 *
 * @param {(sql: string, params: unknown[]) => Promise<{rows: Object[]}>} run
 * @param {unknown[]} contents
 * @returns {Promise<string[]|undefined>}
 */
export async function contentTokensForWrites(run, contents) {
  if (contents.length === 0) return undefined;
  const first = await contentTokensForWrite(run, contents[0]);
  if (first === undefined) return undefined;
  return [first, ...await Promise.all(contents.slice(1).map(contentTokenDocument))];
}

/**
 * 단건 INSERT 문(열 목록 뒤 VALUES (...))의 끝에 content_tokens 열과 값을 더한다.
 *
 * @param {string}    insertHead   ON CONFLICT, RETURNING 앞까지의 INSERT 문
 * @param {unknown[]} insertParams
 * @param {string|undefined} doc   contentTokensForWrite 결과
 * @returns {{insertHead: string, insertParams: unknown[]}}
 * @throws {ContentTokensSqlError} 문장이 VALUES (...)로 끝나지 않을 때
 */
export function appendContentTokensColumn(insertHead, insertParams, doc) {
  if (doc === undefined) return { insertHead, insertParams };
  if (!VALUES_KEYWORD.test(insertHead) || !TRAILING_PAREN.test(insertHead)) {
    throw new ContentTokensSqlError("content_tokens를 더할 INSERT 문은 (열 목록) VALUES (...)로 끝나야 한다");
  }
  const position = insertParams.length + 1;
  return {
    insertHead  : insertHead
      .replace(VALUES_KEYWORD, `, ${LEXICAL_COLUMN})$1`)
      .replace(TRAILING_PAREN, `, ${contentTokensExpression(position)})`),
    insertParams: [...insertParams, doc]
  };
}

/**
 * UPDATE의 SET 절 조각 목록에 content_tokens 대입을 더한다. 자리표시자는 params 다음 번호다.
 *
 * @param {string[]}  setClauses (변경)
 * @param {unknown[]} params     (변경)
 * @param {string|undefined} doc
 */
export function appendContentTokensSet(setClauses, params, doc) {
  if (doc === undefined) return;
  params.push(doc);
  setClauses.push(`${LEXICAL_COLUMN} = ${contentTokensExpression(params.length)}`);
}

/**
 * 다중 행 INSERT의 VALUES 묶음 하나에 content_tokens 값을 더한다.
 *
 * @param {{placeholders: string, values: unknown[]}} binding
 * @param {number} position 이 값의 자리표시자 번호
 * @param {string|undefined} doc
 * @returns {{placeholders: string, values: unknown[]}}
 */
export function withRowContentTokens(binding, position, doc) {
  if (doc === undefined) return binding;
  return {
    placeholders: binding.placeholders.replace(TRAILING_PAREN, `, ${contentTokensExpression(position)})`),
    values      : [...binding.values, doc]
  };
}
