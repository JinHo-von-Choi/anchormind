/**
 * Unit tests: 사용자 지정 keywords와 본문 추출 결과의 병합.
 *
 * 지정 keywords만 저장하면 본문에만 등장하는 코드 식별자가 색인되지 않아
 * keywords 배열 교집합을 쓰는 검색 경로에서 회수가 불가능해진다.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { FragmentFactory, mergeKeywords } = await import("../../lib/memory/write/FragmentFactory.js");

describe("mergeKeywords", () => {
  it("사용자 지정을 앞에 두고 추출 결과를 뒤에 붙인다", () => {
    assert.deepEqual(
      mergeKeywords(["회상", "점수"], ["computeRecallScore", "recall"]),
      ["회상", "점수", "computeRecallScore", "recall"]
    );
  });

  it("대소문자를 무시하고 중복을 제거한다", () => {
    assert.deepEqual(mergeKeywords(["nginx"], ["NGINX", "포트"]), ["nginx", "포트"]);
  });

  it("추출 항목의 원형 대소문자를 보존한다", () => {
    const merged = mergeKeywords(["로그"], ["computeRecallScore"]);
    assert.ok(merged.includes("computeRecallScore"), "식별자가 소문자화되면 안 된다");
  });

  it("상한 10개를 넘지 않는다", () => {
    const supplied  = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const extracted = ["i", "j", "k", "l", "m"];
    assert.equal(mergeKeywords(supplied, extracted).length, 10);
  });

  it("사용자 지정이 상한을 이미 넘으면 그대로 보존한다", () => {
    const supplied = Array.from({ length: 12 }, (_, i) => `k${i}`);
    assert.deepEqual(mergeKeywords(supplied, ["extra"]), supplied);
  });

  it("추출 결과가 비어도 사용자 지정을 잃지 않는다", () => {
    assert.deepEqual(mergeKeywords(["유일"], []), ["유일"]);
  });
});

describe("FragmentFactory.create 키워드 경로", () => {
  const factory = new FragmentFactory();

  it("keywords 지정 시에도 본문 식별자를 색인한다", () => {
    const frag = factory.create({
      content : "recall 점수 산출은 computeRecallScore 함수가 담당한다",
      topic   : "t",
      type    : "fact",
      keywords: ["회상", "점수"]
    });
    assert.ok(frag.keywords.includes("회상"), "사용자 지정 보존 필요");
    assert.ok(frag.keywords.includes("computeRecallScore"), "본문 식별자 색인 필요");
  });

  it("keywords 미지정 경로는 기존대로 추출만 수행한다", () => {
    const frag = factory.create({
      content: "키워드 미지정 파편이며 extractKeywords가 동작해야 한다",
      topic  : "t",
      type   : "fact"
    });
    assert.ok(frag.keywords.length > 0);
    assert.ok(frag.keywords.includes("extractKeywords"));
  });
});
