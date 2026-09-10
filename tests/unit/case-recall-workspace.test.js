import { after, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { teardownTestResources, assertCleanShutdown } from "../_lifecycle.js";

after(async () => {
  await teardownTestResources();
  await assertCleanShutdown();
});

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
    return { rows: [{
      case_id: "case-a", event_type: "decision_committed",
      summary: "source-independent event", created_at: "2026-01-01T00:00:00Z"
    }] };
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
  it("case 파편과 nullable-source 이벤트를 immutable agent/key/workspace 범위로 조회", async () => {
    queries.length = 0;
    const cases = await new CaseRecall().buildCaseTriples(
      [{ case_id: "case-a" }],
      { keyId: "key-a", groupKeyIds: ["key-a"], workspace: "ws-a" }
    );

    const caseQuery = queries[0];
    const eventQuery = queries[1];
    assert.match(caseQuery.sql, /\(workspace = \$\d+ OR workspace IS NULL\)/);
    assert.doesNotMatch(eventQuery.sql, /JOIN agent_memory\.fragments/);
    assert.doesNotMatch(eventQuery.sql, /source_fragment_id|valid_to/);
    assert.match(eventQuery.sql, /ce\.agent_id/);
    assert.match(eventQuery.sql, /ce\.key_id = ANY/);
    assert.match(eventQuery.sql, /\(ce\.workspace = \$\d+ OR ce\.workspace IS NULL\)/);
    assert.doesNotMatch(eventQuery.sql, /ce\.key_id IS NULL/);
    assert.deepEqual(eventQuery.params, [["case-a"], "default", ["key-a"], "ws-a"]);
    assert.equal(cases[0].events[0].summary, "source-independent event");
  });

  it("master allWorkspaces는 이벤트 key/workspace 조건을 추가하지 않는다", async () => {
    queries.length = 0;
    await new CaseRecall().buildCaseTriples(
      [{ case_id: "case-a" }], { allWorkspaces: true }
    );

    const eventQuery = queries[1];
    assert.doesNotMatch(eventQuery.sql, /JOIN agent_memory\.fragments/);
    assert.match(eventQuery.sql, /ce\.agent_id/);
    assert.doesNotMatch(eventQuery.sql, /ce\.key_id (?:IS NULL|= ANY)/);
    assert.doesNotMatch(eventQuery.sql, /ce\.workspace (?:=|IS NULL)/);
    assert.deepEqual(eventQuery.params, [["case-a"], "default"]);
  });

  it("빈 키 그룹은 NULL 이벤트를 허용하지 않고 아무 이벤트도 매칭하지 않는다", async () => {
    queries.length = 0;
    await new CaseRecall().buildCaseTriples(
      [{ case_id: "case-a" }], { keyId: "key-a", groupKeyIds: [], workspace: "ws-a" }
    );

    const eventQuery = queries[1];
    assert.doesNotMatch(eventQuery.sql, /JOIN agent_memory\.fragments/);
    assert.match(eventQuery.sql, /ce\.key_id = ANY/);
    assert.doesNotMatch(eventQuery.sql, /ce\.key_id IS NULL/);
    assert.deepEqual(eventQuery.params, [["case-a"], "default", [], "ws-a"]);
  });
});
