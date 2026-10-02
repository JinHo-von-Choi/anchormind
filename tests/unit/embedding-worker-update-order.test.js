/**
 * EmbeddingWorker 배치 저장 잠금 순서 검사
 *
 * 작성자: 최진호
 * 작성일: 2026-10-02
 *
 * 여러 행을 한 문장으로 갱신할 때 행 잠금 순서가 조회 순서나 실행 계획에 좌우되면
 * 같은 행을 id 순으로 잠그는 접근 기록 갱신과 교차해 교착이 생긴다.
 * 저장 문장이 id 오름차순 잠금 CTE를 거치고, 행별 벡터 대응이 유지되는지 DB 없이 확인한다.
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
    { id: "f-c", content: "gamma" },
    { id: "f-a", content: "alpha" },
    { id: "f-b", content: "beta" }
  ];

  it("대상 행을 id 오름차순으로 잠근 뒤 갱신한다", async () => {
    await buildWorker()._embedChunk(rows);

    assert.equal(queries.length, 1);
    const { sql, mode, agentId } = queries[0];
    assert.equal(agentId, "system");
    assert.equal(mode, "write");
    assert.match(sql, /ORDER BY id\s+FOR NO KEY UPDATE/);
    assert.match(sql, /UPDATE \S*fragments AS f[\s\S]*FROM locked/);
    assert.match(sql, /WHERE f\.id = locked\.id/);
  });

  it("잠금 CTE가 갱신 문장보다 앞에 온다", async () => {
    await buildWorker()._embedChunk(rows);

    const { sql } = queries[0];
    assert.ok(sql.indexOf("FOR NO KEY UPDATE") < sql.indexOf("SET embedding"));
  });

  it("행마다 id와 벡터를 짝지어 바인딩한다", async () => {
    await buildWorker()._embedChunk(rows);

    const { sql, params } = queries[0];
    assert.deepEqual(params, ["f-c", "[1]", "f-a", "[2]", "f-b", "[3]"]);
    assert.match(sql, /\(\$1::text, \$2::vector\), \(\$3::text, \$4::vector\), \(\$5::text, \$6::vector\)/);
    assert.match(sql, /JOIN v ON v\.id = locked\.id/);
  });
});
