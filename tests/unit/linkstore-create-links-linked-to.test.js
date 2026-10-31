/**
 * LinkStore.createLinks 연결 배열 갱신 검사
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 링크 upsert와 연결 배열 갱신이 한 트랜잭션에서 실행되는지, 쌍마다 상대 id만 더하는지, 대상 행을 id 순으로
 * 잠그는지, 갱신이 실패하면 트랜잭션 전체가 실패로 끝나는지 DB 없이 확인한다. 실제 DB 동작은
 * tests/db-concurrency/linked-to-pairs.test.js가 본다.
 */

import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

let queries      = [];
let failLinkedTo = false;

const fakeClient = {
  query: async (sql, params = []) => {
    queries.push({ sql, params });
    if (failLinkedTo && /UPDATE \S*fragments f/.test(sql)) throw new Error("lock timeout");
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
  queries      = [];
  failLinkedTo = false;
});

describe("LinkStore.createLinks 연결 배열 갱신", () => {
  const pairs = [
    { fromId: "c", toId: "d", relationType: "related" },
    { fromId: "a", toId: "b", relationType: "related" }
  ];
  const linkedToUpdate = () => queries.find(q => /UPDATE \S*fragments f/.test(q.sql));

  it("대상 파편 id 전체를 정렬 순서로 advisory lock 잡는다", async () => {
    await new LinkStore().createLinks(pairs, "agent-a");
    const lock = queries.find(q => /pg_advisory_xact_lock/.test(q.sql));
    assert.deepEqual(lock.params, [["a", "b", "c", "d"]]);
  });

  it("쌍의 정방향과 역방향을 같은 위치로 넘겨 자기 쌍의 상대 id만 더한다", async () => {
    await new LinkStore().createLinks(pairs, "agent-a");
    const { sql, params } = linkedToUpdate();
    assert.match(sql, /unnest\(\$1::text\[\], \$2::text\[\]\)\s+UNION\s+SELECT \* FROM unnest\(\$2::text\[\], \$1::text\[\]\)/);
    assert.deepEqual(params.slice(0, 2), [["c", "a"], ["d", "b"]]);
  });

  it("갱신할 행을 id 순으로 잠근 뒤 잠근 행만 갱신한다", async () => {
    await new LinkStore().createLinks(pairs, "agent-a");
    const { sql, params } = linkedToUpdate();
    assert.match(sql, /WHERE id = ANY\(\$3::text\[\]\)\s+ORDER BY id\s+FOR NO KEY UPDATE/);
    assert.match(sql, /JOIN locked l ON l\.id = p\.src/);
    assert.deepEqual(params[2], ["a", "b", "c", "d"]);
  });

  it("연결 배열 갱신이 실패하면 트랜잭션 전체가 실패한다", async () => {
    failLinkedTo = true;
    await assert.rejects(() => new LinkStore().createLinks(pairs, "agent-a"), /lock timeout/);
  });

  it("쌍이 없으면 아무 질의도 발행하지 않는다", async () => {
    const ids = await new LinkStore().createLinks([], "agent-a");
    assert.deepEqual(ids, []);
    assert.equal(queries.length, 0);
  });
});
