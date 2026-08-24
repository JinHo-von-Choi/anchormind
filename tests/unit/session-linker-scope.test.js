import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { SessionLinker } from "../../lib/memory/link/SessionLinker.js";

describe("SessionLinker authenticated scope", () => {
  test("key with missing workspace/group scope fails closed before index or store access", async () => {
    let indexCalls = 0;
    let storeCalls = 0;
    const linker = new SessionLinker(
      {
        async getByIds() { storeCalls++; throw new Error("must not read"); },
        async createLinks() { storeCalls++; throw new Error("must not write"); }
      },
      {
        async getSessionFragments() { indexCalls++; throw new Error("must not read"); },
        async getWorkingMemory() { indexCalls++; throw new Error("must not read"); }
      }
    );

    assert.equal(await linker.consolidateSessionFragments("s-a", "agent-a", "key-a"), null);
    assert.deepEqual(
      await linker.autoLinkSessionFragments([{ id: "a", key_id: "key-a" }], "agent-a", "key-a"),
      { linkedCount: 0, linkSuggestions: [] }
    );
    assert.equal(indexCalls, 0);
    assert.equal(storeCalls, 0);
  });
});
