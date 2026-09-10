import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

import { MemoryRecaller } from "../../lib/memory/processors/MemoryRecaller.js";

let managerCalls = [];
mock.module("../../lib/memory/MemoryManager.js", {
  namedExports: {
    MemoryManager: {
      getInstance: () => ({
        fragmentHistory: async args => {
          managerCalls.push(args);
          return { current: { id: args.id } };
        },
        graphExplore: async args => {
          managerCalls.push(args);
          return { startId: args.startId, nodes: [], edges: [], count: 0 };
        }
      })
    }
  }
});
const { tool_fragmentHistory, tool_graphExplore } = await import("../../lib/tools/memory.js");

const pointReads = [
  { method: "fragmentHistory", args: { id: "fragment-a" }, tool: tool_fragmentHistory },
  { method: "graphExplore", args: { startId: "fragment-a" }, tool: tool_graphExplore }
];

function createRecaller() {
  const calls = [];
  const fragment = { id: "fragment-a", workspace: "project-a", agent_id: "agent-a" };
  const store = {
    getHistory: async (...args) => {
      calls.push(args);
      return { current: fragment, versions: [], superseded_by_chain: [] };
    },
    getById: async (...args) => {
      calls.push(args);
      return fragment;
    },
    getRCAChain: async (...args) => {
      calls.push(args);
      return [{ id: "fragment-b", relation_type: "resolved_by", workspace: "project-b" }];
    }
  };
  return { recaller: new MemoryRecaller({ store }), calls };
}

for (const { method, args, tool } of pointReads) {
  describe(`${method} workspace authorization`, () => {
    it("master allWorkspaces는 point lookup과 후속 hydration에 전달된다", async () => {
      const { recaller, calls } = createRecaller();
      const result = await recaller[method]({
        ...args, _isMaster: true, allWorkspaces: true,
        agentId: "agent-a", workspace: "ignored-project", _defaultWorkspace: "ignored-default"
      });
      assert.equal(result.error, undefined);
      assert.equal(calls.length, method === "graphExplore" ? 2 : 1);
      for (const call of calls) {
        assert.equal(call[1], "agent-a");
        assert.equal(call[2], null);
        assert.deepEqual(call[4], {
          workspace: null, allWorkspaces: true, includePeerAgents: false, _isMaster: true
        });
      }
    });

    it("직접 processor 호출도 비master allWorkspaces를 저장소 접근 전에 거부한다", async () => {
      const { recaller, calls } = createRecaller();
      for (const auth of [{ _keyId: "key-a", _isMaster: false }, { _keyId: null }]) {
        await assert.rejects(
          recaller[method]({ ...args, ...auth, allWorkspaces: true }),
          { code: "WORKSPACE_SCOPE_FORBIDDEN" }
        );
      }
      assert.equal(calls.length, 0);
    });

    it("명시 workspace와 key 기본값의 우선순위를 유지하고 생략은 global-only다", async () => {
      for (const [scope, expected] of [
        [{ workspace: "project-a", _defaultWorkspace: "project-b" }, "project-a"],
        [{ _defaultWorkspace: "project-b" }, "project-b"],
        [{}, null]
      ]) {
        const { recaller, calls } = createRecaller();
        await recaller[method]({
          ...args, ...scope, agentId: "agent-a", _keyId: "key-a", _groupKeyIds: ["key-a", "key-b"]
        });
        for (const call of calls) {
          assert.equal(call[1], "agent-a");
          assert.equal(call[2], "key-a");
          assert.deepEqual(call[3], ["key-a", "key-b"]);
          assert.deepEqual(call[4], {
            workspace: expected, allWorkspaces: false, includePeerAgents: false
          });
        }
      }
    });

    it("공개 도구는 allWorkspaces/peer 권한 위반을 manager 호출 전에 거부한다", async () => {
      managerCalls = [];
      for (const scope of [{ allWorkspaces: true }, { includePeerAgents: true }]) {
        const result = await tool({ ...args, ...scope, _keyId: "key-a", _isMaster: false });
        assert.equal(result.success, false);
        assert.match(result.error, /master/);
      }
      assert.equal(managerCalls.length, 0);
    });

    it("공개 도구는 master allWorkspaces 요청을 허용한다", async () => {
      managerCalls = [];
      const result = await tool({ ...args, _isMaster: true, allWorkspaces: true });
      assert.equal(result.success, true);
      assert.equal(managerCalls.length, 1);
      assert.equal(managerCalls[0].allWorkspaces, true);
    });
  });
}
