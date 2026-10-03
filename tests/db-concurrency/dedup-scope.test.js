/**
 * 중복 판정 범위 실서버 시험(일회용 DB)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 실제 유일 색인으로 세 색인 상태(키 범위 색인만, 두 범위 모두, workspace 범위 색인만)를 만들고
 * FragmentWriter의 insert, amend와 BatchRememberProcessor가 각 상태에서 같은 키, 같은 본문,
 * 다른 workspace를 어떻게 저장하는지 확인한다. 실행 중에 키 범위 색인을 지웠을 때(42P10)
 * 색인 상태를 다시 읽고 이어 가는지, DROP INDEX CONCURRENTLY가 앞선 트랜잭션을 기다리는 동안과
 * lock_timeout으로 중단된 뒤(키 범위 색인이 indisvalid=false, indisready=true로 남는다)
 * remember, 원자 remember, batch_remember, amend, 가져오기가 오류 없이 키 범위로 판정하는지,
 * 마무리 스크립트(scripts/ops/finish-dedup-scope.mjs), workspace 값 정규화, reflect workspace 백필의
 * 같은 본문 제외도 본다. 실행마다 전용 데이터베이스를 만들고 끝나면 지운다.
 */
import pg                              from "pg";
import crypto                          from "node:crypto";
import { describe, it, before, beforeEach, after } from "node:test";
import assert                          from "node:assert/strict";

const { SCHEMA, prepareLaneDatabase, dropLaneDatabase, directQuery, directClientConfig } = await import("./_harness.js");

/** 앱 모듈이 풀을 만들기 전에 실행 전용 데이터베이스를 준비한다. */
await prepareLaneDatabase();

const { FragmentWriter }                        = await import("../../lib/memory/write/FragmentWriter.js");
const { BatchRememberProcessor }                = await import("../../lib/memory/write/BatchRememberProcessor.js");
const { FragmentFactory }                       = await import("../../lib/memory/write/FragmentFactory.js");
const { WriteGate }                             = await import("../../lib/memory/write/WriteGate.js");
const { DEDUP_INDEXES, invalidateDedupIndexes } = await import("../../lib/memory/write/DedupScope.js");
const { getPrimaryPool, shutdownPool }          = await import("../../lib/tools/db.js");
const { checkImportRow, writeImportRow, importProfile, IMPORT_DEFAULTS } = await import("../../lib/memory/write/FragmentImporter.js");
const { WRITE_ENTRIES }                         = await import("../../lib/memory/write/WriteGate.js");
const { main: finishDedupScope }                = await import("../../scripts/ops/finish-dedup-scope.mjs");
const { main: backfillReflectWorkspace }        = await import("../../scripts/backfill-reflect-workspace.js");

const KEY    = "dedup-lane-key";
const TEXT   = "같은 키의 두 workspace에 같은 본문을 저장하는 실서버 시험 파편";
const OTHER  = "workspace 범위 amend 판정을 위한 다른 실서버 시험 파편 본문";
const writer = new FragmentWriter();

const INDEX_DDL = {
  [DEDUP_INDEXES.keyLegacy]   : `CREATE UNIQUE INDEX IF NOT EXISTS ${DEDUP_INDEXES.keyLegacy} ON ${SCHEMA}.fragments (key_id, content_hash) WHERE key_id IS NOT NULL`,
  [DEDUP_INDEXES.masterLegacy]: `CREATE UNIQUE INDEX IF NOT EXISTS ${DEDUP_INDEXES.masterLegacy} ON ${SCHEMA}.fragments (content_hash) WHERE key_id IS NULL`,
  [DEDUP_INDEXES.keyScoped]   : `CREATE UNIQUE INDEX IF NOT EXISTS ${DEDUP_INDEXES.keyScoped} ON ${SCHEMA}.fragments (key_id, content_hash, (COALESCE(workspace, ''))) WHERE key_id IS NOT NULL`,
  [DEDUP_INDEXES.masterScoped]: `CREATE UNIQUE INDEX IF NOT EXISTS ${DEDUP_INDEXES.masterScoped} ON ${SCHEMA}.fragments (content_hash, (COALESCE(workspace, ''))) WHERE key_id IS NULL`
};

const STATES = {
  legacy: [DEDUP_INDEXES.keyLegacy, DEDUP_INDEXES.masterLegacy],
  both  : Object.values(DEDUP_INDEXES),
  scoped: [DEDUP_INDEXES.keyScoped, DEDUP_INDEXES.masterScoped]
};

/** 판정 색인을 state 구성으로 맞춘다. 표를 비우고 모든 판정 색인(무효 상태 포함)을 지운 뒤 만든다. */
async function setIndexes(state) {
  await directQuery(`DELETE FROM ${SCHEMA}.fragments`);
  for (const name of Object.values(DEDUP_INDEXES)) await directQuery(`DROP INDEX IF EXISTS ${SCHEMA}.${name}`);
  for (const name of STATES[state]) await directQuery(INDEX_DDL[name]);
  invalidateDedupIndexes();
  assert.deepEqual(await validIndexes(), [...STATES[state]].sort());
}

async function validIndexes() {
  const { rows } = await directQuery(
    `SELECT c.relname AS name FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relnamespace = '${SCHEMA}'::regnamespace AND c.relname = ANY($1::text[]) AND i.indisvalid
      ORDER BY 1`, [Object.values(DEDUP_INDEXES)]);
  return rows.map(r => r.name);
}

async function indexFlags(name) {
  const { rows } = await directQuery(
    `SELECT i.indisvalid AS valid, i.indisready AS ready FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relnamespace = '${SCHEMA}'::regnamespace AND c.relname = $1`, [name]);
  return rows[0] ?? null;
}

const LANE_URL = () => {
  const c = directClientConfig();
  return `postgresql://${c.user}:${encodeURIComponent(c.password)}@${c.host}:${c.port}/${c.database}`;
};

/** fragments 를 읽은 채 열려 있는 트랜잭션. DROP INDEX CONCURRENTLY 는 이 트랜잭션이 끝나기를 기다린다. */
async function holdReader() {
  const client = new pg.Client(directClientConfig());
  await client.connect();
  await client.query("BEGIN");
  await client.query(`SELECT count(*) FROM ${SCHEMA}.fragments`);
  return { async release() { try { await client.query("COMMIT"); } finally { await client.end(); } } };
}

/** 별도 연결에서 문장 하나를 실행한다. 끝나기를 기다리지 않으려면 반환 약속을 나중에 기다린다. */
async function runOnOwnConnection(sql) {
  const client = new pg.Client(directClientConfig());
  await client.connect();
  try {
    return await client.query(sql);
  } finally {
    await client.end();
  }
}

async function waitUntil(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("조건을 기다리다 시간이 지났다");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

/** 원자 remember 경로처럼 외부 트랜잭션 안에서 저장한다. */
async function insertAtomic(workspace, opts) {
  const client = await getPrimaryPool().connect();
  try {
    await client.query("BEGIN");
    const id = await writer.insert(await draft(workspace, opts), { client });
    await client.query("COMMIT");
    return id;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function importGlobal(content = TEXT) {
  const profile  = importProfile(IMPORT_DEFAULTS.admin, { keyId: KEY, owner: true });
  const prepared = await checkImportRow(
    { content, topic: "dedup-lane", type: "fact" },
    { entry: WRITE_ENTRIES.ADMIN_IMPORT, gate: new WriteGate(), profile }
  );
  assert.equal(prepared.status, "ready", prepared.reason);
  return writeImportRow(prepared, { writer, profile });
}

async function rowCount() {
  const { rows } = await directQuery(`SELECT count(*)::int AS n FROM ${SCHEMA}.fragments`);
  return rows[0].n;
}

/** 관문을 거친 remember 후보를 만든다. */
async function draft(workspace, { keyId = KEY, content = TEXT } = {}) {
  const gate      = new WriteGate();
  const { draft } = await gate.check({
    entry : "remember",
    op    : "create",
    fields: { content, topic: "dedup-lane", type: "fact", importance: 0.5 },
    ctx   : { keyId, agentId: "default" },
    build : (input) => ({ ...input, id: crypto.randomUUID(), agent_id: "default", key_id: keyId, workspace })
  });
  return draft;
}

const insert = async (workspace, opts) => writer.insert(await draft(workspace, opts));

async function amend(id, content) {
  const gate       = new WriteGate();
  const { fields } = await gate.check({ entry: "amend", op: "update", fields: { content }, base: { type: "fact" } });
  return writer.update(id, fields, "default", KEY);
}

async function batch(items, keyId = KEY, content = TEXT) {
  const proc = new BatchRememberProcessor({
    store: {}, index: { index: async () => {} }, factory: new FragmentFactory()
  });
  proc.setPool(getPrimaryPool());
  return proc.process({
    fragments: items.map(workspace => ({ content, topic: "dedup-lane", type: "fact", workspace })),
    agentId  : "default",
    _keyId   : keyId
  });
}

before(async () => {
  await directQuery(
    `INSERT INTO ${SCHEMA}.api_keys (id, name, key_hash, key_prefix) VALUES ($1, $1, $1, 'lane')`, [KEY]
  );
});

beforeEach(() => { delete process.env.MEMENTO_DEDUP_SCOPE; });

after(async () => {
  delete process.env.MEMENTO_DEDUP_SCOPE;
  try {
    await shutdownPool();
  } finally {
    await dropLaneDatabase();
  }
});

describe("마이그레이션 직후", () => {
  it("migration-050 은 workspace 범위 색인을 만들고 키 범위 색인은 남긴다", async () => {
    assert.deepEqual(await validIndexes(), [...STATES.both].sort());
  });
});

describe("insert: 같은 키, 같은 본문, 다른 workspace", () => {
  for (const [state, separate] of [["legacy", false], ["both", false], ["scoped", true]]) {
    for (const keyId of [KEY, null]) {
      it(`${state} 색인, ${keyId ? "키 보유" : "마스터"} 경로`, async () => {
        await setIndexes(state);
        const first  = await insert("ws-a", { keyId });
        const second = await insert("ws-b", { keyId });
        const again  = await insert("ws-a", { keyId });
        assert.equal(again, first, "같은 workspace는 같은 파편이다");
        if (separate) {
          assert.notEqual(second, first);
          assert.equal(await rowCount(), 2);
        } else {
          assert.equal(second, first);
          assert.equal(await rowCount(), 1);
        }
      });
    }
  }
});

describe("insert: workspace 범위 색인만 있을 때", () => {
  beforeEach(async () => { await setIndexes("scoped"); });

  it("전역 파편이 있으면 workspace 요청도 그 id를 돌려준다", async () => {
    const global = await insert(null);
    assert.equal(await insert("ws-c"), global);
    assert.equal(await rowCount(), 1);
  });

  it("MEMENTO_DEDUP_SCOPE=key이면 키 범위 색인 없이도 다른 workspace의 기존 id를 돌려준다", async () => {
    process.env.MEMENTO_DEDUP_SCOPE = "key";
    const first = await insert("ws-a");
    assert.equal(await insert("ws-b"), first);
    assert.equal(await rowCount(), 1);
  });

  it("유일 색인이 같은 키, workspace(NULL과 ''는 같은 칸), 본문의 두 번째 행을 막는다", async () => {
    await insert(null);
    const { rows: [row] } = await directQuery(`SELECT content, content_hash FROM ${SCHEMA}.fragments`);
    await assert.rejects(
      directQuery(
        `INSERT INTO ${SCHEMA}.fragments (id, content, topic, type, content_hash, key_id, workspace)
         VALUES ($1, $2, 't', 'fact', $3, $4, '')`,
        [crypto.randomUUID(), row.content, row.content_hash, KEY]
      ),
      err => err.code === "23505" && err.constraint === DEDUP_INDEXES.keyScoped
    );
  });
});

describe("insert: 실행 중 키 범위 색인 제거", () => {
  const FRESH = "키 범위 색인을 지운 뒤 처음 저장하는 실서버 시험 파편 본문";

  it("기억한 상태의 ON CONFLICT 대상이 없어지면(42P10) 다시 읽고 저장한 뒤 workspace 범위로 판정한다", async () => {
    await setIndexes("both");
    const first = await insert("ws-a");
    await directQuery(`DROP INDEX ${SCHEMA}.${DEDUP_INDEXES.keyLegacy}`);
    await directQuery(`DROP INDEX ${SCHEMA}.${DEDUP_INDEXES.masterLegacy}`);
    const fresh = await insert("ws-b", { content: FRESH });
    assert.ok(fresh);
    assert.equal(await rowCount(), 2);
    const second = await insert("ws-b");
    assert.notEqual(second, first);
    assert.equal(await rowCount(), 3);
  });

  it("외부 트랜잭션 안에서도 저장점으로 되돌려 같은 트랜잭션을 이어 간다", async () => {
    await setIndexes("both");
    await insert("ws-a");
    await directQuery(`DROP INDEX ${SCHEMA}.${DEDUP_INDEXES.keyLegacy}`);
    const client = await getPrimaryPool().connect();
    try {
      await client.query("BEGIN");
      await writer.insert(await draft("ws-b", { content: FRESH }), { client });
      await writer.insert(await draft("ws-b"), { client });
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    assert.equal(await rowCount(), 3);
  });
});

describe("amend: 바뀐 본문의 해시 충돌", () => {
  for (const [state, merged] of [["legacy", true], ["both", true], ["scoped", false]]) {
    it(`${state} 색인: 다른 workspace의 같은 본문으로 고친다`, async () => {
      await setIndexes(state);
      const a = await insert("ws-a");
      const b = await insert("ws-b", { content: OTHER });
      const result = await amend(b, TEXT);
      if (merged) {
        assert.deepEqual(result, { merged: true, existingId: a });
      } else {
        assert.equal(result.id, b);
        assert.equal(await rowCount(), 2);
      }
    });
  }
});

describe("batch_remember", () => {
  for (const [state, rows] of [["legacy", 1], ["both", 1], ["scoped", 2]]) {
    it(`${state} 색인: 한 요청과 기존 파편의 같은 본문`, async () => {
      await setIndexes(state);
      const first = await batch(["ws-a", "ws-b"]);
      assert.equal(await rowCount(), rows);
      const second = await batch(["ws-b"]);
      assert.equal(second.results[0].id, first.results[1].id);
      assert.equal(await rowCount(), rows);
    });
  }

  it("scoped 색인: 전역 파편이 있으면 batch도 그 id를 돌려준다", async () => {
    await setIndexes("scoped");
    const { results: [global] } = await batch([null]);
    const { results } = await batch(["ws-c"]);
    assert.equal(results[0].id, global.id);
    assert.equal(await rowCount(), 1);
  });
});

describe("자료 정합", () => {
  it("같은 키, workspace, 본문 조합의 중복 행이 없다", async () => {
    await setIndexes("scoped");
    for (const ws of ["ws-a", "ws-b", "ws-a", null]) await insert(ws);
    await insert("ws-a", { keyId: null });
    await batch(["ws-a", "ws-b", "ws-c", "ws-a"]);
    await batch(["ws-b", "ws-d"]);
    const { rows } = await directQuery(
      `SELECT key_id, COALESCE(workspace, '') AS ws, content_hash, count(*)::int AS n
         FROM ${SCHEMA}.fragments GROUP BY 1, 2, 3 HAVING count(*) > 1`
    );
    assert.deepEqual(rows, []);
  });
});

/**
 * 키 범위 색인이 무효 상태로 남은 동안 모든 쓰기 경로가 오류 없이 키 범위로 판정하는지 본다.
 * 다른 workspace의 같은 본문은 모두 ws-a의 기존 파편을 돌려받아야 한다.
 */
async function assertKeyScopeWithoutErrors(seed) {
  assert.equal(await insert("ws-b"), seed.text, "remember");
  assert.equal(await insertAtomic("ws-c"), seed.text, "원자 remember");
  assert.equal((await batch(["ws-d"])).results[0].id, seed.batch, "batch_remember");
  assert.deepEqual(await amend(seed.other, TEXT), { merged: true, existingId: seed.text }, "amend");
  const imported = await importGlobal();
  assert.equal(imported.status, "duplicate", "가져오기");
  assert.equal(imported.id, seed.text);
  assert.equal(await insert("ws-b", { keyId: null }), seed.master, "마스터 remember");
}

/** ws-a의 키 보유 본문, 다른 workspace의 amend 대상, batch 본문, 마스터 본문을 두고 색인 상태를 기억시킨다. */
async function seedForTransition() {
  await setIndexes("both");
  const seed = {
    text  : await insert("ws-a"),
    other : await insert("ws-b", { content: OTHER }),
    batch : (await batch(["ws-a"])).results[0].id,
    master: await insert("ws-a", { keyId: null })
  };
  assert.equal(await rowCount(), 4);
  return seed;
}

describe("키 범위 색인이 무효 상태로 남았을 때", () => {
  it("DROP INDEX CONCURRENTLY 가 앞선 트랜잭션을 기다리는 동안 모든 쓰기 경로가 오류 없이 키 범위로 판정한다", { timeout: 60_000 }, async () => {
    const seed   = await seedForTransition();
    const reader = await holdReader();
    let   dropping;
    try {
      dropping = runOnOwnConnection(`DROP INDEX CONCURRENTLY ${SCHEMA}.${DEDUP_INDEXES.keyLegacy}`);
      await waitUntil(async () => (await indexFlags(DEDUP_INDEXES.keyLegacy))?.valid === false);
      assert.deepEqual(await indexFlags(DEDUP_INDEXES.keyLegacy), { valid: false, ready: true });
      invalidateDedupIndexes();
      await assertKeyScopeWithoutErrors(seed);
      assert.equal(await rowCount(), 4);
    } finally {
      await reader.release();
      await dropping;
    }
    assert.equal(await indexFlags(DEDUP_INDEXES.keyLegacy), null);
    invalidateDedupIndexes();
    assert.notEqual(await insert("ws-e"), seed.text, "키 범위 색인이 사라지면 workspace 범위");
  });

  it("lock_timeout 으로 중단된 뒤에도 오류 없이 키 범위로 판정하고, 마무리 스크립트가 지우면 workspace 범위가 된다", { timeout: 60_000 }, async () => {
    const seed   = await seedForTransition();
    const reader = await holdReader();
    try {
      for (const name of [DEDUP_INDEXES.keyLegacy, DEDUP_INDEXES.masterLegacy]) {
        const client = new pg.Client(directClientConfig());
        await client.connect();
        try {
          await client.query("SET lock_timeout = '300ms'");
          await assert.rejects(client.query(`DROP INDEX CONCURRENTLY ${SCHEMA}.${name}`), err => err.code === "55P03");
        } finally {
          await client.end();
        }
        assert.deepEqual(await indexFlags(name), { valid: false, ready: true });
      }
    } finally {
      await reader.release();
    }
    invalidateDedupIndexes();
    await assertKeyScopeWithoutErrors(seed);
    assert.equal(await rowCount(), 4);

    const out  = [];
    const code = await finishDedupScope(["--confirm", "--url", LANE_URL()], {}, { out: l => out.push(l), err: l => out.push(l) });
    assert.equal(code, 0, out.join("\n"));
    assert.equal(await indexFlags(DEDUP_INDEXES.keyLegacy), null);
    assert.equal(await indexFlags(DEDUP_INDEXES.masterLegacy), null);
    invalidateDedupIndexes();
    assert.notEqual(await insert("ws-e"), seed.text);
    assert.notEqual(await insert("ws-e", { keyId: null }), seed.master);
  });
});

describe("마무리 스크립트", () => {
  it("새 색인이 유효하지 않으면 키 범위 색인을 지우지 않는다", async () => {
    await setIndexes("both");
    await directQuery(`DROP INDEX ${SCHEMA}.${DEDUP_INDEXES.masterScoped}`);
    const out  = [];
    const code = await finishDedupScope(["--confirm", "--url", LANE_URL()], {}, { out: l => out.push(l), err: l => out.push(l) });
    assert.equal(code, 1);
    assert.deepEqual(await indexFlags(DEDUP_INDEXES.keyLegacy), { valid: true, ready: true });
  });

  it("새 설치(migration-050 뒤 두 범위 모두)에서 키 범위 색인을 지우고 다시 실행해도 성공한다", async () => {
    await setIndexes("both");
    const run = () => finishDedupScope(["--confirm", "--url", LANE_URL()], {}, { out: () => {}, err: () => {} });
    assert.equal(await run(), 0);
    assert.deepEqual(await validIndexes(), [...STATES.scoped].sort());
    assert.equal(await run(), 0);
  });
});

describe("workspace 값 정규화", () => {
  it("batch 의 '' 저장 뒤 전역 batch 와 remember 는 같은 칸이다", async () => {
    await setIndexes("scoped");
    const first = (await batch([""])).results[0].id;
    const { rows: [row] } = await directQuery(`SELECT workspace FROM ${SCHEMA}.fragments WHERE id = $1`, [first]);
    assert.equal(row.workspace, null);
    assert.equal((await batch([null])).results[0].id, first);
    assert.equal((await batch(["  "])).results[0].id, first);
    const single = await insert("");
    assert.equal(await insert(null), single);
    assert.equal(await rowCount(), 2, "batch 와 remember 는 content_hash 형식이 달라 따로 남는다");
  });
});

describe("reflect workspace 백필", () => {
  it("대상 workspace에 같은 키의 같은 본문이 있으면 옮기지 않고 dryRun 에 제외 건수를 알린다", async () => {
    await setIndexes("scoped");
    const same  = "proj-alpha 배포 회고: 같은 본문이 이미 대상 workspace에 있는 reflect 파편";
    const fresh = "proj-alpha 배포 회고: 대상 workspace로 옮겨야 하는 reflect 파편";
    const ids   = { ws: crypto.randomUUID(), dup: crypto.randomUUID(), move: crypto.randomUUID() };
    await directQuery(
      `INSERT INTO ${SCHEMA}.fragments (id, content, topic, type, content_hash, key_id, workspace)
       VALUES ($1, $4, 't', 'fact', md5($4), $6, 'proj-alpha'),
              ($2, $4, 'session_reflect', 'episode', md5($4), $6, NULL),
              ($3, $5, 'session_reflect', 'episode', md5($5), $6, NULL)`,
      [ids.ws, ids.dup, ids.move, same, fresh, KEY]
    );
    const lines  = [];
    const dryRun = await backfillReflectWorkspace({ pool: getPrimaryPool(), execute: false, out: l => lines.push(l) });
    assert.deepEqual(dryRun, { total: 2, excluded: 1, updated: 0 });
    assert.ok(lines.some(l => l.includes("제외 1건")));

    const done = await backfillReflectWorkspace({ pool: getPrimaryPool(), execute: true, out: () => {} });
    assert.equal(done.updated, 1);
    const { rows } = await directQuery(`SELECT id, workspace FROM ${SCHEMA}.fragments WHERE id = ANY($1)`, [[ids.dup, ids.move]]);
    const byId = Object.fromEntries(rows.map(r => [r.id, r.workspace]));
    assert.equal(byId[ids.dup], null);
    assert.equal(byId[ids.move], "proj-alpha");
  });
});
