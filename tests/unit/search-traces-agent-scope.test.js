import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

const calls = [];
mock.module("../../lib/tools/db.js", {
  exports: {
    getPrimaryPool: () => ({
      query: async (sql, params) => {
        calls.push({ sql, params });
        return { rows: [] };
      }
    }),
    getBatchPool: () => null,
    getPoolStats: () => ({}),
    queryWithAgentVector: async () => ({ rows: [] }),
    withTransaction: async (_pool, fn) => fn({ query: async () => ({ rows: [] }) }),
    shutdownPool: async () => {}
  }
});

const { tool_reconstructHistory, tool_searchTraces } = await import("../../lib/tools/reconstruct.js");
const { MemoryManager } = await import("../../lib/memory/MemoryManager.js");

beforeEach(() => { calls.length = 0; });

describe("search_traces agent scope", () => {
  it("agent 생략은 default-only이고 key/workspace 범위를 유지한다", async () => {
    const result = await tool_searchTraces({
      _keyId: "key-a", _groupKeyIds: ["key-a"], _defaultWorkspace: "workspace-a"
    });
    assert.equal(result.success, true);
    assert.match(calls[0].sql, /f\.agent_id = \$1/);
    assert.match(calls[0].sql, /f\.key_id/);
    assert.match(calls[0].sql, /f\.workspace/);
    assert.equal(calls[0].params[0], "default");
  });

  it("specific agent는 own+default를 검색한다", async () => {
    await tool_searchTraces({
      agentId: "agent-a", _keyId: "key-a", _groupKeyIds: ["key-a"]
    });
    assert.match(calls[0].sql, /\(f\.agent_id = \$1 OR f\.agent_id = 'default'\)/);
    assert.match(calls[0].sql, /f\.workspace IS NULL/);
  });

  it("승인된 peer 모드는 agent만 완화하고 key/workspace는 유지한다", async () => {
    await tool_searchTraces({
      agentId: "agent-a", includePeerAgents: true,
      _keyId: "key-a", _groupKeyIds: ["key-a"], _defaultWorkspace: "workspace-a",
      _isMaster: true
    });
    assert.match(calls[0].sql, /peer-agent: no f\.agent_id filter/);
    assert.match(calls[0].sql, /f\.key_id/);
    assert.match(calls[0].sql, /f\.workspace/);
  });
});

describe("reconstruct_history scope forwarding", () => {
  it("tool entry가 master allWorkspaces를 facade 호출에 보존한다", async () => {
    const originalGetInstance = MemoryManager.getInstance;
    let received;
    MemoryManager.getInstance = () => ({
      reconstructHistory: async params => {
        received = params;
        return {
          ordered_timeline: [], causal_chains: [], unresolved_branches: [],
          supporting_fragments: [], case_events: [], event_dag: [], summary: "empty"
        };
      }
    });
    try {
      const result = await tool_reconstructHistory({
        caseId: "case-all", allWorkspaces: true, _isMaster: true,
        _keyId: null, _groupKeyIds: null
      });
      assert.equal(result.success, true);
      assert.equal(received.allWorkspaces, true);
      assert.equal(received._isMaster, true);
      assert.equal(received.workspace, null);
    } finally {
      MemoryManager.getInstance = originalGetInstance;
    }
  });
});
