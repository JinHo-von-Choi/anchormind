import { describe, test, mock } from "node:test";
import assert from "node:assert/strict";

const calls = [];
const pool = {
  query: async (sql, params = []) => {
    const text = String(sql);
    calls.push({ sql: text, params });
    if (text.includes("case_events ce")) {
      return { rows: [
        { case_id: "case-a", event_type: "error_observed", summary: "same", created_at: "2026-08-25", key_id: "key-a", workspace: "ws-a" },
        { case_id: "case-a", event_type: "error_observed", summary: "cross", created_at: "2026-08-25", key_id: "key-a", workspace: "ws-b" },
        { case_id: "case-a", event_type: "error_observed", summary: "global", created_at: "2026-08-25", key_id: null, workspace: null }
      ], rowCount: 3 };
    }
    if (text.includes("SELECT f.case_id")) {
      return { rows: [
        { case_id: "case-a", goal: "same", outcome: null, resolution_status: "open", key_id: "key-a", workspace: "ws-a", fragment_count: "1" },
        { case_id: "case-a", goal: "cross", outcome: null, resolution_status: "open", key_id: "key-a", workspace: "ws-b", fragment_count: "1" },
        { case_id: "case-a", goal: "global", outcome: null, resolution_status: "open", key_id: null, workspace: null, fragment_count: "1" }
      ], rowCount: 3 };
    }
    if (text.includes("SELECT f.id, f.content")) {
      return { rows: [
        { id: "same", content: "same", type: "fact", topic: "pilot", case_id: "case-a", key_id: "key-a", workspace: "ws-a" },
        { id: "cross", content: "cross", type: "fact", topic: "pilot", case_id: "case-a", key_id: "key-a", workspace: "ws-b" },
        { id: "global", content: "global", type: "fact", topic: "pilot", case_id: "case-a", key_id: null, workspace: null }
      ], rowCount: 3 };
    }
    if (text.includes("avg(importance)")) {
      return { rows: [{ avg_importance: "0.5", avg_utility: "0.5", total_tokens: "0" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  },
  connect: async () => ({ query: pool.query, release() {} })
};

mock.module("../../lib/tools/db.js", {
  namedExports: {
    getPrimaryPool: () => pool,
    queryWithAgentVector: async (agentId, sql, params = []) => pool.query(sql, params),
    getPool: () => pool,
    getBatchPool: () => pool,
    withTransaction: async fn => fn({ query: pool.query, release() {} }),
    shutdownPool: async () => {},
    getPoolStats: () => ({})
  }
});

const { CaseRecall } = await import("../../lib/memory/read/CaseRecall.js");
const { tool_searchTraces } = await import("../../lib/tools/reconstruct.js");
const { MemoryConsolidator } = await import("../../lib/memory/consolidate/MemoryConsolidator.js");
const { CaseEventStore } = await import("../../lib/memory/CaseEventStore.js");
const { ClaimStore } = await import("../../lib/symbolic/ClaimStore.js");
const { MemoryRememberer } = await import("../../lib/memory/processors/MemoryRememberer.js");

describe("Task 2 round 4 runtime exact tuple checks", () => {
  test("CaseRecall strict case and event assembly excludes cross-workspace/NULL", async () => {
    const result = await new CaseRecall().buildCaseTriples([
      { case_id: "case-a", key_id: "key-a", workspace: "ws-a" },
      { case_id: "case-a", key_id: "key-a", workspace: "ws-b" },
      { case_id: "case-a", key_id: null, workspace: null }
    ], { keyId: "key-a", workspace: "ws-a", strictScope: true });
    assert.equal(result.length, 1);
    assert.equal(result[0].goal, "same");
    assert.deepEqual(result[0].events.map(event => event.summary), ["same"]);
  });

  test("search_traces strict entrypoint returns only the exact tuple", async () => {
    const result = await tool_searchTraces({
      keyword: "pilot", _keyId: "key-a", _defaultWorkspace: "ws-a", limit: 10
    });
    assert.deepEqual(result.traces.map(row => row.id), ["same"]);
    const query = calls.find(call => call.sql.includes("SELECT f.id, f.content"));
    assert.match(query.sql, /f\.key_id/);
    assert.match(query.sql, /f\.workspace/);
  });

  test("workspace-only stats preserve legacy workspace/global behavior; strict tuple does not", async () => {
    calls.length = 0;
    const consolidator = new MemoryConsolidator();
    await consolidator.getStats({ workspace: "ws-a", strictScope: false });
    const legacySql = calls.map(call => call.sql).join("\n");
    assert.match(legacySql, /workspace\s*=\s*\$\d+\s+OR\s+f\.workspace\s+IS\s+NULL/);
    assert.doesNotMatch(legacySql, /AND FALSE/);
    calls.length = 0;
    await consolidator.getStats({ keyId: "key-a", workspace: "ws-a", strictScope: true });
    const strictSql = calls.map(call => call.sql).join("\n");
    assert.match(strictSql, /f\.key_id/);
    assert.match(strictSql, /f\.workspace/);
  });

  test("CaseEventStore strict reads and edge writes carry both tuple axes", async () => {
    calls.length = 0;
    const store = new CaseEventStore();
    const rows = await store.getByCase("case-a", {
      keyId: "key-a", workspace: "ws-a", strictScope: true
    });
    assert.deepEqual(rows.map(row => row.workspace), ["ws-a"]);
    await store.addEdge("evt-a", "evt-b", "preceded_by", 1, {
      keyId: "key-a", workspace: "ws-a", strictScope: true
    });
    const edge = calls.find(call => call.sql.includes("case_event_edges"));
    assert.match(edge.sql, /sf_from\.key_id/);
    assert.match(edge.sql, /sf_to\.workspace/);
  });

  test("MemoryRememberer case-event entrypoint forwards exact tuple to preceded_by", async () => {
    const seen = { append: null, case: null, edges: [] };
    const store = {
      append: async (...args) => { seen.append = args; return { event_id: "evt-new" }; },
      addEvidence: async () => {},
      getByCase: async (...args) => { seen.case = args; return [{ event_id: "evt-old" }]; },
      addEdge: async (...args) => { seen.edges.push(args); }
    };
    await MemoryRememberer.prototype._recordCaseEvent.call({ caseEventStore: store }, {
      id: "frag-new", case_id: "case-a", type: "error", content: "same",
      keywords: [], workspace: "ws-a"
    }, "key-a", "ws-a", true);
    assert.equal(seen.append[1].strictScope, true);
    assert.equal(seen.append[1].workspace, "ws-a");
    assert.equal(seen.case[1].strictScope, true);
    assert.deepEqual(seen.edges[0][4], { keyId: "key-a", workspace: "ws-a", strictScope: true });
  });

  test("ClaimStore polarity SQL rechecks both fragment endpoint tuples", async () => {
    calls.length = 0;
    await new ClaimStore().findPolarityConflicts("frag-a", "key-a", {
      workspace: "ws-a", strictScope: true
    });
    const query = calls.at(-1);
    assert.match(query.sql, /f1\.key_id/);
    assert.match(query.sql, /f2\.workspace/);
    assert.deepEqual(query.params.slice(-4), ["key-a", "ws-a", "key-a", "ws-a"]);
  });
});
