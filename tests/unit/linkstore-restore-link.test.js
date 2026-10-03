/**
 * LinkStore.restoreLink 단위 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 가져온 링크가 기존 행을 건드리지 않고, 새로 만들 때만 양쪽 linked_to를 갱신하는지 DB 대역으로
 * 확인한다.
 */

import { describe, it, mock, beforeEach } from "node:test";
import assert                             from "node:assert/strict";

let captured = [];
let rowCount = 1;

const fakeClient = {
  query: async (sql, params = []) => {
    captured.push({ sql, params });
    return { rowCount: /INSERT INTO/.test(sql) ? rowCount : 1, rows: [] };
  }
};

mock.module("../../lib/tools/db.js", {
  namedExports: {
    getPrimaryPool      : () => ({}),
    withTransaction     : async (_pool, fn) => fn(fakeClient),
    queryWithAgentVector: async () => ({ rows: [] })
  }
});

const { LinkStore } = await import("../../lib/memory/link/LinkStore.js");

beforeEach(() => {
  captured = [];
  rowCount = 1;
});

describe("LinkStore.restoreLink", () => {
  const link = { from_id: "a", to_id: "b", relation_type: "caused_by", weight: 2, confidence: 0.9, decay_rate: 0.01, created_at: "2026-01-01T00:00:00.000Z" };

  it("새 링크는 열을 그대로 넣고 양쪽 linked_to를 갱신한다", async () => {
    const result = await new LinkStore().restoreLink(fakeClient, link);
    assert.deepEqual(result, { created: true });

    const insert = captured[0];
    assert.match(insert.sql, /ON CONFLICT \(from_id, to_id\) DO NOTHING/);
    assert.deepEqual(insert.params.slice(0, 7), ["a", "b", "caused_by", "2026-01-01T00:00:00.000Z", 2, 0.9, 0.01]);

    const update = captured[1];
    assert.match(update.sql, /FOR NO KEY UPDATE/);
    assert.deepEqual(update.params, [["a", "b"], "a", "b"]);
  });

  it("이미 있는 링크는 건드리지 않고 linked_to도 갱신하지 않는다", async () => {
    rowCount = 0;
    const result = await new LinkStore().restoreLink(fakeClient, link);
    assert.deepEqual(result, { created: false });
    assert.equal(captured.length, 1);
  });

  it("값이 없는 열은 null을 넘겨 서버 기본값을 쓴다", async () => {
    await new LinkStore().restoreLink(fakeClient, { from_id: "a", to_id: "b" });
    assert.deepEqual(captured[0].params, ["a", "b", "related", null, null, null, null, null]);
  });
});
