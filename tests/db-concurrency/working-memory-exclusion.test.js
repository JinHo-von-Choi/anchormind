/**
 * 작업 기억 행의 조회와 집계 제외 검사(일회용 DB)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 기억을 보여 주거나 세는 경로가 작업 기억 행(source=wm-fallback)을 빼는지, 일반 파편과 닫힌
 * 파편은 그대로 보이는지 실제 PostgreSQL에서 확인한다. 경로마다 작업 기억 행을 넣기 전과 뒤의
 * 결과를 견주고, 닫힌 파편을 포함하는 읽기는 일반 닫힌 파편이 남는지도 본다.
 */
import { describe, it, before, after } from "node:test";
import assert                          from "node:assert/strict";
import pg                              from "pg";

const ADMIN_KEY = "lane-admin-key-0123456789abcdef0123456789";
process.env.MEMENTO_ACCESS_KEY  = ADMIN_KEY;
process.env.EMBEDDING_BASE_URL  = "http://127.0.0.1:9";

const { prepareLaneDatabase, dropLaneDatabase, directClientConfig } = await import("./_harness.js");

/** 앱 모듈이 풀을 만들기 전에 실행 전용 데이터베이스를 준비한다. */
await prepareLaneDatabase();

const { shutdownPool }       = await import("../../lib/tools/db.js");
const { FragmentWriter }     = await import("../../lib/memory/write/FragmentWriter.js");
const { FragmentReader }     = await import("../../lib/memory/read/FragmentReader.js");
const { FragmentFactory }    = await import("../../lib/memory/write/FragmentFactory.js");
const { WriteGate, WRITE_ENTRIES } = await import("../../lib/memory/write/WriteGate.js");
const wm                     = await import("../../lib/memory/WorkingMemoryRows.js");
const { handleMemory }       = await import("../../lib/admin/admin-memory.js");
const { handleAdminApi }     = await import("../../lib/admin/admin-routes.js");
const { ADMIN_BASE }         = await import("../../lib/admin/admin-auth.js");
const { evaluateSchemaFitGate } = await import("../../lib/scheduler.js");
const { checkEmbeddingConsistency } = await import("../../scripts/check-embedding-consistency.js");
const { EmbeddingWorker }    = await import("../../lib/memory/embedding/EmbeddingWorker.js");
const { default: statsCli }  = await import("../../lib/cli/stats.js");

const TAG     = `wmx${Date.now().toString(36)}`;
const TOPIC   = `wmx-topic-${TAG}`;
const PROBE   = `wmxprobe${TAG}`;
const writer  = new FragmentWriter();
const reader  = new FragmentReader();
const gate    = new WriteGate();
const factory = new FragmentFactory();

let client;
let wmId;
let liveId;
let closedId;

function fakeRes() {
  return { statusCode: 200, body: "", setHeader() {}, end(b) { if (b !== undefined) this.body = b; } };
}

async function adminGet(pathname, { memory = false } = {}) {
  const res = fakeRes();
  const req = {
    method : "GET",
    url    : pathname,
    headers: { authorization: `Bearer ${ADMIN_KEY}` },
    socket : { remoteAddress: "127.0.0.1" }
  };
  if (memory) await handleMemory(req, res, new URL(pathname, "http://localhost"));
  else        await handleAdminApi(req, res);
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null };
}

async function writeWmRow() {
  const { draft } = await gate.check({
    entry : WRITE_ENTRIES.REMEMBER,
    op    : "create",
    fields: { content: `작업 기억 제외 검사 본문 ${TAG} 충분히 길게 적는다`, topic: TOPIC, type: "fact", keywords: [PROBE] },
    build : (input) => {
      const f = factory.create({ ...input, sessionId: `${TAG}-sess` }, { contentPrepared: true });
      f.agent_id  = "default";
      f.key_id    = null;
      f.workspace = null;
      return f;
    }
  });
  return writer.insert(wm.markWorkingMemoryRow(draft));
}

async function insertPlain(id, { closed }) {
  await client.query(
    `INSERT INTO agent_memory.fragments
       (id, content, topic, keywords, type, content_hash, valid_from, valid_to, created_at)
     VALUES ($1, $2, $3, ARRAY[$4]::text[], 'fact', md5($1), NOW() - INTERVAL '2 hours', $5, NOW() - INTERVAL '1 minute')`,
    [id, `일반 파편 본문 ${id} 충분히 길게 적는다`, TOPIC, PROBE, closed ? new Date(Date.now() - 600 * 1000) : null]
  );
}

before(async () => {
  client = new pg.Client(directClientConfig());
  await client.connect();
  liveId   = `${TAG}-live`;
  closedId = `${TAG}-closed`;
  await insertPlain(liveId,   { closed: false });
  await insertPlain(closedId, { closed: true });
  wmId = await writeWmRow();
});

after(async () => {
  try {
    await client.end();
    await shutdownPool();
  } finally {
    await dropLaneDatabase();
  }
});

describe("닫힌 파편을 포함하는 읽기", () => {
  const ids = (rows) => rows.map(r => r.id);

  it("전제: 작업 기억 행은 닫힌 상태이고 일반 닫힌 파편과 구분된다", async () => {
    const row = (await client.query("SELECT valid_to, source FROM agent_memory.fragments WHERE id = $1", [wmId])).rows[0];
    assert.equal(row.source, "wm-fallback");
    assert.ok(row.valid_to);
  });

  it("searchByKeywords는 includeSuperseded에서도 작업 기억 행을 빼고 닫힌 일반 파편은 남긴다", async () => {
    const found = ids(await reader.searchByKeywords([PROBE], { agentId: "default", includeSuperseded: true, limit: 50 }));
    assert.ok(found.includes(closedId) && found.includes(liveId));
    assert.ok(!found.includes(wmId));
  });

  it("searchByTopic은 includeSuperseded에서도 작업 기억 행을 뺀다", async () => {
    const found = ids(await reader.searchByTopic(TOPIC, { agentId: "default", includeSuperseded: true, limit: 50 }));
    assert.ok(found.includes(closedId));
    assert.ok(!found.includes(wmId));
  });

  it("searchByTimeRange는 includeSuperseded에서도 작업 기억 행을 뺀다", async () => {
    const found = ids(await reader.searchByTimeRange(new Date(Date.now() - 3600 * 1000), new Date(Date.now() + 60000),
      { agentId: "default", includeSuperseded: true, limit: 200 }));
    assert.ok(found.includes(closedId));
    assert.ok(!found.includes(wmId));
  });

  it("searchBySource는 source가 wm-fallback이어도 작업 기억 행을 돌려주지 않는다", async () => {
    const found = await reader.searchBySource("wm-fallback", "default", null, 50, { includeSuperseded: true });
    assert.deepEqual(found, []);
  });

  it("getByIds는 includeSuperseded에서도 작업 기억 행을 빼고 getById는 includeExpired에서도 null이다", async () => {
    const found = ids(await reader.getByIds([wmId, closedId, liveId], "default", null, [], { includeSuperseded: true }));
    assert.deepEqual(found.sort(), [closedId, liveId].sort());
    assert.equal(await reader.getById(wmId, "default", null, [], { includeExpired: true }), null);
    assert.ok(await reader.getById(closedId, "default", null, [], { includeExpired: true }));
  });

  it("searchAsOf는 작업 기억 행을 빼고 그 시점에 유효했던 일반 파편은 남긴다", async () => {
    const found = ids(await reader.searchAsOf(new Date(Date.now() - 1800 * 1000).toISOString(), "default", { limit: 200 }, null));
    assert.ok(!found.includes(wmId));
    assert.ok(found.includes(closedId));
  });
});

describe("관리 화면과 집계", () => {
  /** 작업 기억 행이 있는 지금 값과 지운 뒤 값이 같으면 그 경로가 작업 기억 행을 세지 않는 것이다. */
  async function withoutWmRow(read) {
    const withRow = await read();
    await client.query("UPDATE agent_memory.fragments SET source = 'plain-copy' WHERE id = $1", [wmId]);
    try {
      return { withRow, withoutRow: await read() };
    } finally {
      await client.query("UPDATE agent_memory.fragments SET source = 'wm-fallback' WHERE id = $1", [wmId]);
    }
  }

  it("대조 전제: 작업 기억 행을 일반 행으로 바꾸면 이 경로들의 값이 달라진다", async () => {
    const base  = await adminGet(`${ADMIN_BASE}/memory/overview`, { memory: true });
    await client.query("UPDATE agent_memory.fragments SET source = 'plain-copy' WHERE id = $1", [wmId]);
    const plain = await adminGet(`${ADMIN_BASE}/memory/overview`, { memory: true });
    await client.query("UPDATE agent_memory.fragments SET source = 'wm-fallback' WHERE id = $1", [wmId]);
    assert.equal(plain.json.totalFragments, base.json.totalFragments + 1);
  });

  it("memory overview는 작업 기억 행을 총계, 유형, 주제, 최근 목록에 넣지 않는다", async () => {
    const { withRow, withoutRow } = await withoutWmRow(() => adminGet(`${ADMIN_BASE}/memory/overview`, { memory: true }));
    assert.equal(withRow.json.totalFragments + 1, withoutRow.json.totalFragments);
    assert.ok(!JSON.stringify(withRow.json).includes(wmId));
    assert.equal(withRow.json.qualityPending + 1, withoutRow.json.qualityPending);
  });

  it("memory 목록과 상세는 작업 기억 행을 보이지 않는다", async () => {
    const list = await adminGet(`${ADMIN_BASE}/memory/fragments?limit=100`, { memory: true });
    assert.ok(!JSON.stringify(list.json).includes(wmId));
    const detail = await adminGet(`${ADMIN_BASE}/memory/fragments/${wmId}`, { memory: true });
    assert.equal(detail.status, 404);
  });

  it("memory anomalies의 품질 미검증 수는 작업 기억 행을 세지 않는다", async () => {
    const { withRow, withoutRow } = await withoutWmRow(() => adminGet(`${ADMIN_BASE}/memory/anomalies`, { memory: true }));
    assert.equal(withRow.json.qualityUnverified + 1, withoutRow.json.qualityUnverified);
  });

  it("/stats의 총계와 품질 대기는 작업 기억 행을 세지 않는다", async () => {
    const { withRow, withoutRow } = await withoutWmRow(() => adminGet(`${ADMIN_BASE}/stats`));
    assert.equal(withRow.status, 200);
    assert.equal(withRow.json.fragments + 1, withoutRow.json.fragments);
    assert.equal(withRow.json.queues.qualityPending + 1, withoutRow.json.queues.qualityPending);
  });

  it("/activity는 작업 기억 행을 보이지 않는다", async () => {
    const res = await adminGet(`${ADMIN_BASE}/activity`);
    assert.ok(!JSON.stringify(res.json).includes(wmId));
  });

  it("CLI stats의 총계와 만료 수는 작업 기억 행을 세지 않는다", async () => {
    const run = async () => {
      const lines = [];
      const orig  = console.log;
      console.log = (...a) => lines.push(a.join(" "));
      try { await statsCli({ format: "json" }); } finally { console.log = orig; }
      return JSON.parse(lines.join("\n"));
    };
    const { withRow, withoutRow } = await withoutWmRow(run);
    assert.equal(withRow.fragments + 1, withoutRow.fragments);
    assert.equal(withRow.expired + 1, withoutRow.expired);
  });
});

describe("유지보수 판정과 기동 점검", () => {
  it("통합 관문의 신규 파편 수는 작업 기억 행을 세지 않는다", async () => {
    const cfg  = { mode: "any", pendingCaseFragmentsMin: 1e9, recentRelatedLinksMin: 1e9, fragmentsSinceLastRunMin: 1 };
    const pool = new pg.Pool({ ...directClientConfig(), options: "-c search_path=agent_memory,public", max: 1 });
    const since = new Date(Date.now() + 1000).toISOString();
    const wmLater = `${TAG}-wm-later`;
    await client.query(
      `INSERT INTO agent_memory.fragments (id, content, topic, type, content_hash, source, session_id, valid_to, created_at)
       VALUES ($1, 'later wm', 't', 'fact', md5($1), 'wm-fallback', 'x', NOW() + INTERVAL '2 seconds', NOW() + INTERVAL '2 seconds')`, [wmLater]);
    assert.equal(await evaluateSchemaFitGate(pool, cfg, since), false);
    await client.query("UPDATE agent_memory.fragments SET source = 'plain' WHERE id = $1", [wmLater]);
    assert.equal(await evaluateSchemaFitGate(pool, cfg, since), true);
    await client.query("DELETE FROM agent_memory.fragments WHERE id = $1", [wmLater]);
    await pool.end();
  });

  it("기동 점검의 형태소 미인덱싱 수는 작업 기억 행을 세지 않는다", async () => {
    const warnings = [];
    const orig = console.warn;
    console.warn = (...a) => warnings.push(a.join(" "));
    try {
      const run = async () => {
        warnings.length = 0;
        await checkEmbeddingConsistency();
        const line = warnings.find(w => w.includes("morpheme_indexed=false"));
        return Number(/파편 (\d+)개/.exec(line ?? "")?.[1] ?? 0);
      };
      const withRow = await run();
      await client.query("UPDATE agent_memory.fragments SET source = 'plain-copy' WHERE id = $1", [wmId]);
      const withoutRow = await run();
      await client.query("UPDATE agent_memory.fragments SET source = 'wm-fallback' WHERE id = $1", [wmId]);
      assert.equal(withRow + 1, withoutRow);
    } finally {
      console.warn = orig;
    }
  });

  it("임베딩 대기 조회는 작업 기억 행을 건너뛰고 일반 파편은 가져온다", async () => {
    const worker  = new EmbeddingWorker();
    const seen    = [];
    worker._embedMany = async (rows) => { seen.push(...rows.map(r => r.id)); };
    await worker.processOrphanFragments(500);
    assert.ok(seen.includes(liveId), "일반 파편이 임베딩 대기에서 빠졌다");
    assert.ok(!seen.includes(wmId), "작업 기억 행이 임베딩 대기에 들어갔다");
  });
});
