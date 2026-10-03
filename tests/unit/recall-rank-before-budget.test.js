/**
 * recall 순위 후 예산 선택: 실제 FragmentSearch와 MemoryRecaller, 검색 계층과 DB는 대역
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 1. 검색 순서는 낮고 최종 점수는 높은 후보가 예산 안에 남는다.
 * 2. 차등 시험: 시드 생성기로 만든 후보 집합에서 전체 토큰이 예산 이하이면
 *    MEMENTO_RANK_BEFORE_BUDGET=on과 off의 recall 결과(파편, 순서, 필드, 응답 필드)와 접근 기록이 같다.
 * 3. 성질 시험: 예산이 묶이면 on이 고른 파편의 최종 점수 합은 off(검색 순서 절단)의 합 이상이고
 *    토큰 합은 예산 이하다.
 * 4. 후보는 RANK_CANDIDATE_LIMIT건까지이고, superseded 후보는 예산을 쓰지 않는다.
 */

import { describe, it, afterEach, mock } from "node:test";
import assert                            from "node:assert/strict";

const sideEffectCalls = [];

mock.module("../../lib/redis.js", {
  namedExports: { redisClient: { status: "stub" } }
});
mock.module("../../lib/logger.js", {
  namedExports: { logDebug: mock.fn(), logInfo: mock.fn(), logWarn: mock.fn(), logError: mock.fn() }
});
mock.module("../../lib/memory/signals/SearchMetrics.js", {
  namedExports: { getSearchMetrics: async () => ({ record: async () => {} }) }
});
mock.module("../../lib/memory/signals/SearchParamAdaptor.js", {
  namedExports: { getSearchParamAdaptor: () => ({ getMinSimilarity: async () => null }) }
});
mock.module("../../lib/memory/read/SearchSideEffects.js", {
  namedExports: {
    commitSearchSideEffects: async (_query, _sq, clean, ctx) => {
      sideEffectCalls.push({ ids: clean.map(f => f.id), ctx });
      return "event-1";
    }
  }
});
mock.module("../../lib/memory/read/Reranker.js", {
  namedExports: { isRerankerAvailable: () => false, rerank: async () => null }
});

const { FragmentSearch }                     = await import("../../lib/memory/read/FragmentSearch.js");
const { MemoryRecaller, buildRecallScorer }  = await import("../../lib/memory/processors/MemoryRecaller.js");
const { RANK_CANDIDATE_LIMIT, fragmentTokens } = await import("../../lib/memory/read/BudgetSelector.js");
const { createRng }                          = await import("../../lib/memory/signals/PairedBootstrap.js");

const ANCHOR = Date.parse("2026-10-01T00:00:00.000Z");
const DAY    = 86400000;
const VOCAB  = ["budget", "recall", "token", "rank", "linked", "cache", "index", "query", "score", "memo"];

afterEach(() => {
  delete process.env.MEMENTO_RANK_BEFORE_BUDGET;
  sideEffectCalls.length = 0;
});

/**
 * 검색 계층과 저장소를 대역으로 둔 recall 실행기. 호출마다 후보와 연결 파편을 새로 만든다.
 *
 * @param {{makeCombined: () => Object[], links?: Map<string, Object[]>}} scenario
 * @returns {{recaller: MemoryRecaller, access: string[][], linkSeeds: string[][], calls: {candidates: number, search: number}}}
 */
function buildRecaller({ makeCombined, links = new Map() }) {
  const access    = [];
  const linkSeeds = [];
  const calls  = { candidates: 0, search: 0 };
  const search = new FragmentSearch();
  search._executeSearch = async () => ({
    combined    : makeCombined(),
    searchPath  : ["L2:1", "RRF"],
    l1IsFallback: false,
    layerLatency: { l1Ms: 0, l2Ms: 0, l3Ms: 0, graphUsed: false }
  });
  search.store = {
    incrementAccess: (ids) => { access.push([...ids]); },
    touchLinked    : async () => {}
  };
  search._cacheFragments = async () => {};
  const realCandidates = search.searchCandidates.bind(search);
  const realSearch     = search.search.bind(search);
  search.searchCandidates = (q) => { calls.candidates++; return realCandidates(q); };
  search.search           = (q) => { calls.search++; return realSearch(q); };

  /** fragment_links 조회 대역: from_id 집합의 연결 대상을 id 중복 없이 id 순으로 10건까지 */
  const store = {
    getLinkedFragments: async (fromIds) => {
      linkSeeds.push([...fromIds].sort());
      const byId = new Map();
      for (const id of fromIds) {
        for (const target of links.get(id) ?? []) if (!byId.has(target.id)) byId.set(target.id, { ...target });
      }
      return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, 10);
    }
  };

  const recaller = new MemoryRecaller({
    search,
    store,
    index           : { getSeenIds: async () => new Set() },
    suggestionEngine: { suggest: async () => null }
  });
  return { recaller, access, linkSeeds, calls };
}

/**
 * 시드 생성기로 후보 집합 하나를 만든다. 리랭커 집합, 태그 집합(keywords 경로), 일반 집합을 섞는다.
 *
 * @param {number} seed
 * @returns {{makeCombined: () => Object[], links: Map<string, Object[]>, params: Object, totalTokens: number, rowTokens: number}}
 */
function randomScenario(seed) {
  const rng   = createRng(seed);
  const pick  = (arr) => arr[Math.floor(rng() * arr.length)];
  const n     = 1 + Math.floor(rng() * 40);
  const mode  = pick(["plain", "reranker", "tagged"]);
  const ids   = Array.from({ length: n }, (_, i) => `f${String((i * 7919 + seed) % 1000).padStart(3, "0")}-${i}`);

  const makeFragment = (id) => {
    const words = [pick(VOCAB), pick(VOCAB), pick(VOCAB)];
    const base  = {
      id,
      content   : `${words.join(" ")} ${id}`,
      topic     : pick(["alpha", "beta", "memento-budget"]),
      keywords  : [...new Set(words)],
      type      : pick(["fact", "decision", "procedure"]),
      importance: Math.round(rng() * 100) / 100,
      created_at: new Date(ANCHOR - Math.floor(rng() * 400) * DAY).toISOString(),
      agent_id  : "default",
      workspace : null
    };
    if (rng() < 0.7) base.estimated_tokens = 1 + Math.floor(rng() * 120);
    return base;
  };

  const rows = ids.map(id => {
    const fragment = makeFragment(id);
    if (rng() < 0.6) fragment.similarity = 0.4 + Math.round(rng() * 55) / 100;
    fragment._rrfScore = Math.round(rng() * 1000) / 1000;
    if (mode === "reranker") fragment.rerankerScore = Math.round(rng() * 1000) / 1000;
    if (mode === "tagged") {
      const roll = rng();
      if (roll < 0.3) fragment._kwExact = true;
      else if (roll < 0.5) fragment._kwSupplement = true;
    }
    return fragment;
  });

  const external = Array.from({ length: Math.floor(rng() * 6) }, (_, i) => makeFragment(`x${seed}-${i}`));
  const links    = new Map();
  for (const id of ids) {
    if (rng() < 0.3) {
      const targets = [pick(rows), ...(external.length > 0 ? [pick(external)] : [])]
        .filter(t => t.id !== id)
        .map(({ similarity: _similarity, _rrfScore, rerankerScore: _rerankerScore, _kwExact, _kwSupplement, ...rest }) => rest);
      links.set(id, targets);
    }
  }

  const totalTokens = [...rows, ...external].reduce((sum, f) => sum + fragmentTokens(f), 0);
  const rowTokens   = rows.reduce((sum, f) => sum + fragmentTokens(f), 0);
  const params = {
    includeLinks: rng() < 0.6,
    excludeSeen : false,
    pageSize    : 50,
    anchorTime  : ANCHOR,
    ...(rng() < 0.7 ? { keywords: [pick(VOCAB), pick(VOCAB)] } : {})
  };
  return { makeCombined: () => rows.map(r => ({ ...r, keywords: [...r.keywords] })), links, params, totalTokens, rowTokens };
}

/**
 * 같은 시나리오를 스위치 값 하나로 실행한다.
 *
 * @param {Object} scenario
 * @param {"on"|"off"} mode
 * @param {Object} params
 * @returns {Promise<{result: Object, access: string[][], linkSeeds: string[][], sideEffects: Object[], calls: Object}>}
 */
async function runWith(scenario, mode, params) {
  process.env.MEMENTO_RANK_BEFORE_BUDGET = mode;
  sideEffectCalls.length = 0;
  const { recaller, access, linkSeeds, calls } = buildRecaller(scenario);
  const result = await recaller.recall({ ...params });
  return { result, access, linkSeeds, sideEffects: sideEffectCalls.splice(0), calls };
}

const scoreSum  = (fragments, scoreOf) => fragments.reduce((sum, f) => sum + scoreOf(f), 0);
const tokenSum  = (fragments) => fragments.reduce((sum, f) => sum + fragmentTokens(f), 0);

describe("recall 순위 후 예산 선택", () => {
  it("검색 순서는 낮고 최종 점수는 높은 후보가 예산 안에 남는다", async () => {
    const now      = new Date(ANCHOR).toISOString();
    const scenario = {
      makeCombined: () => [
        /** 검색 순위 점수가 높고(_rrfScore) 질의와 어휘 일치가 없는 후보 */
        { id: "rrf-top", content: "unrelated text", topic: "other", keywords: ["misc"], importance: 0.5,
          created_at: now, estimated_tokens: 60, _rrfScore: 0.9, agent_id: "default", workspace: null },
        /** 검색 순위 점수는 낮고 질의 keyword가 topic에 들어 있는 후보 */
        { id: "final-top", content: "budget selection note", topic: "budget-selection", keywords: ["budget"],
          importance: 0.5, created_at: now, estimated_tokens: 60, _rrfScore: 0.01, agent_id: "default", workspace: null }
      ]
    };
    const params  = { keywords: ["budget"], tokenBudget: 100, includeLinks: false, excludeSeen: false, anchorTime: ANCHOR };
    const scoreOf = buildRecallScorer(params, ANCHOR, null);

    const off = await runWith(scenario, "off", params);
    const on  = await runWith(scenario, "on", params);

    assert.deepEqual(off.result.fragments.map(f => f.id), ["rrf-top"]);
    assert.deepEqual(on.result.fragments.map(f => f.id), ["final-top"]);
    assert.ok(scoreSum(on.result.fragments, scoreOf) > scoreSum(off.result.fragments, scoreOf));
    assert.equal(on.calls.candidates, 1);
    assert.equal(on.calls.search, 0);
    assert.equal(off.calls.search, 1);
    assert.equal(off.calls.candidates, 0);
  });

  it("검색 이벤트에 예산 선택 후보 수와 선택 수를 넘기고, off는 null을 넘긴다", async () => {
    const now      = new Date(ANCHOR).toISOString();
    const scenario = {
      makeCombined: () => ["a", "b", "c"].map(id => ({
        id, content: id, keywords: [], importance: 0.5, created_at: now, estimated_tokens: 40,
        agent_id: "default", workspace: null
      }))
    };
    const params = { tokenBudget: 100, includeLinks: false, excludeSeen: false, anchorTime: ANCHOR };

    const on  = await runWith(scenario, "on", params);
    const off = await runWith(scenario, "off", params);

    assert.equal(on.sideEffects.length, 1);
    assert.equal(on.sideEffects[0].ctx.candidateCount, 3);
    assert.equal(on.sideEffects[0].ctx.budgetKept, 2);
    assert.equal(on.sideEffects[0].ctx.rawResultCount, 2);
    assert.equal(off.sideEffects[0].ctx.candidateCount, null);
    assert.equal(off.sideEffects[0].ctx.budgetKept, null);
  });

  it("후보 전체가 예산 안이면 on과 off의 결과와 접근 기록이 같다(시드 400개)", async () => {
    let linkedCases = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const scenario = randomScenario(seed);
      const params   = { ...scenario.params, tokenBudget: scenario.totalTokens + (seed % 7) };

      const off = await runWith(scenario, "off", params);
      const on  = await runWith(scenario, "on", params);

      assert.deepStrictEqual(on.result, off.result, `seed ${seed}: recall 결과가 다르다`);
      assert.deepStrictEqual(on.access, off.access, `seed ${seed}: 접근 기록이 다르다`);
      assert.deepStrictEqual(on.sideEffects.map(c => c.ids), off.sideEffects.map(c => c.ids), `seed ${seed}: 검색 이벤트 대상이 다르다`);
      assert.equal(on.sideEffects[0].ctx.rawResultCount, off.sideEffects[0].ctx.rawResultCount);
      if (params.includeLinks && on.result.fragments.length > on.sideEffects[0].ids.length) linkedCases++;
    }
    assert.ok(linkedCases > 20, `연결 파편이 합류한 시드가 적다: ${linkedCases}`);
  });

  it("예산이 묶이면 on의 최종 점수 합은 off 이상이고 토큰 합은 예산 이하다(시드 400개)", async () => {
    let bindingCases = 0;
    let strictGains  = 0;
    for (let seed = 1001; seed <= 1400; seed++) {
      const scenario = randomScenario(seed);
      const params   = { ...scenario.params, includeLinks: false, tokenBudget: 1 + Math.floor(scenario.rowTokens * 0.4) };
      const scoreOf  = buildRecallScorer(params, ANCHOR, null);

      const off = await runWith(scenario, "off", params);
      const on  = await runWith(scenario, "on", params);

      const onScore  = scoreSum(on.result.fragments, scoreOf);
      const offScore = scoreSum(off.result.fragments, scoreOf);
      assert.ok(onScore >= offScore - 1e-9, `seed ${seed}: on ${onScore} < off ${offScore}`);
      assert.ok(tokenSum(on.result.fragments) <= params.tokenBudget, `seed ${seed}: 예산 초과`);
      assert.equal(on.result.totalTokens, tokenSum(on.result.fragments));
      if (params.tokenBudget < scenario.rowTokens) bindingCases++;
      if (onScore > offScore + 1e-9) strictGains++;
    }
    assert.ok(bindingCases > 350, `예산이 묶인 시드가 적다: ${bindingCases}`);
    assert.ok(strictGains > 0, "점수 합이 커진 시드가 하나도 없다");
  });

  it("예산이 묶여도 연결 파편의 기준은 검색 순서 절단이고, 연결 파편까지 예산 안에서 고른다(시드 200개)", async () => {
    let linkedRuns = 0;
    for (let seed = 2001; seed <= 2200; seed++) {
      const scenario = randomScenario(seed);
      const params   = { ...scenario.params, includeLinks: true, tokenBudget: 1 + Math.floor(scenario.rowTokens * 0.4) };

      const off = await runWith(scenario, "off", params);
      const on  = await runWith(scenario, "on", params);

      assert.deepStrictEqual(on.linkSeeds, off.linkSeeds, `seed ${seed}: 연결 기준이 다르다`);
      assert.ok(tokenSum(on.result.fragments) <= params.tokenBudget, `seed ${seed}: 연결 파편 포함 예산 초과`);
      if (on.linkSeeds.length > 0) linkedRuns++;
    }
    assert.ok(linkedRuns > 100, `연결 조회가 일어난 시드가 적다: ${linkedRuns}`);
  });

  it("검색 후보는 상한까지와 상한 밖의 검색 순서 절단 결과만 예산 선택에 들어간다", async () => {
    const now      = new Date(ANCHOR).toISOString();
    const scenario = {
      makeCombined: () => Array.from({ length: RANK_CANDIDATE_LIMIT + 50 }, (_, i) => ({
        id: `c${String(i).padStart(4, "0")}`, content: "x", keywords: [], importance: 0.5,
        created_at: now, estimated_tokens: 1, agent_id: "default", workspace: null
      }))
    };
    const base = { includeLinks: false, excludeSeen: false, anchorTime: ANCHOR };

    /** 예산이 묶이고 검색 순서 절단이 상한 안에서 끝나면 후보는 상한 수다 */
    const binding = await runWith(scenario, "on", { ...base, tokenBudget: 100 });
    assert.equal(binding.sideEffects[0].ctx.candidateCount, RANK_CANDIDATE_LIMIT);
    assert.equal(binding.result.totalCount, 100);

    /** 모두 예산 안이면 검색 순서 절단이 전부를 고르므로 상한 밖 후보도 들어가고 off와 같다 */
    const onAll  = await runWith(scenario, "on", { ...base, tokenBudget: 100000 });
    const offAll = await runWith(scenario, "off", { ...base, tokenBudget: 100000 });
    assert.equal(onAll.sideEffects[0].ctx.candidateCount, RANK_CANDIDATE_LIMIT + 50);
    assert.deepStrictEqual(onAll.result, offAll.result);
  });

  it("상한 밖까지 이어지는 검색 순서 절단보다 점수 합이 작지 않다(태그 후보 230건)", async () => {
    const now  = new Date(ANCHOR).toISOString();
    const rows = Array.from({ length: 230 }, (_, i) => ({
      id: `c${String(i).padStart(4, "0")}`, content: "x", keywords: ["k"], importance: 0.5,
      rerankerScore: 1 - i / 1000, _rrfScore: 1 - i / 1000, created_at: now,
      estimated_tokens: i >= 200 ? 1 : 60, agent_id: "default", workspace: null,
      ...(i === 0 ? { _kwExact: true } : {})
    }));
    const scenario = { makeCombined: () => rows.map(r => ({ ...r, keywords: [...r.keywords] })) };
    const params   = { tokenBudget: 1000, includeLinks: false, excludeSeen: false, anchorTime: ANCHOR, pageSize: 50 };
    const scoreOf  = buildRecallScorer(params, ANCHOR, null);

    const off = await runWith(scenario, "off", params);
    const on  = await runWith(scenario, "on", params);

    assert.ok(off.sideEffects[0].ids.some(id => id >= "c0200"), "off가 상한 밖 후보를 고르지 않았다");
    const sumOf = (ids) => ids.reduce((sum, id) => sum + scoreOf(rows.find(r => r.id === id)), 0);
    assert.ok(sumOf(on.sideEffects[0].ids) >= sumOf(off.sideEffects[0].ids) - 1e-9);
    assert.ok(tokenSum(on.sideEffects[0].ids.map(id => rows.find(r => r.id === id))) <= params.tokenBudget);
  });

  it("superseded 후보는 예산을 쓰지 않는다", async () => {
    const now      = new Date(ANCHOR).toISOString();
    const scenario = {
      makeCombined: () => [
        { id: "old", content: "x", keywords: [], importance: 0.9, created_at: now, estimated_tokens: 80,
          valid_to: now, _rrfScore: 0.9, agent_id: "default", workspace: null },
        { id: "cur", content: "y", keywords: [], importance: 0.5, created_at: now, estimated_tokens: 60,
          _rrfScore: 0.1, agent_id: "default", workspace: null }
      ]
    };
    const params = { tokenBudget: 100, includeLinks: false, excludeSeen: false, anchorTime: ANCHOR };

    const off = await runWith(scenario, "off", params);
    const on  = await runWith(scenario, "on", params);

    assert.deepEqual(off.result.fragments.map(f => f.id), []);
    assert.deepEqual(on.result.fragments.map(f => f.id), ["cur"]);
  });

  it("searchCandidates가 없는 검색 의존성은 검색 계층 절단 경로를 쓴다", async () => {
    process.env.MEMENTO_RANK_BEFORE_BUDGET = "on";
    let searched = 0;
    const recaller = new MemoryRecaller({
      search: {
        search: async () => {
          searched++;
          return { fragments: [{ id: "a", content: "a", created_at: new Date(ANCHOR).toISOString() }], count: 1, totalTokens: 1, searchPath: "stub" };
        }
      },
      store           : { getLinkedFragments: async () => [] },
      index           : { getSeenIds: async () => new Set() },
      suggestionEngine: { suggest: async () => null }
    });
    const result = await recaller.recall({ includeLinks: false, excludeSeen: false, anchorTime: ANCHOR });
    assert.equal(searched, 1);
    assert.deepEqual(result.fragments.map(f => f.id), ["a"]);
  });
});
