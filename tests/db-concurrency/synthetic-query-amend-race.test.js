import { describe, it, after, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

const { SCHEMA, prepareLaneDatabase, dropLaneDatabase, directQuery } = await import("./_harness.js");
await prepareLaneDatabase();
const vectorDimensions = Number((await directQuery(
  `SELECT atttypmod AS dims FROM pg_attribute
    WHERE attrelid = '${SCHEMA}.fragment_synthetic_query'::regclass AND attname = 'embedding'`
)).rows[0].dims);

let started;
let release;
const generated = new Promise(resolve => { started = resolve; });
const resume = new Promise(resolve => { release = resolve; });
const realGenerator = await import("../../lib/memory/embedding/SyntheticQueryGenerator.js");
const realEmbedding = await import("../../lib/tools/embedding.js");
mock.module("../../lib/memory/embedding/SyntheticQueryGenerator.js", {
  namedExports: { ...realGenerator, generateQueries: async () => { started(); await resume; return { queries: ["old question"] }; } }
});
mock.module("../../lib/tools/embedding.js", {
  namedExports: {
    ...realEmbedding,
    generateEmbedding: async () => Array(vectorDimensions).fill(0.01),
    prepareTextForEmbedding: text => text,
    EMBEDDING_ENABLED: true
  }
});

const { SyntheticQueryWorker } = await import("../../lib/memory/embedding/SyntheticQueryWorker.js");
const { shutdownPool } = await import("../../lib/tools/db.js");

after(async () => {
  try { await shutdownPool(); } finally { await dropLaneDatabase(); }
});

describe("합성 질의와 amend 경합", () => {
  it("이전 본문에서 생성한 질의를 새 본문 버전에 적재하지 않는다", async () => {
    const id = `synthetic-race-${crypto.randomUUID()}`;
    await directQuery(
      `INSERT INTO ${SCHEMA}.fragments
        (id, content, type, topic, importance, ttl_tier, agent_id, keywords, content_hash)
       VALUES ($1, 'old content', 'decision', 'race', 0.9, 'warm', 'default', '{}', 'old-hash')`,
      [id]
    );
    const worker = new SyntheticQueryWorker();
    const pending = worker._generateFor({
      id, content: "old content", content_hash: "old-hash", key_id: null, agent_id: "default", workspace: null
    });
    await generated;
    await directQuery(`UPDATE ${SCHEMA}.fragments SET content = 'new content', content_hash = 'new-hash' WHERE id = $1`, [id]);
    release();
    assert.equal(await pending, false);
    const { rows } = await directQuery(
      `SELECT count(*)::int AS n FROM ${SCHEMA}.fragment_synthetic_query WHERE fragment_id = $1`, [id]
    );
    assert.equal(rows[0].n, 0);
  });
});
