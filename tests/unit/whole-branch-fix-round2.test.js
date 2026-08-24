import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { readFileSync } from "node:fs";

import {
  isAutoReflectDisabled,
  resolveSecurityPilotModelPaths,
  validateSecurityPilotStartup
} from "../../lib/security-pilot.js";
import { graphLinkScopeAllowed } from "../../lib/memory/link/GraphLinker.js";
import { autoReflect } from "../../lib/memory/processors/AutoReflect.js";

const sessionsSource = readFileSync(new URL("../../lib/sessions.js", import.meta.url), "utf8");
const adminSessionsSource = readFileSync(new URL("../../lib/admin/admin-sessions.js", import.meta.url), "utf8");
const serverSource = readFileSync(new URL("../../server.js", import.meta.url), "utf8");
const runnerSource = readFileSync(new URL("../../scripts/run-security-pilot.sh", import.meta.url), "utf8");
const graphLinkSource = readFileSync(new URL("../../lib/memory/link/GraphLinker.js", import.meta.url), "utf8");
const consolidatorSource = readFileSync(new URL("../../lib/memory/consolidate/MemoryConsolidator.js", import.meta.url), "utf8");

describe("whole-branch security hardening round 2", () => {
  test("AutoReflect disable policy covers both pilot and explicit auto-reflect off", () => {
    assert.equal(isAutoReflectDisabled({ MEMENTO_SECURITY_PILOT_AUTOMATION: "off" }), true);
    assert.equal(isAutoReflectDisabled({ MEMENTO_AUTO_REFLECT: "false" }), true);
    assert.equal(isAutoReflectDisabled({ MEMENTO_SECURITY_PILOT_AUTOMATION: "on", MEMENTO_AUTO_REFLECT: "true" }), false);
    assert.match(sessionsSource, /isAutoReflectDisabled/);
    assert.match(adminSessionsSource, /isAutoReflectDisabled/);
  });

  test("AutoReflect itself returns before tracker, LLM, or manager work when disabled", async () => {
    const previous = process.env.MEMENTO_AUTO_REFLECT;
    process.env.MEMENTO_AUTO_REFLECT = "false";
    try {
      const result = await autoReflect("round2-disabled-session");
      assert.equal(result.reason, "automation_disabled");
      assert.equal(result.count, 0);
    } finally {
      if (previous === undefined) delete process.env.MEMENTO_AUTO_REFLECT;
      else process.env.MEMENTO_AUTO_REFLECT = previous;
    }
  });

  test("startup validation fails closed for an incomplete pilot", () => {
    const result = validateSecurityPilotStartup({
      MEMENTO_SECURITY_PILOT_AUTOMATION: "off",
      EMBEDDING_PROVIDER: "openai"
    }, { exists: () => false });
    assert.equal(result.ok, false);
    assert.match(result.reason, /transformers|local|access key/i);
  });

  test("startup validation accepts only the complete local offline pilot contract", () => {
    const env = {
      MEMENTO_SECURITY_PILOT_AUTOMATION: "off",
      MEMENTO_AUTO_REFLECT: "false",
      MEMENTO_ACCESS_KEY: "round2-access-key",
      MEMENTO_AUTH_DISABLED: "false",
      MEMENTO_BIND_HOST: "127.0.0.1",
      EMBEDDING_PROVIDER: "transformers",
      EMBEDDING_MODEL: "/cache/huggingface/hub/models--Xenova--multilingual-e5-small/snapshots/abc",
      EMBEDDING_DIMENSIONS: "384",
      SECURITY_PILOT_MODEL_ID: "Xenova/multilingual-e5-small",
      SECURITY_PILOT_MODEL_CACHE: "/cache/huggingface/hub",
      SECURITY_PILOT_MODEL_SNAPSHOT: "/cache/huggingface/hub/models--Xenova--multilingual-e5-small/snapshots/abc",
      HF_HUB_OFFLINE: "1",
      TRANSFORMERS_OFFLINE: "1",
      HF_DATASETS_OFFLINE: "1",
      LLM_PRIMARY: "none",
      LLM_FALLBACKS: "[]",
      MEMENTO_SPLIT_LLM_PRIMARY: "none",
      MEMENTO_SPLIT_LLM_FALLBACKS: "[]",
      RERANKER_URL: "",
      NLI_SERVICE_URL: "",
      EMBEDDING_BASE_URL: ""
    };
    const result = validateSecurityPilotStartup(env, { exists: () => true });
    assert.equal(result.ok, true, result.reason);
  });

  test("model resolver distinguishes hub root, model directory, and snapshot", () => {
    const result = resolveSecurityPilotModelPaths({
      SECURITY_PILOT_MODEL_ID: "Xenova/multilingual-e5-small",
      SECURITY_PILOT_MODEL_CACHE: "/cache/huggingface/hub",
      SECURITY_PILOT_MODEL_SNAPSHOT: "/cache/huggingface/hub/models--Xenova--multilingual-e5-small/snapshots/abc"
    });
    assert.equal(result.cacheRoot, "/cache/huggingface/hub");
    assert.equal(result.modelDir, "/cache/huggingface/hub/models--Xenova--multilingual-e5-small");
    assert.equal(result.snapshot, "/cache/huggingface/hub/models--Xenova--multilingual-e5-small/snapshots/abc");
  });

  test("GraphLinker preserves non-pilot legacy master behavior but exact-authenticated scope remains strict", () => {
    assert.equal(graphLinkScopeAllowed({ keyId: null, workspace: null }, { pilot: false }), true);
    assert.equal(graphLinkScopeAllowed({ keyId: null, workspace: null }, { pilot: true }), false);
    assert.equal(graphLinkScopeAllowed({ keyId: "key-a", workspace: null }, { pilot: false }), false);
    assert.equal(graphLinkScopeAllowed({ keyId: "key-a", workspace: "ws-a" }, { pilot: false }), true);
    assert.match(graphLinkSource, /VALUES \(\$1, \$2, 'co_retrieved'/);
    assert.match(graphLinkSource, /limitParam = exact \? "\$3" : "\$1"/);
  });

  test("consolidator skips retro-link imports in the security pilot", () => {
    assert.match(consolidatorSource, /isSecurityPilotAutomationOff/);
    assert.match(consolidatorSource, /name: "retro_link"[\s\S]*?isSecurityPilotAutomationOff\(\)[\s\S]*?import\("\.\.\/link\/GraphLinker\.js"\)/);
  });

  test("server validates pilot before listener creation and runner exports the hub root", () => {
    assert.match(serverSource, /validateSecurityPilotStartup/);
    assert.ok(serverSource.indexOf("validateSecurityPilotStartup") < serverSource.indexOf("server.listen"));
    assert.match(runnerSource, /MODEL_CACHE=.*huggingface\/hub/);
    assert.match(runnerSource, /EMBEDDING_MODEL="\$SNAPSHOT_DIR"/);
  });
});
