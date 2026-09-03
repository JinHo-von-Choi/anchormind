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
      return { rows: [{ fragment_id: "fragment-a", similarity: 0.9 }] };
    }
    return { rows: [{ id: "fragment-a", workspace: "ws-a" }] };
  })
};

mock.module("../../lib/tools/db.js", {
  namedExports: { getPrimaryPool: () => pool }
});
mock.module("../../config/memory.js", {
  namedExports: {
    MEMORY_CONFIG: {
      syntheticQuery: {
        searchEnabled: true,
        similarityDecay: 0.85,
        searchLimit: 10
      }
    }
  }
});
mock.module("../../lib/logger.js", {
  namedExports: { logWarn: mock.fn(), logInfo: mock.fn(), logError: mock.fn() }
});

const { searchSyntheticQueries } = await import("../../lib/memory/read/SyntheticQuerySearch.js");

describe("SyntheticQuerySearch workspace-before-limit", () => {
  it("후보 LIMIT 전과 hydration 양쪽에 workspace 조건 적용", async () => {
    queries.length = 0;
    await searchSyntheticQueries([0.1, 0.2], { workspace: "ws-a" });

    assert.equal(queries.length, 2);
    assert.match(queries[0].sql, /\(f\.workspace = \$\d+ OR f\.workspace IS NULL\)/);
    assert.match(queries[1].sql, /\(f\.workspace = \$\d+ OR f\.workspace IS NULL\)/);
  });

  it("allWorkspaces=true만 workspace SQL 조건을 제거", async () => {
    queries.length = 0;
    await searchSyntheticQueries([0.1, 0.2], { allWorkspaces: true });

    assert.doesNotMatch(queries[0].sql, /f\.workspace (?:=|IS NULL)/);
    assert.doesNotMatch(queries[1].sql, /f\.workspace (?:=|IS NULL)/);
  });
});
