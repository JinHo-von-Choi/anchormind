/**
 * ConflictResolver 동작 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 저장소와 검색기는 주입 대역, DB 풀은 행을 돌려주는 대역을 쓴다.
 * 충돌 후보 선별, 자동 링크 대상 선별, assertion 판정 결과를 확인한다.
 */

import { describe, it, mock, before, after } from "node:test";
import assert                                from "node:assert/strict";

let poolRows  = [];
let poolError = null;

const realDb = await import("../../lib/tools/db.js");
mock.module("../../lib/tools/db.js", {
  exports: {
    ...realDb,
    getPrimaryPool: () => ({
      query: async () => {
        if (poolError) throw poolError;
        return { rows: poolRows };
      }
    })
  }
});

const { ConflictResolver }                           = await import("../../lib/memory/write/ConflictResolver.js");
const { teardownTestResources, assertCleanShutdown } = await import("../_lifecycle.js");

/** 환경 설정과 무관하게 판정만 보도록 심볼릭 검사 대역을 주입한다. */
const NO_POLARITY_CONFLICT = { detectPolarityConflicts: async () => ({ conflicts: [] }) };

let savedReconsolidation;

before(() => {
  savedReconsolidation = process.env.ENABLE_RECONSOLIDATION;
  delete process.env.ENABLE_RECONSOLIDATION;
});

after(async () => {
  if (savedReconsolidation === undefined) delete process.env.ENABLE_RECONSOLIDATION;
  else process.env.ENABLE_RECONSOLIDATION = savedReconsolidation;
  await teardownTestResources();
  await assertCleanShutdown();
});

describe("detectConflicts", () => {
  it("자기 자신을 빼고 유사도 0.8 초과 파편만 충돌로 돌려준다", async () => {
    const search = {
      search: async () => ({
        fragments: [
          { id: "new", content: "self",  similarity: 0.99 },
          { id: "a",   content: "close", similarity: 0.81 },
          { id: "b",   content: "edge",  similarity: 0.8 },
          { id: "c",   content: "none" }
        ]
      })
    };
    const conflicts = await new ConflictResolver({}, search).detectConflicts("본문", "topic", "new");
    assert.deepEqual(conflicts.map(c => c.existing_id), ["a"]);
  });

  it("검색이 실패하면 빈 배열을 돌려준다", async () => {
    const search = { search: async () => { throw new Error("search down"); } };
    assert.deepEqual(await new ConflictResolver({}, search).detectConflicts("본문", "topic", "new"), []);
  });
});

describe("autoLinkOnRemember", () => {
  it("topic 파편 가운데 최대 3개와 related 링크를 만든다", async () => {
    const created = [];
    const store   = {
      searchByTopic: async () => [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }],
      createLink   : async (from, to, rel) => { created.push(`${from}->${to}:${rel}`); }
    };
    const count = await new ConflictResolver(store, {}).autoLinkOnRemember({ id: "new", topic: "t" }, "default");
    assert.equal(count, 3);
    assert.deepEqual(created, ["new->a:related", "new->b:related", "new->c:related"]);
  });

  it("topic이 없으면 조회하지 않고 0을 돌려준다", async () => {
    const store = { searchByTopic: mock.fn(async () => []), createLink: mock.fn(async () => {}) };
    assert.equal(await new ConflictResolver(store, {}).autoLinkOnRemember({ id: "new" }, "default"), 0);
    assert.equal(store.searchByTopic.mock.callCount(), 0);
  });
});

describe("checkAssertionConsistency", () => {
  const fragment = { id: "new", topic: "deploy", content: "nginx reload 후 503 해소 확인" };
  const resolver = () => new ConflictResolver({}, {}, { claimConflictDetector: NO_POLARITY_CONFLICT });

  it("verified 파편과 Jaccard 0.3 초과로 겹치면 inferred와 후보를 돌려준다", async () => {
    poolError = null;
    poolRows  = [
      { id: "v1", content: "nginx reload 후 503 해소", assertion_status: "verified" },
      { id: "o1", content: "전혀 다른 내용의 파편",     assertion_status: "observed" }
    ];
    const result = await resolver().checkAssertionConsistency(fragment, "default", null);
    assert.equal(result.assertionStatus, "inferred");
    assert.deepEqual(result.supersedeCandidates, ["v1"]);
  });

  it("겹치는 파편이 observed뿐이면 observed를 유지하고 후보는 돌려준다", async () => {
    poolError = null;
    poolRows  = [{ id: "o2", content: "nginx reload 후 503 해소", assertion_status: "observed" }];
    const result = await resolver().checkAssertionConsistency(fragment, "default", null);
    assert.equal(result.assertionStatus, "observed");
    assert.deepEqual(result.supersedeCandidates, ["o2"]);
  });

  it("DB 조회가 실패하면 observed와 빈 후보를 돌려준다", async () => {
    poolError = new Error("connection reset");
    try {
      const result = await resolver().checkAssertionConsistency(fragment, "default", null);
      assert.deepEqual(result, { assertionStatus: "observed", supersedeCandidates: [], validationWarnings: [] });
    } finally {
      poolError = null;
    }
  });
});
