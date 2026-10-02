/**
 * remember 중복 적중 처리 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 같은 키 범위에 같은 본문이 있으면 store.insert가 기존 파편 id를 돌려준다.
 * 확인이 켜져 있으면 기존 파편을 고치지 않고 상태만 알린다. 꺼져 있으면 흐름은
 * 그대로 두고 분류 계수만 한다.
 */
import { describe, it, beforeEach } from "node:test";
import assert                        from "node:assert/strict";
import {
  MemoryRememberer, isDuplicateHit, classifyDuplicate
} from "../../lib/memory/processors/MemoryRememberer.js";
import { rememberDuplicateTotal, recordRememberDuplicate } from "../../lib/metrics.js";

let calls;

/** insertResult: store.insert 반환값, existing: getDuplicateState 반환값 */
function makeRememberer({ insertResult, existing }) {
  return new MemoryRememberer({
    store: {
      insert           : async () => insertResult,
      updateTtlTier    : async (...a) => { calls.ttl.push(a); },
      getDuplicateState: async (...a) => { calls.state.push(a); return existing; }
    },
    index           : { index: async () => { calls.index++; }, addToWorkingMemory: async () => {} },
    factory         : { create: (p) => ({ ...p, id: "frag-new", keywords: p.keywords ?? [], importance: p.importance ?? 0.6 }) },
    quotaChecker    : { check: async () => {}, getUsage: async () => ({}) },
    postProcessor   : { run: async () => { calls.post++; } },
    conflictResolver: {
      detectConflicts   : async () => { calls.detect++; return []; },
      autoLinkOnRemember: async () => { calls.link++; }
    },
    policyRules        : null,
    getHardGate        : async () => false,
    policyGatingEnabled: false
  });
}

const params = { content: "같은 본문 재저장 시험 파편", type: "fact", topic: "t", importance: 0.2, workspace: "ws-beta" };

beforeEach(() => {
  calls = { ttl: [], state: [], index: 0, post: 0, detect: 0, link: 0 };
  delete process.env.MEMENTO_REMEMBER_DUPLICATE_GUARD;
});

describe("중복 적중 판정과 분류", () => {
  it("isDuplicateHit은 문자열 id가 서로 다를 때만 참", () => {
    assert.equal(isDuplicateHit({ id: "a" }, "b"), true);
    assert.equal(isDuplicateHit({ id: "a" }, "a"), false);
    assert.equal(isDuplicateHit({ id: undefined }, "a"), false);
    assert.equal(isDuplicateHit({ id: "a" }, null), false);
  });

  it("classifyDuplicate는 닫힘, 다른 workspace, 같은 범위, 미상을 구분한다", () => {
    assert.equal(classifyDuplicate({ workspace: "w" }, null), "unknown");
    assert.equal(classifyDuplicate({ workspace: "w" }, { workspace: "w", valid_to: new Date() }), "closed");
    assert.equal(classifyDuplicate({ workspace: "w" }, { workspace: "x", valid_to: null }), "other_workspace");
    assert.equal(classifyDuplicate({ workspace: null }, { workspace: null, valid_to: null }), "same_scope");
    assert.equal(classifyDuplicate({}, { valid_to: null }), "same_scope");
  });
});

describe("remember 중복 적중", () => {
  it("확인이 꺼져 있으면 현행 흐름을 그대로 탄다(상태 조회는 계수용 1회)", async () => {
    const r   = makeRememberer({ insertResult: "frag-old", existing: { workspace: "ws-alpha", valid_to: null, ttl_tier: "permanent", keywords: ["k"] } });
    const res = await r.remember(params);
    assert.equal(res.id, "frag-old");
    assert.equal(res.existing, undefined);
    assert.equal(calls.state.length, 1);
    assert.equal(calls.index, 1);
    assert.equal(calls.post, 1);
    assert.deepEqual(calls.ttl, [["frag-old", "short", null]]);
  });

  it("확인이 켜져 있으면 다른 workspace의 기존 파편을 고치지 않고 알린다", async () => {
    process.env.MEMENTO_REMEMBER_DUPLICATE_GUARD = "true";
    const r   = makeRememberer({ insertResult: "frag-old", existing: { workspace: "ws-alpha", valid_to: null, ttl_tier: "permanent", keywords: ["k"] } });
    const res = await r.remember(params);
    assert.deepEqual(res, {
      id: "frag-old", keywords: ["k"], ttl_tier: "permanent", scope: "permanent",
      conflicts: [], existing: true, duplicate: "other_workspace"
    });
    assert.equal(calls.index, 0);
    assert.equal(calls.post, 0);
    assert.equal(calls.detect, 0);
    assert.equal(calls.link, 0);
    assert.deepEqual(calls.ttl, []);
  });

  it("확인이 켜져 있으면 닫힌 기존 파편은 closed로 알린다", async () => {
    process.env.MEMENTO_REMEMBER_DUPLICATE_GUARD = "true";
    const r   = makeRememberer({ insertResult: "frag-old", existing: { workspace: "ws-beta", valid_to: new Date(), ttl_tier: "cold", keywords: [] } });
    const res = await r.remember(params);
    assert.equal(res.duplicate, "closed");
    assert.deepEqual(calls.ttl, []);
  });

  it("새 파편이 저장되면 상태 조회 없이 현행 흐름", async () => {
    process.env.MEMENTO_REMEMBER_DUPLICATE_GUARD = "true";
    const r   = makeRememberer({ insertResult: "frag-new", existing: null });
    const res = await r.remember(params);
    assert.equal(res.id, "frag-new");
    assert.equal(calls.state.length, 0);
    assert.equal(calls.index, 1);
  });

  it("분류 계수기는 확인 설정과 무관하게 kind별로 오른다", async () => {
    const read = async (kind) => (await rememberDuplicateTotal.get()).values.find(v => v.labels.kind === kind)?.value ?? 0;
    const before = await read("other_workspace");
    const r = makeRememberer({ insertResult: "frag-old", existing: { workspace: "ws-alpha", valid_to: null, ttl_tier: "warm", keywords: [] } });
    await r.remember(params);
    assert.equal(await read("other_workspace"), before + 1);
  });

  it("상태 조회가 실패하면 unknown으로 계수하고 저장 흐름은 이어진다", async () => {
    const read = async (kind) => (await rememberDuplicateTotal.get()).values.find(v => v.labels.kind === kind)?.value ?? 0;
    const before = await read("unknown");
    const r = makeRememberer({ insertResult: "frag-old", existing: null });
    r.store.getDuplicateState = async () => { throw new Error("lookup down"); };
    const res = await r.remember(params);
    assert.equal(res.id, "frag-old");
    assert.equal(res.existing, undefined);
    assert.equal(calls.index, 1);
    assert.equal(await read("unknown"), before + 1);
  });

  it("범위 밖 kind 값은 unknown으로 닫힌다", async () => {
    const read = async (kind) => (await rememberDuplicateTotal.get()).values.find(v => v.labels.kind === kind)?.value ?? 0;
    const before = await read("unknown");
    recordRememberDuplicate("ws-secret-name");
    assert.equal(await read("unknown"), before + 1);
  });
});
