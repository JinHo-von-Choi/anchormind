/**
 * 작업 기억 PostgreSQL 행 검사(일회용 DB)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 실제 PostgreSQL에서 작업 기억 행의 기록, 조회, 보관 시간 만료, 보관량 제거, 세션 격리,
 * 조회 대상에서의 제외를 확인한다. 실행마다 전용 데이터베이스를 만들어 쓰고 끝나면 지운다.
 */
import { describe, it, before, after } from "node:test";
import assert                          from "node:assert/strict";
import pg                              from "pg";

const { prepareLaneDatabase, dropLaneDatabase, directClientConfig } = await import("./_harness.js");

/** 앱 모듈이 풀을 만들기 전에 실행 전용 데이터베이스를 준비한다. */
await prepareLaneDatabase();

const { shutdownPool }       = await import("../../lib/tools/db.js");
const { FragmentWriter }     = await import("../../lib/memory/write/FragmentWriter.js");
const { FragmentFactory }    = await import("../../lib/memory/write/FragmentFactory.js");
const { WriteGate, WRITE_ENTRIES } = await import("../../lib/memory/write/WriteGate.js");
const wm                     = await import("../../lib/memory/WorkingMemoryRows.js");
const { processMorphemeBackfill } = await import("../../lib/memory/consolidate/MorphemeBackfill.js");

const TAG    = `wm${Date.now().toString(36)}`;
const writer = new FragmentWriter();
const gate   = new WriteGate();
const factory = new FragmentFactory();

let client;
let seq = 0;

/** 관문을 거친 작업 기억 행을 FragmentWriter로 기록한다. */
async function writeWmRow({ session = `${TAG}-a`, content = null, tokens = 10, importance = 0.5 } = {}) {
  seq += 1;
  const text = content ?? `작업 기억 본문 ${TAG} ${seq} 충분히 길게 적는다`;
  const { draft } = await gate.check({
    entry : WRITE_ENTRIES.REMEMBER,
    op    : "create",
    fields: { content: text, topic: "wm-test", type: "fact", importance },
    build : (input) => {
      const f = factory.create({ ...input, sessionId: session }, { contentPrepared: true });
      f.agent_id         = "default";
      f.key_id           = null;
      f.workspace        = null;
      f.estimated_tokens = tokens;
      return f;
    }
  });
  return writer.insert(wm.markWorkingMemoryRow(draft));
}

before(async () => {
  client = new pg.Client(directClientConfig());
  await client.connect();
});

after(async () => {
  try {
    await client.end();
    await shutdownPool();
  } finally {
    await dropLaneDatabase();
  }
});

async function backdate(id, seconds) {
  await client.query(
    "UPDATE agent_memory.fragments SET created_at = NOW() - make_interval(secs => $2) WHERE id = $1",
    [id, seconds]
  );
}

describe("작업 기억 행 기록과 조회", () => {
  it("기록한 행을 같은 세션이 읽고 조회 대상(valid_to IS NULL)에는 나타나지 않는다", async () => {
    const session = `${TAG}-rw`;
    const id      = await writeWmRow({ session });
    const items   = await wm.listWorkingMemoryRows(session);
    assert.deepEqual(items.map(i => i.id), [id]);
    assert.equal(items[0].agent_id, "default");

    const live = await client.query(
      "SELECT count(*)::int AS n FROM agent_memory.fragments WHERE id = $1 AND valid_to IS NULL", [id]);
    assert.equal(live.rows[0].n, 0);
    const row = (await client.query(
      "SELECT source, ttl_tier, session_id, is_anchor FROM agent_memory.fragments WHERE id = $1", [id])).rows[0];
    assert.deepEqual(row, { source: "wm-fallback", ttl_tier: "short", session_id: session, is_anchor: false });
  });

  it("같은 본문의 영구 파편과 서로 중복으로 판정하지 않는다", async () => {
    const content = `중복 판정 확인 본문 ${TAG} 충분히 길게 적는다`;
    const permanentId = `${TAG}-perm`;
    await client.query(
      `INSERT INTO agent_memory.fragments (id, content, topic, type, content_hash, key_id)
       VALUES ($1, $2, 't', 'fact', encode(sha256(convert_to($2, 'UTF8')), 'hex'), NULL)`,
      [permanentId, content]
    );
    const wmId = await writeWmRow({ session: `${TAG}-dup`, content });
    assert.notEqual(wmId, permanentId);
    const left = await client.query("SELECT count(*)::int AS n FROM agent_memory.fragments WHERE id = $1", [permanentId]);
    assert.equal(left.rows[0].n, 1);
  });

  it("한 세션 안에서 같은 본문은 한 행이다", async () => {
    const session = `${TAG}-same`;
    const content = `세션 안 같은 본문 ${TAG} 충분히 길게 적는다`;
    const a = await writeWmRow({ session, content });
    const b = await writeWmRow({ session, content });
    assert.equal(a, b);
    assert.equal((await wm.listWorkingMemoryRows(session)).length, 1);
  });

  it("morpheme 백필은 작업 기억 행을 처리하지 않는다", async () => {
    const id = await writeWmRow({ session: `${TAG}-morph` });
    const seen = [];
    await processMorphemeBackfill({
      morphemeIndex: { tokenize: async (t) => { seen.push(t); return []; }, getOrRegisterEmbeddings: async () => [] },
      batchSize    : 5000
    });
    const row = (await client.query("SELECT content, morpheme_indexed FROM agent_memory.fragments WHERE id = $1", [id])).rows[0];
    assert.ok(!seen.includes(row.content), "작업 기억 본문이 형태소 처리에 전달됐다");
    assert.equal(row.morpheme_indexed, false);
  });
});

describe("보관 시간 만료와 정리", () => {
  it("24시간이 지난 행은 조회되지 않고 정리가 지운다", async () => {
    const session = `${TAG}-ttl`;
    const old     = await writeWmRow({ session });
    const fresh   = await writeWmRow({ session });
    await backdate(old, 25 * 3600);

    assert.deepEqual((await wm.listWorkingMemoryRows(session)).map(i => i.id), [fresh]);
    const deleted = await wm.deleteExpiredWorkingMemoryRows();
    assert.ok(deleted >= 1);
    const remain = await client.query("SELECT id FROM agent_memory.fragments WHERE id = ANY($1::text[])", [[old, fresh]]);
    assert.deepEqual(remain.rows.map(r => r.id), [fresh]);
  });

  it("정리는 일반 파편을 지우지 않는다", async () => {
    const id = `${TAG}-keep`;
    await client.query(
      `INSERT INTO agent_memory.fragments (id, content, topic, type, content_hash, source, session_id, created_at)
       VALUES ($1, 'keep', 't', 'fact', md5($1), 'wm-fallback', 'x', NOW() - INTERVAL '3 days')`, [id]);
    await wm.deleteExpiredWorkingMemoryRows();
    const row = await client.query("SELECT 1 FROM agent_memory.fragments WHERE id = $1", [id]);
    assert.equal(row.rowCount, 1, "valid_to가 비어 있는 행은 작업 기억 행이 아니다");
  });

  it("FragmentWriter.deleteExpired가 만료한 작업 기억 행을 함께 정리한다", async () => {
    const session = `${TAG}-gc`;
    const old     = await writeWmRow({ session });
    await backdate(old, 30 * 3600);
    await writer.deleteExpired();
    const row = await client.query("SELECT 1 FROM agent_memory.fragments WHERE id = $1", [old]);
    assert.equal(row.rowCount, 0);
  });
});

describe("보관량 상한과 격리", () => {
  it("토큰 합이 500을 넘으면 오래된 비보호 행부터 지운다", async () => {
    const session = `${TAG}-cap`;
    const ids = [];
    for (let i = 0; i < 6; i++) {
      const id = await writeWmRow({ session, tokens: 100 });
      await backdate(id, (6 - i) * 60);
      ids.push(id);
    }
    assert.equal(await wm.enforceWorkingMemoryRowBudget(session), 1);
    assert.deepEqual((await wm.listWorkingMemoryRows(session)).map(i => i.id), ids.slice(1));
  });

  it("세션 삭제와 항목 제거는 다른 세션의 행에 닿지 않는다", async () => {
    const a = `${TAG}-iso-a`;
    const b = `${TAG}-iso-b`;
    const idA1 = await writeWmRow({ session: a });
    await writeWmRow({ session: a });
    const idB  = await writeWmRow({ session: b });

    assert.equal(await wm.evictWorkingMemoryRows(b, [idA1]), 0);
    assert.equal(await wm.evictWorkingMemoryRows(a, [idA1]), 1);
    assert.equal(await wm.clearWorkingMemoryRows(a), 1);
    assert.deepEqual((await wm.listWorkingMemoryRows(b)).map(i => i.id), [idB]);
  });
});
