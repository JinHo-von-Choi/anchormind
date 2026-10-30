/**
 * remember의 내부 검색이 사용자 검색처럼 접근 기록·검색 이벤트를 남기지 않는지, 비원자·원자 저장 경로가 같은
 * 응답을 돌려주는지, 단계 계측이 결과와 오류를 바꾸지 않는지 검증한다.
 */
import { describe, it } from "node:test";
import assert           from "node:assert/strict";

process.env.DOTENV_CONFIG_PATH      ??= ".env.test";
process.env.MEMENTO_METRICS_DEFAULT ??= "off";
process.env.REDIS_ENABLED           ??= "false";
process.env.CACHE_ENABLED           ??= "false";

const { searchSideEffects }      = await import("../../lib/memory/read/FragmentSearch.js");
const { ConflictResolver }       = await import("../../lib/memory/write/ConflictResolver.js");
const { buildRecallSearchQuery } = await import("../../lib/memory/processors/MemoryRecaller.js");
const { MemoryRememberer }       = await import("../../lib/memory/processors/MemoryRememberer.js");
const { timeStage, rememberStageDuration } = await import("../../lib/memory/stage-metrics.js");

describe("검색 부수 효과 범위", () => {
  it("지정하지 않았거나 모르는 값이면 all이다", () => {
    assert.equal(searchSideEffects({}), "all");
    assert.equal(searchSideEffects({ sideEffects: "nope" }), "all");
    assert.equal(searchSideEffects({ sideEffects: "none" }), "none");
    assert.equal(searchSideEffects({ sideEffects: "access" }), "access");
  });

  it("충돌 탐지는 부수 효과 없는 내부 검색이다", async () => {
    const seen = [];
    const resolver = new ConflictResolver({}, { search: async (q) => { seen.push(q); return { fragments: [] }; } });
    await resolver.detectConflicts("본문", "topic", "id-1", "default", "key-1", "ws");
    assert.equal(seen.at(-1).sideEffects, "none");
  });

  it("recall 인자 _searchSideEffects를 검색 질의로 넘긴다", () => {
    const ctx = { fragmentCount: 0, anchorTime: 0, agentId: "default", keyId: "k", groupKeyIds: ["k"], workspace: null, allWorkspaces: false };
    assert.equal(buildRecallSearchQuery({ _searchSideEffects: "access" }, ctx).sideEffects, "access");
    assert.equal(buildRecallSearchQuery({}, ctx).sideEffects, undefined);
  });
});

describe("저장 경로 응답", () => {
  const conflict = { existing_id: "old", existing_content: "기존", similarity: 0.9, recommendation: "r" };
  const rememberer = () => new MemoryRememberer({
    store: {
      insert           : async () => "new-id",
      writer           : { insert: async () => "new-id" },
      updateTtlTier    : async () => {},
      getDuplicateState: async () => null
    },
    index           : { index: async () => {} },
    factory         : {},
    quotaChecker    : { check: async () => {} },
    postProcessor   : { run: async () => {} },
    conflictResolver: {
      detectConflicts   : async () => [conflict],
      autoLinkOnRemember: async () => 1
    },
    policyRules        : null,
    getHardGate        : async () => false,
    policyGatingEnabled: false
  });
  const fragment = { id: "new-id", content: "본문", topic: "t", type: "fact", keywords: ["k"], importance: 0.6, ttl_tier: "warm" };

  it("공통 후속 처리는 문서의 scope와 충돌 탐지 결과를 그대로 돌려준다", async () => {
    const res = await rememberer()._finalizeRemember(fragment, { agentId: "default", keyId: "key-1", groupKeyIds: null, params: {} });
    assert.equal(res.scope, "permanent");
    assert.deepEqual(res.conflicts, [conflict]);
  });

  it("비원자 경로도 같은 응답을 돌려준다", async () => {
    const res = await rememberer()._persistNonAtomic(fragment, {}, "default", "key-1", null);
    assert.equal(res.scope, "permanent");
    assert.deepEqual(res.conflicts, [conflict]);
  });
});

describe("단계 계측", () => {
  it("결과를 그대로 돌려주고 오류를 다시 던진다", async () => {
    const countOf = async () => (await rememberStageDuration.get()).values
      .find(v => v.metricName.endsWith("_count") && v.labels.stage === "autolink")?.value ?? 0;
    const before = await countOf();
    assert.equal(await timeStage(rememberStageDuration, { stage: "autolink" }, async () => 7), 7);
    await assert.rejects(() => timeStage(rememberStageDuration, { stage: "autolink" }, async () => { throw new Error("x"); }), /x/);
    assert.equal(await countOf() - before, 2);
  });
});
