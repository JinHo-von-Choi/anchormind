import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

const queries = [];
const pool = {
  query: mock.fn(async (sql, params) => {
    queries.push({ sql, params });
    if (queries.length % 2 === 1) {
      return { rows: [{
        case_id: "case-a", goal: "goal", outcome: "done",
        resolution_status: "resolved", fragment_count: 1
      }] };
    }
    return { rows: [] };
  })
};

mock.module("../../lib/tools/db.js", {
  namedExports: { getPrimaryPool: () => pool }
});
mock.module("../../lib/logger.js", {
  namedExports: { logWarn: mock.fn(), logInfo: mock.fn(), logError: mock.fn() }
});

const { CaseRecall } = await import("../../lib/memory/read/CaseRecall.js");

describe("CaseRecall event workspace isolation", () => {
  it("API key와 source fragment workspace를 event SQL에 직접 적용", async () => {
    queries.length = 0;
    await new CaseRecall().buildCaseTriples(
      [{ case_id: "case-a" }],
      { keyId: "key-a", groupKeyIds: ["key-a"], workspace: "ws-a" }
    );

    const eventQuery = queries[1];
    assert.match(eventQuery.sql, /JOIN agent_memory\.fragments f/);
    assert.match(eventQuery.sql, /f\.id = e\.source_fragment_id/);
    assert.match(eventQuery.sql, /e\.key_id = ANY/);
    assert.match(eventQuery.sql, /\(f\.workspace = \$\d+ OR f\.workspace IS NULL\)/);
    assert.match(eventQuery.sql, /\(f\.agent_id = \$\d+ OR f\.agent_id = 'default'\)/);
  });

  it("master allWorkspaces는 source workspace join을 제거", async () => {
    queries.length = 0;
    await new CaseRecall().buildCaseTriples(
      [{ case_id: "case-a" }], { allWorkspaces: true, includePeerAgents: true }
    );

    const eventQuery = queries[1];
    assert.doesNotMatch(eventQuery.sql, /source_fragment_id/);
    assert.doesNotMatch(eventQuery.sql, /workspace (?:=|IS NULL)/);
  });
});
