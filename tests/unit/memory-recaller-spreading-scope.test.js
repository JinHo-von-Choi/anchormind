import { after, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { teardownTestResources, assertCleanShutdown } from "../_lifecycle.js";

after(async () => {
  await teardownTestResources();
  await assertCleanShutdown();
});

const activationCalls = [];

mock.module("../../lib/memory/signals/SpreadingActivation.js", {
  namedExports: {
    activateByContext: mock.fn(async (...args) => {
      activationCalls.push(args);
      return [];
    })
  }
});

const { MemoryRecaller } = await import("../../lib/memory/processors/MemoryRecaller.js");

function createRecaller() {
  return new MemoryRecaller({
    search: {
      search: async () => ({
        fragments: [{
          id: "fragment-a",
          content: "synthetic fragment",
          workspace: null,
          importance: 0.5,
          created_at: "2026-01-01T00:00:00Z"
        }],
        count: 1,
        totalTokens: 4,
        searchPath: "L2:1"
      })
    },
    store: { getLinkedFragments: async () => [] },
    index: { getSeenIds: async () => new Set() },
    suggestionEngine: null
  });
}

describe("MemoryRecaller spreading workspace propagation", () => {
  let previous;
  before(() => {
    previous = process.env.ENABLE_SPREADING_ACTIVATION;
    process.env.ENABLE_SPREADING_ACTIVATION = "true";
  });
  after(() => {
    if (previous === undefined) delete process.env.ENABLE_SPREADING_ACTIVATION;
    else process.env.ENABLE_SPREADING_ACTIVATION = previous;
  });

  it("global-only scope 전달", async () => {
    activationCalls.length = 0;
    await createRecaller().recall({ contextText: "context", includeLinks: false });
    assert.deepEqual(activationCalls[0][4], {
      workspace: null,
      allWorkspaces: false
    });
  });

  it("명시 workspace scope 전달", async () => {
    activationCalls.length = 0;
    await createRecaller().recall({
      contextText: "context", workspace: "ws-a", includeLinks: false
    });
    assert.equal(activationCalls[0][4].workspace, "ws-a");
  });

  it("master allWorkspaces scope 전달", async () => {
    activationCalls.length = 0;
    await createRecaller().recall({
      contextText: "context", allWorkspaces: true, _isMaster: true, includeLinks: false
    });
    assert.equal(activationCalls[0][4].allWorkspaces, true);
  });
});
