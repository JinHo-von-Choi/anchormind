/**
 * 본문 어휘 토큰과 tsquery 생성기 단위 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * buildLexicalTsquery는 to_tsquery('simple', ...)에 그대로 넘길 OR 식을 만든다. 토큰마다 작은따옴표로
 * 감싸므로 tsquery 연산자(& | ! ( ) : * <->)는 글자로 남고, 작은따옴표와 역슬래시는 두 번 쓴다.
 * 표의 각 줄은 입력 토큰과 기대 식이다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

import {
  buildLexicalTsquery,
  escapeTsqueryLexeme,
  normalizeLexicalTokens,
  lexicalDocument,
  lexicalTokens,
  lexicalInput,
  contentTokenResult,
  contentTokenDocument,
  QUERY_TERM_LIMIT,
  MAX_LEXEME_CHARS,
  TOKENIZE_MAX_CHARS,
  MAX_RUN_CHARS,
  SKIP_REASONS
} from "../../lib/memory/embedding/LexicalTokens.js";

const ESCAPE_TABLE = [
  ["평범한 토큰",        ["배포"],          "'배포'"],
  ["작은따옴표",         ["it's"],          "'it''s'"],
  ["역슬래시",           ["a\\b"],          "'a\\\\b'"],
  ["작은따옴표와 역슬래시", ["\\'x"],        "'\\\\''x'"],
  ["AND 연산자",         ["a&b"],           "'a&b'"],
  ["OR 연산자",          ["a|b"],           "'a|b'"],
  ["NOT 연산자",         ["!a"],            "'!a'"],
  ["괄호",               ["(a)"],           "'(a)'"],
  ["접두 일치 표기",      ["a:*"],           "'a:*'"],
  ["가중치 표기",         ["a:AB"],          "'a:ab'"],
  ["구 연산자",           ["a<->b"],         "'a<->b'"],
  ["거리 구 연산자",      ["a<2>b"],         "'a<2>b'"],
  ["큰따옴표",           ["\"q\""],         "'\"q\"'"],
  ["대문자",             ["HNSW"],          "'hnsw'"],
  ["NUL 문자",           ["ab\u0000c"],     "'abc'"],
  ["앞뒤 공백",           ["  pg  "],        "'pg'"]
];

describe("escapeTsqueryLexeme", () => {
  it("작은따옴표와 역슬래시를 두 번 쓰고 감싼다", () => {
    assert.equal(escapeTsqueryLexeme("o'neil\\x"), "'o''neil\\\\x'");
  });
});

describe("buildLexicalTsquery 이스케이프 표", () => {
  for (const [name, tokens, expected] of ESCAPE_TABLE) {
    it(name, () => assert.equal(buildLexicalTsquery(tokens), expected));
  }
});

describe("buildLexicalTsquery 결합", () => {
  it("토큰을 OR로 잇는다", () => {
    assert.equal(buildLexicalTsquery(["배포", "서버", "pgvector"]), "'배포' | '서버' | 'pgvector'");
  });

  it("대소문자만 다른 토큰은 한 번만 쓴다", () => {
    assert.equal(buildLexicalTsquery(["Redis", "redis", "REDIS"]), "'redis'");
  });

  it("글자나 숫자가 없는 토큰은 버린다", () => {
    assert.equal(buildLexicalTsquery(["!!!", "'", "&|", "  ", "", "ok"]), "'ok'");
  });

  it("남는 토큰이 없으면 null", () => {
    assert.equal(buildLexicalTsquery([]), null);
    assert.equal(buildLexicalTsquery(["", "--", "::"]), null);
    assert.equal(buildLexicalTsquery(null), null);
  });

  it("항 수를 QUERY_TERM_LIMIT로 자른다", () => {
    const tokens = Array.from({ length: QUERY_TERM_LIMIT + 5 }, (_, i) => `t${i}`);
    assert.equal(buildLexicalTsquery(tokens).split(" | ").length, QUERY_TERM_LIMIT);
  });

  it("문자열이 아닌 원소는 버린다", () => {
    assert.equal(buildLexicalTsquery([42, null, undefined, { a: 1 }, "x1"]), "'x1'");
  });
});

describe("normalizeLexicalTokens", () => {
  it("한글 호환 자모를 담은 어미 토큰을 버린다", () => {
    assert.deepEqual(normalizeLexicalTokens(["고르", "ㄴ다", "ㅂ니다", "색인"]), ["고르", "색인"]);
  });

  it("MAX_LEXEME_CHARS를 넘는 토큰을 버린다", () => {
    const long = "a".repeat(MAX_LEXEME_CHARS + 1);
    assert.deepEqual(normalizeLexicalTokens([long, "a".repeat(MAX_LEXEME_CHARS)]), ["a".repeat(MAX_LEXEME_CHARS)]);
  });

  it("상한 개수까지만 남긴다", () => {
    assert.deepEqual(normalizeLexicalTokens(["a1", "b2", "c3"], 2), ["a1", "b2"]);
  });

  it("입력 순서를 지킨다", () => {
    assert.deepEqual(normalizeLexicalTokens(["zeta", "alpha", "Zeta"]), ["zeta", "alpha"]);
  });
});

describe("lexicalDocument", () => {
  it("토큰을 공백으로 잇는다", () => {
    assert.equal(lexicalDocument(["배포", "서버"]), "배포 서버");
  });

  it("토큰이 없으면 빈 문자열(채운 행의 빈 tsvector)", () => {
    assert.equal(lexicalDocument([]), "");
  });
});

describe("lexicalTokens", () => {
  it("본문을 형태소 토큰으로 바꾸고 조사를 떼어 낸다", async () => {
    const tokens = await lexicalTokens("사용자는 운영 서버 재시작을 싫어한다");
    assert.ok(tokens.includes("사용자"));
    assert.ok(tokens.includes("서버"));
    assert.ok(!tokens.some(t => /[\u3131-\u318E]/.test(t)));
  });

  it("영문은 소문자 어간으로 바꾼다", async () => {
    const tokens = await lexicalTokens("The server was Restarting");
    assert.ok(tokens.includes("server"));
    assert.ok(tokens.includes("restart"));
  });

  it("질의와 본문은 같은 토큰을 만든다", async () => {
    const doc   = await lexicalTokens("pgvector HNSW 색인을 만든다");
    const query = await lexicalTokens("HNSW 색인");
    for (const token of query) assert.ok(doc.includes(token), token);
  });

  it("빈 본문과 문자열이 아닌 값은 빈 배열", async () => {
    assert.deepEqual(await lexicalTokens(""), []);
    assert.deepEqual(await lexicalTokens(null), []);
  });
});

describe("숫자 토큰과 입력 상한", () => {
  it("3자리 이상 숫자 연속을 본문과 질의 양쪽 토큰으로 남긴다", async () => {
    const doc   = await lexicalTokens("MCP 서버 포트는 53535이고 공유기는 443을 3999로 보낸다. 버전 12는 짧다");
    const query = await lexicalTokens("포트 53535");
    for (const n of ["53535", "443", "3999"]) assert.ok(doc.includes(n), n);
    assert.ok(!doc.includes("12"));
    assert.ok(query.includes("53535"));
  });

  it("앞 TOKENIZE_MAX_CHARS자만 토큰화한다", () => {
    const text = "가나 ".repeat(TOKENIZE_MAX_CHARS);
    assert.equal(lexicalInput(text).text.length, TOKENIZE_MAX_CHARS);
    assert.equal(lexicalInput(text).skip, null);
  });

  it("공백 없이 MAX_RUN_CHARS자를 넘는 한글 연속은 토큰화하지 않는다", async () => {
    const run = "운영서버재시작".repeat(Math.ceil((MAX_RUN_CHARS + 1) / 7)).slice(0, MAX_RUN_CHARS + 1);
    assert.deepEqual(lexicalInput(`앞 ${run} 뒤`), { text: "", skip: SKIP_REASONS.LONG_RUN });
    assert.deepEqual(await contentTokenResult(run), { doc: null, skip: SKIP_REASONS.LONG_RUN });
    assert.equal(await contentTokenDocument(run), null);
    assert.deepEqual(await lexicalTokens(run), []);
  });

  it("상한 이하의 한글 연속과 긴 영문 식별자는 토큰화한다", async () => {
    const run = "가".repeat(MAX_RUN_CHARS);
    assert.equal(lexicalInput(run).skip, null);
    const latin = "a".repeat(MAX_RUN_CHARS * 2);
    assert.equal(lexicalInput(latin).skip, null);
  });

  it("토큰화하는 본문은 문서 문자열과 사유 없음을 돌려준다", async () => {
    const result = await contentTokenResult("운영 서버 재시작");
    assert.equal(result.skip, null);
    assert.ok(result.doc.split(" ").includes("서버"));
  });
});
