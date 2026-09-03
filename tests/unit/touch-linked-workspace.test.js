import { after, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { teardownTestResources, assertCleanShutdown } from "../_lifecycle.js";

after(async () => {
  await teardownTestResources();
  await assertCleanShutdown();
});

let captured = null;

mock.module("../../lib/tools/db.js", {
  namedExports: {
    getPrimaryPool: () => ({}),
    queryWithAgentVector: mock.fn(async (_agentId, sql, params) => {
      captured = { sql, params };
      return { rowCount: 1, rows: [] };
    }),
    withTransaction: mock.fn(async fn => fn({ query: async () => ({ rows: [] }) }))
  }
});
mock.module("../../lib/logger.js", {
  namedExports: { logWarn: mock.fn(), logInfo: mock.fn(), logError: mock.fn() }
});

const { FragmentWriter } = await import("../../lib/memory/write/FragmentWriter.js");
const { FragmentSearch } = await import("../../lib/memory/read/FragmentSearch.js");

describe("touchLinked workspace side-effect scope", () => {
  it("기본값은 global-only", async () => {
    await new FragmentWriter().touchLinked(["fragment-a"], "agent-a", null);
    assert.match(captured.sql, /workspace IS NULL/);
  });

  it("명시 workspace를 UPDATE 대상에 적용", async () => {
    await new FragmentWriter().touchLinked(
      ["fragment-a"], "agent-a", "key-a", { workspace: "ws-a" }
    );
    assert.match(captured.sql, /\(workspace = \$\d+ OR workspace IS NULL\)/);
    assert.ok(captured.params.includes("ws-a"));
  });

  it("allWorkspaces=true만 workspace 조건을 제거", async () => {
    await new FragmentWriter().touchLinked(
      ["fragment-a"], "agent-a", null,
      { allWorkspaces: true }
    );
    assert.doesNotMatch(captured.sql, /workspace (?:=|IS NULL)/);
  });
});

describe("FragmentSearch touchLinked scope propagation", () => {
  it("검색의 effective workspace 옵션을 side effect에 전달", async () => {
    const search = new FragmentSearch();
    let touchArgs = null;
    search._executeSearch = async () => ({
      combined: [{
        id: "fragment-a", content: "synthetic", workspace: "ws-a",
        created_at: "2026-01-01T00:00:00Z"
      }],
      searchPath: [],
      l1IsFallback: false,
      layerLatency: { l1Ms: 0, l2Ms: 0, l3Ms: 0, graphUsed: false }
    });
    search.store = {
      incrementAccess: () => {},
      touchLinked: async (...args) => { touchArgs = args; }
    };
    search._cacheFragments = async () => {};

    await search.search({ workspace: "ws-a", allWorkspaces: false });

    assert.deepEqual(touchArgs[3], {
      workspace: "ws-a",
      allWorkspaces: false
    });
  });
});
