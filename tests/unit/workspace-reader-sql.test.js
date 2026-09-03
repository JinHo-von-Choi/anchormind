import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

let captured = null;

mock.module("../../lib/tools/db.js", {
  namedExports: {
    queryWithAgentVector: mock.fn(async (_agentId, sql, params) => {
      captured = { sql, params };
      return { rows: [] };
    }),
    getPrimaryPool: mock.fn(() => null)
  }
});

mock.module("../../lib/tools/embedding.js", {
  namedExports: {
    vectorToSql: mock.fn(() => "[0.1,0.2]"),
    generateEmbedding: mock.fn(async () => [0.1, 0.2]),
    prepareTextForEmbedding: mock.fn(value => value),
    EMBEDDING_ENABLED: true
  }
});

mock.module("../../lib/logger.js", {
  namedExports: { logWarn: mock.fn(), logInfo: mock.fn(), logError: mock.fn() }
});

const { FragmentReader } = await import("../../lib/memory/read/FragmentReader.js");

describe("FragmentReader effective workspace SQL", () => {
  it("keyword 조회 기본값은 global-only", async () => {
    await new FragmentReader().searchByKeywords(["synthetic"], {});
    assert.match(captured.sql, /workspace IS NULL/);
  });

  it("명시 workspace는 동일 workspace + NULL", async () => {
    await new FragmentReader().searchByTopic("synthetic-topic", { workspace: "ws-a" });
    assert.match(captured.sql, /\(workspace = \$\d+ OR workspace IS NULL\)/);
    assert.ok(captured.params.includes("ws-a"));
  });

  it("allWorkspaces=true는 keyword workspace 조건을 제거", async () => {
    await new FragmentReader().searchByKeywords(
      ["synthetic"], { allWorkspaces: true }
    );
    assert.doesNotMatch(captured.sql, /workspace (?:=|IS NULL)/);
  });

  it("semantic 조회도 global-only를 적용", async () => {
    await new FragmentReader().searchBySemantic([0.1, 0.2], {});
    assert.match(captured.sql, /f\.workspace IS NULL/);
  });

  it("source 조회는 allWorkspaces=true일 때만 필터를 제거", async () => {
    const reader = new FragmentReader();
    await reader.searchBySource("learning_extraction", "default", null, 5);
    assert.match(captured.sql, /workspace IS NULL/);

    await reader.searchBySource(
      "learning_extraction", "default", null, 5, null, true
    );
    assert.doesNotMatch(captured.sql, /workspace (?:=|IS NULL)/);
  });
});
