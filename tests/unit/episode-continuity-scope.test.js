import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

const calls = [];
const responses = [];
mock.module("../../lib/tools/db.js", {
  exports: {
    getPrimaryPool: () => ({
      query: async (sql, params) => {
        calls.push({ sql, params });
        return responses.shift() ?? { rows: [] };
      }
    })
  }
});
mock.module("../../lib/logger.js", {
  exports: { logWarn: () => {} }
});

const { linkEpisodeMilestone, _lastEventCacheForTest } = await import(
  "../../lib/memory/processors/EpisodeContinuityService.js"
);

beforeEach(() => {
  calls.length = 0;
  responses.length = 0;
  _lastEventCacheForTest().clear();
});

describe("EpisodeContinuityService immutable scope", () => {
  it("fragment identity를 검증하고 event snapshot과 previous-event scope를 저장한다", async () => {
    responses.push(
      { rows: [{
        summary: "synthetic milestone", workspace: "workspace-a", topic: "topic-a",
        agent_id: "agent-a", key_id: "key-a"
      }] },
      { rows: [{ event_id: "event-new" }] },
      { rows: [{ event_id: "event-old" }] },
      { rows: [] }
    );
    await linkEpisodeMilestone("fragment-a", "agent-a", "key-a", "session-a");
    assert.match(calls[0].sql, /agent_id = \$2/);
    assert.match(calls[0].sql, /key_id IS NOT DISTINCT FROM \$3/);
    assert.deepEqual(calls[0].params, ["fragment-a", "agent-a", "key-a"]);
    assert.match(calls[1].sql, /key_id, agent_id, workspace/);
    assert.deepEqual(calls[1].params.slice(-3), ["key-a", "agent-a", "workspace-a"]);
    assert.match(calls[2].sql, /ce\.agent_id = \$1/);
    assert.match(calls[2].sql, /ce\.key_id IS NOT DISTINCT FROM \$2/);
    assert.match(calls[2].sql, /ce\.workspace = \$3/);
    assert.doesNotMatch(calls[2].sql, /JOIN\s+agent_memory\.fragments/);
  });

  it("passed agent/key와 일치하는 fragment가 없으면 event를 만들지 않는다", async () => {
    responses.push({ rows: [] });
    await linkEpisodeMilestone("fragment-b", "agent-b", "key-b", "session-b");
    assert.equal(calls.length, 1);
  });
});
