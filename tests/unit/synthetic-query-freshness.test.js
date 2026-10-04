import { after, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { teardownTestResources, assertCleanShutdown } from "../_lifecycle.js";

after(async () => {
  await teardownTestResources();
  await assertCleanShutdown();
});

let currentHash = "old-hash";
const writes = [];

mock.module("../../lib/redis.js", { namedExports: { popFromQueue: async () => null, getQueueLength: async () => 0 } });
mock.module("../../lib/memory/embedding/SyntheticQueryGenerator.js", {
  namedExports: { generateQueries: async () => ({ queries: ["질문"] }), isEligible: () => true }
});
mock.module("../../lib/tools/embedding.js", {
  namedExports: { generateEmbedding: async () => [0.1], prepareTextForEmbedding: text => text, EMBEDDING_ENABLED: true }
});
mock.module("../../lib/tools/db.js", {
  namedExports: {
    queryWithAgentVector: mock.fn(async (_agent, sql, params) => {
      writes.push({ sql, params });
      return { rows: [], rowCount: params[6] === currentHash ? 1 : 0 };
    })
  }
});
mock.module("../../config/memory.js", {
  namedExports: { MEMORY_CONFIG: { syntheticQuery: { enabled: true } } }
});
mock.module("../../lib/logger.js", {
  namedExports: { logWarn: mock.fn(), logInfo: mock.fn(), logError: mock.fn(), logDebug: mock.fn() }
});

const { SyntheticQueryWorker } = await import("../../lib/memory/embedding/SyntheticQueryWorker.js");

describe("합성 질의 원문 버전", () => {
  it("생성 중 본문 해시가 바뀌면 이전 본문의 질의를 저장하지 않는다", async () => {
    const worker = new SyntheticQueryWorker();
    currentHash = "new-hash";
    const generated = await worker._generateFor({
      id: "f-1", content: "old", content_hash: "old-hash", key_id: null, agent_id: "default", workspace: null
    });
    assert.equal(generated, false);
    assert.equal(worker.stats.generated, 0);
    assert.match(writes[0].sql, /content_hash = \$7/);
    assert.match(writes[0].sql, /FOR KEY SHARE/);
    assert.equal(writes[0].params[6], "old-hash");
  });
});
