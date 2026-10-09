/**
 * fragment_segment의 임베딩 열을 fragments.embedding에 맞추는 정렬 (migration-064는 vector(1536)으로 만든다)
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

import { alignSegmentEmbedding } from "../../scripts/align-synthetic-query-embedding.js";

const column = (udtName, declaredDim) => ({ udtName, declaredDim });

function fakeClient(source, target) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      const normalized = sql.replace(/\s+/g, " ").trim();
      queries.push(normalized);
      if (normalized.includes("FROM pg_attribute")) {
        const spec = params[1] === "fragments" ? source : params[1] === "fragment_segment" ? target : undefined;
        return { rows: spec ? [{ udt_name: spec.udtName, declared_dim: spec.declaredDim }] : [] };
      }
      return { rows: [] };
    }
  };
}

const writes = client => client.queries.filter(q => !q.includes("FROM pg_attribute"));

describe("alignSegmentEmbedding", () => {
  it("이미 같은 차원이면 아무것도 바꾸지 않는다", async () => {
    const client = fakeClient(column("vector", 1536), column("vector", 1536));
    const out    = await alignSegmentEmbedding(client);
    assert.equal(out.action, "skip");
    assert.equal(out.reason, "already_aligned");
    assert.deepEqual(writes(client), []);
  });

  it("차원이 다르면 구간 행을 지우고 열 타입과 HNSW 인덱스를 새 차원으로 만든다", async () => {
    const client = fakeClient(column("vector", 1024), column("vector", 1536));
    const out    = await alignSegmentEmbedding(client);
    assert.equal(out.action, "converted");
    assert.equal(out.sourceType, "vector(1024)");
    assert.deepEqual(writes(client), [
      "BEGIN",
      "LOCK TABLE agent_memory.fragment_segment IN ACCESS EXCLUSIVE MODE",
      "DROP INDEX IF EXISTS agent_memory.idx_fseg_embedding_hnsw",
      "DELETE FROM agent_memory.fragment_segment",
      "ALTER TABLE agent_memory.fragment_segment ALTER COLUMN embedding TYPE vector(1024) USING NULL",
      "CREATE INDEX idx_fseg_embedding_hnsw ON agent_memory.fragment_segment USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 128) WHERE embedding IS NOT NULL",
      "COMMIT"
    ]);
  });

  it("halfvec 차원으로도 맞춘다", async () => {
    const client = fakeClient(column("halfvec", 3072), column("vector", 1536));
    const out    = await alignSegmentEmbedding(client);
    assert.equal(out.action, "converted");
    assert.ok(writes(client).some(q => q.includes("TYPE halfvec(3072)") || q.includes("halfvec_cosine_ops")));
  });

  it("구간 표가 아직 없으면(마이그레이션 전) 건너뛴다", async () => {
    const client = fakeClient(column("vector", 1024), undefined);
    const out    = await alignSegmentEmbedding(client);
    assert.equal(out.action, "skip");
    assert.equal(out.reason, "embedding_column_missing");
  });

  it("변환 중 실패하면 롤백하고 오류에 사유를 담는다", async () => {
    const client = fakeClient(column("vector", 1024), column("vector", 1536));
    const orig   = client.query;
    client.query = async (sql, params) => { if (/ALTER TABLE/.test(sql)) throw new Error("boom"); return orig(sql, params); };
    await assert.rejects(() => alignSegmentEmbedding(client), /segment embedding alignment failed/);
    assert.ok(client.queries.includes("ROLLBACK"));
  });
});
