/**
 * RERANKER_WINDOW / RERANKER_TOP_K: 호출 시점에 읽는 리랭커 후보 수 설정
 */

import { describe, it, afterEach } from "node:test";
import assert                      from "node:assert/strict";

import { rerankerWindow, rerankerTopK } from "../../lib/config.js";

describe("reranker window config", () => {
  afterEach(() => { delete process.env.RERANKER_WINDOW; delete process.env.RERANKER_TOP_K; });

  it("미설정이면 기존 동작과 같은 30과 15다", () => {
    assert.equal(rerankerWindow(), 30);
    assert.equal(rerankerTopK(), 15);
  });

  it("환경변수를 호출 시점에 읽는다", () => {
    process.env.RERANKER_WINDOW = "20";
    process.env.RERANKER_TOP_K  = "10";
    assert.equal(rerankerWindow(), 20);
    assert.equal(rerankerTopK(), 10);
    process.env.RERANKER_WINDOW = "40";
    assert.equal(rerankerWindow(), 40);
  });

  it("범위 밖이거나 숫자가 아니면 기본값이다", () => {
    for (const bad of ["0", "-3", "abc", "101", "2.5"]) {
      process.env.RERANKER_WINDOW = bad;
      assert.equal(rerankerWindow(), 30, `RERANKER_WINDOW=${bad}`);
    }
  });
});
