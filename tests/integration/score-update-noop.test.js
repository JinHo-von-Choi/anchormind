/**
 * 점수 갱신의 무변경 재기록 검사(일회용 DB)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 값이 바뀌지 않는 행은 두 번째 실행에서 다시 쓰이지 않아야 한다(xmin 불변).
 * DATABASE_URL이 없으면 건너뛴다.
 */
import "./_cleanup.js";
import { describe, it, before, after } from "node:test";
import assert                          from "node:assert/strict";
import pg                              from "pg";

const DB_URL = process.env.DATABASE_URL;
const TAG    = `noop${Date.now().toString(36)}`;
let   client;

before(async () => {
  if (!DB_URL) return;
  client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  /** 30일 미만, 접근 3회: utility = importance * (1 + ln 3), 시각에 의존하지 않는다 */
  for (let i = 0; i < 20; i++) {
    const id = `${TAG}-${String(i).padStart(2, "0")}`;
    await client.query(
      `INSERT INTO agent_memory.fragments
         (id, content, topic, type, content_hash, importance, access_count, created_at, ttl_tier)
       VALUES ($1, $1, 't', 'fact', md5($1), $2, 3, NOW() - INTERVAL '3 days', 'warm')`,
      [id, 0.3 + i * 0.02]
    );
  }
});

after(async () => {
  if (!client) return;
  await client.query(`DELETE FROM agent_memory.fragments WHERE id LIKE $1`, [`${TAG}-%`]);
  await client.end();
});

describe("utility_score 무변경 재기록", { skip: !DB_URL }, () => {
  it("두 번째 실행은 값이 같은 행을 다시 쓰지 않는다", async () => {
    const { MemoryConsolidator } = await import("../../lib/memory/consolidate/MemoryConsolidator.js");
    const run = () => MemoryConsolidator.prototype._updateUtilityScores.call({});
    await run();
    const before = await client.query(
      `SELECT id, xmin::text AS x FROM agent_memory.fragments WHERE id LIKE $1 ORDER BY id`, [`${TAG}-%`]);
    await run();
    const after = await client.query(
      `SELECT id, xmin::text AS x FROM agent_memory.fragments WHERE id LIKE $1 ORDER BY id`, [`${TAG}-%`]);
    const rewritten = after.rows.filter((r, i) => r.x !== before.rows[i].x).length;
    assert.equal(rewritten, 0, `다시 쓰인 행 ${rewritten}/20`);
  });
});
