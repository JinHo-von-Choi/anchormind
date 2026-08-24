import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MemoryRememberer } from "../../lib/memory/processors/MemoryRememberer.js";

const consolidator = readFileSync(new URL("../../lib/memory/consolidate/MemoryConsolidator.js", import.meta.url), "utf8");
const reflector = readFileSync(new URL("../../lib/memory/processors/MemoryReflector.js", import.meta.url), "utf8");
const tool = readFileSync(new URL("../../lib/tools/memory.js", import.meta.url), "utf8");

test("duplicate merge follow-up mutations preserve key and workspace scope", () => {
  const body = consolidator.slice(consolidator.indexOf("async _mergeDuplicates"), consolidator.indexOf("async _transitionWithCount"));
  assert.match(body, /workspace/);
  assert.match(body, /key_id\s*=\s*\$/);
});

test("stats and memory_stats propagate the request scope", () => {
  assert.match(consolidator, /async getStats\(scope\s*=\s*\{\}/);
  assert.match(reflector, /async stats\(scope\s*=\s*\{\}/);
  assert.match(tool, /mgr\.stats\(scope\)/);
});

test("forget entrypoint passes the exact tuple to the delete mutation", async () => {
  let lookupOptions;
  let deleteArgs;
  const rememberer = {
    store: {
      getById: async (_id, _agent, _key, _groups, opts) => {
        lookupOptions = opts;
        return { id: "frag-a", keywords: [], topic: "pilot", type: "fact", ttl_tier: "hot", linked_to: [] };
      },
      delete: async (...args) => { deleteArgs = args; return true; }
    },
    index: { deindex: async () => {} }
  };
  const result = await MemoryRememberer.prototype.forget.call(rememberer, {
    id: "frag-a", _keyId: "key-a", workspace: "ws-a"
  });
  assert.equal(result.deleted, 1);
  assert.deepEqual(lookupOptions, { workspace: "ws-a", strictScope: true });
  assert.deepEqual(deleteArgs.slice(0, 4), ["frag-a", "default", "key-a", "ws-a"]);
  assert.deepEqual(deleteArgs[4], { workspace: "ws-a", strictScope: true });
});
