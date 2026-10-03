/**
 * FragmentWriter 중복 판정 범위 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 유일 색인 대역(_dedup-fake-db.js)으로 세 색인 상태(키 범위 색인만, 두 범위 모두,
 * workspace 범위 색인만)와 색인 없음에서 insert의 사전 판정과 충돌 처리, amend의 해시 충돌
 * 판정을 확인한다. 운영 단계로 색인이 바뀐 직후(기억한 상태와 실제가 다른 경우)도 확인한다.
 */
import { describe, it, mock, beforeEach, afterEach } from "node:test";
import assert                                       from "node:assert/strict";

import { makeFakeDb } from "./_dedup-fake-db.js";

let db = null;
mock.module("../../lib/tools/db.js", {
  namedExports: {
    getPrimaryPool      : () => db?.pool() ?? null,
    queryWithAgentVector: async (_agentId, sql, params) => db.query(sql, params)
  }
});

const { FragmentWriter }                         = await import("../../lib/memory/write/FragmentWriter.js");
const { DEDUP_INDEXES, invalidateDedupIndexes }  = await import("../../lib/memory/write/DedupScope.js");
const { computeContentHash }                     = await import("../../lib/tools/embedding.js");
const { WriteGate }                              = await import("../../lib/memory/write/WriteGate.js");

const STATES = {
  legacy: [DEDUP_INDEXES.keyLegacy, DEDUP_INDEXES.masterLegacy],
  both  : [DEDUP_INDEXES.keyLegacy, DEDUP_INDEXES.masterLegacy, DEDUP_INDEXES.keyScoped, DEDUP_INDEXES.masterScoped],
  scoped: [DEDUP_INDEXES.keyScoped, DEDUP_INDEXES.masterScoped]
};

const TEXT   = "같은 키의 두 workspace에 같은 본문을 저장하는 시험 파편";
const writer = new FragmentWriter();
let   seq    = 0;

function fragment(workspace, { keyId = "key-1", content = TEXT, importance = 0.5 } = {}) {
  seq++;
  return {
    id: `frag-${seq}`, content, topic: "t", type: "fact", importance,
    agent_id: "default", key_id: keyId, workspace
  };
}

function row(id, workspace, { keyId = "key-1", content = TEXT } = {}) {
  return { id, key_id: keyId, workspace, content_hash: computeContentHash(content) };
}

/** 관문 표식 확인보다 아래 단계(사전 판정과 INSERT)를 본다. */
const insert = async (frag, client) => (await writer._runInsert(client, writer._prepareInsertRow(frag))).id;

const countStatements = (pattern) => db.statements.filter(s => pattern.test(s)).length;

beforeEach(() => {
  invalidateDedupIndexes();
  delete process.env.MEMENTO_DEDUP_SCOPE;
});

afterEach(() => {
  delete process.env.MEMENTO_DEDUP_SCOPE;
});

describe("insert: 같은 키, 같은 본문, 다른 workspace", () => {
  for (const [state, expectSeparate] of [["legacy", false], ["both", false], ["scoped", true]]) {
    for (const keyId of ["key-1", null]) {
      it(`${state} 색인, ${keyId ? "키 보유" : "마스터"} 경로`, async () => {
        db = makeFakeDb({ indexes: STATES[state] });
        const first  = await insert(fragment("ws-a", { keyId }));
        const second = await insert(fragment("ws-b", { keyId }));
        if (expectSeparate) {
          assert.notEqual(second, first);
          assert.equal(db.rows.length, 2);
          assert.equal(db.byId(second).workspace, "ws-b");
        } else {
          assert.equal(second, first);
          assert.equal(db.rows.length, 1);
        }
      });
    }
  }
});

describe("insert: workspace 범위 색인만 있을 때", () => {
  beforeEach(() => { db = makeFakeDb({ indexes: STATES.scoped }); });

  it("같은 workspace에서는 기존 id를 돌려준다", async () => {
    const first  = await insert(fragment("ws-a"));
    const second = await insert(fragment("ws-a"));
    assert.equal(second, first);
    assert.equal(db.rows.length, 1);
  });

  it("전역 파편이 있으면 workspace 요청도 그 id를 돌려준다", async () => {
    db.rows.push(row("global-1", null));
    assert.equal(await insert(fragment("ws-a")), "global-1");
    assert.equal(db.rows.length, 1);
  });

  it("workspace 파편만 있으면 전역 요청은 따로 저장한다", async () => {
    db.rows.push(row("ws-row", "ws-a"));
    const id = await insert(fragment(null));
    assert.notEqual(id, "ws-row");
    assert.equal(db.rows.length, 2);
  });

  it("MEMENTO_DEDUP_SCOPE=key이면 다른 workspace의 기존 id를 돌려준다", async () => {
    process.env.MEMENTO_DEDUP_SCOPE = "key";
    db.rows.push(row("ws-row", "ws-a"));
    assert.equal(await insert(fragment("ws-b")), "ws-row");
    assert.equal(db.rows.length, 1);
  });

  it("다른 키의 같은 본문은 영향을 주지 않는다", async () => {
    db.rows.push(row("other-key", "ws-a", { keyId: "key-2" }));
    const id = await insert(fragment("ws-a"));
    assert.notEqual(id, "other-key");
    assert.equal(db.rows.length, 2);
  });

  it("사전 조회 뒤 같은 칸에 먼저 들어간 행은 ON CONFLICT로 병합한다", async () => {
    const original = db.query;
    db.query = async (sql, params) => {
      const result = await original(sql, params);
      if (String(sql).startsWith("SELECT id, workspace, content_hash")) {
        db.rows.push({ ...row("racer", "ws-a"), importance: 0.3, is_anchor: false });
      }
      return result;
    };
    const id = await insert(fragment("ws-a", { importance: 0.6 }));
    assert.equal(id, "racer");
    assert.equal(db.byId("racer").importance, 0.6);
  });
});

describe("insert: 두 범위 색인이 모두 있을 때의 경합", () => {
  it("사전 조회 뒤 다른 workspace에 먼저 들어간 행은 키 범위 색인으로 병합한다", async () => {
    db = makeFakeDb({ indexes: STATES.both });
    const original = db.query;
    db.query = async (sql, params) => {
      const result = await original(sql, params);
      if (String(sql).startsWith("SELECT id, workspace, content_hash")) db.rows.push(row("racer", "ws-a"));
      return result;
    };
    assert.equal(await insert(fragment("ws-b")), "racer");
    assert.equal(db.rows.length, 1);
  });
});

describe("insert: 운영 단계로 색인이 바뀐 직후", () => {
  it("키 범위 색인이 지워지면 42P10 뒤 색인 상태를 다시 읽고 저장한다", async () => {
    db = makeFakeDb({ indexes: STATES.both });
    await insert(fragment("ws-a", { content: "색인 상태를 기억시키는 첫 번째 시험 파편 본문" }));
    db.indexes = new Set(STATES.scoped);
    const id = await insert(fragment("ws-b"));
    assert.equal(db.byId(id).workspace, "ws-b");
    assert.equal(countStatements(/pg_index/), 2);
  });

  it("키 범위 색인이 다시 생기면 23505 뒤 키 범위로 판정한다", async () => {
    db = makeFakeDb({ indexes: STATES.scoped });
    const first = await insert(fragment("ws-a"));
    db.indexes = new Set(STATES.both);
    assert.equal(await insert(fragment("ws-b")), first);
    assert.equal(db.rows.length, 1);
    assert.equal(countStatements(/pg_index/), 2);
  });

  it("외부 트랜잭션에서는 저장점으로 되돌린 뒤 다시 시도해 트랜잭션을 이어 간다", async () => {
    db = makeFakeDb({ indexes: STATES.both });
    await insert(fragment("ws-a", { content: "색인 상태를 기억시키는 두 번째 시험 파편 본문" }));
    db.indexes = new Set(STATES.scoped);
    const client = db.client();
    await client.query("BEGIN");
    const id = await insert(fragment("ws-b"), client);
    await client.query("COMMIT");
    assert.equal(db.byId(id).workspace, "ws-b");
    assert.equal(countStatements(/^ROLLBACK TO SAVEPOINT/), 1);
    assert.equal(countStatements(/^RELEASE SAVEPOINT/), 1);
  });

  it("판정 색인이 아닌 제약 위반은 다시 시도하지 않고 전한다", async () => {
    db = makeFakeDb({ indexes: STATES.scoped });
    const original = db.query;
    db.query = async (sql, params) => {
      if (/^INSERT INTO agent_memory\.fragments\s/.test(String(sql).trim())) {
        const err = new Error("duplicate key value violates unique constraint \"idx_fragments_idempotency_tenant\"");
        err.code       = "23505";
        err.constraint = "idx_fragments_idempotency_tenant";
        throw err;
      }
      return original(sql, params);
    };
    await assert.rejects(() => insert(fragment("ws-a")), err => err.constraint === "idx_fragments_idempotency_tenant");
    assert.equal(countStatements(/pg_index/), 1);
  });
});

describe("insert: 키 범위 색인이 무효 상태로 남았을 때(DROP INDEX CONCURRENTLY 대기 또는 중단)", () => {
  for (const keyId of ["key-1", null]) {
    it(`${keyId ? "키 보유" : "마스터"} 경로: 키 범위로 판정하고 오류를 내지 않는다`, async () => {
      db = makeFakeDb({ indexes: STATES.scoped, invalid: STATES.legacy });
      const first  = await insert(fragment("ws-a", { keyId }));
      const second = await insert(fragment("ws-b", { keyId }));
      assert.equal(second, first);
      assert.equal(db.rows.length, 1);
    });
  }

  it("기억한 상태가 두 색인 모두 유효였다가 키 범위 색인이 무효로 바뀌어도 키 범위로 판정한다", async () => {
    db = makeFakeDb({ indexes: STATES.both });
    const first = await insert(fragment("ws-a"));
    db.indexes = new Set(STATES.scoped);
    db.invalid = new Set(STATES.legacy);
    const fresh = await insert(fragment("ws-c", { content: "키 범위 색인이 무효로 바뀐 뒤 처음 저장하는 본문" }));
    assert.equal(db.byId(fresh).workspace, "ws-c");
    assert.equal(await insert(fragment("ws-b")), first);
    assert.equal(db.rows.length, 2);
  });

  it("외부 트랜잭션: 사전 조회 뒤 다른 workspace에 먼저 들어간 행은 23505 뒤 기존 id로 돌려준다", async () => {
    db = makeFakeDb({ indexes: STATES.scoped, invalid: STATES.legacy });
    let injected = false;
    const original = db.query;
    db.query = async (sql, params) => {
      const result = await original(sql, params);
      if (!injected && String(sql).startsWith("SELECT id, workspace, content_hash")) {
        injected = true;
        db.rows.push(row("racer", "ws-a"));
      }
      return result;
    };
    const client = db.client();
    await client.query("BEGIN");
    const id = await insert(fragment("ws-b"), client);
    await client.query("COMMIT");
    assert.equal(id, "racer");
    assert.equal(db.rows.length, 1);
  });

  it("다시 판정한 뒤에도 키 범위 색인이 막으면 키 범위의 기존 행을 돌려준다", async () => {
    db = makeFakeDb({ indexes: STATES.scoped, invalid: STATES.legacy });
    let   lookups  = 0;
    const original = db.query;
    db.query = async (sql, params) => {
      const result = await original(sql, params);
      if (!String(sql).startsWith("SELECT id, workspace, content_hash")) return result;
      lookups++;
      if (lookups === 1) db.rows.push(row("racer", "ws-a"));
      return lookups <= 2 ? { rows: [] } : result;
    };
    assert.equal(await insert(fragment("ws-b")), "racer");
    assert.equal(lookups, 3, "두 번의 판정과 23505 뒤 다시 읽기");
  });
});

describe("insert: workspace 값 정규화", () => {
  it("''와 공백뿐인 workspace는 NULL로 저장하고 전역 파편과 같은 칸이다", async () => {
    db = makeFakeDb({ indexes: STATES.scoped });
    const first = await insert(fragment(""));
    assert.equal(db.byId(first).workspace, null);
    assert.equal(await insert(fragment("   ")), first);
    assert.equal(await insert(fragment(null)), first);
    assert.equal(db.rows.length, 1);
  });
});

describe("insert: 판정 색인이 없을 때", () => {
  it("ON CONFLICT 없이 저장하고 사전 조회로 같은 칸 중복을 막는다", async () => {
    db = makeFakeDb({ indexes: [] });
    const first  = await insert(fragment("ws-a"));
    const second = await insert(fragment("ws-a"));
    assert.equal(second, first);
    assert.equal(db.statements.some(s => s.includes("ON CONFLICT")), false);
  });
});

describe("amend: 바뀐 본문의 해시 충돌 판정", () => {
  const OTHER = "workspace 범위 판정을 위한 다른 시험 파편 본문";

  async function amend(id, content) {
    const gate       = new WriteGate();
    const { fields } = await gate.check({ entry: "amend", op: "update", fields: { content }, base: { type: "fact" } });
    const existing   = { ...db.byId(id), agent_id: "default" };
    return writer.update(id, fields, "default", "key-1", existing);
  }

  for (const [state, merged] of [["legacy", true], ["both", true], ["scoped", false]]) {
    it(`${state} 색인: 다른 workspace의 같은 본문`, async () => {
      db = makeFakeDb({ indexes: STATES[state], rows: [row("a", "ws-a"), row("b", "ws-b", { content: OTHER })] });
      const result = await amend("b", TEXT);
      if (merged) {
        assert.deepEqual(result, { merged: true, existingId: "a" });
      } else {
        assert.equal(result.id, "b");
        assert.equal(db.byId("b").content_hash, computeContentHash(TEXT));
      }
    });
  }

  it("scoped 색인: 전역 파편의 같은 본문으로 고치면 병합 신호를 낸다", async () => {
    db = makeFakeDb({ indexes: STATES.scoped, rows: [row("g", null), row("b", "ws-b", { content: OTHER })] });
    assert.deepEqual(await amend("b", TEXT), { merged: true, existingId: "g" });
  });

  it("scoped 색인과 MEMENTO_DEDUP_SCOPE=key: 다른 workspace도 병합 신호", async () => {
    process.env.MEMENTO_DEDUP_SCOPE = "key";
    db = makeFakeDb({ indexes: STATES.scoped, rows: [row("a", "ws-a"), row("b", "ws-b", { content: OTHER })] });
    assert.deepEqual(await amend("b", TEXT), { merged: true, existingId: "a" });
  });

  it("기억한 상태보다 색인이 늘어 UPDATE가 23505를 받으면 막은 색인의 범위로 병합 신호를 낸다", async () => {
    db = makeFakeDb({ indexes: STATES.scoped, rows: [row("a", "ws-a"), row("b", "ws-b", { content: OTHER })] });
    await insert(fragment("ws-c", { content: "색인 상태를 기억시키는 세 번째 시험 파편 본문" }));
    db.indexes = new Set(STATES.both);
    assert.deepEqual(await amend("b", TEXT), { merged: true, existingId: "a" });
    assert.equal(db.byId("b").content_hash, computeContentHash(OTHER));
  });

  it("무효 상태로 남은 키 범위 색인이 있으면 키 범위로 병합 신호를 낸다", async () => {
    db = makeFakeDb({
      indexes: STATES.scoped, invalid: STATES.legacy,
      rows   : [row("a", "ws-a"), row("b", "ws-b", { content: OTHER })]
    });
    assert.deepEqual(await amend("b", TEXT), { merged: true, existingId: "a" });
  });
});
