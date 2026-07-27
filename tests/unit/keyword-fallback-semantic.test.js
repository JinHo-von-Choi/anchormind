/**
 * keywords-only 쿼리 L3 시맨틱 보조 경로 검증
 *
 * 작성자: 최진호
 * 작성일: 2026-07-26
 *
 * text 없는 keywords 쿼리에서 L2가 놓친 content 매칭 파편을
 * L3 시맨틱 보조가 병합하는지 검증한다.
 */

import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

let semanticCalls = [];

mock.module("../../lib/redis.js", {
  namedExports: { redisClient: { status: "stub" } }
});

mock.module("../../lib/logger.js", {
  namedExports: {
    logDebug: mock.fn(), logInfo: mock.fn(), logWarn: mock.fn(), logError: mock.fn()
  }
});

mock.module("../../lib/tools/embedding.js", {
  namedExports: {
    EMBEDDING_ENABLED      : true,
    computeContentHash     : () => "hash",
    generateBatchEmbeddings: async () => [],
    generateEmbedding      : async (text) => {
      semanticCalls.push({ kind: "embed", text });
      return new Array(4).fill(0.1);
    },
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
    importance: 0.7, created_at: NOW, valid_to: null,
    agent_id: "default", workspace: null, ...overrides
  };
}

function makeSearch({ l2Rows, l3Rows }) {
  const search = Object.create(FragmentSearch.prototype);
  search.index = {
    searchByKeywords: async () => [],
    searchByTopic   : async () => [],
    searchByType    : async () => [],
    getRecent       : async () => [],
    getCachedFragment: async () => null,
    cacheFragment   : async () => {},
    index           : async () => {}
  };
  search.store = {
    searchByKeywords: async () => l2Rows.map(r => ({ ...r })),
    searchByTopic   : async () => [],
    getByIds        : async () => [],
    searchBySemantic: async (...args) => {
      semanticCalls.push({ kind: "semantic" });
      return l3Rows.map(r => ({ ...r }));
    },
    incrementAccess : () => {},
    touchLinked     : async () => {}
  };
  search.embeddingCache = { get: async () => null, set: () => {} };
  search._morphemeIndex = { textToMorphemeVector: async () => null };
  return search;
}

beforeEach(() => { semanticCalls = []; });

describe("keywords-only L3 시맨틱 보조", () => {
  it("text 없는 keywords 쿼리에서 L3 결과가 병합되고 searchPath에 L3kw가 남는다", async () => {
    const search = makeSearch({
      l2Rows: [frag({ id: "l2-hit" })],
      l3Rows: [frag({ id: "l3-only", content: "content 수신 상한 4000자" })]
    });

    const result = await search.search({
      keywords   : ["contentGuard", "4000자"],
      contextText: "content 길이 게이트 이력",
      agentId    : "default",
      tokenBudget: 5000
    });

    const ids = new Set(result.fragments.map(f => f.id));
    assert.ok(ids.has("l2-hit"), "L2 결과 유실");
    assert.ok(ids.has("l3-only"), "L3 보조 결과 미병합");
    assert.match(result.searchPath, /L3kw:\d+/);
    assert.ok(semanticCalls.some(c => c.kind === "embed"), "임베딩 미호출");
  });

  it("합성 텍스트는 정규화된 keywords만 포함하고 contextText는 제외한다", async () => {
    const search = makeSearch({ l2Rows: [], l3Rows: [] });
    await search.search({
      keywords   : ["Beta", "alpha", "ALPHA", " beta "],
      contextText: "gamma delta",
      agentId    : "default",
      tokenBudget: 1000
    });
    const embed = semanticCalls.find(c => c.kind === "embed");
    assert.ok(embed, "임베딩 미호출");
    assert.equal(embed.text, "alpha beta", "소문자·중복 제거·정렬된 keywords만 기대");
    assert.doesNotMatch(embed.text, /gamma/, "contextText는 합성 텍스트에서 제외되어야 함");
  });

  it("중복 ID는 L2 결과가 우선한다", async () => {
    const search = makeSearch({
      l2Rows: [frag({ id: "dup", importance: 0.9 })],
      l3Rows: [frag({ id: "dup", importance: 0.1 })]
    });
    const result = await search.search({
      keywords: ["k"], agentId: "default", tokenBudget: 5000
    });
    const dups = result.fragments.filter(f => f.id === "dup");
    assert.equal(dups.length, 1);
    assert.equal(dups[0].importance, 0.9);
  });
});
