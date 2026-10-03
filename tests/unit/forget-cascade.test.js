/**
 * forget 삭제 연쇄 단위 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 영수증 순수 함수, 잠금 문장과 연쇄 문장의 구조, FragmentWriter.deleteWithCascade의 문장 순서,
 * MemoryRememberer.forget의 스위치별 경로, 고아 사본 정리의 미리보기와 실행을 DB 없이 본다.
 * 실제 행 기준 정합은 tests/db-concurrency/forget-cascade.test.js가 본다.
 */

import { describe, it, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

/** FragmentWriter가 쓰는 DB 계층 대역 */
let dbCalls = [];
let lockedRows = [];
mock.module("../../lib/tools/db.js", {
  namedExports: {
    queryWithAgentVector: async (agentId, sql, params = [], opts = {}) => {
      dbCalls.push({ agentId, sql: String(sql), params, opts });
      if (opts && typeof opts === "object" && opts.lock && /WITH gone AS/.test(sql)) {
        return { rows: lockedRows, rowCount: lockedRows.length };
      }
      return { rows: [], rowCount: 0 };
    },
    getPrimaryPool: () => null
  }
});
const deindexed = [];
mock.module("../../lib/memory/FragmentIndex.js", {
  namedExports: { deindexRows: async rows => { deindexed.push(...rows); } }
});

const {
  DELETED_SUMMARY, CONTRADICTION_AUDIT_TOPIC, CASCADE_DELETE_SQL,
  emptyPurge, addPurge, forgetReceipt, cascadeDeleteLock, summarizeCascade, purgeOrphanCaseSummaries
} = await import("../../lib/memory/write/ForgetCascade.js");
const { FragmentWriter }   = await import("../../lib/memory/write/FragmentWriter.js");
const { MemoryRememberer } = await import("../../lib/memory/processors/MemoryRememberer.js");

const norm = sql => String(sql).replace(/\s+/g, " ").trim();

describe("영수증 순수 함수", () => {
  it("emptyPurge는 두 건수가 0이고 addPurge는 항목별로 더한다", () => {
    assert.deepEqual(emptyPurge(), { case_summaries: 0, audit_fragments: 0 });
    const sum = addPurge(addPurge(emptyPurge(), { case_summaries: 2, audit_fragments: 1 }), { case_summaries: 3 });
    assert.deepEqual(sum, { case_summaries: 5, audit_fragments: 1 });
  });

  it("forgetReceipt는 purged가 null이면 영수증을 싣지 않는다", () => {
    const off = forgetReceipt({ deleted: 1, protected: 0, purged: null });
    assert.equal(off.deleted, 1);
    assert.equal(off.protected, 0);
    assert.equal(Object.hasOwn(off, "purged"), false);
  });

  it("forgetReceipt는 purged 건수를 복사해 싣는다", () => {
    const purged = { case_summaries: 2, audit_fragments: 1 };
    const on     = forgetReceipt({ deleted: 3, protected: 1, purged });
    assert.equal(on.deleted, 3);
    assert.equal(on.protected, 1);
    assert.deepEqual(on.purged, purged);
    assert.notEqual(on.purged, purged);
  });

  it("summarizeCascade는 요청 대상과 딸려 지운 모순 해소 기록을 나눈다", () => {
    const rows = [
      { id: "t1", scrubbed: 4 }, { id: "a1", scrubbed: 4 }, { id: "t2", scrubbed: 4 }
    ];
    const out = summarizeCascade(["t1", "t2", "t3"], rows);
    assert.equal(out.deleted, 2);
    assert.deepEqual(out.removedIds, ["t1", "a1", "t2"]);
    assert.deepEqual(out.auditRows.map(r => r.id), ["a1"]);
    assert.deepEqual(out.purged, { case_summaries: 4, audit_fragments: 1 });
  });

  it("summarizeCascade는 지운 행이 없으면 건수가 모두 0이다", () => {
    const out = summarizeCascade(["t1"], []);
    assert.equal(out.deleted, 0);
    assert.deepEqual(out.removedIds, []);
    assert.deepEqual(out.purged, emptyPurge());
  });
});

describe("잠금 문장과 연쇄 문장", () => {
  it("키 범위가 있으면 대상 조회에 키 조건을 넣고 서버 기록 모순 해소 파편을 함께 잠근다", () => {
    const lock = cascadeDeleteLock(["t1"], "k1");
    const sql  = norm(lock.sql);
    assert.equal(lock.operation, "delete");
    assert.deepEqual(lock.params, [["t1"], "k1", CONTRADICTION_AUDIT_TOPIC]);
    assert.match(sql, /t\.id = ANY\(\$1::text\[\]\) AND t\.key_id = \$2/);
    assert.match(sql, /topic = \$3 AND key_id IS NULL AND linked_to && ARRAY\(/);
    assert.match(sql, /ORDER BY id FOR UPDATE$/);
  });

  it("master(키 없음)는 대상 조회에 키 조건이 없다", () => {
    const lock = cascadeDeleteLock(["t1", "t2"], null);
    assert.deepEqual(lock.params, [["t1", "t2"], CONTRADICTION_AUDIT_TOPIC]);
    assert.doesNotMatch(norm(lock.sql), /key_id = \$/);
    assert.match(norm(lock.sql), /topic = \$2 AND key_id IS NULL/);
  });

  it("연쇄 문장은 잠근 행을 지우고 같은 문장에서 case_events 요약을 바꾼다", () => {
    const sql = norm(CASCADE_DELETE_SQL);
    assert.match(sql, /DELETE FROM agent_memory\.fragments WHERE id = ANY\(\$1::text\[\]\)/);
    assert.match(sql, /UPDATE agent_memory\.case_events SET summary = \$2 WHERE source_fragment_id = ANY\(\$1::text\[\]\)/);
    assert.match(sql, /summary IS DISTINCT FROM \$2/);
    assert.equal(DELETED_SUMMARY, "[삭제됨]");
  });
});

describe("FragmentWriter.deleteWithCascade", () => {
  beforeEach(() => { dbCalls = []; lockedRows = []; deindexed.length = 0; });

  it("잠금 트랜잭션에서 지운 뒤 지운 id 전체의 링크와 linked_to를 정리하고 모순 해소 기록의 색인을 지운다", async () => {
    lockedRows = [
      { id: "a1", keywords: ["k"], topic: CONTRADICTION_AUDIT_TOPIC, type: "decision", key_id: null, scrubbed: 2 },
      { id: "t1", keywords: [],    topic: "ops",                     type: "fact",     key_id: "k1", scrubbed: 2 }
    ];
    const out = await new FragmentWriter().deleteWithCascade(["t1"], "agent-x", "k1");

    assert.deepEqual(out, { deleted: 1, purged: { case_summaries: 2, audit_fragments: 1 } });
    assert.match(dbCalls[0].sql, /WITH gone AS/);
    assert.deepEqual(dbCalls[0].params, [DELETED_SUMMARY]);
    assert.equal(dbCalls[0].opts.lock.operation, "delete");
    assert.deepEqual(dbCalls[0].opts.lock.params, [["t1"], "k1", CONTRADICTION_AUDIT_TOPIC]);

    const links  = dbCalls.find(c => /DELETE FROM agent_memory\.fragment_links/.test(c.sql));
    const unlink = dbCalls.find(c => c.opts?.lock?.operation === "unlink");
    assert.deepEqual(links.params, [["a1", "t1"]]);
    assert.deepEqual(unlink.opts.lock.params, [["a1", "t1"]]);
    assert.ok(dbCalls.indexOf(links) > 0 && dbCalls.indexOf(unlink) > 0, "정리는 삭제 뒤에 한다");
    assert.deepEqual(deindexed.map(r => r.id), ["a1"]);
  });

  it("잠근 행이 없으면 정리 문장을 실행하지 않는다", async () => {
    const out = await new FragmentWriter().deleteWithCascade(["t1"], "default", "k2");
    assert.deepEqual(out, { deleted: 0, purged: emptyPurge() });
    assert.equal(dbCalls.length, 1);
  });

  it("빈 목록은 질의하지 않는다", async () => {
    const out = await new FragmentWriter().deleteWithCascade([], "default", null);
    assert.deepEqual(out, { deleted: 0, purged: emptyPurge() });
    assert.equal(dbCalls.length, 0);
  });
});

/**
 * forget 경로만 쓰는 MemoryRememberer 대역
 *
 * @param {Object} [frag]
 */
function makeRememberer(frag = { id: "f1", key_id: "k1", ttl_tier: "warm", keywords: [], topic: "ops", type: "fact" }) {
  const store = {
    getById          : mock.fn(async () => frag),
    probeAccess      : mock.fn(async () => ({ exists: false, accessible: false })),
    delete           : mock.fn(async () => true),
    deleteMany       : mock.fn(async ids => ids.length),
    searchByTopic    : mock.fn(async () => []),
    deleteWithCascade: mock.fn(async ids => ({ deleted: ids.length, purged: { case_summaries: 2, audit_fragments: 1 } }))
  };
  const index = { deindex: mock.fn(async () => {}) };
  return { rememberer: new MemoryRememberer({ store, index }), store, index };
}

describe("MemoryRememberer.forget 삭제 연쇄", () => {
  const saved = process.env.MEMENTO_FORGET_CASCADE;
  afterEach(() => {
    if (saved === undefined) delete process.env.MEMENTO_FORGET_CASCADE;
    else process.env.MEMENTO_FORGET_CASCADE = saved;
  });

  it("기본(on)은 id 삭제를 연쇄 삭제로 하고 영수증을 싣는다", async () => {
    delete process.env.MEMENTO_FORGET_CASCADE;
    const { rememberer, store, index } = makeRememberer();
    const res = await rememberer.forget({ id: "f1", _keyId: "k1", agentId: "a1" });

    assert.equal(res.deleted, 1);
    assert.equal(res.protected, 0);
    assert.deepEqual(res.purged, { case_summaries: 2, audit_fragments: 1 });
    assert.equal(store.delete.mock.calls.length, 0);
    assert.deepEqual(store.deleteWithCascade.mock.calls[0].arguments, [["f1"], "a1", "k1"]);
    assert.equal(index.deindex.mock.calls.length, 1);
  });

  it("off는 store.delete로 지우고 영수증을 싣지 않는다", async () => {
    process.env.MEMENTO_FORGET_CASCADE = "off";
    const { rememberer, store } = makeRememberer();
    const res = await rememberer.forget({ id: "f1", _keyId: "k1" });

    assert.equal(res.deleted, 1);
    assert.equal(Object.hasOwn(res, "purged"), false);
    assert.equal(store.deleteWithCascade.mock.calls.length, 0);
    assert.equal(store.delete.mock.calls.length, 1);
  });

  it("topic 삭제는 소유한 대상만 한 번에 연쇄 삭제하고 영수증을 더한다", async () => {
    delete process.env.MEMENTO_FORGET_CASCADE;
    const { rememberer, store } = makeRememberer();
    store.searchByTopic = mock.fn(async () => [
      { id: "f1", key_id: "k1", ttl_tier: "warm", keywords: [], topic: "ops", type: "fact" },
      { id: "f2", key_id: "k9", ttl_tier: "warm", keywords: [], topic: "ops", type: "fact" },
      { id: "f3", key_id: "k1", ttl_tier: "permanent", keywords: [], topic: "ops", type: "fact" },
      { id: "f4", key_id: "k1", ttl_tier: "warm", keywords: [], topic: "ops", type: "fact" }
    ]);
    const res = await rememberer.forget({ topic: "ops", _keyId: "k1" });

    assert.equal(res.deleted, 2);
    assert.equal(res.protected, 2);
    assert.deepEqual(res.purged, { case_summaries: 2, audit_fragments: 1 });
    assert.deepEqual(store.deleteWithCascade.mock.calls[0].arguments[0], ["f1", "f4"]);
    assert.equal(store.deleteMany.mock.calls.length, 0);
  });

  it("삭제하지 않은 조기 응답(권한 없음, permanent 보호)은 그대로다", async () => {
    delete process.env.MEMENTO_FORGET_CASCADE;
    const missing = makeRememberer(null);
    missing.store.probeAccess = mock.fn(async () => ({ exists: true, accessible: false }));
    const denied = await missing.rememberer.forget({ id: "f1", _keyId: "k2" });
    assert.equal(denied.error, "No permission to delete this fragment");
    assert.equal(Object.hasOwn(denied, "purged"), false);

    const kept = makeRememberer({ id: "f1", key_id: "k1", ttl_tier: "permanent", keywords: [], topic: "ops", type: "fact" });
    const prot = await kept.rememberer.forget({ id: "f1", _keyId: "k1" });
    assert.equal(prot.protected, 1);
    assert.equal(kept.store.deleteWithCascade.mock.calls.length, 0);
  });
});

describe("purgeOrphanCaseSummaries", () => {
  it("미리보기는 건수와 event_id 표본만 돌려주고 갱신하지 않는다", async () => {
    const sqls = [];
    const pool = {
      query: async (sql, params) => {
        sqls.push({ sql: norm(sql), params });
        if (/count\(\*\)/.test(sql)) return { rows: [{ n: 3 }] };
        return { rows: [{ event_id: "e1", summary: "본문 사본" }] };
      }
    };
    const out = await purgeOrphanCaseSummaries(pool);

    assert.deepEqual(out, { mode: "dry-run", orphans: 3, sample_event_ids: ["e1"] });
    assert.ok(sqls.every(s => !/^UPDATE/.test(s.sql)));
    assert.ok(sqls.every(s => /NOT EXISTS \(SELECT 1 FROM agent_memory\.fragments f WHERE f\.id = ce\.source_fragment_id\)/.test(s.sql)));
    assert.ok(sqls.every(s => s.params[0] === DELETED_SUMMARY));
  });

  it("실행은 묶음 크기보다 적게 바뀔 때까지 반복한다", async () => {
    const counts = [2, 2, 1];
    const calls  = [];
    const pool   = {
      query: async (sql, params) => {
        calls.push({ sql: norm(sql), params });
        return { rowCount: counts.shift() ?? 0 };
      }
    };
    const out = await purgeOrphanCaseSummaries(pool, { execute: true, batchSize: 2 });

    assert.deepEqual(out, { mode: "execute", updated: 5, batches: 3 });
    assert.ok(calls.every(c => /^UPDATE agent_memory\.case_events SET summary = \$1/.test(c.sql)));
    assert.ok(calls.every(c => /FOR UPDATE SKIP LOCKED/.test(c.sql)));
    assert.deepEqual(calls[0].params, [DELETED_SUMMARY, 2]);
  });
});
