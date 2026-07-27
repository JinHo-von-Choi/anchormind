/**
 * keywords 보조 L3 실행 상한(timeout) 검증
 *
 * 작성자: 최진호
 * 작성일: 2026-07-27
 *
 * L3 시맨틱 보조가 keywordFallbackTimeoutMs를 초과하면 supplement는
 * 빈 배열로 취급되고 searchPath에 L3kw:timeout이 남아야 한다.
 */

import { describe, it, beforeEach, afterEach, mock } from "node:test";
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
const { MEMORY_CONFIG }  = await import("../../config/memory.js");

const NOW = new Date().toISOString();

function frag(overrides) {
  return {
    id: "f", content: "c", topic: "t", keywords: ["k"], type: "fact",
    importance: 0.7, created_at: NOW, valid_to: null,
    agent_id: "default", workspace: null, ...overrides
  };
}

/**
 * L3 시맨틱 검색이 delayMs 이후에만 응답하는 느린 store로 FragmentSearch를 구성한다.
 */
function makeSlowSearch({ l2Rows, l3Rows, delayMs }) {
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
    searchBySemantic: async (...args) => {
      semanticCalls.push({ kind: "semantic" });
      await new Promise(resolve => setTimeout(resolve, delayMs));
      return l3Rows.map(r => ({ ...r }));
    },
    incrementAccess: () => {},
    touchLinked     : async () => {}
  };
  search.embeddingCache = { get: async () => null, set: () => {} };
  search._morphemeIndex = {
    textToMorphemeVector: async () => {
      throw new Error("morphemeIndex는 _skipMorpheme=true일 때 절대 호출되면 안 된다");
    }
  };
  return search;
}

describe("keywords 보조 L3 실행 상한", () => {
  let originalTimeoutMs;

  beforeEach(() => {
    semanticCalls      = [];
    originalTimeoutMs  = MEMORY_CONFIG.semanticSearch.keywordFallbackTimeoutMs;
  });

  afterEach(() => {
    MEMORY_CONFIG.semanticSearch.keywordFallbackTimeoutMs = originalTimeoutMs;
  });

  it("L3 응답이 상한을 초과하면 supplement 없이 L3kw:timeout이 searchPath에 남는다", async () => {
    MEMORY_CONFIG.semanticSearch.keywordFallbackTimeoutMs = 20;

    const search = makeSlowSearch({
      l2Rows : [frag({ id: "l2-hit" })],
      l3Rows : [frag({ id: "l3-too-late", content: "타임아웃 이후 도착" })],
      delayMs: 200
    });

    const result = await search.search({
      keywords   : ["timeout", "probe"],
      agentId    : "default",
      tokenBudget: 5000
    });

    const ids = new Set(result.fragments.map(f => f.id));
    assert.ok(ids.has("l2-hit"), "L2 결과는 유지되어야 함");
    assert.ok(!ids.has("l3-too-late"), "타임아웃된 L3 결과가 병합되면 안 됨");
    assert.doesNotMatch(result.searchPath, /L3kw:\d+/, "정상 L3kw 카운트 세그먼트가 남으면 안 됨");
    assert.match(result.searchPath, /L3kw:timeout/, "L3kw:timeout 세그먼트 부재");
  });

  it("_skipMorpheme=true 전달 시 형태소 프로브를 생략한다", async () => {
    MEMORY_CONFIG.semanticSearch.keywordFallbackTimeoutMs = 1500;

    const search = makeSlowSearch({
      l2Rows : [],
      l3Rows : [frag({ id: "l3-only" })],
      delayMs: 0
    });

    const result = await search.search({
      keywords   : ["morph", "skip"],
      agentId    : "default",
      tokenBudget: 5000
    });

    const ids = new Set(result.fragments.map(f => f.id));
    assert.ok(ids.has("l3-only"), "형태소 프로브 생략 경로에서도 기본 L3 결과는 병합돼야 함");
  });
});
