import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  byDescendingScore,
  decodeRankingCursor,
  deterministicOrderBy,
  paginateRankedFragments
} from "../../lib/memory/read/DeterministicRanking.js";
import { mergeHydratedCandidates, mergeRRF } from "../../lib/memory/read/FragmentSearch.js";
import { MemoryRecaller } from "../../lib/memory/processors/MemoryRecaller.js";
import { applyRerankerScores } from "../../lib/memory/read/Reranker.js";

const scoreOf = fragment => fragment.score;

function shuffle(values, seed) {
  const result = [...values];
  let state = seed + 1;
  for (let i = result.length - 1; i > 0; i--) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const j = state % (i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

describe("결정적 랭킹 공통 계약", () => {
  const golden = [
    { id: "d", score: 1, created_at: null },
    { id: "b", score: 1, created_at: "2026-01-01T00:00:00.000Z" },
    { id: "z", score: 2, created_at: "2020-01-01T00:00:00.000Z" },
    { id: "c", score: 1, created_at: "not-a-timestamp" },
    { id: "a", score: 1, created_at: "2026-01-01T00:00:00.000Z" },
    { id: "n", score: 1, created_at: "2026-02-01T00:00:00.000Z" }
  ];
  const expected = ["z", "n", "a", "b", "c", "d"];

  it("SQL ORDER BY와 JS comparator가 같은 golden 결과 계약을 표현한다", () => {
    assert.equal(
      deterministicOrderBy("score DESC"),
      "ORDER BY score DESC, created_at DESC NULLS LAST, id ASC"
    );
    assert.deepEqual([...golden].sort(byDescendingScore(scoreOf)).map(f => f.id), expected);
  });

  it("primary score가 다른 항목의 상대 순서는 바꾸지 않는다", () => {
    const rows = [
      { id: "new-low", score: 0.1, created_at: "2026-08-01" },
      { id: "old-high", score: 0.9, created_at: "2020-01-01" }
    ];
    assert.deepEqual(rows.sort(byDescendingScore(scoreOf)).map(f => f.id), ["old-high", "new-low"]);
  });

  it("입력을 100회 셔플해도 NULL/invalid timestamp를 포함한 결과가 같다", () => {
    for (let seed = 0; seed < 100; seed++) {
      const ids = shuffle(golden, seed).sort(byDescendingScore(scoreOf)).map(f => f.id);
      assert.deepEqual(ids, expected, `seed=${seed}`);
    }
  });
});

describe("RRF와 Redis hydration 결정성", () => {
  it("Redis Set 후보 입력 순서가 RRF primary score를 만들지 않는다", () => {
    const hydrated = [
      { id: "new", content: "new", created_at: "2026-02-01" },
      { id: "old", content: "old", created_at: "2026-01-01" }
    ];
    for (let seed = 0; seed < 100; seed++) {
      const result = mergeRRF([
        { name: "l1", results: shuffle(["new", "old"], seed), weightFactor: 2, unranked: true },
        { name: "l2", results: hydrated, weightFactor: 1 }
      ]);
      assert.deepEqual(result.map(item => item.id), ["new", "old"]);
    }
  });

  it("RRF source 도착 순서를 셔플해도 동점 결과가 created_at/id 순이다", () => {
    const layers = [
      { name: "one", results: [{ id: "b", created_at: "2026-01-01", content: "b" }] },
      { name: "two", results: [{ id: "a", created_at: "2026-01-01", content: "a" }] },
      { name: "three", results: [{ id: "c", created_at: null, content: "c" }] }
    ];
    const expected = ["a", "b", "c"];
    for (let seed = 0; seed < 100; seed++) {
      assert.deepEqual(mergeRRF(shuffle(layers, seed)).map(f => f.id), expected);
    }
  });

  it("cold DB fallback과 warm Redis hydration의 ID 순서가 같다", () => {
    const direct = { id: "direct", importance: 0.9, created_at: "2026-01-03" };
    const hydration = [
      { id: "h3", importance: 0.5, created_at: null },
      { id: "h2", importance: 0.5, created_at: "2026-01-02" },
      { id: "h1", importance: 0.5, created_at: "2026-01-02" }
    ];
    const cold = mergeHydratedCandidates(
      [direct, ...hydration.map(f => ({ ...f, _l1Hydrated: true }))],
      []
    );
    const warm = mergeHydratedCandidates([direct], shuffle(hydration, 17));
    assert.deepEqual(cold.map(f => f.id), ["direct", "h1", "h2", "h3"]);
    assert.deepEqual(warm.map(f => f.id), cold.map(f => f.id));
  });
});

describe("랭킹 튜플 cursor", () => {
  it("페이지 경계에 완전 동점 항목이 몰려도 중복·누락 없이 이어진다", () => {
    const anchorTime = Date.parse("2026-08-31T00:00:00.000Z");
    const all = Array.from({ length: 13 }, (_, i) => ({
      id        : `f${String(i).padStart(2, "0")}`,
      score     : 0.5,
      created_at: "2026-01-01T00:00:00.000Z"
    })).sort(byDescendingScore(scoreOf));

    const collected = [];
    let cursor = null;
    do {
      const page = paginateRankedFragments(all, { cursor, pageSize: 5, anchorTime, scoreOf });
      collected.push(...page.fragments.map(f => f.id));
      cursor = page.nextCursor;
      if (cursor) {
        const decoded = decodeRankingCursor(cursor);
        assert.equal(decoded.anchorTime, anchorTime);
        assert.equal(decoded.score, 0.5);
        assert.equal(decoded.created_at, Date.parse("2026-01-01T00:00:00.000Z"));
      }
    } while (cursor);

    assert.deepEqual(collected, all.map(f => f.id));
    assert.equal(new Set(collected).size, all.length);
  });

  it("cursor 항목이 사라져도 tuple 역조건으로 다음 경계를 찾는다", () => {
    const rows = ["a", "b", "c", "d"].map(id => ({
      id, score: 1, created_at: "2026-01-01"
    }));
    const first = paginateRankedFragments(rows, {
      cursor: null, pageSize: 2, anchorTime: 1, scoreOf
    });
    const withoutBoundary = rows.filter(row => row.id !== "b");
    const second = paginateRankedFragments(withoutBoundary, {
      cursor: first.nextCursor, pageSize: 2, anchorTime: 1, scoreOf
    });
    assert.deepEqual(second.fragments.map(f => f.id), ["c", "d"]);
  });

  it("MemoryRecaller가 cursor의 anchorTime을 검색과 다음 페이지에 재사용한다", async () => {
    const anchorTime = Date.parse("2026-08-31T00:00:00.000Z");
    const rows = ["d", "b", "a", "c"].map(id => ({
      id, type: "fact", content: id, rerankerScore: 0.5,
      created_at: "2026-01-01T00:00:00.000Z"
    }));
    const searchCalls = [];
    const recaller = new MemoryRecaller({
      search: {
        search: async query => {
          searchCalls.push(query);
          return { fragments: rows.map(row => ({ ...row })), count: rows.length, totalTokens: 4, searchPath: "fixture" };
        }
      },
      store: { getLinkedFragments: async () => [] },
      index: { getSeenIds: async () => new Set() },
      suggestionEngine: { suggest: async () => null }
    });

    const first = await recaller.recall({
      includeLinks: false, excludeSeen: false, pageSize: 2, anchorTime
    });
    const second = await recaller.recall({
      includeLinks: false, excludeSeen: false, pageSize: 2, cursor: first.nextCursor
    });

    assert.deepEqual(first.fragments.map(f => f.id), ["a", "b"]);
    assert.deepEqual(second.fragments.map(f => f.id), ["c", "d"]);
    assert.equal(searchCalls[0].anchorTime, anchorTime);
    assert.equal(searchCalls[1].anchorTime, anchorTime);
  });

  it("reranker recency score도 cursor anchorTime에 고정되어 두 페이지가 이어진다", async () => {
    const anchorTime = Date.parse("2026-08-31T00:00:00.000Z");
    const candidates = ["d", "b", "a", "c"].map(id => ({
      id, type: "fact", content: id, created_at: "2026-01-01T00:00:00.000Z"
    }));
    const rawScores = candidates.map(() => 0.5);
    const scoreRuns = [];
    const recaller = new MemoryRecaller({
      search: {
        search: async query => {
          const fragments = applyRerankerScores(candidates, rawScores, query.anchorTime);
          scoreRuns.push(fragments.map(fragment => fragment.rerankerScore));
          return { fragments, count: fragments.length, totalTokens: 4, searchPath: "synthetic-reranker" };
        }
      },
      store: { getLinkedFragments: async () => [] },
      index: { getSeenIds: async () => new Set() },
      suggestionEngine: { suggest: async () => null }
    });

    const first = await recaller.recall({
      includeLinks: false, excludeSeen: false, pageSize: 2, anchorTime
    });
    const second = await recaller.recall({
      includeLinks: false, excludeSeen: false, pageSize: 2, cursor: first.nextCursor
    });

    assert.deepEqual([...first.fragments, ...second.fragments].map(fragment => fragment.id), ["a", "b", "c", "d"]);
    assert.deepEqual(scoreRuns[0], scoreRuns[1]);
  });
});
