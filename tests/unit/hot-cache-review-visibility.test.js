import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { teardownTestResources, assertCleanShutdown } from "../_lifecycle.js";

import { FragmentSearch } from "../../lib/memory/read/FragmentSearch.js";

after(async () => {
  await teardownTestResources();
  await assertCleanShutdown();
});

function searchWith(cached, metadata) {
  const search = new FragmentSearch();
  search.index = { getCachedFragment: async () => cached };
  search.store = { getCacheValidation: async () => metadata };
  return search;
}

describe("Hot Cache 검토 생명주기", () => {
  it("본문 해시가 바뀐 캐시를 miss로 강등한다", async () => {
    const search = searchWith(
      { id: "f1", content: "old", content_hash: "old", review_state: "pending", valid_to: null },
      [{ id: "f1", content_hash: "new", review_state: "pending", valid_to: null }]
    );
    assert.deepEqual(await search._tryHotCache(["f1"], "k1", null, { agentId: "a", viewerKeyId: "k1" }), []);
  });

  it("승인·거절로 검토 상태가 바뀐 캐시를 반환하지 않는다", async () => {
    const cached = { id: "f1", content: "x", content_hash: "h", review_state: "pending", valid_to: null };
    for (const state of ["approved", "rejected"]) {
      const search = searchWith(cached, [{ id: "f1", content_hash: "h", review_state: state, valid_to: null }]);
      assert.deepEqual(await search._tryHotCache(["f1"], "k1", null, { agentId: "a", viewerKeyId: "k1" }), []);
    }
  });

  it("DB 재검증 실패는 캐시 hit가 아니라 miss다", async () => {
    const search = searchWith({ id: "f1", content: "x", content_hash: "h" }, []);
    search.store.getCacheValidation = async () => { throw new Error("db down"); };
    assert.deepEqual(await search._tryHotCache(["f1"], "k1", null, { agentId: "a" }), []);
  });
});
