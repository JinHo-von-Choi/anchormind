import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

let calls = [];
let responses = [];
let primaryResponses = [];

mock.module("../../lib/tools/db.js", {
  namedExports: {
    getPrimaryPool: () => ({
      query: async (sql, params) => {
        calls.push({ agentId: null, sql, params });
        return primaryResponses.shift() ?? { rows: [] };
      }
    }),
    queryWithAgentVector: async (agentId, sql, params) => {
      calls.push({ agentId, sql, params });
      return responses.shift() ?? { rows: [] };
    },
    withTransaction: async (_pool, fn) => fn({
      query: async (sql, params) => {
        calls.push({ agentId: "transaction", sql, params });
        if (/COALESCE\(MAX\(sequence_no\)/.test(sql)) return { rows: [{ next_seq: 0 }] };
        if (/SELECT agent_id, workspace/.test(sql)) {
          return { rows: [{ agent_id: "agent-a", workspace: "workspace-a" }] };
        }
        if (/INSERT INTO agent_memory\.case_events/.test(sql)) {
          return { rows: [{ event_id: "event-created", sequence_no: 0 }] };
        }
        return { rows: [] };
      }
    })
  }
});
mock.module("../../lib/tools/embedding.js", {
  namedExports: { vectorToSql: value => JSON.stringify(value), computeContentHash: value => value }
});

const { FragmentReader } = await import("../../lib/memory/read/FragmentReader.js");
const { LinkStore } = await import("../../lib/memory/link/LinkStore.js");
const { HistoryReconstructor } = await import("../../lib/memory/read/HistoryReconstructor.js");
const { CaseEventStore } = await import("../../lib/memory/CaseEventStore.js");
const { CaseRecall } = await import("../../lib/memory/read/CaseRecall.js");
const { MemoryReflector } = await import("../../lib/memory/processors/MemoryReflector.js");
const { FragmentWriter } = await import("../../lib/memory/write/FragmentWriter.js");

beforeEach(() => {
  calls = [];
  responses = [];
  primaryResponses = [];
});

describe("fragment point lookup workspace contract", () => {
  it("opts 생략 내부 getById/getByIds는 named-workspace 처리용 무필터를 유지한다", async () => {
    const reader = new FragmentReader();
    await reader.getById("fragment-a", "agent-a", "key-a", ["key-a"]);
    await reader.getByIds(["fragment-a"], "agent-a", "key-a", ["key-a"]);

    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.doesNotMatch(call.sql, /(?:f\.)?workspace IS NULL/);
      assert.doesNotMatch(call.sql, /(?:f\.)?workspace = \$/);
    }
  });

  it("workspace:null을 명시한 scoped getById/getByIds는 global-only다", async () => {
    const reader = new FragmentReader();
    await reader.getById(
      "fragment-global", "agent-a", "key-a", ["key-a"], { workspace: null }
    );
    await reader.getByIds(
      ["fragment-global"], "agent-a", "key-a", ["key-a"], { workspace: null }
    );

    assert.equal(calls.length, 2);
    assert.match(calls[0].sql, /workspace IS NULL/);
    assert.match(calls[1].sql, /workspace IS NULL/);
  });
});

describe("auto-case scope contract", () => {
  it("case lookup은 agent own+default와 key group, named workspace+global을 결합한다", async () => {
    const reader = new FragmentReader();
    await reader.findCaseIdBySessionTopic(
      "session-a", "topic-a", "key-a", ["key-a", "key-b"],
      { agentId: "agent-a", workspace: "project-a" }
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].agentId, "agent-a");
    assert.match(calls[0].sql, /\(agent_id = \$3 OR agent_id = 'default'\)/);
    assert.match(calls[0].sql, /key_id = ANY/);
    assert.match(calls[0].sql, /\(workspace = \$\d+ OR workspace IS NULL\)/);
    assert.deepEqual(calls[0].params, [
      "session-a", "topic-a", "agent-a", "key-a", ["key-a", "key-b"], "project-a"
    ]);
  });

  it("error lookup과 case backfill은 null workspace를 global-only로 재검증한다", async () => {
    const reader = new FragmentReader();
    await reader.findErrorFragmentsBySessionTopic(
      "session-a", "topic-a", null, [], { agentId: "agent-a", workspace: null }
    );
    await new FragmentWriter().updateCaseId(
      "error-a", "case-a", null,
      { agentId: "agent-a", groupKeyIds: [], workspace: null }
    );

    assert.equal(calls.length, 2);
    assert.match(calls[0].sql, /\(agent_id = \$3 OR agent_id = 'default'\)/);
    assert.match(calls[0].sql, /workspace IS NULL/);
    assert.match(calls[1].sql, /\(agent_id = \$3 OR agent_id = 'default'\)/);
    assert.match(calls[1].sql, /workspace IS NULL/);
    assert.equal(calls[1].agentId, "agent-a");
  });
});

describe("fragment_history scoped hydration", () => {
  it("current, versions, chain에 agent/key/workspace 범위를 모두 적용한다", async () => {
    responses = [
      { rows: [{ id: "fragment-a", agent_id: "agent-a", workspace: "workspace-a" }] },
      { rows: [{ fragment_id: "fragment-a", agent_id: "agent-a", workspace: "workspace-a" }] },
      { rows: [] }
    ];
    const reader = new FragmentReader();
    const result = await reader.getHistory(
      "fragment-a", "agent-a", "key-a", ["key-a"], { workspace: "workspace-a" }
    );

    assert.equal(calls.length, 3);
    assert.match(calls[0].sql, /agent_id = \$2/);
    assert.match(calls[0].sql, /key_id/);
    assert.match(calls[0].sql, /workspace/);
    assert.match(calls[1].sql, /agent_id = \$2/);
    assert.match(calls[1].sql, /workspace/);
    assert.deepEqual(calls[1].params, ["fragment-a", "agent-a", "workspace-a"]);
    assert.deepEqual(result.versions, [
      { fragment_id: "fragment-a", agent_id: "agent-a", workspace: "workspace-a" }
    ]);
    assert.match(calls[2].sql, /f\.agent_id = \$2/);
    assert.match(calls[2].sql, /f\.key_id/);
    assert.match(calls[2].sql, /f\.workspace/);
  });

  it("current가 scope 밖이면 versions와 chain을 조회하지 않는다", async () => {
    responses = [{ rows: [] }];
    const result = await new FragmentReader().getHistory(
      "fragment-b", "agent-a", "key-a", ["key-a"], { workspace: "workspace-a" }
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(result, { current: null, versions: [], superseded_by_chain: [] });
  });

  it("공개 경로가 명시한 null workspace는 current/version/chain을 전역으로 제한한다", async () => {
    responses = [
      { rows: [{ id: "fragment-global", agent_id: "default", workspace: null }] },
      { rows: [] },
      { rows: [] }
    ];
    await new FragmentReader().getHistory(
      "fragment-global", "default", null, [], { workspace: null }
    );
    assert.equal(calls.length, 3);
    assert.match(calls[0].sql, /workspace IS NULL/);
    assert.match(calls[1].sql, /workspace IS NULL/);
    assert.match(calls[2].sql, /f\.workspace IS NULL/);
  });
});

describe("graph_explore RCA scope", () => {
  it("seed와 target 모두 agent/key/workspace 조건을 적용한다", async () => {
    responses = [{ rows: [] }];
    await new LinkStore().getRCAChain(
      "fragment-a", "agent-a", "key-a", ["key-a"], { workspace: "workspace-a" }
    );
    const call = calls[0];
    assert.equal(call.agentId, "agent-a");
    assert.match(call.sql, /f\.agent_id = \$2/);
    assert.match(call.sql, /f2\.agent_id = \$2/);
    assert.match(call.sql, /f\.key_id/);
    assert.match(call.sql, /f2\.key_id/);
    assert.match(call.sql, /f\.workspace/);
    assert.match(call.sql, /f2\.workspace/);
  });

  it("peer mode도 key/workspace 조건은 유지한다", async () => {
    responses = [{ rows: [] }];
    await new LinkStore().getRCAChain(
      "fragment-a", "agent-a", "key-a", ["key-a"],
      { workspace: "workspace-a", includePeerAgents: true }
    );
    assert.match(calls[0].sql, /peer-agent: no [a-z0-9._]+ filter/);
    assert.match(calls[0].sql, /f2\.key_id/);
    assert.match(calls[0].sql, /f2\.workspace/);
  });

  it("workspace 미지정 RCA는 seed와 target을 전역(NULL)으로 제한한다", async () => {
    responses = [{ rows: [] }];
    await new LinkStore().getRCAChain("fragment-a", "default", null, []);
    assert.match(calls[0].sql, /f\.workspace IS NULL/);
    assert.match(calls[0].sql, /f2\.workspace IS NULL/);
  });
});

describe("reconstruct/search trace scope", () => {
  it("reconstruct_history timeline에 agent/key/workspace 범위를 전파한다", async () => {
    const reconstructor = new HistoryReconstructor({}, {}, null);
    await reconstructor.reconstruct({
      caseId: "case-a", agentId: "agent-a", keyId: "key-a",
      groupKeyIds: ["key-a"], workspace: "workspace-a"
    });
    const timeline = calls[0];
    assert.match(timeline.sql, /\(f\.agent_id = \$1 OR f\.agent_id = 'default'\)/);
    assert.match(timeline.sql, /f\.key_id/);
    assert.match(timeline.sql, /f\.workspace/);
    assert.equal(timeline.params[0], "agent-a");
  });

  it("case events/evidence/DAG/links에 동일 scope를 끝까지 전파한다", async () => {
    primaryResponses = [
      { rows: [{ id: "fragment-a", agent_id: "agent-a", resolution_status: "open" }] },
      { rows: [{ from_id: "fragment-a", to_id: "fragment-a", relation_type: "caused_by" }] }
    ];
    const seen = [];
    const caseEventStore = {
      getByCase: async (_caseId, opts) => {
        seen.push(["case", opts]);
        return [{ event_id: "event-a", event_type: "error_observed" }];
      },
      getEdgesByEvents: async (ids, keyId) => {
        seen.push(["dag", { ids, keyId }]);
        return [];
      },
      getEvidenceByEvent: async (_eventId, opts) => {
        seen.push(["evidence", opts]);
        return [];
      }
    };
    await new HistoryReconstructor({}, {}, caseEventStore).reconstruct({
      caseId: "case-a", agentId: "agent-a", keyId: "key-a",
      groupKeyIds: ["key-a"], workspace: "workspace-a"
    });
    for (const [kind, scope] of seen.filter(([kind]) => kind !== "dag")) {
      assert.equal(scope.agentId, "agent-a", kind);
      assert.equal(scope.includePeerAgents, false, kind);
      assert.equal(scope.keyId, "key-a", kind);
      assert.equal(scope.workspace, "workspace-a", kind);
      assert.equal(scope.allWorkspaces, false, kind);
    }
    assert.deepEqual(seen.find(([kind]) => kind === "dag")?.[1], {
      ids: ["event-a"],
      keyId: {
        keyId: "key-a", groupKeyIds: ["key-a"], workspace: "workspace-a",
        allWorkspaces: false, _isMaster: false,
        agentId: "agent-a", includePeerAgents: false
      }
    });
    const linkCall = calls.find(call => /FROM agent_memory\.fragment_links fl/.test(call.sql));
    assert.match(linkCall.sql, /fl\.from_id = ANY\(\$1\)/);
    assert.match(linkCall.sql, /fl\.to_id\s+= ANY\(\$1\)/);
    assert.match(linkCall.sql, /\bOR\b/);
    assert.match(linkCall.sql, /f_from\.agent_id/);
    assert.match(linkCall.sql, /f_to\.agent_id/);
    assert.match(linkCall.sql, /f_from\.key_id/);
    assert.match(linkCall.sql, /f_to\.key_id/);
    assert.match(linkCall.sql, /f_from\.workspace/);
    assert.match(linkCall.sql, /f_to\.workspace/);
  });

  it("MemoryReflector facade가 master allWorkspaces를 reconstructor까지 보존한다", async () => {
    primaryResponses = [{ rows: [] }];
    const reflector = new MemoryReflector({
      reflectProcessor: {}, store: { links: {} }, caseEventStore: null, consolidator: {}
    });

    await reflector.reconstructHistory({
      caseId: "case-all", agentId: "default",
      allWorkspaces: true, _isMaster: true
    });

    assert.equal(calls.length, 1);
    assert.doesNotMatch(calls[0].sql, /workspace IS NULL|workspace = \$/);
  });

});

describe("case event fragment scope matrix", () => {
  it("append가 source fragment의 agent/workspace snapshot을 저장한다", async () => {
    await new CaseEventStore().append({
      case_id: "case-a",
      event_type: "error_observed",
      summary: "synthetic event",
      source_fragment_id: "fragment-a",
      key_id: "key-a"
    });
    const sourceRead = calls.find(call => /SELECT agent_id, workspace/.test(call.sql));
    const insert = calls.find(call => /INSERT INTO agent_memory\.case_events/.test(call.sql));
    assert.deepEqual(sourceRead.params, ["fragment-a", "key-a"]);
    assert.match(insert.sql, /agent_id, workspace/);
    assert.equal(insert.params.at(-2), "agent-a");
    assert.equal(insert.params.at(-1), "workspace-a");
  });

  it("getByCase는 current fragment가 아니라 immutable event snapshot을 필터한다", async () => {
    await new CaseEventStore().getByCase("case-a", {
      agentId: "agent-a", keyId: "key-a", groupKeyIds: ["key-a"],
      workspace: "workspace-a"
    });
    assert.match(calls[0].sql, /ce\.agent_id/);
    assert.match(calls[0].sql, /ce\.key_id/);
    assert.match(calls[0].sql, /ce\.workspace/);
    assert.doesNotMatch(calls[0].sql, /JOIN\s+agent_memory\.fragments/);
  });

  it("workspace 미지정 event snapshot 조회는 전역(NULL)으로 제한한다", async () => {
    await new CaseEventStore().getByCase("case-a", { agentId: "default" });
    assert.match(calls[0].sql, /ce\.workspace IS NULL/);
  });

  for (const scope of [
    { name: "default", opts: { agentId: "default" }, expected: /[a-z]+\.agent_id = \$\d+/ },
    { name: "specific", opts: { agentId: "agent-a" }, expected: /\([a-z]+\.agent_id = \$\d+ OR [a-z]+\.agent_id = 'default'\)/ },
    { name: "peer", opts: { agentId: "agent-a", includePeerAgents: true }, expected: /peer-agent: no [a-z._]+ filter/ }
  ]) {
    it(`${scope.name} 범위를 case event와 evidence SQL에 동일 적용한다`, async () => {
      const store = new CaseEventStore();
      const opts = {
        ...scope.opts, keyId: "key-a", groupKeyIds: ["key-a"], workspace: "workspace-a"
      };
      await store.getByCase("case-a", opts);
      await store.getEvidenceByEvent("event-a", opts);
      for (const call of calls) {
        assert.match(call.sql, scope.expected);
        if (scope.name === "peer") {
          assert.match(call.sql, /(?:ce|f)\.agent_id IS NOT NULL/);
        }
        assert.match(call.sql, /\.key_id/);
        assert.match(call.sql, /\.workspace/);
      }
    });
  }

  it("DAG edge는 snapshot agent/workspace와 전체 group key를 양 끝점에 적용한다", async () => {
    await new CaseEventStore().getEdgesByEvents(["event-a", "event-b"], {
      agentId: "agent-a", keyId: "key-a", groupKeyIds: ["key-a", "key-b"],
      workspace: "workspace-a"
    });
    assert.match(calls[0].sql, /ee\.from_event_id = ANY\(\$1::uuid\[\]\)/);
    assert.match(calls[0].sql, /ee\.to_event_id\s+= ANY\(\$1::uuid\[\]\)/);
    assert.match(calls[0].sql, /\bOR\b/);
    assert.match(calls[0].sql, /ce_from\.agent_id/);
    assert.match(calls[0].sql, /ce_to\.agent_id/);
    assert.match(calls[0].sql, /ce_from\.workspace/);
    assert.match(calls[0].sql, /ce_to\.workspace/);
    assert.equal(
      calls[0].params.filter(value => Array.isArray(value) && value.includes("key-b")).length,
      2
    );
  });
});

describe("CaseRecall event snapshot scope", () => {
  it("event summary를 current fragment JOIN 없이 ce snapshot으로 필터한다", async () => {
    primaryResponses = [
      { rows: [{ case_id: "case-a", resolution_status: "open", fragment_count: 1 }] },
      { rows: [{ case_id: "case-a", event_type: "error_observed", summary: "synthetic" }] }
    ];
    await new CaseRecall().buildCaseTriples([{ case_id: "case-a" }], {
      agentId: "agent-a", keyId: "key-a", groupKeyIds: ["key-a"],
      workspace: "workspace-a"
    });
    const eventQuery = calls.find(call => /FROM agent_memory\.case_events ce/.test(call.sql));
    assert.match(eventQuery.sql, /ce\.agent_id/);
    assert.match(eventQuery.sql, /ce\.key_id/);
    assert.match(eventQuery.sql, /ce\.workspace/);
    assert.doesNotMatch(eventQuery.sql, /JOIN\s+agent_memory\.fragments/);
  });
});
