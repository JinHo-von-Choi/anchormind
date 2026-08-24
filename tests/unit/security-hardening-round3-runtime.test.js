import { describe, test, mock } from "node:test";
import assert from "node:assert/strict";

const calls = [];
const pool = {
  query: async (sql, params = []) => {
    calls.push({ sql: String(sql), params });
    if (String(sql).includes("SELECT f.id, f.created_at")) {
      return { rows: [
        { id: "same", created_at: "2026-08-25T00:00:00Z", key_id: "key-a", workspace: "ws-a" },
        { id: "cross", created_at: "2026-08-25T00:00:00Z", key_id: "key-a", workspace: "ws-b" },
        { id: "global", created_at: "2026-08-25T00:00:00Z", key_id: null, workspace: null }
      ], rowCount: 3 };
    }
    return { rows: [{ id: "same", case_id: "case-a", key_id: "key-a", workspace: "ws-a" }], rowCount: 1 };
  },
  connect: async () => ({ query: pool.query, release() {} })
};

mock.module("../../lib/tools/db.js", {
  namedExports: {
    getPrimaryPool: () => pool,
    queryWithAgentVector: async (agentId, sql, params = []) => {
      calls.push({ agentId, sql: String(sql), params });
      if (String(sql).includes("SELECT f.id, f.created_at")) {
        return { rows: [
          { id: "same", created_at: "2026-08-25T00:00:00Z", key_id: "key-a", workspace: "ws-a" },
          { id: "cross", created_at: "2026-08-25T00:00:00Z", key_id: "key-a", workspace: "ws-b" },
          { id: "global", created_at: "2026-08-25T00:00:00Z", key_id: null, workspace: null }
        ], rowCount: 3 };
      }
      return { rows: [{ id: "same", case_id: "case-a", key_id: "key-a", workspace: "ws-a" }], rowCount: 1 };
    },
    getPool: () => pool,
    getBatchPool: () => pool,
    withTransaction: async fn => fn({ query: pool.query, release() {} }),
    shutdownPool: async () => {},
    getPoolStats: () => ({})
  }
});

const { SearchScope } = await import("../../lib/memory/read/SearchScope.js");
const { FragmentSearch } = await import("../../lib/memory/read/FragmentSearch.js");
const { RememberPostProcessor } = await import("../../lib/memory/write/RememberPostProcessor.js");
const { FragmentReader } = await import("../../lib/memory/read/FragmentReader.js");
const { FragmentWriter } = await import("../../lib/memory/write/FragmentWriter.js");
const { TemporalLinker } = await import("../../lib/memory/link/TemporalLinker.js");
const { ConflictResolver } = await import("../../lib/memory/write/ConflictResolver.js");

describe("Task 2 round 3 runtime exact tuple checks", () => {
  test("HotCache actual scope rejects cross-workspace and NULL rows", async () => {
    const scope = SearchScope.fromQuery({ keyId: "key-a", workspace: "ws-a", strictScope: true });
    const rows = [
      { id: "same", content: "same", key_id: "key-a", workspace: "ws-a" },
      { id: "cross", content: "cross", key_id: "key-a", workspace: "ws-b" },
      { id: "global", content: "global", key_id: null, workspace: null }
    ];
    const result = await FragmentSearch.prototype._tryHotCache.call({
      index: { getCachedFragment: async id => rows.find(row => row.id === id) || null }
    }, rows.map(row => row.id), "key-a", scope);
    assert.deepEqual(result.map(row => row.id), ["same"]);
  });

  test("RememberPostProcessor real run gates linked/proactive ownership by exact tuple", async () => {
    const links = [];
    const store = {
      getByIds: async () => [
        { id: "same", key_id: "key-a", workspace: "ws-a" },
        { id: "cross", key_id: "key-a", workspace: "ws-b" },
        { id: "global", key_id: null, workspace: null }
      ],
      createLink: async (...args) => links.push(args),
      patchAssertion: async () => true
    };
    const processor = new RememberPostProcessor({
      store,
      conflictResolver: { checkAssertionConsistency: async () => ({ assertionStatus: "observed" }) },
      temporalLinker: { linkTemporalNeighbors: async () => [] },
      morphemeIndex: { tokenize: async () => [], getOrRegisterEmbeddings: async () => [] },
      search: { search: async () => ({ fragments: [
        { id: "same", keywords: ["anchor"], key_id: "key-a", workspace: "ws-a" },
        { id: "cross", keywords: ["anchor"], key_id: "key-a", workspace: "ws-b" },
        { id: "global", keywords: ["anchor"], key_id: null, workspace: null }
      ] }) }
    });
    await processor.run({
      id: "new", content: "anchor", keywords: ["anchor"], type: "fact",
      topic: "pilot", key_id: "key-a", workspace: "ws-a", linked_to: ["same", "cross", "global"]
    }, { agentId: "agent-a", keyId: "key-a", workspace: "ws-a", strictScope: true });
    await processor._proactiveRecallPromise;
    assert.ok(links.length >= 1);
    assert.ok(links.every(args => args[5]?.keyId === "key-a" && args[5]?.workspace === "ws-a"));
    assert.ok(links.every(args => args[1] === "same"));
  });

  test("case-id, touch, assertion mutation entrypoints bind both tuple axes", async () => {
    const reader = new FragmentReader();
    const writer = new FragmentWriter();
    calls.length = 0;
    await reader.findCaseIdBySessionTopic("session-a", "pilot", "key-a", [], "ws-a", { strictScope: true });
    await reader.findErrorFragmentsBySessionTopic("session-a", "pilot", "key-a", [], "ws-a", { strictScope: true });
    await writer.updateCaseId("same", "case-a", "key-a", "ws-a", { strictScope: true });
    await writer.touchLinked(["same"], "agent-a", "key-a", "ws-a", { strictScope: true });
    await writer.patchAssertion("same", "inferred", "key-a", "ws-a", { strictScope: true });
    const sql = calls.map(call => call.sql).join("\n");
    assert.match(sql, /key_id/);
    assert.match(sql, /workspace/);
    assert.match(sql, /\$3/);
    assert.match(sql, /\$4/);
  });

  test("TemporalLinker post-filter drops hostile rows returned by a fake DB", async () => {
    const links = [];
    const linker = new TemporalLinker({ createLink: async (...args) => links.push(args) });
    const result = await linker.linkTemporalNeighbors({
      id: "new", topic: "pilot", created_at: "2026-08-25T00:00:00Z", key_id: "key-a", workspace: "ws-a"
    }, { agentId: "agent-a", keyId: "key-a", workspace: "ws-a", strictScope: true });
    assert.deepEqual(result.map(row => row.toId), ["same"]);
    assert.deepEqual(links.map(args => args[1]), ["same"]);
  });

  test("supersede mutation rechecks the exact tuple before updating the old fragment", async () => {
    calls.length = 0;
    const links = [];
    const resolver = new ConflictResolver({
      createLink: async (...args) => links.push(args)
    }, { search: async () => ({ fragments: [] }) });
    await resolver.supersede("old", "new", "agent-a", "key-a", "ws-a", true);
    const update = calls.find(call => call.sql.includes("UPDATE agent_memory.fragments"));
    assert.match(update.sql, /f\.key_id/);
    assert.match(update.sql, /f\.workspace/);
    assert.deepEqual(links[0][5], { keyId: "key-a", workspace: "ws-a", strictScope: true });
  });
});
