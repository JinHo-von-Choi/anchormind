/**
 * 본문 어휘 채널의 검색 계층 연결 시험(임베딩 켜짐)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 저장소와 색인을 대역으로 둔 FragmentSearch로 다음을 본다.
 *   1. text 질의에서 어휘 후보가 RRF에 합류하고 검색 경로에 Lexical:N이 남는다
 *   2. 응답 파편에는 _lexicalScore가 없고, 결과의 _lexicalScores가 id별 점수를 담는다
 *   3. 저장소가 어휘 검색을 제공하지 않으면 결과가 그대로다
 *   4. recall 최종 점수가 _lexicalScore를 lexical 가산에 쓰고, 예산 선택 on과 off가 같은 순서를 낸다
 */

import { describe, it, afterEach, mock } from "node:test";
import assert                             from "node:assert/strict";

mock.module("../../lib/redis.js", {
  namedExports: { redisClient: { status: "stub" } }
});
mock.module("../../lib/logger.js", {
  namedExports: { logDebug: mock.fn(), logInfo: mock.fn(), logWarn: mock.fn(), logError: mock.fn() }
});
mock.module("../../lib/tools/embedding.js", {
  namedExports: {
    EMBEDDING_ENABLED      : true,
    computeContentHash     : () => "hash",
    generateBatchEmbeddings: async () => [],
    generateEmbedding      : async () => new Array(4).fill(0.1),
    prepareTextForEmbedding: text => String(text ?? ""),
    vectorToSql            : vector => `[${vector.join(",")}]`,
    cosineSimilarity       : () => 0,
    normalizeL2            : vector => vector,
    extractDocumentMetadata: () => ({}),
    OPENAI_API_KEY         : "",
    EMBEDDING_API_KEY      : "",
    EMBEDDING_MODEL        : "stub",
    EMBEDDING_DIMENSIONS   : 4,
    EMBEDDING_SUPPORTS_DIMS_PARAM: false,
    EMBEDDING_PROVIDER     : "openai"
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

const { FragmentSearch }                       = await import("../../lib/memory/read/FragmentSearch.js");
const { MemoryRecaller, computeRecallScore }   = await import("../../lib/memory/processors/MemoryRecaller.js");
const { MEMORY_CONFIG }                        = await import("../../config/memory.js");

const NOW = new Date().toISOString();

function frag(overrides) {
  return {
    id: "f", content: "c", topic: "t", keywords: ["k"], type: "fact",
    importance: 0.5, created_at: NOW, valid_to: null, agent_id: "default", workspace: null, ...overrides
  };
}

function makeSearch({ l3Rows = [], lexicalRows = null, lexicalCalls = [] }) {
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
    searchByKeywords: async () => [],
    searchByTopic   : async () => [],
    getByIds        : async () => [],
    searchBySemantic: async () => l3Rows.map(r => ({ ...r })),
    incrementAccess : () => {},
    touchLinked     : async () => {}
  };
  if (lexicalRows) {
    search.store.searchByLexical = async (text, sq) => {
      lexicalCalls.push({ text, sq });
      return lexicalRows.map(r => ({ ...r }));
    };
  }
  search.embeddingCache = { get: async () => null, set: () => {} };
  search._morphemeIndex = { textToMorphemeVector: async () => null };
  return search;
}

describe("text 질의의 RRF 합류", () => {
  it("어휘 후보가 결과에 들어오고 검색 경로에 남는다", async () => {
    const calls  = [];
    const search = makeSearch({
      l3Rows     : [frag({ id: "sem", similarity: 0.7 })],
      lexicalRows: [frag({ id: "lex", _lexicalScore: 1 }), frag({ id: "sem", _lexicalScore: 0.5 })],
      lexicalCalls: calls
    });
    const result = await search.search({ text: "운영 서버 재시작", agentId: "default", keyId: "k1", workspace: "ws", tokenBudget: 5000 });

    const ids = result.fragments.map(f => f.id);
    assert.ok(ids.includes("lex"));
    assert.ok(ids.includes("sem"));
    assert.match(result.searchPath, /Lexical:2/);
    assert.equal(calls[0].text, "운영 서버 재시작");
    assert.equal(calls[0].sq.keyId, "k1");
    assert.equal(calls[0].sq.workspace, "ws");
    assert.ok(result.fragments.every(f => !("_lexicalScore" in f)));
    assert.equal(result._lexicalScores.get("lex"), 1);
    assert.equal(result._lexicalScores.get("sem"), 0.5);
  });

  it("저장소가 어휘 검색을 제공하지 않으면 경로와 결과가 그대로다", async () => {
    const search = makeSearch({ l3Rows: [frag({ id: "sem", similarity: 0.7 })] });
    const result = await search.search({ text: "운영 서버", agentId: "default", tokenBudget: 5000 });
    assert.deepEqual(result.fragments.map(f => f.id), ["sem"]);
    assert.doesNotMatch(result.searchPath, /Lexical/);
    assert.equal(result._lexicalScores.size, 0);
  });

  it("예산 선택용 후보에도 어휘 후보와 점수가 남는다", async () => {
    const search = makeSearch({ lexicalRows: [frag({ id: "lex", _lexicalScore: 0.8 })] });
    const { candidates } = await search.searchCandidates({ text: "서버", agentId: "default", tokenBudget: 5000 });
    assert.equal(candidates.find(f => f.id === "lex")._lexicalScore, 0.8);
  });
});

describe("질의 프로파일의 어휘 계층 가중", () => {
  it("세 프로파일이 lexicalWeightFactor를 가진다", () => {
    for (const intent of ["EXACT_SYMBOL", "CONCEPT_INTENT", "HYBRID"]) {
      assert.equal(typeof MEMORY_CONFIG.queryProfiles[intent].lexicalWeightFactor, "number", intent);
    }
    assert.ok(MEMORY_CONFIG.queryProfiles.EXACT_SYMBOL.lexicalWeightFactor > MEMORY_CONFIG.queryProfiles.CONCEPT_INTENT.lexicalWeightFactor);
  });
});

describe("recall 최종 점수", () => {
  const ctx = {
    lexicalQuery: { keywords: undefined, topic: undefined, _implicitKeywords: [] },
    anchorTime  : Date.parse(NOW),
    config      : MEMORY_CONFIG,
    workspace   : null
  };

  it("_lexicalScore가 lexical 가산에 들어간다", () => {
    const base = frag({ id: "a" });
    const with1 = computeRecallScore({ ...base, _lexicalScore: 1 }, ctx);
    const none  = computeRecallScore(base, ctx);
    assert.ok(Math.abs(with1 - none - MEMORY_CONFIG.ranking.lexicalWeightFallback) < 1e-9);
  });

  it("keywords 일치 점수가 더 크면 그 값을 쓴다", () => {
    const kwCtx = { ...ctx, lexicalQuery: { keywords: ["c"], topic: "t", _implicitKeywords: [] } };
    const base  = frag({ id: "a" });
    assert.equal(computeRecallScore({ ...base, _lexicalScore: 0.01 }, kwCtx), computeRecallScore(base, kwCtx));
  });
});

describe("recall 순서와 예산 선택 스위치", () => {
  afterEach(() => { delete process.env.MEMENTO_RANK_BEFORE_BUDGET; });

  function recallerWith(combined) {
    const search = new FragmentSearch();
    search._executeSearch = async () => ({
      combined    : combined.map(f => ({ ...f })),
      searchPath  : ["Lexical:3", "RRF"],
      l1IsFallback: false,
      layerLatency: { l1Ms: 0, l2Ms: 0, l3Ms: 0, graphUsed: false }
    });
    search.store = { incrementAccess: () => {}, touchLinked: async () => {} };
    search._cacheFragments = async () => {};
    return new MemoryRecaller({
      search,
      store           : { getLinkedFragments: async () => [] },
      index           : { getSeenIds: async () => new Set() },
      suggestionEngine: { suggest: async () => null }
    });
  }

  const combined = [
    frag({ id: "low",  _lexicalScore: 0.1, _rrfScore: 0.03 }),
    frag({ id: "high", _lexicalScore: 1,   _rrfScore: 0.02 }),
    frag({ id: "mid",  _lexicalScore: 0.5, _rrfScore: 0.01 })
  ];

  for (const mode of ["on", "off"]) {
    it(`${mode}: 다른 신호가 같으면 어휘 점수 순서로 돌려주고 내부 점수는 응답에 없다`, async () => {
      process.env.MEMENTO_RANK_BEFORE_BUDGET = mode;
      const result = await recallerWith(combined).recall({ text: "서버", tokenBudget: 5000, includeLinks: false, excludeSeen: false });
      assert.deepEqual(result.fragments.map(f => f.id), ["high", "mid", "low"]);
      assert.ok(result.fragments.every(f => !("_lexicalScore" in f)));
      assert.equal(result._lexicalScores, undefined);
    });
  }
});
