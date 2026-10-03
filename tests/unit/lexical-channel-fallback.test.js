/**
 * 본문 어휘 채널의 검색 계층 연결 시험(임베딩 꺼짐)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 임베딩이 꺼진 설치의 text 질의는 RRF 대신 대체 경로를 탄다. 저장소와 색인을 대역으로 둔 FragmentSearch로
 * 다음을 본다.
 *   1. keywords 없는 text 질의도 어휘 후보를 얻는다
 *   2. L2와 겹치는 후보에는 어휘 점수만 옮기고 중복 없이 합친다
 *   3. 중요도와 시각이 같으면 어휘 점수 순서로 정렬한다
 */

import { describe, it, mock } from "node:test";
import assert                 from "node:assert/strict";

mock.module("../../lib/redis.js", {
  namedExports: { redisClient: { status: "stub" } }
});
mock.module("../../lib/logger.js", {
  namedExports: { logDebug: mock.fn(), logInfo: mock.fn(), logWarn: mock.fn(), logError: mock.fn() }
});
mock.module("../../lib/tools/embedding.js", {
  namedExports: {
    EMBEDDING_ENABLED      : false,
    computeContentHash     : () => "hash",
    generateBatchEmbeddings: async () => [],
    generateEmbedding      : async () => { throw new Error("임베딩 호출 금지"); },
    prepareTextForEmbedding: text => String(text ?? ""),
    vectorToSql            : vector => `[${vector.join(",")}]`
  }
});
mock.module("../../lib/memory/signals/SearchMetrics.js", {
  namedExports: { getSearchMetrics: async () => ({ record: async () => {} }) }
});
mock.module("../../lib/memory/signals/SearchParamAdaptor.js", {
  namedExports: { getSearchParamAdaptor: () => ({ getMinSimilarity: async () => null }) }
});
mock.module("../../lib/memory/read/SearchSideEffects.js", {
  namedExports: { commitSearchSideEffects: async () => null }
});
mock.module("../../lib/memory/read/Reranker.js", {
  namedExports: { isRerankerAvailable: () => false, rerank: async () => null }
});

const { FragmentSearch } = await import("../../lib/memory/read/FragmentSearch.js");

const NOW = new Date().toISOString();

function frag(overrides) {
  return {
    id: "f", content: "c", topic: "t", keywords: ["k"], type: "fact",
    importance: 0.5, created_at: NOW, valid_to: null, agent_id: "default", workspace: null, ...overrides
  };
}

function makeSearch({ l2Rows = [], lexicalRows = [] }) {
  const search = Object.create(FragmentSearch.prototype);
  search.index = {
    searchByKeywords : async () => [],
    searchByTopic    : async () => [],
    searchByType     : async () => [],
    getRecent        : async () => [],
    getCachedFragment: async () => null,
    cacheFragment    : async () => {},
    index            : async () => {}
  };
  search.store = {
    searchByKeywords: async () => l2Rows.map(r => ({ ...r })),
    searchByTopic   : async () => [],
    getByIds        : async () => [],
    searchByLexical : async () => lexicalRows.map(r => ({ ...r })),
    incrementAccess : () => {},
    touchLinked     : async () => {}
  };
  return search;
}

describe("임베딩 꺼짐 text 질의", () => {
  it("keywords 없는 text 질의가 어휘 후보를 얻는다", async () => {
    const search = makeSearch({ lexicalRows: [frag({ id: "a", _lexicalScore: 1 }), frag({ id: "b", _lexicalScore: 0.4 })] });
    const result = await search.search({ text: "배포 절차", agentId: "default", tokenBudget: 5000 });
    assert.deepEqual(result.fragments.map(f => f.id), ["a", "b"]);
    assert.match(result.searchPath, /Lexical:2/);
  });

  it("L2와 겹치는 후보는 한 번만 남고 어휘 점수를 받는다", async () => {
    const search = makeSearch({
      l2Rows     : [frag({ id: "both", keywords: ["배포"] })],
      lexicalRows: [frag({ id: "both", _lexicalScore: 0.6 }), frag({ id: "lex", _lexicalScore: 1 })]
    });
    const result = await search.search({ text: "배포 절차", keywords: ["배포"], agentId: "default", tokenBudget: 5000 });
    const ids    = result.fragments.map(f => f.id);
    assert.equal(ids.filter(id => id === "both").length, 1);
    assert.ok(ids.includes("lex"));
    assert.equal(result._lexicalScores.get("both"), 0.6);
  });

  it("중요도와 시각이 같으면 어휘 점수 순서로 정렬한다", async () => {
    const search = makeSearch({
      lexicalRows: [frag({ id: "low", _lexicalScore: 0.2 }), frag({ id: "high", _lexicalScore: 1 }), frag({ id: "mid", _lexicalScore: 0.5 })]
    });
    const result = await search.search({ text: "서버", agentId: "default", tokenBudget: 5000 });
    assert.deepEqual(result.fragments.map(f => f.id), ["high", "mid", "low"]);
  });

  it("text 없는 keywords 질의는 어휘 채널을 부르지 않는다", async () => {
    let called = 0;
    const search = makeSearch({ l2Rows: [frag({ id: "kw" })] });
    search.store.searchByLexical = async () => { called++; return []; };
    await search.search({ keywords: ["k"], agentId: "default", tokenBudget: 5000 });
    assert.equal(called, 0);
  });
});
