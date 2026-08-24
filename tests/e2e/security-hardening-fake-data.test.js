import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "../fixtures/security-hardening-data.js";
import {
  createSecurityPilotHarness,
  networkTripwire,
  runAutoReflectFixture
} from "../fixtures/security-hardening-harness.js";

const activeHarnesses = new Set();

afterEach(async () => {
  for (const harness of activeHarnesses) await harness.close();
  activeHarnesses.clear();
});

function newHarness() {
  const harness = createSecurityPilotHarness(fixture);
  activeHarnesses.add(harness);
  return harness;
}

describe("security hardening fake-data MCP boundary", () => {
  test("unauthenticated MCP request is rejected", async () => {
    const harness = newHarness();
    const { baseUrl } = await harness.start();
    const response = await fetch(baseUrl + "/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "recall", arguments: {} }
      })
    });
    assert.equal(response.status, 401);
  });

  test("key-a/ws-a MCP flow cannot see key-b or ws-b", async () => {
    const harness = newHarness();
    await harness.start();
    const result = await harness.callTool("recall", {
      _keyId: "key-a",
      _groupKeyIds: ["key-a"],
      workspace: "ws-a",
      keywords: ["pilot"]
    });
    assert.deepEqual(result.fragments.map((row) => row.id).sort(), ["a-a"]);
  });

  test("AutoReflect preserves key/workspace and excludes foreign session groups", async () => {
    const result = await runAutoReflectFixture({
      sessionId: "s-a",
      agentId: "agent-a",
      keyId: "key-a",
      groupKeyIds: ["key-a"],
      workspace: "ws-a"
    });
    assert.deepEqual(result.groups.map((group) => group.workspace), ["ws-a"]);
    assert.ok(result.fragments.every((row) => row.key_id === "key-a" && row.workspace === "ws-a"));
  });

  test("fake-data E2E performs zero external network calls", async () => {
    const harness = newHarness();
    await harness.start();
    assert.equal(process.env.ENABLE_SPREADING_ACTIVATION, "false");
    await harness.callTool("memory_stats", {
      _keyId: "key-a",
      _groupKeyIds: ["key-a"],
      workspace: "ws-a"
    });
    await harness.callTool("fragment_history", {
      id: "a-b",
      _keyId: "key-a",
      _groupKeyIds: ["key-a"],
      workspace: "ws-a"
    });
    assert.equal(networkTripwire.callsOutsideLoopback(), 0);
  });
});
