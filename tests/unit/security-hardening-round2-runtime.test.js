import { describe, test, mock } from "node:test";
import assert from "node:assert/strict";

const dbCalls = [];
const clientCalls = [];
const graphRows = [
  { id: "a-a", key_id: "key-a", workspace: "ws-a", _link_weight: 1, _relation_type: "related" },
  { id: "a-b", key_id: "key-a", workspace: "ws-b", _link_weight: 1, _relation_type: "related" },
  { id: "global", key_id: null, workspace: null, _link_weight: 1, _relation_type: "related" }
];

const client = {
  query: async (sql, params = []) => {
    clientCalls.push({ sql: String(sql), params });
    if (String(sql).includes("UPDATE agent_memory.fragment_links")) {
      return { rows: [{ id: "link-a", new_weight: 1.2, new_confidence: 0.9, old_weight: 1, old_confidence: 0.85 }] };
    }
    return { rows: [] };
  },
  release: () => {}
};
const pool = {
  query: async (sql, params = []) => {
    dbCalls.push({ sql: String(sql), params });
    return { rows: graphRows };
  },
  connect: async () => client
};

mock.module("../../lib/tools/db.js", {
  namedExports: {
    getPrimaryPool: () => pool,
    queryWithAgentVector: async (agentId, sql, params = []) => {
      dbCalls.push({ agentId, sql: String(sql), params });
      if (String(sql).startsWith("DELETE") || String(sql).startsWith("UPDATE")) return { rows: [], rowCount: 1 };
      return { rows: [] };
    },
    getPool: () => pool,
    getBatchPool: () => pool,
    withTransaction: async fn => fn(client),
    shutdownPool: async () => {},
    getPoolStats: () => ({})
  }
});
mock.module("../../lib/tools/embedding.js", {
  namedExports: {
    computeContentHash: value => `hash:${value}`,
    vectorToSql: vector => `(${(vector || []).join(",")})`,
    generateBatchEmbeddings: async () => [],
    EMBEDDING_ENABLED: false,
    EMBEDDING_API_KEY: null,
    OPENAI_API_KEY: null,
    EMBEDDING_MODEL: "test",
    EMBEDDING_DIMENSIONS: 0,
    EMBEDDING_SUPPORTS_DIMS_PARAM: false,
    EMBEDDING_PROVIDER: "test"
  }
});

const { fetchGraphNeighbors } = await import("../../lib/memory/read/GraphNeighborSearch.js");
const { FragmentWriter } = await import("../../lib/memory/write/FragmentWriter.js");
const { reconsolidate } = await import("../../lib/memory/link/ReconsolidationEngine.js");
const { ContradictionDetector } = await import("../../lib/memory/link/ContradictionDetector.js");

describe("Task 2 round 2 runtime exact tuple checks", () => {
  test("GraphNeighborSearch strict entrypoint filters cross-workspace and NULL rows", async () => {
    dbCalls.length = 0;
    const rows = await fetchGraphNeighbors(["seed-a"], 10, "agent-a", "key-a", {
      workspace: "ws-a", strictScope: true
    });
    assert.deepEqual(rows.map(row => row.id), ["a-a"]);
    assert.match(dbCalls[0].sql, /JOIN agent_memory\.fragments source/);
    assert.match(dbCalls[0].sql, /source\.key_id/);
    assert.match(dbCalls[0].sql, /target\.workspace/);
  });

  test("GraphNeighborSearch strict partial scope fails closed without querying", async () => {
    dbCalls.length = 0;
    const rows = await fetchGraphNeighbors(["seed-a"], 10, "agent-a", "key-a", { strictScope: true });
    assert.deepEqual(rows, []);
    assert.equal(dbCalls.length, 0);
  });

  test("FragmentWriter strict forget cleans only owned link endpoints and linked_to rows", async () => {
    dbCalls.length = 0;
    const writer = new FragmentWriter();
    assert.equal(await writer.delete("a-a", "agent-a", "key-a", "ws-a", { strictScope: true }), true);
    const cleanup = dbCalls.filter(call => /fragment_links|linked_to/.test(call.sql));
    assert.equal(cleanup.length, 2);
    assert.match(cleanup[0].sql, /from_frag\.key_id/);
    assert.match(cleanup[0].sql, /to_frag\.workspace/);
    assert.match(cleanup[1].sql, /f\.key_id/);
    assert.match(cleanup[1].sql, /f\.workspace/);
  });

  test("Reconsolidation strict UPDATE rechecks both endpoint tuple axes", async () => {
    clientCalls.length = 0;
    const result = await reconsolidate("link-a", "reinforce", {
      keyId: "key-a", workspace: "ws-a", triggeredBy: "test"
    });
    assert.equal(result.id, "link-a");
    const update = clientCalls.find(call => call.sql.includes("UPDATE agent_memory.fragment_links"));
    assert.match(update.sql, /from_frag\.key_id/);
    assert.match(update.sql, /to_frag\.workspace/);
    assert.deepEqual(update.params.slice(-4), ["key-a", "ws-a", "key-a", "ws-a"]);
  });

  test("ContradictionDetector accepts a valid same-workspace exact tuple", async () => {
    const links = [];
    const detector = new ContradictionDetector({
      createLink: async (...args) => links.push(args)
    });
    const newer = {
      id: "a-new", content: "new", key_id: "key-a", workspace: "ws-a",
      created_at: "2026-08-02T00:00:00Z", is_anchor: false, topic: "pilot", keywords: []
    };
    const older = {
      id: "a-old", content: "old", key_id: "key-a", workspace: "ws-a",
      created_at: "2026-08-01T00:00:00Z", is_anchor: false, topic: "pilot", keywords: []
    };
    assert.equal(await detector.resolveContradiction(newer, older, "same tuple", {
      keyId: "key-a", workspace: "ws-a"
    }), true);
    assert.equal(links.length > 0, true);
    assert.equal(links[0][5].strictScope, true);
  });
});
