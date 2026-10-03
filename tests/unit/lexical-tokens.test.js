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
  QUERY_TERM_LIMIT,
  MAX_LEXEME_CHARS
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
    assert.ok(!tokens.some(t => /[ㄱ-ㆎ]/.test(t)));
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
