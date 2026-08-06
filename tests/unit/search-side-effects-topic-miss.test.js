/**
 * SearchSideEffects — topic 필터 0건의 adaptor 학습 제외 검증
 *
 * 작성자: 최진호
 * 작성일: 2026-08-06
 *
 * topic은 전 계층 정확일치이므로 오기 한 글자로도 0건이 된다. 이 0건을
 * SearchParamAdaptor에 학습시키면 min_similarity가 부당하게 낮아진다.
 * search_events 기록은 유지하되 recordOutcome만 건너뛰는지 확인한다.
 */

import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

const recordedEvents  = [];
const recordedOutcomes = [];

mock.module("../../lib/memory/signals/SearchEventRecorder.js", {
  namedExports: {
    buildSearchEvent : (query, fragments, meta) => ({ query, fragments, meta }),
    recordSearchEvent: async (event) => { recordedEvents.push(event); return "evt-1"; },
    classifyQueryType: () => "text"
  }
});

mock.module("../../lib/memory/signals/SearchParamAdaptor.js", {
  namedExports: {
    getSearchParamAdaptor: () => ({
      recordOutcome: async (...args) => { recordedOutcomes.push(args); }
    })
  }
});

const { commitSearchSideEffects } = await import("../../lib/memory/read/SearchSideEffects.js");

/**
 * commitSearchSideEffects 호출용 최소 ctx를 생성한다.
 *
 * @param {number} rawResultCount
 * @returns {Object}
 */
function ctxOf(rawResultCount) {
  return {
    searchPath  : ["L2:0"],
    sessionId   : "sess-1",
    latencyMs   : 3,
    l1IsFallback: false,
    layerLatency: { l1Ms: 1, l2Ms: 1, l3Ms: 1, graphUsed: false },
    rawResultCount
  };
}

beforeEach(() => {
  recordedEvents.length   = 0;
  recordedOutcomes.length = 0;
});

describe("commitSearchSideEffects — topic 0건 adaptor 제외", () => {

  it("topic 지정 + 0건이면 recordOutcome을 호출하지 않는다", async () => {
    const eventId = await commitSearchSideEffects(
      { topic: "anchormind-mcp" },
      { keyId: ["key-1"] },
      [],
      ctxOf(0)
    );

    assert.equal(eventId, "evt-1");
    assert.equal(recordedEvents.length, 1, "search_events 기록은 유지되어야 한다");
    assert.equal(recordedOutcomes.length, 0);
  });

  it("topic 지정 + 결과가 있으면 recordOutcome을 호출한다", async () => {
    await commitSearchSideEffects(
      { topic: "anchormind-mcp" },
      { keyId: ["key-1"] },
      [{ id: "f1" }],
      ctxOf(1)
    );

    assert.equal(recordedOutcomes.length, 1);
    assert.equal(recordedOutcomes[0][3], 1);
  });

  it("topic 미지정 0건은 기존대로 recordOutcome을 호출한다", async () => {
    await commitSearchSideEffects({ text: "무엇이든" }, { keyId: null }, [], ctxOf(0));

    assert.equal(recordedOutcomes.length, 1);
    assert.equal(recordedOutcomes[0][3], 0);
  });

  it("공백만 있는 topic은 필터로 보지 않고 recordOutcome을 호출한다", async () => {
    await commitSearchSideEffects({ topic: "   " }, { keyId: null }, [], ctxOf(0));

    assert.equal(recordedOutcomes.length, 1);
  });

});
