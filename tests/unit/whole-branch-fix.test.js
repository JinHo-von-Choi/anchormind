import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { readFileSync } from "node:fs";

import { exactScopeClause } from "../../lib/memory/keyScope.js";
import { isSecurityPilotAutomationOff } from "../../lib/security-pilot.js";
import { isHealthRequestAuthorized } from "../../lib/handlers/health-handler.js";
import { handleHealth, handleMetrics } from "../../lib/handlers/health-handler.js";
import { workingMemoryRedisKey } from "../../lib/memory/FragmentIndex.js";

const schedulerSource = readFileSync(new URL("../../lib/scheduler.js", import.meta.url), "utf8");
const serverSource = readFileSync(new URL("../../server.js", import.meta.url), "utf8");
const graphSource = readFileSync(new URL("../../lib/memory/link/GraphLinker.js", import.meta.url), "utf8");
const topicSource = readFileSync(new URL("../../lib/memory/read/TopicResolver.js", import.meta.url), "utf8");
const contextSource = readFileSync(new URL("../../lib/memory/read/ContextBuilder.js", import.meta.url), "utf8");
const embedderSource = readFileSync(new URL("../../lib/embeddings/LocalTransformersEmbedder.js", import.meta.url), "utf8");

describe("whole-branch security hardening", () => {
  test("security pilot automation off is explicit and fail-closed", () => {
    assert.equal(isSecurityPilotAutomationOff("off"), true);
    assert.equal(isSecurityPilotAutomationOff("OFF"), true);
    assert.equal(isSecurityPilotAutomationOff("on"), false);
    assert.equal(isSecurityPilotAutomationOff(undefined), false);
  });

  test("scheduler does not launch unscoped GraphLinker work", () => {
    assert.match(schedulerSource, /isSecurityPilotAutomationOff/);
    assert.match(schedulerSource, /linkFragment\(fragmentId,\s*["']system["'],\s*null/);
    assert.match(schedulerSource, /startSchedulers[\s\S]*isSecurityPilotAutomationOff[\s\S]*return/);
  });

  test("security pilot off guards server automation preload", () => {
    assert.match(serverSource, /MEMENTO_SECURITY_PILOT_AUTOMATION|isSecurityPilotAutomationOff/);
    assert.match(serverSource, /preloadReranker\(\)/);
    assert.match(serverSource, /warmupMorpheme\(\)/);
  });

  test("GraphLinker refuses missing exact key/workspace before any mutation", () => {
    assert.match(graphSource, /exact key.*workspace|exact.*scope/i);
    assert.match(graphSource, /return 0/);
    assert.match(graphSource, /valid_to/);
    assert.match(graphSource, /access_count/);
  });

  test("TopicResolver supports exact key/workspace scope", () => {
    const params = [];
    const clause = exactScopeClause(params, "f", { keyId: "key-a", workspace: "ws-a" });
    assert.match(clause, /f\.key_id\s*=\s*\$1/);
    assert.match(clause, /f\.workspace\s*=\s*\$2/);
    assert.match(topicSource, /exactScopeClause/);
  });

  test("working memory namespace carries exact key/workspace and rejects partial scope", () => {
    const scoped = workingMemoryRedisKey("session-a", { keyId: "key-a", workspace: "ws-a" });
    assert.notEqual(scoped, workingMemoryRedisKey("session-a", { keyId: "key-a", workspace: "ws-b" }));
    assert.equal(workingMemoryRedisKey("session-a", { keyId: "key-a" }), null);
    assert.equal(workingMemoryRedisKey("session-a", {}), "frag:wm:session-a");
    assert.match(contextSource, /getWorkingMemory\(params\.sessionId[\s\S]*params/);
  });

  test("local embedder explicitly disables remote model resolution in offline/pilot mode", () => {
    assert.match(embedderSource, /allowRemoteModels\s*:\s*false/);
    assert.match(embedderSource, /HF_HUB_OFFLINE|TRANSFORMERS_OFFLINE|SECURITY_PILOT/);
    assert.match(embedderSource, /cacheDir|localModelPath/);
  });

  test("health and metrics authorization are fail-closed without access key", () => {
    assert.equal(isHealthRequestAuthorized({ accessKey: "", authDisabled: false, req: { headers: {} } }), false);
    assert.equal(isHealthRequestAuthorized({ accessKey: "", authDisabled: true, req: { headers: {} } }), true);
  });

  test("actual health and metrics handlers reject missing credentials", async () => {
    const makeRes = () => ({
      statusCode: 0,
      headers: {},
      body: "",
      setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
      end(body = "") { this.body = body; }
    });
    const req = { method: "GET", headers: {}, socket: {} };
    const healthRes = makeRes();
    const metricsRes = makeRes();
    await handleHealth(req, healthRes, process.hrtime.bigint());
    await handleMetrics(req, metricsRes, process.hrtime.bigint());
    assert.equal(healthRes.statusCode, 401);
    assert.equal(metricsRes.statusCode, 401);
  });
});
