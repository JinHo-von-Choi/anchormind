import { test, describe } from "node:test";
import assert from "node:assert/strict";

describe("fragment history", () => {
  test("FragmentStore.getHistory가 함수이다", async () => {
    const { FragmentStore } = await import("../../lib/memory/write/FragmentStore.js");
    const store = new FragmentStore();
    assert.strictEqual(typeof store.getHistory, "function");
  });

  test("MemoryManager.fragmentHistory가 함수이다", async () => {
    const { MemoryManager } = await import("../../lib/memory/MemoryManager.js");
    const mm = new MemoryManager();
    assert.strictEqual(typeof mm.fragmentHistory, "function");
  });

  test("includePeerAgents를 저장소 조회 옵션으로 전달한다", async () => {
    let captured = null;
    const store = {
      getHistory: async (...args) => {
        captured = args;
        return { current: { id: "frag-peer" }, versions: [], superseded_by_chain: [] };
      }
    };
    const { MemoryRecaller } = await import("../../lib/memory/processors/MemoryRecaller.js");
    const recaller = new MemoryRecaller({ store });

    const result = await recaller.fragmentHistory({
      id               : "frag-peer",
      agentId          : "default",
      includePeerAgents: true
    });

    assert.equal(result.current.id, "frag-peer");
    assert.deepEqual(captured[4], { includePeerAgents: true, workspace: null, allWorkspaces: false });
  });
});

describe("reconstruct_history 근거 조회", () => {
  test("근거 조회는 이벤트 수와 무관하게 한 번의 질의로 묶는다", async () => {
    const { readFileSync } = await import("node:fs");
    const path             = (await import("node:path")).default;
    const ROOT = path.resolve(import.meta.dirname, "../..");
    const src  = readFileSync(path.join(ROOT, "lib/memory/read/HistoryReconstructor.js"), "utf8");
    assert.match(src, /getEvidenceByEvents/);
    assert.doesNotMatch(src, /Promise\.all\(case_events\.map\(async \(evt\) =>[\s\S]*getEvidenceByEvent\(/);
  });
});
