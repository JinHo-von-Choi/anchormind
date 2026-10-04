import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

const { SCHEMA, prepareLaneDatabase, dropLaneDatabase, directQuery } = await import("./_harness.js");
await prepareLaneDatabase();

const { EmbeddingWorker } = await import("../../lib/memory/embedding/EmbeddingWorker.js");
const { shutdownPool } = await import("../../lib/tools/db.js");

after(async () => {
  try { await shutdownPool(); } finally { await dropLaneDatabase(); }
});

describe("임베딩과 amend 경합", () => {
  it("이전 본문으로 계산한 벡터를 새 본문 행에 쓰지 않는다", async () => {
    const id = `embed-race-${crypto.randomUUID()}`;
    const oldHash = crypto.createHash("md5").update(id).digest("hex");
    await directQuery(
      `INSERT INTO ${SCHEMA}.fragments
        (id, content, type, topic, importance, ttl_tier, agent_id, keywords, content_hash)
       VALUES ($1, 'old content', 'fact', 'race', 0.5, 'warm', 'default', '{}', $2)`,
      [id, oldHash]
    );
    const dims = (await directQuery(
      `SELECT atttypmod AS dims FROM pg_attribute
        WHERE attrelid = '${SCHEMA}.fragments'::regclass AND attname = 'embedding'`
    )).rows[0].dims;

    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const worker = new EmbeddingWorker();
    worker.embeddingCache = { get: async () => { await gate; return Array(dims).fill(0.01); }, set() {} };
    const pending = worker._embedChunk([{ id, content: "old content", content_hash: oldHash }]);

    await directQuery(
      `UPDATE ${SCHEMA}.fragments SET content = 'new content', content_hash = 'new-hash', embedding = NULL WHERE id = $1`,
      [id]
    );
    release();
    await pending;

    const { rows } = await directQuery(`SELECT content, content_hash, embedding IS NULL AS empty FROM ${SCHEMA}.fragments WHERE id = $1`, [id]);
    assert.deepEqual(rows[0], { content: "new content", content_hash: "new-hash", empty: true });
  });
});
