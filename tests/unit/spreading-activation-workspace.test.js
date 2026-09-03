import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

const queries = [];
const graphCalls = [];

const pool = {
  query: mock.fn(async (sql, params) => {
    queries.push({ sql, params });
    if (/SELECT DISTINCT f\.id/.test(sql)) return { rows: [{ id: "seed-a" }] };
    return { rows: [], rowCount: 1 };
  })
};

mock.module("../../lib/tools/db.js", {
  namedExports: { getPrimaryPool: () => pool }
});
mock.module("../../lib/memory/read/GraphNeighborSearch.js", {
  namedExports: {
    fetchGraphNeighbors: mock.fn(async (...args) => {
      graphCalls.push(args);
      return [{ id: "neighbor-a" }];
    })
  }
});
mock.module("../../lib/memory/write/FragmentFactory.js", {
  namedExports: {
    FragmentFactory: class {
      extractKeywords() { return ["synthetic"]; }
    }
  }
});

const { activateByContext } = await import("../../lib/memory/signals/SpreadingActivation.js");

async function flushActivationQueue() {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
}

describe("SpreadingActivation effective workspace", () => {
  it("global-only를 seed, graph, update에 적용", async () => {
    queries.length = 0;
    graphCalls.length = 0;
    await activateByContext("context", "agent-a", null, "session-global", {});
    await flushActivationQueue();

    assert.match(queries[0].sql, /f\.workspace IS NULL/);
    assert.match(queries.at(-1).sql, /workspace IS NULL/);
    assert.deepEqual(graphCalls[0][4], {
      workspace: null,
      allWorkspaces: false,
      includePeerAgents: false
    });
  });

  it("명시 workspace를 seed, graph, update에 적용", async () => {
    queries.length = 0;
    graphCalls.length = 0;
    await activateByContext(
      "context", "agent-a", "key-a", "session-workspace", { workspace: "ws-a" }
    );
    await flushActivationQueue();

    assert.match(queries[0].sql, /\(f\.workspace = \$\d+ OR f\.workspace IS NULL\)/);
    assert.match(queries.at(-1).sql, /\(workspace = \$\d+ OR workspace IS NULL\)/);
    assert.equal(graphCalls[0][4].workspace, "ws-a");
  });

  it("allWorkspaces=true만 workspace 조건을 제거", async () => {
    queries.length = 0;
    graphCalls.length = 0;
    await activateByContext(
      "context", "agent-a", null, "session-all", { allWorkspaces: true }
    );
    await flushActivationQueue();

    assert.doesNotMatch(queries[0].sql, /f\.workspace (?:=|IS NULL)/);
    assert.doesNotMatch(queries.at(-1).sql, /workspace (?:=|IS NULL)/);
    assert.equal(graphCalls[0][4].allWorkspaces, true);
  });

  it("cache key가 workspace를 포함해 같은 session의 scope를 분리", async () => {
    graphCalls.length = 0;
    await activateByContext(
      "context", "agent-a", "key-a", "shared-session", { workspace: "ws-a" }
    );
    await flushActivationQueue();
    await activateByContext(
      "context", "agent-a", "key-a", "shared-session", { workspace: "ws-b" }
    );
    await flushActivationQueue();

    assert.equal(graphCalls.length, 2);
  });
});
