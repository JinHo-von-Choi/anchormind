/**
 * LocalTransformersEmbedder 동시성·배치 동작 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-07-04
 */
import { test, mock } from "node:test";
import assert         from "node:assert";

let pipelineCalls = 0;
let inferCalls    = [];

mock.module("@huggingface/transformers", {
  namedExports: {
    pipeline: async () => {
      pipelineCalls += 1;
      await new Promise(r => setTimeout(r, 20));
      /** 호출 시그니처를 기록하는 가짜 파이프라인. 입력이 배열이면 2D 결과 반환 */
      return async (input) => {
        inferCalls.push(input);
        const dims = 4;
        const one  = () => new Array(dims).fill(0.5);
        if (Array.isArray(input)) {
          return { tolist: () => input.map(one), data: null };
        }
        return { data: Float32Array.from(one()) };
      };
    }
  }
});

const { LocalTransformersEmbedder } = await import("../../lib/embeddings/LocalTransformersEmbedder.js");

test("동시 init 2건이 pipeline()을 1회만 실행한다", async () => {
  pipelineCalls  = 0;
  const embedder = new LocalTransformersEmbedder({ modelId: "m1", dimensions: 4 });
  await Promise.all([embedder.init(), embedder.init()]);
  assert.strictEqual(pipelineCalls, 1);
});

test("동시 embed 호출이 직렬화된다 (동시 in-flight 최대 1)", async () => {
  const embedder  = new LocalTransformersEmbedder({ modelId: "m2", dimensions: 4 });
  let inFlight    = 0;
  let maxInFlight = 0;
  await embedder.init();
  const origPipe     = embedder._pipeline;
  embedder._pipeline = async (input, opts) => {
    inFlight   += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise(r => setTimeout(r, 10));
    inFlight   -= 1;
    return origPipe(input, opts);
  };
  await Promise.all([embedder.embed("a"), embedder.embed("b"), embedder.embed("c")]);
  assert.strictEqual(maxInFlight, 1);
});

test("embedBatch는 배열 1회 추론으로 텍스트 수만큼 벡터를 반환한다", async () => {
  inferCalls     = [];
  const embedder = new LocalTransformersEmbedder({ modelId: "m3", dimensions: 4 });
  const vecs     = await embedder.embedBatch(["x", "y", "z"]);
  assert.strictEqual(vecs.length, 3);
  assert.strictEqual(vecs[0].length, 4);
  assert.strictEqual(inferCalls.length, 1);
  assert.deepStrictEqual(inferCalls[0], ["x", "y", "z"]);
});

test("차원 불일치 시 throw", async () => {
  const embedder = new LocalTransformersEmbedder({ modelId: "m4", dimensions: 8 });
  await assert.rejects(() => embedder.embed("a"), /dim mismatch/i);
});
