/**
 * 벤치마크 격리 키 행 보장과 임베딩 모델 비교 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */

import { describe, it, mock, after } from "node:test";
import assert                        from "node:assert/strict";

const order  = [];
const calls  = [];
const realDb = await import("../../lib/tools/db.js");
mock.module("../../lib/tools/db.js", {
  namedExports: {
    ...realDb,
    queryWithAgentVector: async (_agentId, sql, params) => {
      order.push("key");
      calls.push({ sql, params });
      return { rows: [], rowCount: 0 };
    }
  }
});

const { RecallBenchmark, embeddingMismatch }         = await import("../../lib/memory/signals/RecallBenchmark.js");
const { teardownTestResources, assertCleanShutdown } = await import("../_lifecycle.js");

after(async () => {
  await teardownTestResources();
  await assertCleanShutdown();
});

function makeManager() {
  return {
    deleteByAgent: async () => { order.push("cleanup"); return 0; },
    remember     : async () => { order.push("remember"); return { id: "frag-1" }; }
  };
}

const GOLDSET = [{ id: "g1", store: "Grafana 내부 포트는 3300이다", keywords: ["grafana"] }];

describe("RecallBenchmark.seed", () => {
  it("격리 키 스코프에서는 적재 전에 api_keys 행을 보장한다", async () => {
    order.length = 0;
    calls.length = 0;
    const idMap = await new RecallBenchmark(makeManager()).seed(GOLDSET);
    assert.equal(idMap.get("g1"), "frag-1");
    assert.deepEqual(order, ["key", "cleanup", "remember"]);
    assert.deepEqual(calls[0].params, ["benchmark-harness-key"]);
    assert.match(calls[0].sql, /api_keys/);
  });

  it("keyId가 null이면 api_keys 행을 만들지 않는다", async () => {
    order.length = 0;
    calls.length = 0;
    await new RecallBenchmark(makeManager(), { keyId: null }).seed(GOLDSET);
    assert.deepEqual(order, ["cleanup", "remember"]);
    assert.equal(calls.length, 0);
  });
});

describe("embeddingMismatch", () => {
  const current = { provider: "transformers", model: "Xenova/bge-m3", dimensions: 1024 };

  it("기준선에 임베딩 정보가 없으면 null", () => {
    assert.equal(embeddingMismatch(undefined, current), null);
  });

  it("모델이나 차원이 같으면 null", () => {
    assert.equal(embeddingMismatch({ model: "Xenova/bge-m3", dimensions: 1024 }, current), null);
  });

  it("모델이 다르면 두 모델 이름을 담은 문구를 돌려준다", () => {
    const msg = embeddingMismatch({ model: "text-embedding-3-small", dimensions: 1536 }, current);
    assert.match(msg, /text-embedding-3-small/);
    assert.match(msg, /Xenova\/bge-m3/);
  });
});
