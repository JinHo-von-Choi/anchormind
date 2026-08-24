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

  test("complete authenticated scope filters every fragment by exact group metadata", async () => {
    const links = [];
    const linker = new SessionLinker(
      {
        async createLinks(pairs) { links.push(...pairs); },
        async isReachable() { return false; }
      },
      null
    );
    const fragments = [
      { id: "e-a", type: "error", caseId: "case-a", key_id: "key-a", workspace: "ws-a", group_key_ids: ["key-a"], keywords: ["auth", "token"] },
      { id: "d-a", type: "decision", caseId: "case-a", key_id: "key-a", workspace: "ws-a", group_key_ids: ["key-a"], keywords: ["auth", "token"] },
      { id: "e-foreign-group", type: "error", caseId: "case-a", key_id: "key-a", workspace: "ws-a", group_key_ids: ["key-b"], keywords: ["auth", "token"] }
    ];

    await linker.autoLinkSessionFragments(fragments, "agent-a", "key-a", ["key-a"], "ws-a");

    assert.deepEqual(links, [{ fromId: "e-a", toId: "d-a", relationType: "caused_by" }]);
  });
});
