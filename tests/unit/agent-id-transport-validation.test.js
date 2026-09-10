import { describe, test, mock } from "node:test";
import assert from "node:assert/strict";

let resourceCalls = 0;
mock.module("../../lib/tools/resources.js", {
  exports: {
    RESOURCES: [],
    readResource: async () => {
      resourceCalls++;
      return { contents: [] };
    }
  }
});

const { dispatchJsonRpc } = await import("../../lib/jsonrpc.js");
const { TOOL_REGISTRY } = await import("../../lib/tool-registry.js");
const { rbacDeniedTotal } = await import("../../lib/metrics.js");

const master = {
  authenticated: true, keyId: null, groupKeyIds: null, permissions: null,
  defaultWorkspace: null, mode: null, sessionId: "validation-session", isMaster: true
};

describe("agentId transport length validation", () => {
  for (const method of ["tools/call", "resources/read"]) {
    test(`${method}: accepts 128 and rejects 129 without handler or RBAC denial`, async () => {
      const original = TOOL_REGISTRY.get("recall");
      let toolCalls = 0;
      TOOL_REGISTRY.set("recall", {
        ...original, post: null, log: null,
        handler: async () => { toolCalls++; return { content: [] }; }
      });
      const invoke = agentId => dispatchJsonRpc({
        id: 1, method,
        params: method === "tools/call"
          ? { name: "recall", arguments: { agentId } }
          : { uri: "memory://stats", agentId }
      }, master);
      try {
        const accepted = await invoke("a".repeat(128));
        assert.equal(accepted.kind, "ok");
        const beforeTools = toolCalls;
        const beforeResources = resourceCalls;
        const beforeDenials = await rbacDeniedTotal.get();
        const rejected = await invoke("a".repeat(129));
        assert.equal(rejected.response.error.code, -32602);
        assert.match(rejected.response.error.message, /agentId.*128/);
        assert.equal(toolCalls, beforeTools);
        assert.equal(resourceCalls, beforeResources);
        assert.deepEqual(await rbacDeniedTotal.get(), beforeDenials);
      } finally {
        TOOL_REGISTRY.set("recall", original);
      }
    });
  }
});
