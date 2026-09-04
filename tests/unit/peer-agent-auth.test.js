import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dispatchJsonRpc, handleToolsCall, handleToolsList } from "../../lib/jsonrpc.js";
import { TOOL_REGISTRY } from "../../lib/tool-registry.js";

const tenantCtx = {
  authenticated: true,
  keyId: "synthetic-key", groupKeyIds: ["synthetic-key"], permissions: ["read"],
  defaultWorkspace: "workspace-a", mode: null, sessionId: "session-a", isMaster: false
};
const masterCtx = {
  authenticated: true,
  keyId: null, groupKeyIds: null, permissions: null,
  defaultWorkspace: null, mode: null, sessionId: "session-master", isMaster: true
};

function withStubbedTool(name, handler, run) {
  const original = TOOL_REGISTRY.get(name);
  TOOL_REGISTRY.set(name, { ...original, handler });
  return Promise.resolve(run()).finally(() => TOOL_REGISTRY.set(name, original));
}

describe("trusted tool context authorization", () => {
  it("sessionData 없는 직접 dispatch를 거부한다", async () => {
    const result = await dispatchJsonRpc({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "recall", arguments: { _keyId: null, _permissions: null } }
    });
    assert.equal(result.response.error.code, -32600);
  });

  it("API key에 바인딩되지 않은 non-master OAuth identity는 진단 가능한 권한 오류를 반환한다", async () => {
    const result = await dispatchJsonRpc({
      jsonrpc: "2.0", id: 11, method: "tools/call",
      params: { name: "recall", arguments: {} }
    }, {
      ...tenantCtx, keyId: null, permissions: null, isMaster: false
    });
    assert.equal(result.response.error.code, -32001);
    assert.match(result.response.error.message, /API-key binding/);
  });

  it("일반 API key의 peer 조회와 non-default agent 읽기·쓰기를 거부한다", async () => {
    for (const [name, permissions] of [["recall", ["read"]], ["remember", ["write"]]]) {
      await assert.rejects(
        handleToolsCall(
          { name, arguments: { agentId: "agent-b", includePeerAgents: name === "recall" } },
          { ...tenantCtx, permissions }
        ),
        error => error.code === -32001
      );
    }
  });

  it("일반 API key의 default agent는 허용하고 내부 필드는 서버값으로 덮는다", async () => {
    await withStubbedTool("recall", async args => ({
      success: true,
      keyId: args._keyId,
      groupKeyIds: args._groupKeyIds,
      workspace: args._defaultWorkspace
    }), async () => {
      const result = await handleToolsCall({
        name: "recall",
        arguments: {
          agentId: "default", _keyId: null, _groupKeyIds: ["forged"],
          _permissions: null, _defaultWorkspace: "forged"
        }
      }, tenantCtx);
      const payload = JSON.parse(result.content[0].text);
      assert.equal(payload.keyId, "synthetic-key");
      assert.deepEqual(payload.groupKeyIds, ["synthetic-key"]);
      assert.equal(payload.workspace, "workspace-a");
    });
  });

  it("read-only API context에서 _permissions=null 위조로 write 권한을 얻지 못한다", async () => {
    const result = await dispatchJsonRpc({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "remember", arguments: { _permissions: null, content: "synthetic" } }
    }, tenantCtx);
    assert.equal(result.response.error.code, -32001);
  });

  it("master는 임의 agent와 peer flag를 handler까지 전달한다", async () => {
    await withStubbedTool("recall", async args => ({
      success: true, agentId: args.agentId, peer: args.includePeerAgents
    }), async () => {
      const result = await handleToolsCall({
        name: "recall", arguments: { agentId: "agent-a", includePeerAgents: true }
      }, masterCtx);
      const payload = JSON.parse(result.content[0].text);
      assert.equal(payload.agentId, "agent-a");
      assert.equal(payload.peer, true);
    });
  });

  it("admin permission도 requiresMaster 도구의 explicit master 조건을 우회하지 못한다", async () => {
    for (const name of ["apply_update", "check_update", "memory_stats"]) {
      await withStubbedTool(name, async () => ({ success: true }), async () => {
        await assert.rejects(
          handleToolsCall(
            { name, arguments: {} },
            { ...tenantCtx, permissions: ["admin"] }
          ),
          error => error.code === -32001 && /requires master/.test(error.message)
        );
      });
    }
  });

  it("non-master tools/list에서 requiresMaster 도구를 숨긴다", () => {
    const tenantNames = handleToolsList({}, tenantCtx).tools.map(tool => tool.name);
    const masterNames = handleToolsList({}, masterCtx).tools.map(tool => tool.name);
    for (const name of ["apply_update", "check_update", "memory_stats"]) {
      assert.equal(tenantNames.includes(name), false);
      assert.equal(masterNames.includes(name), true);
    }
  });
});
