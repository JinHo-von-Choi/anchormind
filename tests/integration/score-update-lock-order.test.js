/**
 * 대량 점수 갱신과 linked_to 정리의 잠금 순서 시험(일회용 DB)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 거래 T1이 id가 작은 행 a를 잠근 뒤, 물리 위치가 앞인 행 z를 갱신한다.
 * 같은 두 행을 다루는 배경 문장이 id 순으로 잠그면 교착이 생기지 않는다.
 * DATABASE_URL이 없으면 건너뛴다.
 */
import "./_cleanup.js";
import { describe, it, before, after } from "node:test";
import assert                          from "node:assert/strict";
import pg                              from "pg";

const DB_URL = process.env.DATABASE_URL;
let   admin;

before(async () => {
  if (!DB_URL) return;
  admin = new pg.Client({ connectionString: DB_URL });
  await admin.connect();
});

after(async () => {
  if (!admin) return;
  await admin.query(`DELETE FROM agent_memory.fragments WHERE id LIKE 'lo-%'`);
  await admin.end();
});

/**
 * a, z 두 행(필요 시 linked_to 포함)을 z, a 순으로 넣고 물리 순서를 확인한다.
 */
async function seedPair(tag, extra = {}) {
  const ids = { a: `lo-${tag}-a`, z: `lo-${tag}-z` };
  for (const id of [ids.z, ids.a]) {
    await admin.query(
      `INSERT INTO agent_memory.fragments
         (id, content, topic, type, content_hash, ttl_tier, importance, utility_score, linked_to)
       VALUES ($1, $1, 't', 'fact', md5($1), 'warm', 0.5, 0, $2)`,
      [id, extra.linkedTo ? [extra.linkedTo] : []]
    );
  }
  const { rows } = await admin.query(
    `SELECT id, ctid FROM agent_memory.fragments WHERE id = ANY($1) ORDER BY ctid`, [[ids.a, ids.z]]);
  assert.equal(rows[0].id, ids.z, "z가 물리적으로 앞에 있어야 재현 조건이 성립한다");
  return ids;
}

/**
 * T1이 a를 잠근 상태에서 background()를 띄우고, 그것이 잠금 대기에 들어가면 z를 갱신한다.
 * 같은 표를 쓰는 다른 시험이 대상 행을 먼저 갱신해 배경 문장이 대기 없이 끝나면
 * rearm()으로 행을 되돌리고 다시 시도한다.
 */
async function interleave(ids, background, waitPattern, rearm = async () => {}) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const t1 = new pg.Client({ connectionString: DB_URL });
    await t1.connect();
    try {
      await t1.query("BEGIN");
      await t1.query("SET LOCAL statement_timeout = 15000");
      await t1.query(`SELECT id FROM agent_memory.fragments WHERE id = $1 FOR NO KEY UPDATE`, [ids.a]);
      let bgError = null;
      let settled = false;
      const bg    = background().catch(err => { bgError = err; }).finally(() => { settled = true; });
      let waiting = false;
      /** 다른 시험이 남긴 행이 많으면 a에 닿기까지 오래 걸린다. 최대 60초 기다린다. */
      for (let i = 0; i < 600 && !waiting && !settled; i++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        const { rows } = await admin.query(
          `SELECT count(*)::int AS c FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND query ILIKE $1 AND pid <> pg_backend_pid()`, [waitPattern]);
        waiting = rows[0].c > 0;
      }
      if (!waiting) {
        await t1.query("ROLLBACK");
        await bg;
        if (bgError) return bgError;
        await rearm();
        continue;
      }
      await t1.query(`UPDATE agent_memory.fragments SET access_count = access_count + 1 WHERE id = $1`, [ids.z]);
      await t1.query("COMMIT");
      await bg;
      return bgError;
    } finally {
      await t1.end();
    }
  }
  assert.fail("배경 문장이 T1의 잠금을 기다려야 한다");
}

describe("잠금 순서", { skip: !DB_URL }, () => {
  it("decayImportance는 id 순 거래와 교착하지 않는다", async () => {
    const ids = await seedPair(`d${Date.now().toString(36)}`);
    const { FragmentGC } = await import("../../lib/memory/consolidate/FragmentGC.js");
    const err = await interleave(ids, () => new FragmentGC().decayImportance(), "%last_decay_at%");
    assert.equal(err, null, `감쇠 실패: ${err?.code} ${err?.message}`);
  });

  it("_updateUtilityScores는 id 순 거래와 교착하지 않는다", async () => {
    const ids = await seedPair(`u${Date.now().toString(36)}`);
    const { MemoryConsolidator } = await import("../../lib/memory/consolidate/MemoryConsolidator.js");
    const err = await interleave(ids,
      () => MemoryConsolidator.prototype._updateUtilityScores.call({}), "%SET utility_score%",
      () => admin.query(`UPDATE agent_memory.fragments SET utility_score = -1 WHERE id = ANY($1)`, [[ids.a, ids.z]]));
    assert.equal(err, null, `utility 실패: ${err?.code} ${err?.message}`);
  });

  it("FragmentWriter.delete의 linked_to 정리는 id 순 거래와 교착하지 않는다", async () => {
    const tag = `x${Date.now().toString(36)}`;
    const idX = `lo-${tag}-x`;
    await admin.query(
      `INSERT INTO agent_memory.fragments (id, content, topic, type, content_hash) VALUES ($1, $1, 't', 'fact', md5($1))`,
      [idX]);
    const ids = await seedPair(tag, { linkedTo: idX });
    const { FragmentWriter } = await import("../../lib/memory/write/FragmentWriter.js");
    const err = await interleave(ids, () => new FragmentWriter().delete(idX, "default", null), "%array_remove%");
    assert.equal(err, null, `삭제 실패: ${err?.code} ${err?.message}`);
    const { rows } = await admin.query(`SELECT count(*)::int AS c FROM agent_memory.fragments WHERE id = $1`, [idX]);
    assert.equal(rows[0].c, 0);
  });

  it("묶음 감쇠의 행별 결과는 같은 기준 시각의 단일 계산과 같다", async () => {
    const tag = `e${Date.now().toString(36)}`;
    for (let i = 0; i < 120; i++) {
      const id = `lo-${tag}-${String(i).padStart(3, "0")}`;
      await admin.query(
        `INSERT INTO agent_memory.fragments
           (id, content, topic, type, content_hash, ttl_tier, importance, last_decay_at, ema_activation)
         VALUES ($1, $1, 't', $2, md5($1), 'cold', $3, NOW() - make_interval(hours => $4), $5)`,
        [id, ["fact", "procedure", "error", "preference", "decision"][i % 5], 0.06 + (i % 40) * 0.02, 1 + (i % 30), (i % 7) / 10]);
    }
    await admin.query(`DROP TABLE IF EXISTS lo_before`);
    await admin.query(
      `CREATE TABLE lo_before AS
         SELECT id, importance, last_decay_at, accessed_at, created_at, type, ema_activation
           FROM agent_memory.fragments WHERE id LIKE $1`, [`lo-${tag}-%`]);
    process.env.MEMENTO_SCORE_UPDATE_BATCH = "50";
    try {
      const { FragmentGC, decayedImportanceSql } = await import("../../lib/memory/consolidate/FragmentGC.js");
      await new FragmentGC().decayImportance();
      const { rows } = await admin.query(
        `SELECT count(DISTINCT f.last_decay_at)::int AS clocks
           FROM agent_memory.fragments f JOIN lo_before o USING (id)`);
      const { rows: [bad] } = await admin.query(
        `SELECT count(*)::int AS c FROM agent_memory.fragments f JOIN lo_before o USING (id)
          WHERE f.importance <> (${decayedImportanceSql("f.last_decay_at", "o")})::real`);
      assert.equal(bad.c, 0, `기준 시각 계산과 다른 행 ${bad.c}`);
      assert.equal(rows[0].clocks, 1, "모든 묶음이 같은 기준 시각을 써야 한다");
    } finally {
      delete process.env.MEMENTO_SCORE_UPDATE_BATCH;
      await admin.query(`DROP TABLE IF EXISTS lo_before`);
    }
  });
});
