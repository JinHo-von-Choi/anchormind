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

const { handleResourcesRead, dispatchJsonRpc } = await import("../../lib/jsonrpc.js");

const tenant = {
  authenticated: true,
  keyId: "synthetic-key",
  groupKeyIds: ["synthetic-key"],
  permissions: ["read"],
  defaultWorkspace: "workspace-a",
  mode: null,
  sessionId: "session-a",
  isMaster: false
};

beforeEach(() => { calls.length = 0; });

describe("resources/read trusted agent scope", () => {
  it("stats/topics에 default agent, key, workspace 범위를 적용한다", async () => {
    for (const uri of ["memory://stats", "memory://topics"]) {
      await handleResourcesRead({ uri }, tenant);
      const call = calls.at(-1);
      assert.match(call.sql, /f\.agent_id = \$1/);
      assert.match(call.sql, /f\.key_id/);
      assert.match(call.sql, /f\.workspace/);
      assert.deepEqual(call.params, [
        "default", "synthetic-key", ["synthetic-key"], "workspace-a"
      ]);
    }
  });

  it("workspace가 없으면 전역(NULL) resource만 조회한다", async () => {
    await handleResourcesRead(
      { uri: "memory://stats" },
      { ...tenant, defaultWorkspace: null }
    );
    assert.match(calls[0].sql, /f\.workspace IS NULL/);
    assert.deepEqual(calls[0].params, [
      "default", "synthetic-key", ["synthetic-key"]
    ]);
  });

  it("client resource params로 peer/master/session identity를 위조할 수 없다", async () => {
    const result = await dispatchJsonRpc({
      jsonrpc: "2.0", id: 1, method: "resources/read",
      params: {
        uri: "memory://stats", includePeerAgents: true,
        _isMaster: true, _keyId: null, _permissions: null
      }
    }, tenant);
    assert.equal(result.response.error.code, -32001);
    assert.equal(calls.length, 0);
  });

  it("trusted context가 없거나 identity 조합이 모순이면 fail-closed한다", async () => {
    await assert.rejects(
      handleResourcesRead({ uri: "memory://stats" }),
      error => error.code === -32600
    );
    for (const bad of [
      { ...tenant, keyId: null },
      { ...tenant, isMaster: true, permissions: null }
    ]) {
      await assert.rejects(
        handleResourcesRead({ uri: "memory://stats" }, bad),
        error => error.code === -32001
      );
    }
    assert.equal(calls.length, 0);
  });

  it("write-only session은 resource read 권한이 없다", async () => {
    await assert.rejects(
      handleResourcesRead({ uri: "memory://stats" }, { ...tenant, permissions: ["write"] }),
      error => error.code === -32001
    );
  });
});
