/**
 * 파생 파편의 신뢰 등급 상속 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-04
 *
 * 통합 분할 자식은 부모 등급을 키 상한으로 물려받고, 모순 감사 파편은 두 원본 등급 중 낮은 값을
 * 키 상한으로 받는지 대역 위에서 본다. 원본 등급을 확인하지 못하면 낮음(1)이다.
 */

import { describe, it, mock, beforeEach, afterEach } from "node:test";
import assert                                        from "node:assert/strict";

process.env.DOTENV_CONFIG_PATH      ??= ".env.test";
process.env.MEMENTO_METRICS_DEFAULT ??= "off";
process.env.REDIS_ENABLED           ??= "false";
process.env.CACHE_ENABLED           ??= "false";

const remembered = [];
/** DB 모듈을 먼저 대역으로 바꿔야 MemoryManager가 불러오는 모듈도 대역을 쓴다. */
const realDb = await import("../../lib/tools/db.js");
mock.module("../../lib/tools/db.js", {
  namedExports: { ...realDb, queryWithAgentVector: async () => ({ rows: [] }) }
});
const realManager = await import("../../lib/memory/MemoryManager.js");
mock.module("../../lib/memory/MemoryManager.js", {
  namedExports: {
    ...realManager,
    MemoryManager: { getInstance: () => ({ remember: async (params) => { remembered.push(params); return { id: "audit" }; } }) }
  }
});

const { ContradictionDetector }    = await import("../../lib/memory/link/ContradictionDetector.js");
const { MemoryConsolidator }       = await import("../../lib/memory/consolidate/MemoryConsolidator.js");
const { auditProvenance }          = await import("../../lib/memory/link/AuditProvenance.js");
const { derivedTrustCap }          = await import("../../lib/memory/provenance.js");
const { ConsolidatorGC, buildSplitCandidateQuery } = await import("../../lib/memory/consolidate/ConsolidatorGC.js");
const { WriteGate }                = await import("../../lib/memory/write/WriteGate.js");
const { provenanceContext }        = await import("../../lib/memory/provenance.js");

const saved = process.env.MEMENTO_PROVENANCE;
beforeEach(() => { remembered.length = 0; delete process.env.MEMENTO_PROVENANCE; });
afterEach(() => {
  if (saved === undefined) delete process.env.MEMENTO_PROVENANCE;
  else process.env.MEMENTO_PROVENANCE = saved;
});

/** 저장된 trust_tier 표를 돌려주는 저장소 대역 */
const storeWith = (tiers, { fail = false } = {}) => ({
  createLink   : async () => {},
  getTrustTiers: async (ids) => {
    if (fail) throw new Error("synthetic trust lookup failure");
    return new Map(ids.filter(id => Object.hasOwn(tiers, id)).map(id => [id, tiers[id]]));
  }
});

describe("derivedTrustCap", () => {
  it("원본 등급 중 낮은 값이고 NULL은 2, 모르는 원본은 1이다", () => {
    assert.equal(derivedTrustCap([3, 2]), 2);
    assert.equal(derivedTrustCap([null, 3]), 2);
    assert.equal(derivedTrustCap([1, 3]), 1);
    assert.equal(derivedTrustCap([0, null]), 0);
    assert.equal(derivedTrustCap([undefined, 3]), 1);
    assert.equal(derivedTrustCap([]), 1);
  });
});

describe("모순 감사 파편", () => {
  it("두 원본 중 낮은 등급을 키 상한으로 넘긴다", async () => {
    assert.deepEqual(await auditProvenance(storeWith({ a: 1, b: 3 }), ["a", "b"]),
      { _provenance: { clientName: "internal", trustCap: 1 } });
    assert.deepEqual(await auditProvenance(storeWith({ a: null, b: 3 }), ["a", "b"]),
      { _provenance: { clientName: "internal", trustCap: 2 } });
  });

  it("원본이 조회되지 않거나 조회가 실패하면 낮음(1)이다", async () => {
    assert.equal((await auditProvenance(storeWith({ a: 3 }), ["a", "b"]))._provenance.trustCap, 1);
    assert.equal((await auditProvenance(storeWith({}, { fail: true }), ["a", "b"]))._provenance.trustCap, 1);
  });

  it("MEMENTO_PROVENANCE=off이면 아무것도 싣지 않는다", async () => {
    process.env.MEMENTO_PROVENANCE = "off";
    assert.deepEqual(await auditProvenance(storeWith({ a: 1, b: 1 }), ["a", "b"]), {});
  });

  it("resolveContradiction의 감사 remember는 패자 등급 1을 상한으로 받아 등급 1로 기록된다", async () => {
    const detector = new ContradictionDetector(storeWith({ old: 1, new: 3 }));
    await detector.resolveContradiction(
      { id: "new", content: "새 본문", created_at: "2026-10-02T00:00:00Z", key_id: null, keywords: [] },
      { id: "old", content: "외부에서 들어온 낡은 본문", created_at: "2026-10-01T00:00:00Z", key_id: null, is_anchor: false },
      "test"
    );
    assert.equal(remembered.length, 1);
    assert.deepEqual(remembered[0]._provenance, { clientName: "internal", trustCap: 1 });
    assert.deepEqual(provenanceContext(remembered[0]), { clientName: "internal", trustCap: 1 });
  });
});

describe("통합 경로의 모순 감사 파편", () => {
  it("MemoryConsolidator도 같은 감사 기록으로 낮은 원본 등급을 상한으로 넘긴다", async () => {
    const consolidator = new MemoryConsolidator();
    const store        = storeWith({ older: 0, newer: 2 });
    consolidator.store = store;
    consolidator.contradictionDetector.store = store;
    await consolidator._resolveContradiction(
      { id: "newer", content: "새 본문", created_at: "2026-10-02T00:00:00Z", key_id: null, keywords: ["k"], topic: "ops" },
      { id: "older", content: "격리 등급 본문", created_at: "2026-10-01T00:00:00Z", key_id: null, is_anchor: false },
      "test"
    );
    assert.equal(remembered.length, 1);
    assert.equal(remembered[0].topic, "contradiction_audit");
    assert.deepEqual(remembered[0]._provenance, { clientName: "internal", trustCap: 0 });
  });
});

describe("통합 분할 자식", () => {
  it("후보 조회는 켜지면 trust_tier를 읽고 꺼지면 읽지 않는다", () => {
    assert.match(buildSplitCandidateQuery([], { provenance: true }).sql, /workspace, trust_tier\n/);
    assert.doesNotMatch(buildSplitCandidateQuery([]).sql, /trust_tier/);
  });

  const children = [{ text: "분할된 자식 본문은 충분히 길게 적어 둔다", childImportance: 0.5 }];
  const parent   = (trustTier) => ({ id: "p", topic: "ops", type: "fact", workspace: null, trust_tier: trustTier });
  const gc       = new ConsolidatorGC({}, { writeGate: () => new WriteGate({ policyGatingEnabled: false }) });
  let seq = 0;
  const uuid = () => `child-${++seq}`;

  it("자식 등급은 부모 등급을 넘지 않는다", async () => {
    const low  = await gc._gateSplitWrites(children, parent(1), "default", null, uuid);
    const high = await gc._gateSplitWrites(children, parent(3), "default", null, uuid);
    const none = await gc._gateSplitWrites(children, parent(null), "default", null, uuid);
    assert.equal(low[0].draft.trust_tier, 1);
    assert.equal(low[0].draft.origin, "consolidation");
    assert.equal(low[0].draft.observed_client, "internal/consolidate_split");
    assert.equal(high[0].draft.trust_tier, 2);
    assert.equal(none[0].draft.trust_tier, 2);
  });
});
