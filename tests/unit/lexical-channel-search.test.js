/**
 * 본문 어휘 채널의 검색 계층 연결 시험(임베딩 켜짐)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 저장소와 색인을 대역으로 둔 FragmentSearch로 다음을 본다.
 *   1. recall 진입점이 켠 text 질의에서만 어휘 후보가 RRF에 합류하고 검색 경로에 Lexical:N이 남는다
 *   2. 응답 파편에는 _lexicalScore가 없다
 *   3. 플래그가 없는 내부 검색이나 저장소가 어휘 검색을 제공하지 않으면 결과가 그대로다
 *   4. recall 최종 점수는 _lexicalScore를 쓰지 않으며, 어휘 후보가 더해져도 기존 후보의 상대 순서는 그대로다
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
const { ConflictResolver } = await import("../../lib/memory/write/ConflictResolver.js");
const { MemoryRecaller, computeRecallScore }   = await import("../../lib/memory/processors/MemoryRecaller.js");
const { MEMORY_CONFIG }                        = await import("../../config/memory.js");
const { markLexicalOnly, lexicalOnlyLast, LEXICAL_ONLY_TIER } = await import("../../lib/memory/read/LexicalSearch.js");

const NOW = new Date().toISOString();
const DAY = 86400000;

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
  it("recall 플래그가 있으면 어휘 후보가 결과에 들어오고 검색 경로에 남는다", async () => {
    const calls  = [];
    const search = makeSearch({
      l3Rows      : [frag({ id: "sem", similarity: 0.7 })],
      lexicalRows : [frag({ id: "lex", _lexicalScore: 1 }), frag({ id: "sem", _lexicalScore: 0.5 })],
      lexicalCalls: calls
    });
    const result = await search.search({
      text: "운영 서버 재시작", agentId: "default", keyId: "k1", workspace: "ws", tokenBudget: 5000, lexicalChannel: true
    });

    const ids = result.fragments.map(f => f.id);
    assert.ok(ids.includes("lex"));
    assert.ok(ids.includes("sem"));
    assert.match(result.searchPath, /Lexical:2/);
    assert.equal(calls[0].text, "운영 서버 재시작");
    assert.equal(calls[0].sq.keyId, "k1");
    assert.equal(calls[0].sq.workspace, "ws");
    assert.ok(result.fragments.every(f => !("_lexicalScore" in f)));
    assert.equal(result._lexicalScores, undefined);
  });

  it("플래그가 없는 검색(충돌 탐지 등 내부 호출)은 어휘 검색을 부르지 않는다", async () => {
    const calls  = [];
    const search = makeSearch({ l3Rows: [frag({ id: "sem", similarity: 0.7 })], lexicalRows: [frag({ id: "lex" })], lexicalCalls: calls });
    const result = await search.search({ text: "운영 서버 재시작 절차 본문 전체", topic: "ops", agentId: "default", tokenBudget: 500 });
    assert.equal(calls.length, 0);
    assert.doesNotMatch(result.searchPath, /Lexical/);
  });

  it("저장소가 어휘 검색을 제공하지 않으면 경로와 결과가 그대로다", async () => {
    const search = makeSearch({ l3Rows: [frag({ id: "sem", similarity: 0.7 })] });
    const result = await search.search({ text: "운영 서버", agentId: "default", tokenBudget: 5000, lexicalChannel: true });
    assert.deepEqual(result.fragments.map(f => f.id), ["sem"]);
    assert.doesNotMatch(result.searchPath, /Lexical/);
  });

  it("예산 선택용 후보에도 어휘 후보가 들어온다", async () => {
    const search = makeSearch({ lexicalRows: [frag({ id: "lex", _lexicalScore: 0.8 })] });
    const { candidates } = await search.searchCandidates({ text: "서버", agentId: "default", tokenBudget: 5000, lexicalChannel: true });
    assert.ok(candidates.some(f => f.id === "lex"));
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

describe("recall 최종 점수와 순서", () => {
  afterEach(() => { delete process.env.MEMENTO_RANK_BEFORE_BUDGET; });

  it("최종 점수는 _lexicalScore를 쓰지 않는다", () => {
    const ctx  = { lexicalQuery: { keywords: ["k"], topic: undefined, _implicitKeywords: [] }, anchorTime: Date.parse(NOW), config: MEMORY_CONFIG, workspace: null };
    const base = frag({ id: "a" });
    assert.equal(computeRecallScore({ ...base, _lexicalScore: 1 }, ctx), computeRecallScore(base, ctx));
  });

  function recallerWith(combined, seen = []) {
    const search = new FragmentSearch();
    search._executeSearch = async (sq) => {
      seen.push(sq);
      return {
        combined    : combined.map(f => ({ ...f })),
        searchPath  : ["L2:3", "RRF"],
        l1IsFallback: false,
        layerLatency: { l1Ms: 0, l2Ms: 0, l3Ms: 0, graphUsed: false }
      };
    };
    search.store = { incrementAccess: () => {}, touchLinked: async () => {} };
    search._cacheFragments = async () => {};
    return new MemoryRecaller({
      search,
      store           : { getLinkedFragments: async () => [] },
      index           : { getSeenIds: async () => new Set() },
      suggestionEngine: { suggest: async () => null }
    });
  }

  const existing = [
    frag({ id: "kw-1", keywords: ["배포"], importance: 0.6, created_at: new Date(Date.parse(NOW) - 2 * DAY).toISOString(), _rrfScore: 0.03 }),
    frag({ id: "kw-2", keywords: ["배포"], importance: 0.4, created_at: NOW, _rrfScore: 0.02 }),
    frag({ id: "kw-3", keywords: ["기타"], importance: 0.9, created_at: new Date(Date.parse(NOW) - 30 * DAY).toISOString(), _rrfScore: 0.01 })
  ];
  const added = [
    frag({ id: "lex-1", keywords: [], importance: 0.7, _lexicalScore: 1, _rrfScore: 0.016 }),
    frag({ id: "lex-2", keywords: [], importance: 0.2, _lexicalScore: 0.3, _rrfScore: 0.015 })
  ];

  for (const mode of ["on", "off"]) {
    it(`${mode}: 어휘 후보가 더해져도 기존 후보의 상대 순서와 점수는 그대로다`, async () => {
      process.env.MEMENTO_RANK_BEFORE_BUDGET = mode;
      const params  = { text: "배포 절차", keywords: ["배포"], tokenBudget: 5000, includeLinks: false, excludeSeen: false };
      const without = (await recallerWith(existing).recall({ ...params })).fragments.map(f => f.id);
      const withLex = (await recallerWith([...existing, ...added]).recall({ ...params })).fragments.map(f => f.id);
      assert.deepEqual(withLex.filter(id => !id.startsWith("lex-")), without);
      assert.ok(withLex.includes("lex-1"));
    });
  }

  /** 질의 낱말을 본문에 모두 담은 중요도 높은 어휘 단독 후보. 최종 점수만 보면 키워드 일치 항목보다 앞선다. */
  const strongLexical = (id) => frag({
    id, content: "배포 절차 배포 절차 점검", keywords: [], importance: 1, _lexicalScore: 1, _rrfScore: 0.02, _lexicalOnly: true
  });
  const keywordHits = Array.from({ length: 6 }, (_, i) => frag({
    id: `kw-${i}`, keywords: ["배포"], importance: 0.3, created_at: new Date(Date.parse(NOW) - (i + 1) * DAY).toISOString(), _rrfScore: 0.01
  }));

  for (const mode of ["on", "off"]) {
    it(`${mode}: 어휘 단독 후보는 키워드 일치 항목을 상위 5개에서 밀어내지 않는다`, async () => {
      process.env.MEMENTO_RANK_BEFORE_BUDGET = mode;
      const params  = { text: "배포 절차", keywords: ["배포"], tokenBudget: 5000, includeLinks: false, excludeSeen: false };
      const off     = (await recallerWith(keywordHits).recall({ ...params })).fragments.map(f => f.id).slice(0, 5);
      const on      = (await recallerWith([...keywordHits, strongLexical("lex-a"), strongLexical("lex-b")]).recall({ ...params }))
        .fragments.map(f => f.id);
      assert.deepEqual(on.slice(0, 5), off);
      assert.deepEqual(on.slice(-2).sort(), ["lex-a", "lex-b"]);
    });

    it(`${mode}: 다른 채널 후보가 5개보다 적으면 어휘 단독 후보가 남은 자리를 채운다`, async () => {
      process.env.MEMENTO_RANK_BEFORE_BUDGET = mode;
      const params = { text: "배포 절차", keywords: ["배포"], tokenBudget: 5000, includeLinks: false, excludeSeen: false };
      const on     = (await recallerWith([...keywordHits.slice(0, 2), strongLexical("lex-a"), strongLexical("lex-b")]).recall({ ...params }))
        .fragments.map(f => f.id);
      assert.deepEqual(on.slice(0, 2).sort(), ["kw-0", "kw-1"]);
      assert.deepEqual(on.slice(2).sort(), ["lex-a", "lex-b"]);
      assert.ok(on.every(id => typeof id === "string"));
    });
  }

  it("RRF 병합은 어휘 계층에만 있는 후보에만 표지를 달고 다른 계층과 함께 찾은 후보에는 달지 않는다", () => {
    const merged = [frag({ id: "both" }), frag({ id: "lex-only" }), frag({ id: "kw-only" })];
    markLexicalOnly(merged, [frag({ id: "both" }), frag({ id: "lex-only" })], [["kw-only"], [frag({ id: "both" })]]);
    assert.deepEqual(merged.map(f => f._lexicalOnly === true), [false, true, false]);
  });

  it("어휘 단독 계층은 다른 후보끼리와 어휘 단독 후보끼리의 순서를 바꾸지 않는다", () => {
    const rank = lexicalOnlyLast(f => f.score);
    const list = [
      { id: "a", score: 3 }, { id: "x", score: 9, _lexicalOnly: true }, { id: "b", score: 1 }, { id: "y", score: 5, _lexicalOnly: true }
    ];
    assert.deepEqual([...list].sort((p, q) => rank(q) - rank(p)).map(f => f.id), ["a", "b", "x", "y"]);
    assert.ok(LEXICAL_ONLY_TIER > 1000);
  });

  it("recall은 검색 질의에 어휘 채널 플래그를 켠다", async () => {
    const seen = [];
    await recallerWith(existing, seen).recall({ text: "배포", tokenBudget: 5000, includeLinks: false, excludeSeen: false });
    assert.equal(seen[0].lexicalChannel, true);
  });
});

describe("저장 경로의 충돌 탐지(임베딩 켜짐)", () => {
  it("detectConflicts는 본문을 질의로 검색하지만 어휘 검색을 부르지 않는다", async () => {
    const calls  = [];
    const search = makeSearch({ lexicalRows: [frag({ id: "lex" })], lexicalCalls: calls });
    if (!search.store.searchByLexical) search.store.searchByLexical = async () => { calls.push(1); return []; };
    const resolver = new ConflictResolver({}, search);
    await resolver.detectConflicts("운영 서버 재시작 절차는 색인 점검 뒤에 진행한다 ".repeat(20), "ops", "new-id", "default", "k1", null);
    assert.equal(calls.length, 0);
  });
});
