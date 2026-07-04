/**
 * generateBatchEmbeddings transformers 경로 배치 호출 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-07-04
 */
import { test, mock } from "node:test";
import assert         from "node:assert";

const batchCalls = [];

mock.module("../../lib/embeddings/LocalTransformersEmbedder.js", {
  namedExports: {
    getLocalEmbedder: () => ({
      embed     : async () => { throw new Error("단건 embed가 호출되면 안 된다"); },
      embedBatch: async (texts) => {
        batchCalls.push(texts.length);
        return texts.map(() => [0.1, 0.2, 0.3]);
      }
    })
  }
});

mock.module("../../lib/config.js", {
  namedExports: {
    OPENAI_API_KEY                : "",
    EMBEDDING_API_KEY              : "",
    EMBEDDING_ENABLED              : true,
    EMBEDDING_BASE_URL             : "",
    EMBEDDING_PROVIDER             : "transformers",
    EMBEDDING_MODEL                : "test-model",
    EMBEDDING_DIMENSIONS           : 3,
    EMBEDDING_SUPPORTS_DIMS_PARAM  : false
    /** embedding.js:13-22의 import 목록과 1:1로 맞출 것 — 누락 시 undefined 에러로 즉시 드러남 */
  }
});

const { generateBatchEmbeddings } = await import("../../lib/tools/embedding.js");

test("transformers 경로는 embedBatch를 청크 단위로 호출한다", async () => {
  const texts = Array.from({ length: 70 }, (_, i) => `t${i}`);
  const vecs  = await generateBatchEmbeddings(texts, 32);
  assert.strictEqual(vecs.length, 70);
  assert.deepStrictEqual(batchCalls, [32, 32, 6]);
});
