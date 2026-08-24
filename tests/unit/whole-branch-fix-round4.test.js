import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { graphLinkScopeAllowed } from "../../lib/memory/link/GraphLinker.js";
import { validateSecurityPilotStartup } from "../../lib/security-pilot.js";
import { tool_memoryConsolidate } from "../../lib/tools/memory.js";
import { reconsolidate } from "../../lib/memory/link/ReconsolidationEngine.js";
import { FragmentGC } from "../../lib/memory/consolidate/FragmentGC.js";

const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const recallerSource = readFileSync(new URL("../../lib/memory/processors/MemoryRecaller.js", import.meta.url), "utf8");
const feedbackSource = readFileSync(new URL("../../lib/tools/memory.js", import.meta.url), "utf8");
const reconsolidationSource = readFileSync(new URL("../../lib/memory/link/ReconsolidationEngine.js", import.meta.url), "utf8");
const consolidatorSource = readFileSync(new URL("../../lib/memory/consolidate/MemoryConsolidator.js", import.meta.url), "utf8");
const fragmentGcSource = readFileSync(new URL("../../lib/memory/consolidate/FragmentGC.js", import.meta.url), "utf8");
const graphSource = readFileSync(new URL("../../lib/memory/link/GraphLinker.js", import.meta.url), "utf8");

const requiredOff = {
  ENABLE_SPREADING_ACTIVATION: "false",
  ENABLE_RECONSOLIDATION: "false",
  MEMENTO_AUTO_REFLECT: "false",
  MEMENTO_GRAPH_LINK: "false",
  MEMENTO_CONSOLIDATE: "false",
  MEMENTO_GC: "false",
  MEMENTO_CONSOLIDATE_SPLIT_LONG: "false",
  MEMENTO_CONSOLIDATE_DETECT_CONTRADICT: "false",
  MEMENTO_CONSOLIDATE_COMPRESS_OLD: "false"
};

function pilotEnv(overrides = {}) {
  return {
    MEMENTO_SECURITY_PILOT_AUTOMATION: "off",
    MEMENTO_ACCESS_KEY: "round4-access-key",
    MEMENTO_AUTH_DISABLED: "false",
    MEMENTO_BIND_HOST: "127.0.0.1",
    EMBEDDING_PROVIDER: "transformers",
    EMBEDDING_MODEL: "/cache/huggingface/hub/models--Xenova--multilingual-e5-small/snapshots/abc123",
    EMBEDDING_DIMENSIONS: "384",
    EMBEDDING_API_KEY: "",
    EMBEDDING_BASE_URL: "",
    SECURITY_PILOT_MODEL_ID: "Xenova/multilingual-e5-small",
    SECURITY_PILOT_MODEL_CACHE: "/cache/huggingface/hub",
    SECURITY_PILOT_MODEL_SNAPSHOT: "/cache/huggingface/hub/models--Xenova--multilingual-e5-small/snapshots/abc123",
    HF_HUB_OFFLINE: "1",
    TRANSFORMERS_OFFLINE: "1",
    HF_DATASETS_OFFLINE: "1",
    LLM_PRIMARY: "none",
    LLM_FALLBACKS: "[]",
    MEMENTO_SPLIT_LLM_PRIMARY: "none",
    MEMENTO_SPLIT_LLM_FALLBACKS: "[]",
    ...requiredOff,
    ...overrides
  };
}

describe("whole-branch security hardening round 4", () => {
  test("validator requires every mutation and maintenance flag to be explicitly false", () => {
    for (const name of Object.keys(requiredOff)) {
      const env = pilotEnv({ [name]: undefined });
      const result = validateSecurityPilotStartup(env, { exists: () => true });
      assert.equal(result.ok, false, `${name} missing must fail closed`);
      assert.match(result.reason, new RegExp(name));
    }

    const hostile = validateSecurityPilotStartup(pilotEnv({ ENABLE_RECONSOLIDATION: "true" }), { exists: () => true });
    assert.equal(hostile.ok, false);
    assert.match(hostile.reason, /ENABLE_RECONSOLIDATION/);
  });

  test("pilot graph scope is disabled even for an otherwise exact tuple", () => {
    assert.equal(graphLinkScopeAllowed({ keyId: "key-a", workspace: "ws-a" }, { pilot: true }), false);
    assert.match(graphSource, /isSecurityPilotAutomationOff/);
  });

  test("runtime maintenance paths have pilot defense-in-depth guards", () => {
    assert.match(recallerSource, /isSecurityPilotAutomationOff/);
    assert.match(recallerSource, /ENABLE_SPREADING_ACTIVATION/);
    assert.match(feedbackSource, /ENABLE_RECONSOLIDATION/);
    assert.match(feedbackSource, /isSecurityPilotAutomationOff/);
    assert.match(reconsolidationSource, /isSecurityPilotAutomationOff/);
    assert.match(consolidatorSource, /isSecurityPilotAutomationOff/);
    assert.match(fragmentGcSource, /isSecurityPilotAutomationOff/);
  });

  test("direct maintenance tools return disabled without reaching a write", async () => {
    const previousPilot = process.env.MEMENTO_SECURITY_PILOT_AUTOMATION;
    const previousReconsolidation = process.env.ENABLE_RECONSOLIDATION;
    process.env.MEMENTO_SECURITY_PILOT_AUTOMATION = "off";
    process.env.ENABLE_RECONSOLIDATION = "true";
    try {
      const consolidate = await tool_memoryConsolidate({ _keyId: null });
      const reconsolidated = await reconsolidate("link-round4", "reinforce");
      const gc = await new FragmentGC().deleteExpired();
      assert.equal(consolidate.disabled, true);
      assert.equal(reconsolidated, null);
      assert.equal(gc, 0);
    } finally {
      if (previousPilot === undefined) delete process.env.MEMENTO_SECURITY_PILOT_AUTOMATION;
      else process.env.MEMENTO_SECURITY_PILOT_AUTOMATION = previousPilot;
      if (previousReconsolidation === undefined) delete process.env.ENABLE_RECONSOLIDATION;
      else process.env.ENABLE_RECONSOLIDATION = previousReconsolidation;
    }
  });

  test("hostile direct node server startup fails on the flag gate before listening", () => {
    const childEnv = {
      ...process.env,
      ...pilotEnv({ ENABLE_SPREADING_ACTIVATION: "true" }),
      NODE_NO_WARNINGS: "1"
    };
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", "import('./server.js')"], {
      cwd: ROOT,
      env: childEnv,
      encoding: "utf8",
      timeout: 10_000
    });
    assert.notEqual(child.status, 0);
    assert.match(`${child.stdout}\n${child.stderr}`, /ENABLE_SPREADING_ACTIVATION/);
    assert.doesNotMatch(`${child.stdout}\n${child.stderr}`, /HTTP server listening on port/);
  });
});
