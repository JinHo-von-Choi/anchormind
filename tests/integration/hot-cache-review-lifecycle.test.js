import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { FragmentSearch } from "../../lib/memory/read/FragmentSearch.js";
import { teardownTestResources, assertCleanShutdown } from "../_lifecycle.js";

after(async () => {
  await teardownTestResources();
  await assertCleanShutdown();
});

function harness(cached, current) {
  const search = new FragmentSearch();
  search.index = { getCachedFragment: async () => cached.value };
  search.store = { getCacheValidation: async () => current.value ? [current.value] : [] };
  return () => search._tryHotCache(["f1"], "writer", null, {
    agentId: "default", viewerKeyId: "writer", workspace: null
  });
}

describe("Hot Cache 검토 상태 전이", () => {
  it("pending 승인·거절, amend, 결정 뒤 늦은 cache fill을 모두 miss로 강등한다", async () => {
    const cached = { value: { id: "f1", content: "old", content_hash: "h1", review_state: "pending", valid_to: null } };
    const current = { value: { id: "f1", content_hash: "h1", review_state: "pending", valid_to: null } };
    const read = harness(cached, current);
    assert.equal((await read()).length, 1);

    current.value = { ...current.value, review_state: "approved" };
    assert.deepEqual(await read(), [], "pending → approve");

    current.value = { ...current.value, review_state: "rejected", valid_to: "2026-10-04T00:00:00Z" };
    assert.deepEqual(await read(), [], "pending → reject");

    cached.value = { ...cached.value, review_state: "approved" };
    current.value = { id: "f1", content_hash: "h2", review_state: "approved", valid_to: null };
    assert.deepEqual(await read(), [], "amend content hash");

    cached.value = { id: "f1", content: "late", content_hash: "h2", review_state: "pending", valid_to: null };
    current.value = { id: "f1", content_hash: "h2", review_state: "rejected", valid_to: "2026-10-04T00:01:00Z" };
    assert.deepEqual(await read(), [], "late fill after reject");
  });
});
