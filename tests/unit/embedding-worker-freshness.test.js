import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

let resolveBatch;
let dbState;

mock.module("../../lib/tools/db.js", {
  namedExports: {
    queryWithAgentVector: async (_agent, sql, params) => {
      if (!sql.includes("UPDATE")) return { rows: [] };
      const sourceHash = params[1];
      const vector     = params[2];
      if (dbState.content_hash !== sourceHash || dbState.embedding !== null) return { rows: [], rowCount: 0 };
      dbState.embedding = vector;
      return { rows: [{ id: dbState.id }], rowCount: 1 };
    }
  }
});

mock.module("../../lib/tools/embedding.js", {
  namedExports: {
    generateEmbedding      : async () => [111],
    generateBatchEmbeddings: async () => new Promise(resolve => { resolveBatch = resolve; }),
    prepareTextForEmbedding: text => String(text),
    vectorToSql            : vec => `[${vec.join(",")}]`,
    EMBEDDING_ENABLED      : true
  }
});

const { EmbeddingWorker } = await import("../../lib/memory/embedding/EmbeddingWorker.js");

describe("EmbeddingWorker 원본 버전 가드", () => {
  it("amend 뒤 늦게 끝난 이전 본문의 벡터를 저장하거나 완료 이벤트로 알리지 않는다", async () => {
    dbState = { id: "f-1", content: "old", content_hash: "old-hash", embedding: null };
    const worker = new EmbeddingWorker();
    worker.embeddingCache = { get: async () => null, set: () => {} };
    const ready = [];
    worker.on("embedding_ready", event => ready.push(event.fragmentId));

    const pending = worker._embedMany([{ id: "f-1", content: "old", content_hash: "old-hash" }]);
    await new Promise(resolve => setImmediate(resolve));
    dbState = { ...dbState, content: "new", content_hash: "new-hash", embedding: null };
    resolveBatch([[111]]);
    await pending;

    assert.equal(dbState.embedding, null);
    assert.deepEqual(ready, []);
  });
});
