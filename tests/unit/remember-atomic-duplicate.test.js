/**
 * remember 원자 저장 경로의 중복 적중 처리 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * MEMENTO_REMEMBER_ATOMIC 경로(_rememberAtomic)는 트랜잭션을 커밋한 뒤 중복 적중을 판정한다.
 * 확인이 꺼져 있으면 응답 구조와 후속 처리는 그대로이고, 켜져 있으면 기존 파편 상태만
 * scope persistent로 알리며 색인, 후처리, 충돌 감지, 연결을 하지 않는다.
 */
import { describe, it, mock, beforeEach } from "node:test";
import assert                              from "node:assert/strict";

process.env.DOTENV_CONFIG_PATH      ??= ".env.test";
process.env.MEMENTO_METRICS_DEFAULT ??= "off";
process.env.REDIS_ENABLED           ??= "false";
process.env.CACHE_ENABLED           ??= "false";

let calls;

const client = {
  query  : async (sql) => {
    calls.sql.push(String(sql));
    if (/FROM .*api_keys/.test(String(sql))) return { rows: [{ fragment_limit: null }] };
    return { rows: [] };
  },
  release: () => { calls.released++; }
};

const realDb = await import("../../lib/tools/db.js");
mock.module("../../lib/tools/db.js", {
  namedExports: { ...realDb, getPrimaryPool: () => ({ connect: async () => client }) }
});

const { MemoryRememberer } = await import("../../lib/memory/processors/MemoryRememberer.js");

const EXISTING = { workspace: "ws-beta", valid_to: null, ttl_tier: "permanent", keywords: ["k"] };

function makeRememberer(insertResult, existing = EXISTING) {
  return new MemoryRememberer({
    store: {
      writer           : { insert: async () => insertResult },
      insert           : async () => insertResult,
      updateTtlTier    : async (...a) => { calls.ttl.push(a); },
      getDuplicateState: async (...a) => { calls.state.push(a); return existing; }
    },
    index           : { index: async () => { calls.index++; } },
    factory         : {},
    quotaChecker    : { check: async () => {} },
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

const fragment = () => ({
  id: "frag-new", content: "원자 경로 중복 시험 파편", topic: "t", type: "fact",
  keywords: ["k"], importance: 0.6, workspace: "ws-beta", ttl_tier: "warm"
});
const ctx = () => ({ agentId: "default", keyId: "key-1", groupKeyIds: null, params: {} });

beforeEach(() => {
  calls = { sql: [], released: 0, ttl: [], state: [], index: 0, post: 0, detect: 0, link: 0 };
  delete process.env.MEMENTO_REMEMBER_DUPLICATE_GUARD;
});

describe("_rememberAtomic 중복 적중", () => {
  it("확인이 꺼져 있으면 기존 응답 구조와 후속 처리를 그대로 탄다", async () => {
    const res = await makeRememberer("frag-old")._rememberAtomic(fragment(), ctx());
    assert.deepEqual(res, {
      id: "frag-old", keywords: ["k"], ttl_tier: "warm", scope: "persistent", conflicts: []
    });
    assert.equal(calls.index, 1);
    assert.equal(calls.post, 1);
    assert.equal(calls.detect, 1);
    assert.equal(calls.link, 1);
    assert.equal(calls.state.length, 1);
    assert.ok(calls.sql.includes("COMMIT"));
    assert.equal(calls.released, 1);
  });

  it("확인이 켜져 있고 살아 있는 기존 파편이 있으면 persistent 범위의 중복 응답을 돌려준다", async () => {
    process.env.MEMENTO_REMEMBER_DUPLICATE_GUARD = "true";
    const res = await makeRememberer("frag-old")._rememberAtomic(fragment(), ctx());
    assert.deepEqual(res, {
      id: "frag-old", keywords: ["k"], ttl_tier: "permanent", scope: "persistent",
      conflicts: [], existing: true, duplicate: "same_scope"
    });
    assert.deepEqual(calls.state, [["frag-old", "key-1", "default"]]);
    assert.equal(calls.index, 0);
    assert.equal(calls.post, 0);
    assert.equal(calls.detect, 0);
    assert.equal(calls.link, 0);
    assert.deepEqual(calls.ttl, []);
    assert.ok(calls.sql.includes("COMMIT"));
    assert.equal(calls.released, 1);
  });

  it("확인이 켜져 있어도 새 파편이 저장되면 상태 조회 없이 후속 처리를 한다", async () => {
    process.env.MEMENTO_REMEMBER_DUPLICATE_GUARD = "true";
    const res = await makeRememberer("frag-new")._rememberAtomic(fragment(), ctx());
    assert.equal(res.id, "frag-new");
    assert.equal(res.existing, undefined);
    assert.equal(calls.state.length, 0);
    assert.equal(calls.index, 1);
    assert.equal(calls.post, 1);
  });
});
