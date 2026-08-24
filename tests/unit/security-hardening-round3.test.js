import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FragmentSearch } from "../../lib/memory/read/FragmentSearch.js";

const remembererSource = readFileSync(new URL("../../lib/memory/processors/MemoryRememberer.js", import.meta.url), "utf8");
const postProcessorSource = readFileSync(new URL("../../lib/memory/write/RememberPostProcessor.js", import.meta.url), "utf8");
const temporalSource = readFileSync(new URL("../../lib/memory/link/TemporalLinker.js", import.meta.url), "utf8");
const conflictSource = readFileSync(new URL("../../lib/memory/write/ConflictResolver.js", import.meta.url), "utf8");
const readerSource = readFileSync(new URL("../../lib/memory/read/FragmentReader.js", import.meta.url), "utf8");
const writerSource = readFileSync(new URL("../../lib/memory/write/FragmentWriter.js", import.meta.url), "utf8");

describe("Task 2 round 3 exact tuple bypasses", () => {
  test("HotCache strict recall excludes cross-workspace and NULL/global fixtures", async () => {
    const rows = [
      { id: "a-a", content: "same", key_id: "key-a", workspace: "ws-a" },
      { id: "a-b", content: "other workspace", key_id: "key-a", workspace: "ws-b" },
      { id: "global", content: "global", key_id: null, workspace: null }
    ];
    const result = await FragmentSearch.prototype._tryHotCache.call({
      index: { getCachedFragment: async id => rows.find(row => row.id === id) || null }
    }, ["a-a", "a-b", "global"], "key-a", {
      keyId: "key-a", workspace: "ws-a", applyTo: row => row.key_id === "key-a" && row.workspace === "ws-a",
      isNoop: () => false
    });
    assert.deepEqual(result.map(row => row.id), ["a-a"]);
  });

  test("MemoryRememberer post-processing receives exact workspace scope", () => {
    assert.match(remembererSource, /postProcessor\.run\([\s\S]*workspace[\s\S]*strictScope/);
    assert.match(remembererSource, /autoLinkOnRemember\([\s\S]*workspace|autoLinkOnRemember\([\s\S]*strictScope/);
  });

  test("RememberPostProcessor ownership-sensitive paths carry workspace and strictScope", () => {
    assert.match(postProcessorSource, /getByIds\([\s\S]*strictScope|exactScopeClause/);
    assert.match(postProcessorSource, /createLink\([\s\S]*workspace[\s\S]*strictScope/);
    assert.match(postProcessorSource, /checkAssertionConsistency\([\s\S]*workspace/);
    assert.match(postProcessorSource, /linkTemporalNeighbors\([\s\S]*workspace[\s\S]*strictScope/);
    assert.match(postProcessorSource, /_proactiveRecall\([\s\S]*workspace[\s\S]*strictScope/);
  });

  test("TemporalLinker and ConflictResolver SQL/link writes enforce exact tuple", () => {
    assert.match(temporalSource, /exactScopeClause|strictScope/);
    assert.match(temporalSource, /workspace/);
    assert.match(conflictSource, /exactScopeClause|strictScope/);
    assert.match(conflictSource, /workspace/);
  });

  test("auto case-id candidate and update retain exact tuple ownership", () => {
    assert.match(readerSource, /findCaseIdBySessionTopic[\s\S]*workspace/);
    assert.match(readerSource, /findErrorFragmentsBySessionTopic[\s\S]*workspace/);
    assert.match(writerSource, /updateCaseId\([\s\S]*workspace[\s\S]*strictScope/);
  });

  test("touchLinked and assertion updates require exact tuple under API-key scope", () => {
    assert.match(writerSource, /touchLinked\([\s\S]*workspace[\s\S]*strictScope|touchLinked[\s\S]*exactScopeClause/);
    assert.match(writerSource, /patchAssertion\([\s\S]*workspace[\s\S]*strictScope|patchAssertion[\s\S]*exactScopeClause/);
  });
});
