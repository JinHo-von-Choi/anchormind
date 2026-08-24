import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";

import { validateSecurityPilotStartup } from "../../lib/security-pilot.js";

const CACHE = "/cache/huggingface/hub";
const MODEL_DIR = `${CACHE}/models--Xenova--multilingual-e5-small`;
const SNAPSHOT = `${MODEL_DIR}/snapshots/abc123`;
const serverSource = readFileSync(new URL("../../server.js", import.meta.url), "utf8");
const runnerSource = readFileSync(new URL("../../scripts/run-security-pilot.sh", import.meta.url), "utf8");
const envFile = readFileSync(new URL("../../.env.security-pilot.example", import.meta.url), "utf8");

function pilotEnv(overrides = {}) {
  return {
    MEMENTO_SECURITY_PILOT_AUTOMATION: "off",
    MEMENTO_AUTO_REFLECT: "false",
    MEMENTO_ACCESS_KEY: "local-security-pilot-access-key",
    MEMENTO_AUTH_DISABLED: "false",
    MEMENTO_BIND_HOST: "127.0.0.1",
    ENABLE_SPREADING_ACTIVATION: "false",
    ENABLE_RECONSOLIDATION: "false",
    MEMENTO_GRAPH_LINK: "false",
    MEMENTO_CONSOLIDATE: "false",
    MEMENTO_GC: "false",
    MEMENTO_CONSOLIDATE_SPLIT_LONG: "false",
    MEMENTO_CONSOLIDATE_DETECT_CONTRADICT: "false",
    MEMENTO_CONSOLIDATE_COMPRESS_OLD: "false",
    EMBEDDING_PROVIDER: "transformers",
    EMBEDDING_MODEL: SNAPSHOT,
    EMBEDDING_DIMENSIONS: "384",
    EMBEDDING_API_KEY: "",
    EMBEDDING_BASE_URL: "",
    SECURITY_PILOT_MODEL_ID: "Xenova/multilingual-e5-small",
    SECURITY_PILOT_MODEL_CACHE: CACHE,
    SECURITY_PILOT_MODEL_SNAPSHOT: SNAPSHOT,
    HF_HUB_OFFLINE: "1",
    TRANSFORMERS_OFFLINE: "1",
    HF_DATASETS_OFFLINE: "1",
    LLM_PRIMARY: "none",
    LLM_FALLBACKS: "[]",
    MEMENTO_SPLIT_LLM_PRIMARY: "none",
    MEMENTO_SPLIT_LLM_FALLBACKS: "[]",
    ...overrides
  };
}

describe("whole-branch security hardening round 3", () => {
  test("pilot requires an access key and explicit authentication", () => {
    let touched = false;
    const result = validateSecurityPilotStartup(pilotEnv({
      MEMENTO_ACCESS_KEY: "",
      MEMENTO_AUTH_DISABLED: "true",
      MEMENTO_BIND_HOST: "0.0.0.0"
    }), { exists: () => { touched = true; return true; } });
    assert.equal(result.ok, false);
    assert.match(result.reason, /access key|authentication/i);
    assert.equal(touched, false, "auth rejection must happen before filesystem checks");
  });

  test("pilot rejects wildcard, IPv6, and non-127.0.0.1 bind hosts", () => {
    for (const host of ["0.0.0.0", "::", "::1", "127.0.0.2", "192.0.2.10"]) {
      const result = validateSecurityPilotStartup(pilotEnv({ MEMENTO_BIND_HOST: host }), { exists: () => true });
      assert.equal(result.ok, false, `host ${host} must be rejected`);
      assert.match(result.reason, /bind|127\.0\.0\.1|loopback/i);
    }
  });

  test("unset bind host is accepted only because it resolves to 127.0.0.1", () => {
    const env = pilotEnv();
    delete env.MEMENTO_BIND_HOST;
    const result = validateSecurityPilotStartup(env, { exists: () => true });
    assert.equal(result.ok, true, result.reason);
  });

  test("pilot accepts only an absolute snapshot with required local files", () => {
    const result = validateSecurityPilotStartup(pilotEnv(), { exists: () => true });
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.paths.snapshot, SNAPSHOT);
  });

  test("pilot rejects a model id, outside snapshot, or incomplete snapshot", () => {
    for (const embeddingModel of [
      "Xenova/multilingual-e5-small",
      "/tmp/foreign-snapshot",
      `${MODEL_DIR}/snapshots/../other`
    ]) {
      const result = validateSecurityPilotStartup(pilotEnv({ EMBEDDING_MODEL: embeddingModel }), { exists: () => true });
      assert.equal(result.ok, false, `${embeddingModel} must not be accepted`);
      assert.match(result.reason, /snapshot|model/i);
    }

    const result = validateSecurityPilotStartup(pilotEnv(), {
      exists: candidate => candidate === CACHE || candidate === SNAPSHOT
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /config|tokenizer|ONNX|snapshot|file/i);
  });

  test("startup validation precedes HTTP server creation and runner exports the same snapshot", () => {
    assert.ok(serverSource.indexOf("validateSecurityPilotStartup") < serverSource.indexOf("createHttpServer({"));
    assert.match(runnerSource, /export EMBEDDING_MODEL="\$SNAPSHOT_DIR"/);
    assert.match(envFile, /^MEMENTO_ACCESS_KEY=.+$/m);
    assert.match(envFile, /^MEMENTO_AUTH_DISABLED=false$/m);
    assert.match(envFile, /^MEMENTO_BIND_HOST=127\.0\.0\.1$/m);
    assert.match(envFile, /^EMBEDDING_MODEL=$/m);
  });
});
