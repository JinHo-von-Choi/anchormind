/**
 * lexical 일치 점수 / implicit keyword 추출 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-05-15
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { lexicalMatchScore, deriveImplicitKeywords } from "../../lib/memory/read/FragmentSearch.js";

describe("lexicalMatchScore", () => {
  it("topic 완전 일치에 가장 높은 점수", () => {
    const frag = { topic: "memento-mcp", keywords: [], content: "" };
    const score = lexicalMatchScore(frag, { topic: "memento-mcp" });
    assert.ok(score >= 4, `topic exact 최소 4점 기대, got ${score}`);
  });

  it("keyword가 content에만 있으면 낮은 점수", () => {
    const frag = { topic: "other", keywords: [], content: "memento 회상 문제" };
    const score = lexicalMatchScore(frag, { keywords: ["memento"] });
    assert.ok(score > 0 && score <= 1.5, `content-only 매치는 약한 신호여야, got ${score}`);
  });

  it("일치 없으면 0", () => {
    const frag = { topic: "alpha", keywords: ["beta"], content: "gamma" };
    assert.equal(lexicalMatchScore(frag, { keywords: ["delta"] }), 0);
  });

  it("topic 매치가 content 매치보다 높다", () => {
    const onTopic  = { topic: "nginx-ssl", keywords: [], content: "" };
    const inBody   = { topic: "other", keywords: [], content: "nginx-ssl" };
    const q = { keywords: ["nginx-ssl"] };
    assert.ok(lexicalMatchScore(onTopic, q) > lexicalMatchScore(inBody, q));
  });
});

describe("deriveImplicitKeywords", () => {
  it("text-only 질의에서 키워드 추출", () => {
    const kws = deriveImplicitKeywords({ text: "memento-mcp recall 정렬 버그" });
    assert.ok(kws.includes("memento-mcp"));
  });

  it("keywords/topic 있으면 빈 배열 (명시 신호 우선)", () => {
    assert.deepEqual(deriveImplicitKeywords({ text: "foo bar", keywords: ["x"] }), []);
    assert.deepEqual(deriveImplicitKeywords({ text: "foo bar", topic: "y" }), []);
  });

  it("stopword와 3자 미만 토큰 제거", () => {
    const kws = deriveImplicitKeywords({ text: "이 문제 관련 상태 확인" });
    assert.ok(!kws.includes("문제"), "stopword 문제 제거 기대");
    assert.ok(!kws.includes("이"), "1자 토큰 제거 기대");
  });

  it("최대 5개로 절삭", () => {
    const kws = deriveImplicitKeywords({ text: "alpha bravo charlie delta echo foxtrot golf" });
    assert.ok(kws.length <= 5);
  });
});
