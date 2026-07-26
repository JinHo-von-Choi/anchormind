/**
 * includePeerAgents 옵션 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-07-14
 *
 * FragmentReader의 agent 격리 필터가 includePeerAgents=true일 때만
 * 완화되고, 테넌트(key) 필터는 유지됨을 검증한다.
 */

import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

let captured = [];

mock.module("../../lib/tools/db.js", {
  namedExports: {
    queryWithAgentVector: async (agentId, sql, params) => {
      captured.push({ agentId, sql, params });
      return { rows: [] };
    },
    getPrimaryPool      : () => ({ query: async () => ({ rows: [] }) }),
    getBatchPool        : () => null,
    shutdownPool        : async () => {},
    getPoolStats        : () => ({}),
    withTransaction     : async (fn) => fn({ query: async () => ({ rows: [] }) })
  }
});

const { FragmentReader } = await import("../../lib/memory/read/FragmentReader.js");
const { FragmentStore }  = await import("../../lib/memory/write/FragmentStore.js");

const AGENT_COND = /agent_id = \$\d+ OR (f\.)?agent_id = 'default'/;
const PEER_COND  = /\$\d+::text IS NOT NULL/;

function lastSql() {
  return captured[captured.length - 1].sql;
}

beforeEach(() => {
  captured = [];
});

describe("FragmentReader includePeerAgents", () => {
  const reader = new FragmentReader();

  it("searchByKeywords 기본은 agent 격리 조건 유지", async () => {
    await reader.searchByKeywords(["k"], { agentId: "a1" });
    assert.match(lastSql(), AGENT_COND);
  });

  it("searchByKeywords includePeerAgents=true면 격리 완화", async () => {
    await reader.searchByKeywords(["k"], { agentId: "a1", includePeerAgents: true });
    assert.doesNotMatch(lastSql(), AGENT_COND);
    assert.match(lastSql(), PEER_COND);
  });

  it("searchByTopic includePeerAgents=true면 격리 완화", async () => {
    await reader.searchByTopic("t", { agentId: "a1", includePeerAgents: true });
    assert.doesNotMatch(lastSql(), AGENT_COND);
  });

  it("searchBySemantic 11번째 인자 true면 f.agent_id 격리 완화", async () => {
    const vec = new Array(4).fill(0.1);
    await reader.searchBySemantic(vec, 5, 0.3, "a1", null, false, null, null, null, false, true);
    assert.doesNotMatch(lastSql(), AGENT_COND);
    assert.match(lastSql(), PEER_COND);
  });

  it("searchBySemantic 기본은 격리 유지", async () => {
    const vec = new Array(4).fill(0.1);
    await reader.searchBySemantic(vec, 5, 0.3, "a1");
    assert.match(lastSql(), AGENT_COND);
  });

  it("getByIds opts.includePeerAgents=true면 격리 완화", async () => {
    await reader.getByIds(["f1"], "a1", null, [], { includePeerAgents: true });
    assert.doesNotMatch(lastSql(), AGENT_COND);
  });

  it("searchByTimeRange includePeerAgents=true면 격리 완화", async () => {
    await reader.searchByTimeRange("2026-01-01", "2026-02-01", { agentId: "a1", includePeerAgents: true });
    assert.doesNotMatch(lastSql(), AGENT_COND);
  });

  it("FragmentStore.getByIds가 includePeerAgents 옵션을 전달", async () => {
    const store = new FragmentStore();
    await store.getByIds(["f1"], "a1", null, [], { includePeerAgents: true });
    assert.doesNotMatch(lastSql(), AGENT_COND);
    assert.match(lastSql(), PEER_COND);
  });

  it("FragmentStore.searchBySemantic이 includePeerAgents 옵션을 전달", async () => {
    const store = new FragmentStore();
    const vec = new Array(4).fill(0.1);
    await store.searchBySemantic(
      vec, 5, 0.3, "a1", null, false, null, null, null, false, true
    );
    assert.doesNotMatch(lastSql(), AGENT_COND);
    assert.match(lastSql(), PEER_COND);
  });

  it("includePeerAgents=true여도 keyId 테넌트 필터는 유지", async () => {
    await reader.searchByKeywords(["k"], { agentId: "a1", keyId: "key-1", includePeerAgents: true });
    assert.match(lastSql(), /key_id/);
  });
});
