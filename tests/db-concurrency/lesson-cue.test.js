/**
 * 교훈 상황 단서(cue) 행의 실서버 시험(일회용 DB)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-20
 *
 * 실제 행으로 다음을 확인한다.
 *   - registerLessonCues가 origin='cue' 행을 파편의 현재 content_hash로 넣는다
 *   - 닫힌 파편(valid_to)에는 cue 행을 넣지 않는다
 *   - origin 열은 generated(기본)와 cue만 받는다
 */

import { describe, it, after } from "node:test";
import assert                  from "node:assert/strict";
import crypto                  from "node:crypto";

process.env.EMBEDDING_BASE_URL = "http://127.0.0.1:9";

const { SCHEMA, prepareLaneDatabase, dropLaneDatabase, directQuery } = await import("./_harness.js");

await prepareLaneDatabase();

const { shutdownPool }        = await import("../../lib/tools/db.js");
const { registerLessonCues }  = await import("../../lib/memory/write/LessonCue.js");

after(async () => {
  try {
    await shutdownPool();
  } finally {
    await dropLaneDatabase();
  }
});

async function dims() {
  const { rows } = await directQuery(
    `SELECT atttypmod FROM pg_attribute
      WHERE attrelid = '${SCHEMA}.fragment_synthetic_query'::regclass AND attname = 'embedding'`);
  return rows[0].atttypmod;
}

async function insertFragment(id, { closed = false } = {}) {
  await directQuery(
    `INSERT INTO ${SCHEMA}.fragments
            (id, content, topic, type, importance, ttl_tier, agent_id, keywords, content_hash, valid_to)
     VALUES ($1, $1, 'lc-topic', 'procedure', 0.9, 'warm', 'default', '{}', md5($1), $2)`,
    [id, closed ? new Date() : null]);
  return id;
}

describe("LessonCue (실제 DB)", () => {
  it("cue 행을 현재 content_hash로 넣고 닫힌 파편은 건너뛴다", async () => {
    const n     = await dims();
    const embed = async () => Array.from({ length: n }, (_, i) => (i === 0 ? 1 : 0));
    const live   = await insertFragment(`lc-${crypto.randomUUID()}`);
    const closed = await insertFragment(`lc-${crypto.randomUUID()}`, { closed: true });

    const inserted = await registerLessonCues([
      { fragmentId: live,   cue: "배포 직후 헬스 체크가 실패할 때" },
      { fragmentId: closed, cue: "닫힌 파편의 상황" }
    ], { embed });
    assert.equal(inserted, 1);

    const { rows } = await directQuery(
      `SELECT q.fragment_id, q.origin, q.source_content_hash = f.content_hash AS fresh
         FROM ${SCHEMA}.fragment_synthetic_query q JOIN ${SCHEMA}.fragments f ON f.id = q.fragment_id
        WHERE q.fragment_id = ANY($1::text[])`, [[live, closed]]);
    assert.deepEqual(rows, [{ fragment_id: live, origin: "cue", fresh: true }]);
  });

  it("origin 열은 generated와 cue만 받는다", async () => {
    const id = await insertFragment(`lc-${crypto.randomUUID()}`);
    await assert.rejects(directQuery(
      `INSERT INTO ${SCHEMA}.fragment_synthetic_query (fragment_id, query_text, origin) VALUES ($1, 'q', 'other')`, [id]));
    const { rows } = await directQuery(
      `INSERT INTO ${SCHEMA}.fragment_synthetic_query (fragment_id, query_text) VALUES ($1, 'q') RETURNING origin`, [id]);
    assert.equal(rows[0].origin, "generated");
  });
});
