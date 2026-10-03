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
const { createApiKey, deleteApiKey } = await import("../../lib/admin/ApiKeyStore.js");
const { handleKeys }         = await import("../../lib/admin/admin-keys.js");
const { SessionLinker }      = await import("../../lib/memory/link/SessionLinker.js");
const { FragmentIndex }      = await import("../../lib/memory/FragmentIndex.js");
const { FragmentStore }      = await import("../../lib/memory/write/FragmentStore.js");
const { ADMIN_BASE }         = await import("../../lib/admin/admin-auth.js");

const TAG    = `wm${Date.now().toString(36)}`;
const writer = new FragmentWriter();
const gate   = new WriteGate();
const factory = new FragmentFactory();

let client;
let seq = 0;

/** 응답을 모으는 최소 res 대역 */
function fakeRes() {
  return { statusCode: 200, body: "", setHeader() {}, end(b) { if (b !== undefined) this.body = b; } };
}

async function callKeys(pathname) {
  const res = fakeRes();
  await handleKeys({ method: "GET", url: pathname, headers: {} }, res, new URL(pathname, "http://localhost"));
  return res;
}

/** 관문을 거친 작업 기억 행을 FragmentWriter로 기록한다. */
async function writeWmRow({ session = `${TAG}-a`, content = null, tokens = 10, importance = 0.5, key = null, agent = "default" } = {}) {
  seq += 1;
  const text = content ?? `작업 기억 본문 ${TAG} ${seq} 충분히 길게 적는다`;
  const { draft } = await gate.check({
    entry : WRITE_ENTRIES.REMEMBER,
    op    : "create",
    fields: { content: text, topic: "wm-test", type: "fact", importance },
    build : (input) => {
      const f = factory.create({ ...input, sessionId: session }, { contentPrepared: true });
      f.agent_id         = agent;
      f.key_id           = key;
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

describe("에이전트와 키 범위", () => {
  it("master 경로에서 같은 세션의 다른 에이전트가 같은 본문을 써도 각자의 행이다", async () => {
    const session = `${TAG}-agents`;
    const content = `에이전트 구분 본문 ${TAG} 충분히 길게 적는다`;
    const a1 = await writeWmRow({ session, content, agent: "agent-a1" });
    const a2 = await writeWmRow({ session, content, agent: "agent-a2" });
    assert.notEqual(a1, a2);
    const owners = (await client.query(
      "SELECT agent_id FROM agent_memory.fragments WHERE id = ANY($1::text[]) ORDER BY agent_id", [[a1, a2]])).rows.map(r => r.agent_id);
    assert.deepEqual(owners, ["agent-a1", "agent-a2"]);
  });

  it("키별 상한은 그 키의 오래된 행부터 지우고 다른 키의 행은 지우지 않는다", async () => {
    const keyA = (await createApiKey({ name: `${TAG}-cap-a` })).id;
    const keyB = (await createApiKey({ name: `${TAG}-cap-b` })).id;
    const ids  = [];
    for (let i = 0; i < 5; i++) {
      const id = await writeWmRow({ session: `${TAG}-capk-${i}`, key: keyA });
      await backdate(id, (5 - i) * 60);
      ids.push(id);
    }
    const other = await writeWmRow({ session: `${TAG}-capk-x`, key: keyB });

    assert.equal(await wm.trimWorkingMemoryRowsOfKey(keyA, 2), 3);
    const left = (await client.query(
      "SELECT id FROM agent_memory.fragments WHERE key_id = $1 AND source = 'wm-fallback' ORDER BY created_at", [keyA])).rows.map(r => r.id);
    assert.deepEqual(left, ids.slice(3));
    const otherLeft = await client.query("SELECT 1 FROM agent_memory.fragments WHERE id = $1", [other]);
    assert.equal(otherLeft.rowCount, 1);
  });
});

describe("만료 정리의 묶음 처리", () => {
  it("묶음 크기씩 여러 문장으로 지우고 잠금 대기 상한을 건다", async () => {
    const session = `${TAG}-sweep`;
    for (let i = 0; i < 25; i++) {
      const id = await writeWmRow({ session: `${session}-${i}` });
      await backdate(id, 30 * 3600);
    }
    const before = (await client.query(
      "SELECT count(*)::int AS n FROM agent_memory.fragments WHERE source = 'wm-fallback' AND valid_to IS NOT NULL AND created_at < NOW() - INTERVAL '24 hours'")).rows[0].n;
    assert.ok(before >= 25);
    const first = await wm.deleteExpiredWorkingMemoryRows({ chunk: 10, maxChunks: 2 });
    assert.equal(first, 20);
    const rest = await wm.deleteExpiredWorkingMemoryRows({ chunk: 10, maxChunks: 50 });
    assert.equal(first + rest, before);
  });

  it("잠금을 쥔 행이 있으면 건너뛰고 나머지를 지운다", async () => {
    const locked = await writeWmRow({ session: `${TAG}-lockA` });
    const free   = await writeWmRow({ session: `${TAG}-lockB` });
    await backdate(locked, 30 * 3600);
    await backdate(free, 30 * 3600);
    const holder = new pg.Client(directClientConfig());
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM agent_memory.fragments WHERE id = $1 FOR UPDATE", [locked]);
      await wm.deleteExpiredWorkingMemoryRows();
      const left = (await client.query("SELECT id FROM agent_memory.fragments WHERE id = ANY($1::text[])", [[locked, free]])).rows.map(r => r.id);
      assert.deepEqual(left, [locked]);
    } finally {
      await holder.query("ROLLBACK");
      await holder.end();
    }
  });
});

describe("API 키 삭제", () => {
  it("작업 기억 행만 가진 키는 삭제할 수 있고 행도 함께 지워진다", async () => {
    const key = (await createApiKey({ name: `${TAG}-del-wm` })).id;
    const id  = await writeWmRow({ session: `${TAG}-del-1`, key });
    await deleteApiKey(key);
    const row = await client.query("SELECT 1 FROM agent_memory.fragments WHERE id = $1", [id]);
    assert.equal(row.rowCount, 0, "키가 없는 채로 남은 작업 기억 행이 있다");
  });

  it("작업 기억 행은 관리 목록의 파편 수에 세지 않는다", async () => {
    const key = (await createApiKey({ name: `${TAG}-del-count` })).id;
    await writeWmRow({ session: `${TAG}-del-2`, key });
    const res  = await callKeys(`${ADMIN_BASE}/keys/${key}/stats`);
    const body = JSON.parse(res.body);
    assert.equal(body.total, 0);
    assert.equal(body.growth7d, 0);
    assert.equal(body.growth28d, 0);
    await deleteApiKey(key);
  });

  it("일반 파편이 있는 키는 여전히 삭제를 거부하고 작업 기억 행을 지우지 않는다", async () => {
    const key = (await createApiKey({ name: `${TAG}-del-real` })).id;
    const wmId = await writeWmRow({ session: `${TAG}-del-3`, key });
    await client.query(
      `INSERT INTO agent_memory.fragments (id, content, topic, type, content_hash, key_id)
       VALUES ($1, 'real', 't', 'fact', md5($1), $2)`, [`${TAG}-real-del`, key]);
    await assert.rejects(() => deleteApiKey(key), (err) => err.name === "ApiKeyInUseError");
    const row = await client.query("SELECT 1 FROM agent_memory.fragments WHERE id = $1", [wmId]);
    assert.equal(row.rowCount, 1);
  });

  it("삭제 확인을 끄면 작업 기억 행을 먼저 지우고 키를 지운다", async () => {
    const key = (await createApiKey({ name: `${TAG}-del-off` })).id;
    const id  = await writeWmRow({ session: `${TAG}-del-4`, key });
    process.env.MEMENTO_API_KEY_DELETE_GUARD = "false";
    try {
      await deleteApiKey(key);
    } finally {
      delete process.env.MEMENTO_API_KEY_DELETE_GUARD;
    }
    const row = await client.query("SELECT 1 FROM agent_memory.fragments WHERE id = $1", [id]);
    assert.equal(row.rowCount, 0);
  });
});

describe("세션 ID를 공유하는 다른 키", () => {
  async function seedShared() {
    seq += 1;
    const session = `${TAG}-shared-${seq}`;
    const k1 = (await createApiKey({ name: `${TAG}-sh-1-${seq}` })).id;
    const k2 = (await createApiKey({ name: `${TAG}-sh-2-${seq}` })).id;
    const ids = {
      k1    : await writeWmRow({ session, key: k1, content: `키 하나의 세션 항목 ${TAG} 충분히 길게 적는다` }),
      k2    : await writeWmRow({ session, key: k2, content: `키 둘의 세션 항목 ${TAG} 충분히 길게 적는다` }),
      master: await writeWmRow({ session, key: null, content: `master의 세션 항목 ${TAG} 충분히 길게 적는다` })
    };
    return { session, k1, k2, ids };
  }

  it("세션 종합은 호출한 키의 항목만 모으고 다른 키와 master의 항목을 evict 대상에 넣지 않는다", async () => {
    const { session, k1, ids } = await seedShared();
    const linker = new SessionLinker(new FragmentStore(), new FragmentIndex());
    const groups = await linker.consolidateSessionFragments(session, "default", k1);
    assert.deepEqual(groups.flatMap(g => g.wmItemIds), [ids.k1]);
    assert.ok(!JSON.stringify(groups).includes("키 둘의"));
    assert.ok(!JSON.stringify(groups).includes("master의"));
  });

  it("키 없는 요청은 key_id가 없는 항목만 모은다", async () => {
    const { session, ids } = await seedShared();
    const linker = new SessionLinker(new FragmentStore(), new FragmentIndex());
    const groups = await linker.consolidateSessionFragments(session, "default", null);
    assert.deepEqual(groups.flatMap(g => g.wmItemIds), [ids.master]);
  });

  it("한 키의 종합 결과를 evict해도 다른 키의 행은 그대로다", async () => {
    const { session, k1, ids } = await seedShared();
    const index  = new FragmentIndex();
    const linker = new SessionLinker(new FragmentStore(), index);
    const groups = await linker.consolidateSessionFragments(session, "default", k1);
    await index.evictWorkingMemoryItems(session, groups.flatMap(g => g.wmItemIds));
    const left = (await wm.listWorkingMemoryRows(session)).map(i => i.id).sort();
    assert.deepEqual(left, [ids.k2, ids.master].sort());
  });
});
