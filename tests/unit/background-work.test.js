import { describe, it, mock, after } from "node:test";
import assert from "node:assert/strict";

import { teardownTestResources } from "../_lifecycle.js";
import { MEMORY_CONFIG } from "../../config/memory.js";
import { drainBackgroundWork, trackBackgroundWork } from "../../lib/background-work.js";
import { RememberPostProcessor } from "../../lib/memory/write/RememberPostProcessor.js";

after(async () => { await teardownTestResources(); });

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

/** drain이 끝났는지를 이벤트 루프를 한 바퀴 돌린 뒤 확인한다. */
async function isSettled(promise) {
  let settled = false;
  promise.then(() => { settled = true; });
  await new Promise((r) => setImmediate(r));
  return settled;
}

describe("drainBackgroundWork", () => {
  it("remember 응답 뒤에 도는 자동 링크가 끝나야 끝난다", async () => {
    const originalMode = MEMORY_CONFIG.proactiveRecall.mode;
    MEMORY_CONFIG.proactiveRecall.mode = "legacy";
    const link = deferred();

    try {
      const processor = new RememberPostProcessor({
        store           : { createLink: mock.fn(() => link.promise) },
        conflictResolver: { checkAssertionConsistency: mock.fn(async () => ({ assertionStatus: "observed" })) },
        temporalLinker  : { linkTemporalNeighbors: mock.fn(async () => undefined) },
        morphemeIndex   : { tokenize: mock.fn(async () => []), getOrRegisterEmbeddings: mock.fn(async () => undefined) },
        search          : { search: mock.fn(async () => ({ fragments: [{ id: "old", keywords: ["cpu", "성능"] }] })) }
      });

      await processor.run(
        { id: "new", content: "cpu 성능 저하", type: "fact", keywords: ["cpu", "성능"] },
        { agentId: "agent", keyId: null }
      );

      const drained = drainBackgroundWork();
      assert.equal(await isSettled(drained), false);

      link.resolve();
      await drained;
    } finally {
      MEMORY_CONFIG.proactiveRecall.mode = originalMode;
    }
  });

  it("대기 중에 새로 띄운 작업과 실패한 작업도 함께 처리한다", async () => {
    const first  = deferred();
    const second = deferred();

    trackBackgroundWork(first.promise.then(() => { trackBackgroundWork(second.promise); }));
    trackBackgroundWork(Promise.reject(new Error("이미 호출자가 기록한 실패")).catch(() => {}));

    const drained = drainBackgroundWork();
    first.resolve();
    assert.equal(await isSettled(drained), false);

    second.resolve();
    await drained;
  });
});
