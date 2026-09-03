import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

const queries = [];
const pool = {
  query: mock.fn(async (sql, params) => {
    queries.push({ sql, params });
    return { rows: [] };
  })
};

mock.module("../../lib/tools/db.js", {
  namedExports: { getPrimaryPool: () => pool }
});

const {
  fetchCausalLinks,
  fetchSessionNeighbors
} = await import("../../lib/memory/read/StitchSourceLoader.js");

describe("StitchSourceLoader scope", () => {
  const scope = {
    keyId: "key-a",
    groupKeyIds: ["key-a"],
    workspace: "ws-a",
    agentId: "agent-a",
    includePeerAgents: false
  };

  it("causal link에 key/workspace/agent 조건 적용", async () => {
    queries.length = 0;
    await fetchCausalLinks(["fragment-a"], scope);
    const { sql } = queries[0];
    assert.match(sql, /f\.key_id/);
    assert.match(sql, /\(f\.workspace = \$\d+ OR f\.workspace IS NULL\)/);
    assert.match(sql, /\(f\.agent_id = \$\d+ OR f\.agent_id = 'default'\)/);
  });

  it("session neighbor에도 key/workspace/agent 조건 적용", async () => {
    queries.length = 0;
    await fetchSessionNeighbors([
      { id: "fragment-a", session_id: "session-a", created_at: "2026-01-01T00:00:00Z" }
    ], scope);
    const { sql } = queries[0];
    assert.match(sql, /f\.key_id/);
    assert.match(sql, /\(f\.workspace = \$\d+ OR f\.workspace IS NULL\)/);
    assert.match(sql, /\(f\.agent_id = \$\d+ OR f\.agent_id = 'default'\)/);
  });
});
