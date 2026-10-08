/**
 * countTokens: 특수 토큰 문자열이 들어 있는 본문
 *
 * 사용자 본문에 `<|endoftext|>` 등이 있으면 js-tiktoken의 기본 encode가
 * "The text contains a special token that is not allowed"를 던져 저장이 실패하던 회귀를 막는다.
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

import { countTokens } from "../../lib/memory/write/FragmentFactory.js";

describe("countTokens — special token strings", () => {
  for (const special of ["<|endoftext|>", "<|im_start|>", "<|fim_prefix|>"]) {
    it(`${special} 가 들어 있어도 던지지 않고 양의 정수를 돌려준다`, () => {
      const n = countTokens(`앞 문장 ${special} 뒤 문장`);
      assert.ok(Number.isInteger(n) && n > 0);
    });
  }

  it("특수 토큰 문자열은 일반 텍스트 조각으로 센다(1토큰으로 접히지 않는다)", () => {
    assert.ok(countTokens("<|endoftext|>") > 1);
  });

  it("특수 토큰이 없는 본문의 값은 그대로다", () => {
    assert.equal(countTokens("hello world"), 2);
    assert.equal(countTokens(""), 0);
  });
});
