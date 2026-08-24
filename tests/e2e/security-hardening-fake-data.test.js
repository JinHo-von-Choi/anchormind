import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import http from "node:http";
import dns from "node:dns";
import { SessionActivityTracker } from "../../lib/memory/processors/SessionActivityTracker.js";
import { fixture } from "../fixtures/security-hardening-data.js";
import {
  createSecurityPilotHarness,
  networkTripwire,
  runAutoReflectFixture
} from "../fixtures/security-hardening-harness.js";

const require = createRequire(import.meta.url);

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
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {} }
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

  test("production MCP route rejects body scope spoofing", async () => {
    const harness = newHarness();
    const { baseUrl } = await harness.start();
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer pilot-key-a" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 2, method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, _keyId: "key-b", workspace: "ws-b" }
      })
    });
    assert.equal(response.status, 403);
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

  test("session activity scope is exact and rejects foreign metadata", () => {
    const activity = { keyId: "key-a", groupKeyIds: ["key-a"], workspace: "ws-a" };
    assert.equal(SessionActivityTracker._matchesScope(activity, {
      keyId: "key-a", groupKeyIds: ["key-a"], workspace: "ws-a"
    }), true);
    assert.equal(SessionActivityTracker._matchesScope(activity, {
      keyId: "key-a", groupKeyIds: ["key-a"], workspace: "ws-b"
    }), false);
  });

  test("AutoReflect scope mismatch performs no LLM, write, or reflected mutation", async () => {
    const result = await runAutoReflectFixture({
      sessionId: "s-foreign",
      agentId: "agent-a",
      keyId: "key-a",
      groupKeyIds: ["key-a"],
      workspace: "ws-a",
      activityWorkspace: "ws-b"
    });
    assert.equal(result.reason, "scope_mismatch");
    assert.deepEqual(result.calls, { llm: 0, reflect: 0 });
    assert.equal(result.reflected, false);
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
    const history = await harness.callTool("fragment_history", {
      id: "a-b",
      _keyId: "key-a",
      _groupKeyIds: ["key-a"],
      workspace: "ws-a"
    });
    assert.deepEqual(history, { success: false, reason: "not_found" });
    assert.equal(networkTripwire.callsOutsideLoopback(), 0);
  });

  test("offline tripwire rejects external HTTP, DNS, and child processes", async () => {
    const harness = newHarness();
    await harness.start();
    await assert.rejects(() => fetch("https://example.com"), /EXTERNAL_NETWORK_FORBIDDEN/);
    assert.throws(() => http.request("https://example.com"), /EXTERNAL_NETWORK_FORBIDDEN/);
    assert.throws(() => dns.lookup("example.com", () => {}), /EXTERNAL_NETWORK_FORBIDDEN/);
    assert.throws(() => require("node:child_process").spawn(process.execPath, ["-e", ""]), /EXTERNAL_NETWORK_FORBIDDEN/);
  });
});
