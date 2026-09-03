/**
 * recall agent/workspace 격리 우회 통합 회귀 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-07-25
 *
 * Hot Cache, L2.5 Graph, 기본 includeLinks 병합이 SQL 및 최종 결과에서
 * 동일한 agent/workspace 스코프를 적용하는지 검증한다.
 */

import { beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";

function createRedisMock() {
  const sets    = new Map();
  const sorted  = new Map();
  const strings = new Map();

  const redis = {
    status: "ready",

    async sadd(key, ...members) {
      if (!sets.has(key)) sets.set(key, new Set());
      for (const member of members) sets.get(key).add(member);
      return members.length;
    },

    async smembers(key) {
      return [...(sets.get(key) ?? [])];
    },

    async sinter(...keys) {
      if (keys.length === 0) return [];
      const intersection = new Set(sets.get(keys[0]) ?? []);
      for (const key of keys.slice(1)) {
        const values = sets.get(key) ?? new Set();
        for (const value of [...intersection]) {
          if (!values.has(value)) intersection.delete(value);
        }
      }
      return [...intersection];
    },

    async sunion(...keys) {
      const union = new Set();
      for (const key of keys) {
        for (const value of (sets.get(key) ?? [])) union.add(value);
      }
      return [...union];
    },

    async zadd(key, score, member) {
      if (!sorted.has(key)) sorted.set(key, new Map());
      sorted.get(key).set(member, score);
      return 1;
    },

    async zrevrange(key, start, stop) {
      const entries = [...(sorted.get(key) ?? new Map()).entries()]
        .sort((a, b) => b[1] - a[1]);
      const end = stop < 0 ? entries.length : stop + 1;
      return entries.slice(start, end).map(([member]) => member);
    },

    async setex(key, _ttl, value) {
      strings.set(key, value);
      return "OK";
    },

    async get(key) {
      return strings.get(key) ?? null;
    },

    pipeline() {
      const operations = [];
      const pipeline = {
        sadd(key, ...members) {
          operations.push(() => redis.sadd(key, ...members));
          return pipeline;
        },
        zadd(key, score, member) {
          operations.push(() => redis.zadd(key, score, member));
          return pipeline;
        },
        expire() {
          operations.push(() => Promise.resolve(1));
          return pipeline;
        },
        async exec() {
          for (const operation of operations) await operation();
          return [];
        }
      };
      return pipeline;
    }
  };

  return redis;
}

const redisRef = { current: createRedisMock() };
const redisProxy = new Proxy(redisRef, {
  get(ref, prop) {
    const value = ref.current[prop];
    return typeof value === "function" ? value.bind(ref.current) : value;
  }
});

let vectorQueries = [];
let graphQueries  = [];
let graphRows     = [];
let linkedRows    = [];

mock.module("../../lib/redis.js", {
  namedExports: { redisClient: redisProxy }
});

mock.module("../../lib/logger.js", {
  namedExports: {
    logDebug: mock.fn(),
    logInfo : mock.fn(),
    logWarn : mock.fn(),
    logError: mock.fn()
  }
});

mock.module("../../lib/tools/db.js", {
  namedExports: {
    queryWithAgentVector: async (agentId, sql, params) => {
      vectorQueries.push({ agentId, sql, params });
      return { rows: linkedRows.map(row => ({ ...row })) };
    },
    getPrimaryPool: () => ({
      query: async (sql, params) => {
        graphQueries.push({ sql, params });
        return { rows: graphRows.map(row => ({ ...row })) };
      }
    }),
    getBatchPool   : () => null,
    shutdownPool   : async () => {},
    getPoolStats   : () => ({}),
    withTransaction: async (_pool, fn) => fn({ query: async () => ({ rows: [] }) })
  }
});

mock.module("../../lib/tools/embedding.js", {
  namedExports: {
    EMBEDDING_ENABLED      : false,
    computeContentHash     : () => "hash",
    cosineSimilarity       : () => 0,
    generateBatchEmbeddings: async () => [],
    generateEmbedding      : async () => [],
    prepareTextForEmbedding: text => String(text ?? ""),
    vectorToSql            : vector => `[${vector.join(",")}]`
  }
});

mock.module("../../lib/memory/write/FragmentFactory.js", {
  namedExports: {
    FragmentFactory: class {
      extractKeywords() { return []; }
    },
    countTokens: text => Math.max(1, Math.ceil(String(text ?? "").length / 4))
  }
});

mock.module("../../lib/memory/signals/SearchMetrics.js", {
  namedExports: {
    getSearchMetrics: async () => ({ record: async () => {} })
  }
});

mock.module("../../lib/memory/signals/SearchParamAdaptor.js", {
  namedExports: {
    getSearchParamAdaptor: () => ({ getMinSimilarity: async () => null })
  }
});

mock.module("../../lib/memory/read/SearchSideEffects.js", {
  namedExports: {
    commitSearchSideEffects: async () => null
  }
});

mock.module("../../lib/memory/read/Reranker.js", {
  namedExports: {
    isRerankerAvailable: () => false,
    rerank             : async () => null
  }
});

const { FragmentIndex }       = await import("../../lib/memory/FragmentIndex.js");
const { FragmentReader }      = await import("../../lib/memory/read/FragmentReader.js");
const { FragmentSearch }      = await import("../../lib/memory/read/FragmentSearch.js");
const { SearchScope }         = await import("../../lib/memory/read/SearchScope.js");
const { fetchGraphNeighbors } = await import("../../lib/memory/read/GraphNeighborSearch.js");
const { LinkStore }           = await import("../../lib/memory/link/LinkStore.js");
const { MemoryRecaller }      = await import("../../lib/memory/processors/MemoryRecaller.js");

const NOW = new Date().toISOString();

function fragment(overrides) {
  return {
    id         : "fragment",
    content    : "scope isolation content",
    topic      : "scope-isolation",
    keywords   : ["scope-isolation"],
    type       : "fact",
    importance : 0.9,
    created_at : NOW,
    valid_to   : null,
    is_anchor  : false,
    agent_id   : "agent-a",
    workspace  : "ws-a",
    ...overrides
  };
}

function idsOf(result) {
  return new Set(result.fragments.map(item => item.id));
}

async function runHotCacheSearch(includePeerAgents) {
  const index = new FragmentIndex();
  const rows = [
    fragment({ id: "own" }),
    fragment({ id: "peer", agent_id: "agent-b" }),
    fragment({ id: "global", agent_id: "default", workspace: null }),
    fragment({ id: "cross-workspace", workspace: "ws-b" })
  ];

  for (const row of rows) {
    await index.index(row, null, null);
    await index.cacheFragment(row.id, row, null);
  }

  const search = Object.create(FragmentSearch.prototype);
  search.index = index;
  search.store = {
    searchByKeywords: async () => [],
    searchByTopic   : async () => [],
    getByIds        : async () => [],
    incrementAccess : () => {},
    touchLinked     : async () => {}
  };

  const query = {
    keywords   : ["scope-isolation"],
    workspace  : "ws-a",
    agentId    : "agent-a",
    tokenBudget: 5000
  };
  if (includePeerAgents !== undefined) {
    query.includePeerAgents = includePeerAgents;
  }

  return search.search(query);
}

async function runAnchorCacheSearch({ warm, isAnchor }) {
  const index = new FragmentIndex();
  const rows = [
    fragment({ id: "anchor-result", is_anchor: true }),
    fragment({ id: "non-anchor-result", is_anchor: false })
  ];

  for (const row of rows) {
    await index.index(row, null, null);
    if (warm) await index.cacheFragment(row.id, row, null);
  }

  const search = Object.create(FragmentSearch.prototype);
  search.index = index;
  search.store = {
    searchByKeywords: async () => [],
    searchByTopic   : async () => [],
    searchByTimeRange: async (_from, _to, options) => rows
      .filter(row => options.isAnchor === undefined || row.is_anchor === options.isAnchor)
      .map(row => ({ ...row })),
    getByIds        : async ids => rows.filter(row => ids.includes(row.id)).map(row => ({ ...row })),
    incrementAccess : () => {},
    touchLinked     : async () => {}
  };

  const query = {
    workspace  : "ws-a",
    agentId    : "agent-a",
    tokenBudget: 5000
  };
  if (isAnchor !== undefined) {
    query.isAnchor = isAnchor;
  } else {
    query.keywords = ["scope-isolation"];
  }
  return search.search(query);
}

beforeEach(() => {
  redisRef.current = createRedisMock();
  vectorQueries = [];
  graphQueries  = [];
  graphRows     = [];
  linkedRows    = [];
});

describe("Hot Cache 최종 결과 agent/workspace 격리", () => {
  it("includePeerAgents 생략 시 peer와 다른 workspace를 차단하고 default 전역은 허용한다", async () => {
    const result = await runHotCacheSearch(undefined);
    assert.deepEqual(idsOf(result), new Set(["own", "global"]));
  });

  it("includePeerAgents=false 시 peer와 다른 workspace를 차단한다", async () => {
    const result = await runHotCacheSearch(false);
    assert.deepEqual(idsOf(result), new Set(["own", "global"]));
  });

  it("includePeerAgents=true 시 같은 workspace peer는 허용하되 다른 workspace는 차단한다", async () => {
    const result = await runHotCacheSearch(true);
    assert.deepEqual(idsOf(result), new Set(["own", "peer", "global"]));
  });
});

describe("Redis cold/warm isAnchor 3상태 정합", () => {
  for (const warm of [false, true]) {
    const state = warm ? "warm" : "cold";

    it(`${state}: true는 앵커만 반환한다`, async () => {
      const result = await runAnchorCacheSearch({ warm, isAnchor: true });
      assert.deepEqual(idsOf(result), new Set(["anchor-result"]));
    });

    it(`${state}: false는 비앵커만 반환한다`, async () => {
      const result = await runAnchorCacheSearch({ warm, isAnchor: false });
      assert.deepEqual(idsOf(result), new Set(["non-anchor-result"]));
    });

    it(`${state}: 미지정은 둘 다 반환한다`, async () => {
      const result = await runAnchorCacheSearch({ warm, isAnchor: undefined });
      assert.deepEqual(idsOf(result), new Set(["anchor-result", "non-anchor-result"]));
    });
  }
});

describe("Semantic 실제 결과 isAnchor 3상태 정합", () => {
  async function runSemantic(isAnchor) {
    const candidates = [
      fragment({ id: "semantic-anchor", is_anchor: true }),
      fragment({ id: "semantic-non-anchor", is_anchor: false })
    ];
    const search = Object.create(FragmentSearch.prototype);
    search.embeddingCache = {
      get: async () => [0.1, 0.2],
      set: () => {}
    };
    search._morphemeIndex = { textToMorphemeVector: async () => null };
    search.store = {
      searchBySemantic: async () => candidates.map(row => ({ ...row, similarity: 0.9 }))
    };
    const query = {
      text             : "synthetic semantic query",
      agentId          : "agent-a",
      workspace        : "ws-a",
      includePeerAgents: false,
      _skipMorpheme    : true
    };
    if (isAnchor !== undefined) query.isAnchor = isAnchor;
    return search._searchL3(
      query,
      "agent-a",
      null,
      null,
      SearchScope.fromQuery(query)
    );
  }

  it("true는 앵커만 반환한다", async () => {
    const results = await runSemantic(true);
    assert.deepEqual(new Set(results.map(row => row.id)), new Set(["semantic-anchor"]));
  });

  it("false는 비앵커만 반환한다", async () => {
    const results = await runSemantic(false);
    assert.deepEqual(new Set(results.map(row => row.id)), new Set(["semantic-non-anchor"]));
  });

  it("미지정은 앵커와 비앵커를 모두 반환한다", async () => {
    const results = await runSemantic(undefined);
    assert.deepEqual(
      new Set(results.map(row => row.id)),
      new Set(["semantic-anchor", "semantic-non-anchor"])
    );
  });
});

describe("FragmentReader 검색 SELECT agent_id 가시성", () => {
  it("SEARCH_COLS_BASE 경로가 Hot Cache에 저장할 agent_id를 반환한다", async () => {
    const reader = new FragmentReader();
    await reader.searchByKeywords(["scope-isolation"], { agentId: "agent-a" });

    const { sql } = vectorQueries.at(-1);
    const selectList = sql.slice(0, sql.indexOf("FROM agent_memory.fragments"));
    assert.match(selectList, /\bf\.agent_id\b/);
  });
});

describe("GraphNeighborSearch SQL 및 최종 RRF 격리", () => {
  it("workspace 미지정은 global-only, allWorkspaces만 필터 없음", async () => {
    await fetchGraphNeighbors(["seed-a"], 10, "agent-a", null, {});
    assert.match(graphQueries.at(-1).sql, /f\.workspace IS NULL/);

    await fetchGraphNeighbors(
      ["seed-a"], 10, "agent-a", null, { allWorkspaces: true }
    );
    assert.doesNotMatch(graphQueries.at(-1).sql, /f\.workspace (?:=|IS NULL)/);
  });
  it("기본 SQL이 key_id에 더해 agent/workspace 조건과 결과 필드를 포함한다", async () => {
    await fetchGraphNeighbors(
      ["seed"],
      10,
      "agent-a",
      ["key-1"],
      { workspace: "ws-a", includePeerAgents: false }
    );

    const { sql, params } = graphQueries.at(-1);
    assert.ok((sql.match(/f\.agent_id/g) ?? []).length >= 4);
    assert.ok((sql.match(/f\.workspace/g) ?? []).length >= 4);
    assert.ok((sql.match(/\(f\.agent_id = \$5 OR f\.agent_id = 'default'\)/g) ?? []).length >= 2);
    assert.ok((sql.match(/\(f\.workspace = \$6 OR f\.workspace IS NULL\)/g) ?? []).length >= 2);
    assert.deepEqual(params, [["seed"], ["seed"], 10, ["key-1"], "agent-a", "ws-a"]);
  });

  it("includePeerAgents=true는 agent 조건만 생략하고 key_id/workspace 조건은 유지한다", async () => {
    await fetchGraphNeighbors(
      ["seed"],
      10,
      "agent-a",
      ["key-1"],
      { workspace: "ws-a", includePeerAgents: true }
    );

    const { sql, params } = graphQueries.at(-1);
    assert.doesNotMatch(sql, /f\.agent_id = \$/);
    assert.match(sql, /f\.key_id = ANY\(\$4::text\[\]\)/);
    assert.match(sql, /\(f\.workspace = \$5 OR f\.workspace IS NULL\)/);
    assert.deepEqual(params, [["seed"], ["seed"], 10, ["key-1"], "ws-a"]);
  });

  it("SQL mock이 범위 밖 행을 반환해도 RRF 병합 전에 scope가 다시 차단한다", async () => {
    graphRows = [
      fragment({ id: "graph-own" }),
      fragment({ id: "graph-peer", agent_id: "agent-b" }),
      fragment({ id: "graph-global", agent_id: "default", workspace: null }),
      fragment({ id: "graph-cross-workspace", workspace: "ws-b" })
    ];

    const search = Object.create(FragmentSearch.prototype);
    search._searchL2 = async () => [fragment({ id: "seed" })];
    search._searchL3 = async () => [];

    const sq = {
      text             : "scope isolation",
      agentId          : "agent-a",
      keyId            : ["key-1"],
      workspace        : "ws-a",
      includePeerAgents: false,
      minImportance    : 0
    };
    const combined = await search._buildTextRRF(
      sq, [], [], false, [], "agent-a", ["key-1"], null, [], {}
    );
    const ids = new Set(combined.map(row => row.id));

    assert.ok(ids.has("graph-own"));
    assert.ok(ids.has("graph-global"));
    assert.ok(!ids.has("graph-peer"));
    assert.ok(!ids.has("graph-cross-workspace"));
  });

  it("isAnchor=false가 graph SQL과 최종 scope에 모두 적용된다", async () => {
    graphRows = [
      fragment({ id: "graph-non-anchor", is_anchor: false }),
      fragment({ id: "graph-anchor", is_anchor: true })
    ];

    const search = Object.create(FragmentSearch.prototype);
    search._searchL2 = async () => [fragment({ id: "seed" })];
    search._searchL3 = async () => [];
    const sq = {
      text             : "scope isolation",
      agentId          : "agent-a",
      keyId            : ["key-1"],
      workspace        : "ws-a",
      includePeerAgents: false,
      isAnchor         : false,
      minImportance    : 0
    };

    const combined = await search._buildTextRRF(
      sq, [], [], false, [], "agent-a", ["key-1"], null, [], {}
    );
    const ids = new Set(combined.map(row => row.id));
    const { sql, params } = graphQueries.at(-1);

    assert.match(sql, /f\.is_anchor = \$/);
    assert.ok(params.includes(false));
    assert.ok(ids.has("graph-non-anchor"));
    assert.ok(!ids.has("graph-anchor"));
  });
});

describe("LinkStore SQL agent/workspace 격리", () => {
  it("workspace 미지정은 global-only, allWorkspaces만 필터 없음", () => {
    const store = new LinkStore();
    const globalSql = store._buildLinkedFragmentsSql({
      fromIds: ["seed-a"], safeRelationType: null, keyId: null
    }).sql;
    assert.match(globalSql, /f\.workspace IS NULL/);

    const allSql = store._buildLinkedFragmentsSql({
      fromIds: ["seed-a"], safeRelationType: null, keyId: null,
      allWorkspaces: true
    }).sql;
    assert.doesNotMatch(allSql, /f\.workspace (?:=|IS NULL)/);
  });
  it("기본 SQL이 key_id에 더해 agent/workspace 조건과 결과 필드를 포함한다", async () => {
    const store = new LinkStore();
    await store.getLinkedFragments(
      ["seed"],
      null,
      "agent-a",
      ["key-1"],
      { workspace: "ws-a", includePeerAgents: false }
    );

    const { sql, params } = vectorQueries.at(-1);
    assert.ok((sql.match(/f\.agent_id/g) ?? []).length >= 4);
    assert.ok((sql.match(/f\.workspace/g) ?? []).length >= 4);
    assert.ok((sql.match(/\(f\.agent_id = \$3 OR f\.agent_id = 'default'\)/g) ?? []).length >= 2);
    assert.ok((sql.match(/\(f\.workspace = \$4 OR f\.workspace IS NULL\)/g) ?? []).length >= 2);
    assert.deepEqual(params, [["seed"], ["key-1"], "agent-a", "ws-a"]);
  });

  it("includePeerAgents=true는 agent 조건만 생략하고 key_id/workspace 조건은 유지한다", async () => {
    const store = new LinkStore();
    await store.getLinkedFragments(
      ["seed"],
      null,
      "agent-a",
      ["key-1"],
      { workspace: "ws-a", includePeerAgents: true }
    );

    const { sql, params } = vectorQueries.at(-1);
    assert.doesNotMatch(sql, /f\.agent_id = \$/);
    assert.match(sql, /f\.key_id = ANY\(\$2(::text\[\])?\)/);
    assert.match(sql, /\(f\.workspace = \$3 OR f\.workspace IS NULL\)/);
    assert.deepEqual(params, [["seed"], ["key-1"], "ws-a"]);
  });

  it("isAnchor=false를 양방향 UNION SQL에 동일하게 적용한다", async () => {
    const store = new LinkStore();
    await store.getLinkedFragments(
      ["seed"],
      null,
      "agent-a",
      ["key-1"],
      { workspace: "ws-a", includePeerAgents: false, isAnchor: false }
    );

    const { sql, params } = vectorQueries.at(-1);
    assert.equal((sql.match(/f\.is_anchor = \$/g) || []).length, 2);
    assert.equal((sql.match(/f\.valid_to IS NULL/g) || []).length, 2);
    assert.ok(params.includes(false));
  });
});

function createRecaller(linkedFragments, capturedCalls) {
  const base = fragment({ id: "base" });
  const search = {
    search: async () => ({
      fragments : [{ ...base }],
      totalTokens: 10,
      searchPath: "L2",
      count     : 1
    })
  };
  const store = {
    getLinkedFragments: async (...args) => {
      capturedCalls.push(args);
      return linkedFragments.map(row => ({ ...row }));
    }
  };

  return new MemoryRecaller({ store, search });
}

describe("MemoryRecaller 기본 includeLinks 최종 병합 격리", () => {
  const linkCandidates = [
    fragment({ id: "linked-own" }),
    fragment({ id: "linked-peer", agent_id: "agent-b" }),
    fragment({ id: "linked-global", agent_id: "default", workspace: null }),
    fragment({ id: "linked-cross-workspace", workspace: "ws-b" })
  ];

  it("기본값은 peer/다른 workspace를 차단하고 opts를 저장소에 전달한다", async () => {
    const calls    = [];
    const recaller = createRecaller(linkCandidates, calls);
    const result   = await recaller.recall({
      agentId  : "agent-a",
      workspace: "ws-a",
      keywords : ["scope-isolation"]
    });

    assert.deepEqual(idsOf(result), new Set(["base", "linked-own", "linked-global"]));
    assert.deepEqual(calls[0][4], {
      workspace         : "ws-a",
      allWorkspaces     : false,
      includePeerAgents : false
    });
  });

  it("includePeerAgents=true는 같은 workspace peer만 허용하고 전역 파편도 유지한다", async () => {
    const calls    = [];
    const recaller = createRecaller(linkCandidates, calls);
    const result   = await recaller.recall({
      agentId          : "agent-a",
      workspace        : "ws-a",
      keywords         : ["scope-isolation"],
      includePeerAgents: true
    });

    assert.deepEqual(
      idsOf(result),
      new Set(["base", "linked-own", "linked-peer", "linked-global"])
    );
    assert.deepEqual(calls[0][4], {
      workspace         : "ws-a",
      allWorkspaces     : false,
      includePeerAgents : true
    });
  });

  it("isAnchor=false 검색에 연결된 앵커가 다시 유입되지 않는다", async () => {
    const calls    = [];
    const candidates = [
      fragment({ id: "linked-non-anchor", is_anchor: false }),
      fragment({ id: "linked-anchor", is_anchor: true })
    ];
    const recaller = createRecaller(candidates, calls);
    const result   = await recaller.recall({
      agentId : "agent-a",
      workspace: "ws-a",
      keywords: ["scope-isolation"],
      isAnchor: false
    });

    assert.deepEqual(idsOf(result), new Set(["base", "linked-non-anchor"]));
    assert.deepEqual(calls[0][4], {
      workspace        : "ws-a",
      includePeerAgents: false,
      isAnchor          : false
    });
  });
});
