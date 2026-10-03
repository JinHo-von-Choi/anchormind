/**
 * batch_remember 중복 판정 범위 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 유일 색인 대역(_dedup-fake-db.js)을 풀로 주입해 세 색인 상태(키 범위 색인만, 두 범위 모두,
 * workspace 범위 색인만)와 색인 없음에서 사전 조회, 청크 안 접기, ON CONFLICT 병합,
 * 색인 변경 직후의 재실행을 확인한다.
 */
import { describe, it, mock, beforeEach, afterEach } from "node:test";
import assert                                       from "node:assert/strict";

import { BatchRememberProcessor }                   from "../../lib/memory/write/BatchRememberProcessor.js";
import { DEDUP_INDEXES, invalidateDedupIndexes }    from "../../lib/memory/write/DedupScope.js";
import { makeFakeDb }                               from "./_dedup-fake-db.js";

const STATES = {
  legacy: [DEDUP_INDEXES.keyLegacy, DEDUP_INDEXES.masterLegacy],
  both  : [DEDUP_INDEXES.keyLegacy, DEDUP_INDEXES.masterLegacy, DEDUP_INDEXES.keyScoped, DEDUP_INDEXES.masterScoped],
  scoped: [DEDUP_INDEXES.keyScoped, DEDUP_INDEXES.masterScoped]
};

const TEXT = "batch 경로에서 같은 본문을 두 workspace에 저장하는 시험 파편";
const hash = (content) => `h:${content}`;

let seq = 0;

function makeFactory() {
  return {
    create(item) {
      seq++;
      return {
        id: `batch-${seq}`, content: item.content, topic: item.topic, type: item.type,
        keywords: [], importance: item.importance ?? 0.5, content_hash: hash(item.content),
        ttl_tier: "warm", is_anchor: false, assertion_status: "observed"
      };
    }
  };
}

let db;

function processor() {
  const proc = new BatchRememberProcessor({ store: {}, index: { index: mock.fn(async () => {}) }, factory: makeFactory() });
  proc.setPool(db.pool());
  return proc;
}

const item = (workspace, extra = {}) => ({ content: TEXT, type: "fact", topic: "t", workspace, ...extra });
const seed = (id, workspace, { keyId = "key-1", importance = 0.5 } = {}) =>
  ({ id, key_id: keyId, workspace, content_hash: hash(TEXT), importance });

async function run(items, keyId = "key-1") {
  return processor().process({ fragments: items, agentId: "default", _keyId: keyId });
}

beforeEach(() => {
  invalidateDedupIndexes();
  delete process.env.MEMENTO_DEDUP_SCOPE;
});

afterEach(() => {
  delete process.env.MEMENTO_DEDUP_SCOPE;
});

describe("batch: 다른 workspace의 같은 본문이 이미 있을 때", () => {
  for (const [state, separate] of [["legacy", false], ["both", false], ["scoped", true]]) {
    it(`${state} 색인`, async () => {
      db = makeFakeDb({ indexes: STATES[state], rows: [seed("existing", "ws-a")] });
      const { results } = await run([item("ws-b")]);
      assert.equal(results[0].success, true);
      if (separate) {
        assert.notEqual(results[0].id, "existing");
        assert.equal(db.rows.length, 2);
      } else {
        assert.equal(results[0].id, "existing");
        assert.equal(db.rows.length, 1);
      }
    });
  }
});

describe("batch: 한 요청 안의 같은 본문", () => {
  it("scoped 색인: workspace가 다르면 따로 저장한다(키 보유, 마스터)", async () => {
    for (const keyId of ["key-1", null]) {
      invalidateDedupIndexes();
      db = makeFakeDb({ indexes: STATES.scoped });
      const { results } = await run([item("ws-a"), item("ws-b"), item("ws-a")], keyId);
      assert.equal(db.rows.length, 2);
      assert.notEqual(results[0].id, results[1].id);
      assert.equal(results[2].id, results[0].id);
    }
  });

  it("legacy 색인: workspace가 달라도 하나로 접는다", async () => {
    db = makeFakeDb({ indexes: STATES.legacy });
    const { results } = await run([item("ws-a"), item("ws-b")]);
    assert.equal(db.rows.length, 1);
    assert.equal(results[1].id, results[0].id);
  });
});

describe("batch: workspace 범위 색인만 있을 때의 사전 조회", () => {
  it("전역 파편이 있으면 INSERT 없이 그 id를 돌려주고 기존 행을 고치지 않는다", async () => {
    db = makeFakeDb({ indexes: STATES.scoped, rows: [seed("global", null, { importance: 0.3 })] });
    const { results, inserted } = await run([item("ws-b", { importance: 0.9 })]);
    assert.equal(results[0].id, "global");
    assert.equal(inserted, 1);
    assert.equal(db.rows.length, 1);
    assert.equal(db.byId("global").importance, 0.3);
    assert.equal(db.statements.some(s => /^INSERT INTO agent_memory\.fragments\s/.test(s)), false);
  });

  it("MEMENTO_DEDUP_SCOPE=key이면 다른 workspace의 기존 id를 돌려준다", async () => {
    process.env.MEMENTO_DEDUP_SCOPE = "key";
    db = makeFakeDb({ indexes: STATES.scoped, rows: [seed("existing", "ws-a")] });
    const { results } = await run([item("ws-b")]);
    assert.equal(results[0].id, "existing");
    assert.equal(db.rows.length, 1);
  });

  it("같은 workspace 중복은 ON CONFLICT로 병합한다", async () => {
    db = makeFakeDb({ indexes: STATES.scoped, rows: [seed("existing", "ws-a", { importance: 0.3 })] });
    const { results } = await run([item("ws-a", { importance: 0.9 })]);
    assert.equal(results[0].id, "existing");
    assert.equal(db.byId("existing").importance, 0.9);
  });
});

describe("batch: 키 범위 색인이 있을 때", () => {
  it("사전 조회 없이 ON CONFLICT가 다른 workspace 중복도 병합한다", async () => {
    db = makeFakeDb({ indexes: STATES.legacy, rows: [seed("existing", "ws-a", { importance: 0.3 })] });
    const { results } = await run([item("ws-b", { importance: 0.9 })]);
    assert.equal(results[0].id, "existing");
    assert.equal(db.byId("existing").importance, 0.9);
    assert.equal(db.statements.some(s => s.startsWith("SELECT id, workspace, content_hash")), false);
  });
});

describe("batch: 운영 단계로 색인이 바뀐 직후", () => {
  it("키 범위 색인이 지워지면 트랜잭션을 되돌리고 색인 상태를 다시 읽어 저장한다", async () => {
    db = makeFakeDb({ indexes: STATES.both, rows: [seed("existing", "ws-a")] });
    await run([item("ws-c", { content: "색인 상태를 기억시키는 batch 시험 파편 본문" })]);
    db.indexes = new Set(STATES.scoped);
    const { results } = await run([item("ws-b")]);
    assert.notEqual(results[0].id, "existing");
    assert.equal(db.byId(results[0].id).workspace, "ws-b");
    assert.equal(db.statements.filter(s => s.includes("pg_index")).length, 2);
    assert.ok(db.statements.includes("ROLLBACK"));
  });
});

describe("batch: 판정 색인이 없을 때", () => {
  it("ON CONFLICT 없이 사전 조회로 같은 칸 중복을 가른다", async () => {
    db = makeFakeDb({ indexes: [], rows: [seed("existing", "ws-a")] });
    const { results } = await run([item("ws-a")]);
    assert.equal(results[0].id, "existing");
    assert.equal(db.rows.length, 1);
    assert.equal(db.statements.some(s => s.includes("ON CONFLICT")), false);
  });
});
