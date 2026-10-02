/**
 * LinkStore.createLinks 갱신 열 검사
 *
 * 작성자: 최진호
 * 작성일: 2026-10-02
 *
 * fragment_links에 없는 열을 갱신 대상에 넣으면 질의 전체가 실패한다.
 * 생성되는 INSERT 문이 테이블에 존재하는 열만 다루는지 DB 없이 확인한다.
 */

import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

let captured = [];

const fakeClient = {
  query: async (sql, params = []) => {
    captured.push({ sql, params });
    return { rows: [{ id: 1 }, { id: 2 }] };
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
});

describe("LinkStore.createLinks 갱신 열", () => {
  const pairs = [
    { fromId: "a", toId: "b", relationType: "caused_by" },
    { fromId: "b", toId: "c", relationType: "related" }
  ];

  it("INSERT 문이 accessed_at 열을 참조하지 않는다", async () => {
    await new LinkStore().createLinks(pairs, "agent-a");

    const insert = captured.find(c => /INSERT INTO\s+\S*fragment_links/.test(c.sql));
    assert.ok(insert, "fragment_links INSERT 문이 발행되어야 한다");
    assert.doesNotMatch(insert.sql, /accessed_at/);
  });

  it("충돌 시 relation_type과 weight를 갱신한다", async () => {
    await new LinkStore().createLinks(pairs, "agent-a");

    const insert = captured.find(c => /INSERT INTO\s+\S*fragment_links/.test(c.sql));
    assert.match(insert.sql, /ON CONFLICT \(from_id, to_id\) DO UPDATE/);
    assert.match(insert.sql, /relation_type\s*=\s*EXCLUDED\.relation_type/);
    assert.match(insert.sql, /weight\s*=\s*GREATEST\(\S*fragment_links\.weight, EXCLUDED\.weight\)/);
    assert.match(insert.sql, /RETURNING id/);
  });

  it("쌍마다 관계 종류를 바인딩한다", async () => {
    await new LinkStore().createLinks(pairs, "agent-a");

    const insert = captured.find(c => /INSERT INTO\s+\S*fragment_links/.test(c.sql));
    assert.deepEqual(insert.params, ["a", "b", "caused_by", "b", "c", "related"]);
  });
});
