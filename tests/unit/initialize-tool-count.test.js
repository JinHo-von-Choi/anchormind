import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { dispatchJsonRpc } from "../../lib/jsonrpc.js";

describe("initialize tool count follows the session tools/list", () => {
  for (const [name, session] of [
    ["master", { keyId: null, isMaster: true, permissions: null }],
    ["scoped key", { keyId: "test-key", isMaster: false, permissions: ["read"] }],
    ["legacy session without explicit master identity", { keyId: null }],
    ["scoped recall-only mode", { keyId: "test-key", isMaster: false, mode: "recall-only" }],
    ["master audit mode", { keyId: null, isMaster: true, mode: "audit" }],
    ["scoped key cannot assume master-only mode", { keyId: "test-key", isMaster: false, mode: "audit" }]
  ]) {
    test(name, async () => {
      const initialized = await dispatchJsonRpc({
        id: 1, method: "initialize", params: {
          protocolVersion: "2025-11-25",
          isMaster: true, mode: "audit"
        }
      }, session);
      const listed = await dispatchJsonRpc({ id: 2, method: "tools/list" }, session);
      assert.equal(initialized.kind, "ok");
      assert.equal(listed.kind, "ok");
      const count = Number(initialized.response.result.serverInfo.description.match(/도구 (\d+)개/)[1]);
      assert.equal(count, listed.response.result.tools.length);
      assert.equal(listed.response.result.tools.some(tool => tool.name === "apply_update"),
        session.isMaster === true);
    });
  }
});
