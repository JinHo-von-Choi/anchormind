import { describe, test, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

const calls = [];
const pool = {
  query: async (sql, params = []) => {
    const text = String(sql);
    calls.push({ sql: text, params });
    if (text.includes("fragment_links fl")) {
      return { rows: [
        { from_id: "inside", to_id: "outside", relation_type: "caused_by", weight: 1 },
        { from_id: "outside", to_id: "inside", relation_type: "resolved_by", weight: 1 }
      ], rowCount: 2 };
    }
    if (text.includes("SELECT f.id, f.content")) {
      return { rows: [{
        id: "inside", content: "inside", type: "error", topic: "pilot",
        case_id: "case-a", resolution_status: "open", key_id: "key-a", workspace: "ws-a",
        created_at: "2026-08-25T00:00:00.000Z"
      }], rowCount: 1 };
    }
    if (text.includes("SELECT f.id FROM agent_memory.fragments")) {
      return { rows: [{ id: "frag-a" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  },
  connect: async () => ({ query: pool.query, release() {} })
};

mock.module("../../lib/tools/db.js", {
  namedExports: {
    getPrimaryPool: () => pool,
    getPool: () => pool,
    getBatchPool: () => pool,
    queryWithAgentVector: async (_agentId, sql, params = []) => pool.query(sql, params),
    withTransaction: async (_pool, fn) => fn({ query: pool.query, release() {} }),
    shutdownPool: async () => {},
    getPoolStats: () => ({})
  }
});

const { MemoryRememberer } = await import("../../lib/memory/processors/MemoryRememberer.js");
const { MemoryRecaller } = await import("../../lib/memory/processors/MemoryRecaller.js");
const { HistoryReconstructor } = await import("../../lib/memory/read/HistoryReconstructor.js");
const { CaseEventStore } = await import("../../lib/memory/CaseEventStore.js");

describe("Task 2 round 5 runtime exact tuple checks", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  afterEach(() => {
    delete process.env.MEMENTO_REMEMBER_ATOMIC;
  });

  test("default non-atomic remember passes exact tuple to case-event recording", async () => {
    delete process.env.MEMENTO_REMEMBER_ATOMIC;
    const seen = { append: null, evidence: null, case: null, edges: [] };
    const rememberer = new MemoryRememberer({
      store: {
        findByIdempotencyKey: async () => null,
        insert: async () => "frag-a",
        findCaseIdBySessionTopic: async () => null,
        findErrorFragmentsBySessionTopic: async () => [],
        updateTtlTier: async () => {}
      },
      index: { index: async () => {}, deindex: async () => {} },
      factory: { create: params => ({
        id: "factory-id", content: params.content, topic: params.topic, type: params.type,
        keywords: [], importance: 0.5, ttl_tier: "warm", session_id: null,
        case_id: params.caseId, key_id: null, workspace: params.workspace,
        validation_warnings: []
      }) },
      quotaChecker: { check: async () => {} },
      postProcessor: { run: async () => {} },
      conflictResolver: { detectConflicts: async () => [], autoLinkOnRemember: async () => {} },
      policyRules: { check: () => [] },
      policyGatingEnabled: false,
      getHardGate: async () => false,
      caseEventStore: {
        append: async (...args) => { seen.append = args; return { event_id: "evt-a" }; },
        addEvidence: async (...args) => { seen.evidence = args; },
        getByCase: async (...args) => { seen.case = args; return []; },
        addEdge: async (...args) => { seen.edges.push(args); }
      }
    });

    await rememberer.remember({
      content: "same tuple", topic: "pilot", type: "error", caseId: "case-a",
      _keyId: "key-a", workspace: "ws-a"
    });
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(seen.append[1].keyId, "key-a");
    assert.equal(seen.append[1].workspace, "ws-a");
    assert.equal(seen.append[1].strictScope, true);
    assert.equal(seen.evidence[4].strictScope, true);
  });

  test("API-key linked recall excludes cross-key and NULL hostile rows", async () => {
    const recaller = new MemoryRecaller({
      search: {
        search: async () => ({
          fragments: [{ id: "root", key_id: "key-a", workspace: "ws-a", agent_id: "default", type: "fact", content: "root" }],
          totalTokens: 1, searchPath: "fake"
        })
      },
      store: {
        getLinkedFragments: async () => [
          { id: "same", key_id: "key-a", workspace: "ws-a", agent_id: "default", type: "fact", content: "same" },
          { id: "cross-key", key_id: "key-b", workspace: "ws-a", agent_id: "default", type: "fact", content: "cross" },
          { id: "global", key_id: null, workspace: null, agent_id: "default", type: "fact", content: "global" }
        ]
      }
    });

    const result = await recaller.recall({
      keywords: ["pilot"], includeLinks: true, _keyId: "key-a", workspace: "ws-a"
    });
    assert.deepEqual(result.fragments.map(row => row.id).sort(), ["root", "same"]);
  });

  test("HistoryReconstructor discards links with either endpoint outside the timeline", async () => {
    const reconstructor = new HistoryReconstructor({}, {});
    const strictLinks = await reconstructor._fetchLinks(["inside"], {
      keyId: "key-a", workspace: "ws-a", strictScope: true
    });
    const legacyLinks = await reconstructor._fetchLinks(["inside"], {
      keyId: "key-a", workspace: "ws-a", strictScope: false
    });
    assert.deepEqual(strictLinks, []);
    assert.deepEqual(legacyLinks, []);

    const result = await reconstructor.reconstruct({
      caseId: "case-a", keyId: "key-a", workspace: "ws-a", strictScope: true
    });
    assert.equal(result.causal_chains.length, 0);
  });

  test("strict append rejects a payload tuple different from the authenticated tuple", async () => {
    const store = new CaseEventStore();
    await assert.rejects(
      () => store.append({
        case_id: "case-a", event_type: "error_observed", summary: "mismatch",
        source_fragment_id: "frag-a", key_id: "key-a", workspace: "ws-a", strictScope: true
      }, { keyId: "key-b", workspace: "ws-a", strictScope: true }),
      /scope.*mismatch/i
    );
    assert.equal(calls.length, 0);
  });

  test("strict evidence insert checks source event and fragment ownership", async () => {
    const store = new CaseEventStore();
    await store.addEvidence("frag-a", "evt-a", "produced_by", 1, {
      keyId: "key-a", workspace: "ws-a", strictScope: true
    });
    const query = calls.find(call => call.sql.includes("fragment_evidence"));
    assert.match(query.sql, /JOIN agent_memory\.case_events ce/);
    assert.match(query.sql, /JOIN agent_memory\.fragments sf/);
    assert.match(query.sql, /sf\.key_id/);
    assert.match(query.sql, /sf\.workspace/);
  });
});
