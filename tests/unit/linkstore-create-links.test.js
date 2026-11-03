/**
 * LinkStore.createLinks 쓰기 검사
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 * 수정일: 2026-11-04 (링크 쓰기가 파편 행의 linked_to를 갱신하지 않는다)
 *
 * 링크 쓰기가 fragment_links upsert 한 문장인지, 파편 행을 잠그거나 갱신하지 않는지, 행을 (from, to) 순으로
 * 넘기는지, 실패하면 트랜잭션 전체가 실패로 끝나는지 DB 없이 확인한다.
 */

import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

let queries    = [];
let failInsert = false;

const fakeClient = {
  query: async (sql, params = []) => {
    queries.push({ sql, params });
    if (failInsert && /INSERT INTO \S*fragment_links/.test(sql)) throw new Error("lock timeout");
    return { rows: [{ id: 11 }, { id: 12 }] };
  }
};

mock.module("../../lib/tools/db.js", {
  namedExports: {
    getPrimaryPool      : () => ({}),
    withTransaction     : async (_pool, fn) => fn(fakeClient),
    queryWithAgentVector: async () => ({ rows: [], rowCount: 0 })
  }
});

const { LinkStore } = await import("../../lib/memory/link/LinkStore.js");

beforeEach(() => {
  queries    = [];
  failInsert = false;
});

describe("LinkStore.createLinks", () => {
  const pairs = [
    { fromId: "c", toId: "d", relationType: "related" },
    { fromId: "a", toId: "b", relationType: "related" }
  ];

  it("링크 upsert 한 문장만 쓰고 파편 행을 잠그거나 갱신하지 않는다", async () => {
    await new LinkStore().createLinks(pairs, "agent-a");
    assert.equal(queries.some(q => /fragments/.test(q.sql) && /UPDATE|FOR NO KEY UPDATE/.test(q.sql)), false);
    assert.equal(queries.some(q => /pg_advisory_xact_lock/.test(q.sql)), false);
    assert.equal(queries.filter(q => /INSERT INTO \S*fragment_links/.test(q.sql)).length, 1);
  });

  it("행을 (from, to) 순으로 정렬해 넘겨 동시 upsert의 잠금 순서를 맞춘다", async () => {
    await new LinkStore().createLinks(pairs, "agent-a");
    const insert = queries.find(q => /INSERT INTO \S*fragment_links/.test(q.sql));
    assert.deepEqual(insert.params.slice(0, 2), [["a", "c"], ["b", "d"]]);
  });

  it("upsert가 실패하면 트랜잭션 전체가 실패한다", async () => {
    failInsert = true;
    await assert.rejects(() => new LinkStore().createLinks(pairs, "agent-a"), /lock timeout/);
  });

  it("쌍이 없으면 아무 질의도 발행하지 않는다", async () => {
    const ids = await new LinkStore().createLinks([], "agent-a");
    assert.deepEqual(ids, []);
    assert.equal(queries.length, 0);
  });
});
