/**
 * EmbeddingWorker 캐시-우선 생성 (정적 가드 + 동작 검증)
 *
 * 작성자: 최진호
 * 작성일: 2026-07-16
 */

import { describe, it, mock } from "node:test";
import assert                 from "node:assert/strict";
import { readFileSync }       from "node:fs";
import { fileURLToPath }      from "node:url";

/* ── 동작 테스트용 모듈 mock (반드시 worker import 전에 등록) ── */
const generateEmbedding = mock.fn(async () => [0.1, 0.2, 0.3]);

mock.module("../../lib/tools/embedding.js", {
  namedExports: {
    generateEmbedding,
    generateBatchEmbeddings: mock.fn(async (texts) => texts.map(() => [0.1, 0.2, 0.3])),
    prepareTextForEmbedding: (t) => String(t),
    vectorToSql            : (v) => JSON.stringify(v),
    EMBEDDING_ENABLED      : true
  }
});
mock.module("../../lib/tools/db.js", {
  namedExports: {
    queryWithAgentVector: mock.fn(async () => ({ rows: [] }))
  }
});

const SRC = readFileSync(
  fileURLToPath(new URL("../../lib/memory/embedding/EmbeddingWorker.js", import.meta.url)),
  "utf8"
);

describe("embedding worker cache-first generation (static)", () => {
  it("EmbeddingCache를 import하고 인스턴스화한다", () => {
    assert.match(SRC, /import\s*\{\s*EmbeddingCache\s*\}/);
    assert.match(SRC, /new EmbeddingCache\(\s*\{\s*redis:/);
  });

  it("생성 전 캐시 get, 미스 시 set 한다", () => {
    assert.match(SRC, /embeddingCache\.get\(/);
    assert.match(SRC, /embeddingCache\.set\(/);
  });

  it("캐시 키를 detectConflicts와 동일하게 expandAssistantQuery로 정렬한다", () => {
    assert.match(SRC, /expandAssistantQuery/);
  });
});

describe("embedding worker cache-first generation (behavior)", () => {
  it("캐시 히트 시 generateEmbedding 미호출, 미스 시 1회 생성 + set", async () => {
    generateEmbedding.mock.resetCalls();

    const { EmbeddingWorker } = await import("../../lib/memory/embedding/EmbeddingWorker.js");
    const worker = new EmbeddingWorker();
    worker.config = { retryLimit: 1, queueKey: "test" };

    /** Redis 대신 인메모리 페이크 캐시 주입 */
    const store = new Map();
    const setSpy = mock.fn((k, v) => { store.set(k, v); });
    worker.embeddingCache = {
      get: mock.fn(async (k) => (store.has(k) ? store.get(k) : null)),
      set: setSpy
    };

    /** detectConflicts가 채운 것처럼, 워커와 동일한 키 헬퍼로 캐시 워밍 */
    const hitContent = "캐시에 이미 있는 파편";
    store.set(worker._cacheKeyText(hitContent), [0.9, 0.9, 0.9]);

    await worker._embedOne({ id: "f-hit", content: hitContent });
    assert.equal(generateEmbedding.mock.callCount(), 0, "히트 시 생성 호출 없음");

    await worker._embedOne({ id: "f-miss", content: "캐시에 없는 새 파편" });
    assert.equal(generateEmbedding.mock.callCount(), 1, "미스 시 생성 1회");
    assert.equal(setSpy.mock.callCount(), 1, "미스 시 set 1회");
  });
});
