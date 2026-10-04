/**
 * EmbeddingWorker 배치 저장 잠금 순서 검사
 *
 * 작성자: 최진호
 * 작성일: 2026-10-02
 *
 * 여러 행을 한 문장으로 갱신할 때 행 잠금 순서가 조회 순서나 실행 계획에 좌우되면
 * 같은 행을 id 순으로 잠그는 접근 기록 갱신과 교차해 교착이 생긴다.
 * 저장은 id 오름차순 잠금 문장과 잠근 행만 갱신하는 문장으로 나뉘고, 행별 벡터 대응이
 * 유지되는지 DB 없이 확인한다.
 */

import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

let queries = [];

mock.module("../../lib/tools/db.js", {
  namedExports: {
    queryWithAgentVector: async (agentId, sql, params, mode) => {
      queries.push({ agentId, sql, params, mode });
      return { rows: [], rowCount: 0 };
    }
  }
});
mock.module("../../lib/tools/embedding.js", {
  namedExports: {
    generateEmbedding      : async () => [0],
    generateBatchEmbeddings: async texts => texts.map(() => [0]),
    prepareTextForEmbedding: text => String(text),
    vectorToSql            : vec => `[${vec.join(",")}]`,
    EMBEDDING_ENABLED      : true
  }
});

const { EmbeddingWorker } = await import("../../lib/memory/embedding/EmbeddingWorker.js");

function buildWorker() {
  const worker = new EmbeddingWorker();
  let   n      = 0;
  worker.embeddingCache = {
    get: async () => [++n],
    set: () => {}
  };
  return worker;
}

beforeEach(() => {
  queries = [];
});

describe("EmbeddingWorker 배치 저장 잠금 순서", () => {
  const rows = [
    { id: "f-c", content: "gamma", content_hash: "hash-c" },
    { id: "f-a", content: "alpha", content_hash: "hash-a" },
    { id: "f-b", content: "beta",  content_hash: "hash-b" }
  ];

  it("대상 행을 id 오름차순으로 먼저 잠그는 문장을 함께 넘긴다", async () => {
    await buildWorker()._embedChunk(rows);

    assert.equal(queries.length, 1);
    const { mode, agentId } = queries[0];
    assert.equal(agentId, "system");
    assert.equal(mode.lock.operation, "embedding");
    assert.match(mode.lock.sql, /^SELECT id FROM \S*fragments WHERE id = ANY\(\$1::text\[\]\) ORDER BY id FOR NO KEY UPDATE$/);
    assert.deepEqual(mode.lock.params, [["f-c", "f-a", "f-b"]]);
  });

  it("갱신 문장은 잠근 행($1)만 갱신하고 잠금 CTE를 쓰지 않는다", async () => {
    await buildWorker()._embedChunk(rows);
    const { sql } = queries[0];
    assert.match(sql, /UPDATE \S*fragments AS f[\s\S]*SET embedding = v\.vec::vector/);
    assert.match(sql, /AND f\.id = ANY\(\$1::text\[\]\)/);
    assert.match(sql, /AND f\.content_hash = v\.source_hash/);
    assert.match(sql, /AND f\.embedding IS NULL/);
    assert.doesNotMatch(sql, /FOR NO KEY UPDATE|locked/);
  });

  it("행마다 id와 벡터를 짝지어 $2부터 바인딩한다", async () => {
    await buildWorker()._embedChunk(rows);
    const { sql, params } = queries[0];
    assert.deepEqual(params, ["f-c", "hash-c", "[1]", "f-a", "hash-a", "[2]", "f-b", "hash-b", "[3]"]);
    assert.match(sql, /\(\$2::text, \$3::text, \$4::vector\), \(\$5::text, \$6::text, \$7::vector\), \(\$8::text, \$9::text, \$10::vector\)/);
    assert.match(sql, /WHERE f\.id = v\.id/);
  });
});
