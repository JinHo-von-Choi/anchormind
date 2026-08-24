import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FragmentSearch } from "../../lib/memory/read/FragmentSearch.js";
import { ContextBuilder } from "../../lib/memory/read/ContextBuilder.js";
import { MemoryLinker } from "../../lib/memory/processors/MemoryLinker.js";
import { MemoryRecaller } from "../../lib/memory/processors/MemoryRecaller.js";

const graphSource = readFileSync(new URL("../../lib/memory/read/GraphNeighborSearch.js", import.meta.url), "utf8");
const memoryToolSource = readFileSync(new URL("../../lib/tools/memory.js", import.meta.url), "utf8");
const reconsolidationSource = readFileSync(new URL("../../lib/memory/link/ReconsolidationEngine.js", import.meta.url), "utf8");
const linkerSource = readFileSync(new URL("../../lib/memory/processors/MemoryLinker.js", import.meta.url), "utf8");
const writerSource = readFileSync(new URL("../../lib/memory/write/FragmentWriter.js", import.meta.url), "utf8");
const contradictionSource = readFileSync(new URL("../../lib/memory/link/ContradictionDetector.js", import.meta.url), "utf8");

describe("Task 2 round 2 exact tuple bypasses", () => {
  test("FragmentSearch temporal entrypoint forwards strict exact scope", async () => {
    let options;
    await FragmentSearch.prototype._searchTemporal.call({
      store: { searchByTimeRange: async (_from, _to, value) => { options = value; return []; } }
    }, {
      timeRange: { from: "2026-08-01", to: "2026-08-02" },
      agentId: "agent-a", keyId: "key-a", workspace: "ws-a", strictScope: true
    });
    assert.equal(options.keyId, "key-a");
    assert.equal(options.workspace, "ws-a");
    assert.equal(options.strictScope, true);
  });

  test("GraphNeighborSearch has strict exact tuple SQL and rejects global fallback", () => {
    assert.match(graphSource, /exactScopeClause/);
    assert.match(graphSource, /strictScope/);
    assert.match(graphSource, /FALSE|workspace\s*=\s*\$|key_id\s*=\s*\$/);
    assert.doesNotMatch(graphSource, /workspace\s*=\s*\$\{params\.length\} OR f\.workspace IS NULL/);
  });

  test("ContextBuilder anchor and learning reads receive scalar key/workspace scope", async () => {
    let anchorQuery;
    let learningCall;
    const builder = new ContextBuilder({
      recall: async () => ({ fragments: [] }),
      index: { getWorkingMemory: async () => [], setSeenIds: async () => {} },
      store: {
        searchBySource: async (...args) => { learningCall = args; return []; }
      },
      getPool: () => ({ query: async (sql, params) => {
        anchorQuery = { sql, params };
        return { rows: [] };
      } })
    });
    await builder.build({ types: [], _keyId: "key-a", workspace: "ws-a" });
    assert.match(anchorQuery.sql, /key_id\s*=\s*\$|exactScopeClause/);
    assert.match(anchorQuery.sql, /workspace\s*=\s*\$/);
    assert.doesNotMatch(anchorQuery.sql, /ANY|workspace\s+IS\s+NULL/);
    assert.deepEqual(learningCall, ["learning_extraction", "default", "key-a", 5, "ws-a", { strictScope: true }]);
  });

  test("ContextBuilder anchor result cannot include cross-workspace or global fixtures", async () => {
    const builder = new ContextBuilder({
      recall: async () => ({ fragments: [] }),
      index: { getWorkingMemory: async () => [], setSeenIds: async () => {} },
      store: { searchBySource: async () => [] },
      getPool: () => ({ query: async () => ({ rows: [
        { id: "a-a", content: "same tuple", type: "preference", importance: 1, key_id: "key-a", workspace: "ws-a" },
        { id: "a-b", content: "other workspace", type: "preference", importance: 1, key_id: "key-a", workspace: "ws-b" },
        { id: "global", content: "global", type: "preference", importance: 1, key_id: null, workspace: null }
      ] }) })
    });
    const result = await builder.build({ types: [], _keyId: "key-a", workspace: "ws-a" });
    assert.deepEqual(result.fragments.map(f => f.id), ["a-a"]);
  });

  test("MemoryRecaller.context propagates API key and default workspace to ContextBuilder", async () => {
    let seen;
    const recaller = new MemoryRecaller({
      contextBuilder: { build: async params => { seen = params; return { fragments: [] }; } }
    });
    await recaller.context({ _keyId: "key-a", _defaultWorkspace: "ws-a" });
    assert.equal(seen._keyId, "key-a");
    assert.equal(seen.workspace, "ws-a");
  });

  test("tool_recall includeContext passes workspace and strict scope to source search", () => {
    const body = memoryToolSource.slice(memoryToolSource.indexOf("if (args.includeContext)"), memoryToolSource.indexOf("const contradictionPending", memoryToolSource.indexOf("if (args.includeContext)")));
    assert.match(body, /searchBySource\([^\n]*workspace/);
    assert.match(body, /strictScope/);
  });

  test("feedback link ownership and reconsolidation UPDATE recheck both tuple axes", () => {
    const feedbackBody = memoryToolSource.slice(memoryToolSource.indexOf("export async function tool_toolFeedback"), memoryToolSource.indexOf("export async function tool_memoryStats"));
    assert.match(feedbackBody, /JOIN[\s\S]*fragments/);
    assert.match(feedbackBody, /workspace/);
    assert.match(reconsolidationSource, /exactScopeClause|from_frag/);
    assert.match(reconsolidationSource, /workspace/);
  });

  test("resolved_by importance update carries the exact tuple", () => {
    assert.match(linkerSource, /update[\s\S]*importance[\s\S]*workspace[\s\S]*strictScope/);
  });

  test("MemoryLinker update entrypoint carries key/workspace and preserves workspace-only legacy", async () => {
    const updates = [];
    const scopes = [];
    const store = {
      getById: async (id) => ({ id, type: "error", importance: 0.9 }),
      createLink: async (_from, _to, _relation, _agent, _weight, scope) => { scopes.push(scope); return true; },
      update: async (...args) => { updates.push(args); return {}; }
    };
    const linker = new MemoryLinker({ store, index: {} });
    await linker.link({ fromId: "a-a", toId: "a-a", relationType: "resolved_by", _keyId: "key-a", workspace: "ws-a" });
    assert.equal(updates[0][5].keyId, "key-a");
    assert.equal(updates[0][5].workspace, "ws-a");
    assert.equal(updates[0][5].strictScope, true);

    updates.length = 0;
    scopes.length = 0;
    await linker.link({ fromId: "a-a", toId: "a-a", relationType: "resolved_by", workspace: "ws-a" });
    assert.equal(scopes[0].strictScope, false);
    assert.equal(updates[0][5].strictScope, false);
  });

  test("strict forget cleanup scopes links and linked_to updates", () => {
    const deleteBody = writerSource.slice(writerSource.indexOf("async delete("), writerSource.indexOf("async deleteMany("));
    assert.match(deleteBody, /exactScopeClause/);
    assert.match(deleteBody, /fragment_links[\s\S]*workspace|fragment_links[\s\S]*key_id/);
    assert.match(deleteBody, /linked_to[\s\S]*workspace|linked_to[\s\S]*key_id/);
  });

  test("contradiction candidate SELECT carries workspace for valid same-workspace resolution", () => {
    assert.match(contradictionSource, /SELECT c\.id[\s\S]*c\.workspace/);
  });
});
