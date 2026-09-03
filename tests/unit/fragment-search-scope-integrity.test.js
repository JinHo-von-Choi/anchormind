/**
 * FragmentSearch 명시 필터 정합 회귀 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-08-12
 *
 * L1 교집합에서 0건 집합이 누락되거나, L1 유래 ID 보충 조회가 SQL 필터를
 * 우회해 명시 topic/type과 무관한 파편이 최종 결과에 유입되는 회귀를 방지한다.
 * 부분 miss 매트릭스: keyword hit + topic miss, topic hit + type miss.
 */

import { describe, it, after } from "node:test";
import assert                  from "node:assert/strict";

import { FragmentSearch, mergeRRF } from "../../lib/memory/read/FragmentSearch.js";
import { teardownTestResources }    from "../_lifecycle.js";

after(async () => {
  await teardownTestResources();
});

/** _searchL1 전용 가짜 Redis 인덱스. 네임스페이스별 결과를 고정 반환한다. */
function fakeIndex({ keywords = [], topic = [], type = [], recent = [] } = {}) {
  return {
    searchByKeywords: async () => keywords,
    searchByTopic   : async () => topic,
    searchByType    : async () => type,
    getRecent       : async () => recent,
  };
}

function searchL1(index, query) {
  return FragmentSearch.prototype._searchL1.call({ index }, query, null);
}

describe("_searchL1 명시 필터 교집합 계약", () => {

  it("keyword hit + topic miss → 공집합 (keyword 집합이 교집합 행세 금지)", async () => {
    const index  = fakeIndex({ keywords: ["a", "b", "c"], topic: [] });
    const result = await searchL1(index, { keywords: ["release"], topic: "memento-mpc" });

    assert.deepEqual(result.ids, []);
    assert.equal(result.isFallback, false);
  });

  it("topic hit + type miss → 공집합", async () => {
    const index  = fakeIndex({ topic: ["a", "b"], type: [] });
    const result = await searchL1(index, { topic: "memento-mcp", type: "error" });

    assert.deepEqual(result.ids, []);
    assert.equal(result.isFallback, false);
  });

  it("keyword miss 단독(topic/type 없음) → 공집합, getRecent 폴백 금지", async () => {
    const index  = fakeIndex({ keywords: [], recent: ["r1", "r2"] });
    const result = await searchL1(index, { keywords: ["nonexistent"] });

    assert.deepEqual(result.ids, []);
    assert.equal(result.isFallback, false);
  });

  it("text-only 쿼리 → 공집합, 폴백 금지 (기존 계약 유지)", async () => {
    const index  = fakeIndex({ recent: ["r1"] });
    const result = await searchL1(index, { text: "자연어 질의" });

    assert.deepEqual(result.ids, []);
    assert.equal(result.isFallback, false);
  });

  it("조건 전무 → getRecent 폴백 유지 (isFallback=true)", async () => {
    const index  = fakeIndex({ recent: ["r1", "r2", "r3"] });
    const result = await searchL1(index, {});

    assert.deepEqual(result.ids, ["r1", "r2", "r3"]);
    assert.equal(result.isFallback, true);
  });

  it("isAnchor 단독 조건은 recent 후보를 hydration 대상으로 유지한다", async () => {
    const index  = fakeIndex({ recent: ["anchor-candidate", "non-anchor-candidate"] });
    const result = await searchL1(index, { isAnchor: false });

    assert.deepEqual(result.ids, ["anchor-candidate", "non-anchor-candidate"]);
    assert.equal(result.isFallback, false);
  });

  it("keyword hit + topic hit → 교집합 정상 동작", async () => {
    const index  = fakeIndex({ keywords: ["a", "b", "c"], topic: ["b", "c", "d"] });
    const result = await searchL1(index, { keywords: ["release"], topic: "memento-mcp" });

    assert.deepEqual(result.ids.sort(), ["b", "c"]);
    assert.equal(result.isFallback, false);
  });
});

describe("_searchL2 ID 보충 조회 scope 정합", () => {

  function makeStore(fetchedRows) {
    return {
      searchByKeywords: async () => [],
      searchByTopic   : async () => [],
      searchByTimeRange: async () => fetchedRows,
      getByIds        : async () => fetchedRows,
    };
  }

  it("보충 조회 결과에서 topic 불일치 파편이 걸러진다", async () => {
    const rows = [
      { id: "f1", content: "x", topic: "memento-mcp",   type: "fact", created_at: "2026-08-01T00:00:00Z" },
      { id: "f2", content: "y", topic: "session_reflect", type: "fact", created_at: "2026-08-01T00:00:00Z" },
    ];
    const results = await FragmentSearch.prototype._searchL2.call(
      { store: makeStore(rows) },
      { keywords: ["release"], topic: "memento-mpc" },
      ["f1", "f2"], "default", null, null
    );

    assert.deepEqual(results, []);
  });

  it("조건 없는 조회는 L1 recent가 scope에서 소진돼도 DB fallback을 사용한다", async () => {
    const rows = [
      { id: "global-old", content: "global", created_at: "2026-01-01T00:00:00Z" }
    ];
    const results = await FragmentSearch.prototype._searchL2.call(
      { store: makeStore(rows) },
      { keywords: [], workspace: null, allWorkspaces: false },
      [], "default", null, null
    );

    assert.deepEqual(results.map(r => r.id), ["global-old"]);
  });

  it("topic 일치 파편만 통과한다", async () => {
    const rows = [
      { id: "f1", content: "x", topic: "memento-mcp", type: "fact", created_at: "2026-08-01T00:00:00Z" },
      { id: "f2", content: "y", topic: "arcana",      type: "fact", created_at: "2026-08-01T00:00:00Z" },
    ];
    const results = await FragmentSearch.prototype._searchL2.call(
      { store: makeStore(rows) },
      { keywords: ["release"], topic: "memento-mcp" },
      ["f1", "f2"], "default", null, null
    );

    assert.deepEqual(results.map(r => r.id), ["f1"]);
  });

  it("type 필터도 보충 조회에 적용된다", async () => {
    const rows = [
      { id: "f1", content: "x", topic: "t", type: "error",     created_at: "2026-08-01T00:00:00Z" },
      { id: "f2", content: "y", topic: "t", type: "procedure", created_at: "2026-08-01T00:00:00Z" },
    ];
    const results = await FragmentSearch.prototype._searchL2.call(
      { store: makeStore(rows) },
      { keywords: ["k"], type: "error" },
      ["f1", "f2"], "default", null, null
    );

    assert.deepEqual(results.map(r => r.id), ["f1"]);
  });

  it("timeRange가 보충 조회에 적용된다", async () => {
    const rows = [
      { id: "old", content: "x", created_at: "2026-01-01T00:00:00Z" },
      { id: "new", content: "y", created_at: "2026-08-10T00:00:00Z" },
    ];
    const results = await FragmentSearch.prototype._searchL2.call(
      { store: makeStore(rows) },
      { keywords: ["k"] },
      ["old", "new"], "default", null,
      { from: "2026-08-01T00:00:00Z" }
    );

    assert.deepEqual(results.map(r => r.id), ["new"]);
  });

  it("isAnchor 단독 조건은 L2 DB 경로에서 true/false를 필터링한다", async () => {
    const rows = [
      { id: "anchor", content: "a", is_anchor: true },
      { id: "non-anchor", content: "b", is_anchor: false }
    ];
    const calls = [];
    const store = {
      searchByKeywords : async () => [],
      searchByTopic    : async () => [],
      searchByTimeRange: async (from, to, options) => {
        calls.push({ from, to, options });
        return rows.filter(row => row.is_anchor === options.isAnchor);
      },
      getByIds: async () => []
    };

    for (const isAnchor of [true, false]) {
      const results = await FragmentSearch.prototype._searchL2.call(
        { store },
        { isAnchor },
        [], "default", null, null
      );
      assert.deepEqual(results.map(row => row.is_anchor), [isAnchor]);
    }
    assert.deepEqual(calls.map(call => call.options.isAnchor), [true, false]);
  });

  it("isAnchor 단독 + includeSuperseded=true는 true/false 각각 만료 파편을 보존한다", async () => {
    const rows = [
      { id: "anchor-active", is_anchor: true, valid_to: null },
      { id: "anchor-expired", is_anchor: true, valid_to: "2026-01-01T00:00:00Z" },
      { id: "non-anchor-active", is_anchor: false, valid_to: null },
      { id: "non-anchor-expired", is_anchor: false, valid_to: "2026-01-01T00:00:00Z" }
    ];
    const calls = [];
    const store = {
      searchByKeywords : async () => [],
      searchByTopic    : async () => [],
      searchByTimeRange: async (_from, _to, options) => {
        calls.push(options);
        return rows.filter(row =>
          row.is_anchor === options.isAnchor &&
          (options.includeSuperseded || !row.valid_to)
        );
      },
      getByIds: async () => []
    };

    for (const isAnchor of [true, false]) {
      const results = await FragmentSearch.prototype._searchL2.call(
        { store },
        { isAnchor, includeSuperseded: true },
        [], "default", null, null
      );
      assert.equal(results.length, 2);
      assert.ok(results.some(row => row.valid_to));
      assert.ok(results.every(row => row.is_anchor === isAnchor));
    }
    assert.deepEqual(calls.map(options => options.includeSuperseded), [true, true]);
  });
});

describe("mergeRRF ID-only 항목 승격", () => {

  it("L1 ID-only 항목이 이후 완전 객체 도착 시 승격되고 점수가 보존된다", () => {
    const merged = mergeRRF([
      { name: "l1", results: ["f1"],                              weightFactor: 1.0 },
      { name: "l2", results: [{ id: "f1", content: "본문", topic: "t" }], weightFactor: 1.0 },
    ], 60);

    const f1 = merged.find(f => f.id === "f1");
    assert.ok(f1, "f1이 병합 결과에 존재해야 한다");
    assert.equal(f1.content, "본문");
    /** 두 레이어 rank 0 점수 합: 1/(60+1) + 1/(60+1) */
    const expected = 1 / 61 + 1 / 61;
    assert.ok(Math.abs(f1._rrfScore - expected) < 1e-12, `점수 보존 실패: ${f1._rrfScore}`);
  });

  it("완전 객체가 먼저 오고 ID-only가 나중이면 객체가 유지된다", () => {
    const merged = mergeRRF([
      { name: "l2", results: [{ id: "f1", content: "본문" }], weightFactor: 1.0 },
      { name: "l1", results: ["f1"],                          weightFactor: 0.5 },
    ], 60);

    const f1 = merged.find(f => f.id === "f1");
    assert.equal(f1.content, "본문");
  });

  it("객체가 오지 않은 ID-only 항목은 content 미보유로 남는다", () => {
    const merged = mergeRRF([
      { name: "l1", results: ["ghost"], weightFactor: 0.5 },
    ], 60);

    const ghost = merged.find(f => f.id === "ghost");
    assert.equal(ghost.content, undefined);
  });
});

describe("_searchTemporal includeSuperseded 전달", () => {
  it("temporal reader에 includeSuperseded=true를 전달한다", async () => {
    let capturedOptions;
    const store = {
      searchByTimeRange: async (_from, _to, options) => {
        capturedOptions = options;
        return [];
      }
    };
    await FragmentSearch.prototype._searchTemporal.call(
      { store },
      {
        timeRange: { from: null, to: null },
        agentId: "synthetic-agent",
        keyId: null,
        workspace: null,
        includeSuperseded: true
      }
    );
    assert.equal(capturedOptions.includeSuperseded, true);
  });
});
