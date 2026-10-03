/**
 * 중복 판정 범위 실서버 시험(일회용 DB)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 실제 유일 색인으로 세 색인 상태(키 범위 색인만, 두 범위 모두, workspace 범위 색인만)를 만들고
 * FragmentWriter의 insert, amend와 BatchRememberProcessor가 각 상태에서 같은 키, 같은 본문,
 * 다른 workspace를 어떻게 저장하는지 확인한다. 실행 중에 키 범위 색인을 지웠을 때(42P10)
 * 색인 상태를 다시 읽고 이어 가는지도 본다. 실행마다 전용 데이터베이스를 만들고 끝나면 지운다.
 */
import crypto                          from "node:crypto";
import { describe, it, before, beforeEach, after } from "node:test";
import assert                          from "node:assert/strict";

const { SCHEMA, prepareLaneDatabase, dropLaneDatabase, directQuery } = await import("./_harness.js");

/** 앱 모듈이 풀을 만들기 전에 실행 전용 데이터베이스를 준비한다. */
await prepareLaneDatabase();

const { FragmentWriter }                        = await import("../../lib/memory/write/FragmentWriter.js");
const { BatchRememberProcessor }                = await import("../../lib/memory/write/BatchRememberProcessor.js");
const { FragmentFactory }                       = await import("../../lib/memory/write/FragmentFactory.js");
const { WriteGate }                             = await import("../../lib/memory/write/WriteGate.js");
const { DEDUP_INDEXES, invalidateDedupIndexes } = await import("../../lib/memory/write/DedupScope.js");
const { getPrimaryPool, shutdownPool }          = await import("../../lib/tools/db.js");

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

/** 판정 색인을 state 구성으로 맞춘다. 표를 비운 뒤 바꾸고, 기억한 색인 상태를 버린다. */
async function setIndexes(state) {
  await directQuery(`DELETE FROM ${SCHEMA}.fragments`);
  for (const name of Object.values(DEDUP_INDEXES)) {
    if (STATES[state].includes(name)) await directQuery(INDEX_DDL[name]);
    else await directQuery(`DROP INDEX IF EXISTS ${SCHEMA}.${name}`);
  }
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

async function batch(items, keyId = KEY) {
  const proc = new BatchRememberProcessor({
    store: {}, index: { index: async () => {} }, factory: new FragmentFactory()
  });
  proc.setPool(getPrimaryPool());
  return proc.process({
    fragments: items.map(workspace => ({ content: TEXT, topic: "dedup-lane", type: "fact", workspace })),
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
