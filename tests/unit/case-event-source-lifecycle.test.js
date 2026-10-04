import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

let sourceRows = [];
let inserted   = false;

const client = {
  query: async (sql) => {
    if (String(sql).includes("FROM agent_memory.fragments")) return { rows: sourceRows };
    if (String(sql).includes("MAX(sequence_no)")) return { rows: [{ next_seq: 0 }] };
    if (String(sql).includes("INSERT INTO agent_memory.case_events")) {
      inserted = true;
      return { rows: [{ event_id: "event-1", sequence_no: 0 }] };
    }
    return { rows: [] };
  }
};

mock.module("../../lib/tools/db.js", {
  namedExports: {
    getPrimaryPool: () => ({ marker: true }),
    withTransaction: async (_pool, body) => body(client),
    queryWithAgentVector: async () => ({ rows: [] })
  }
});

const { CaseEventStore } = await import("../../lib/memory/CaseEventStore.js");

describe("CaseEventStore source 수명주기", () => {
  it("source_fragment_id가 이미 없으면 본문 사본을 저장하지 않는다", async () => {
    sourceRows = [];
    inserted   = false;
    const result = await new CaseEventStore().append({
      case_id: "case-a", event_type: "error_observed", summary: "deleted body",
      source_fragment_id: "missing", key_id: "key-a"
    });
    assert.deepEqual(result, { inserted: false, reason: "source_missing" });
    assert.equal(inserted, false);
  });

  it("source를 잠근 뒤 사건을 저장한다", async () => {
    sourceRows = [{ agent_id: "default", workspace: "ws-a" }];
    inserted   = false;
    const result = await new CaseEventStore().append({
      case_id: "case-a", event_type: "error_observed", summary: "current body",
      source_fragment_id: "present", key_id: "key-a"
    });
    assert.equal(result.inserted, true);
    assert.equal(inserted, true);
  });
});
