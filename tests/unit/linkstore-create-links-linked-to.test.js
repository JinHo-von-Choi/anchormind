/**
 * LinkStore.createLinks 연결 배열 갱신 검사
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 쌍마다 상대 id만 연결 배열에 더해지는지, 대상 행이 id 순으로 먼저 잠기는지,
 * 갱신 실패가 경고 로그로 남고 호출자에게 전파되지 않는지 DB 없이 확인한다.
 */

import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

let   updates  = [];
let   failNext = false;
const warnings = [];

const fakeClient = {
  query: async () => ({ rows: [{ id: 11 }, { id: 12 }] })
};

mock.module("../../lib/tools/db.js", {
  namedExports: {
    getPrimaryPool      : () => ({}),
    withTransaction     : async (_pool, fn) => fn(fakeClient),
    queryWithAgentVector: async (agentId, sql, params, mode) => {
      updates.push({ agentId, sql, params, mode });
      if (failNext) throw new Error("lock timeout");
      return { rows: [], rowCount: 0 };
    }
  }
});

mock.module("../../lib/logger.js", {
  namedExports: {
    logWarn : (msg) => warnings.push(msg),
    logInfo : () => {},
    logError: () => {},
    logDebug: () => {}
  }
});

const { LinkStore } = await import("../../lib/memory/link/LinkStore.js");

beforeEach(() => {
  updates  = [];
  failNext = false;
  warnings.length = 0;
});

describe("LinkStore.createLinks 연결 배열 갱신", () => {
  const pairs = [
    { fromId: "a", toId: "b", relationType: "related" },
    { fromId: "c", toId: "d", relationType: "related" }
  ];

  it("쌍 단위 unnest로 자기 쌍의 상대 id만 더한다", async () => {
    await new LinkStore().createLinks(pairs, "agent-a");

    assert.equal(updates.length, 1);
    const { sql, params, mode } = updates[0];
    assert.match(sql, /unnest\(\$1::text\[\],\s*\$2::text\[\]\)\s+AS\s+p\(src,\s*dst\)/);
    assert.match(sql, /WHERE\s+p\.src\s*=\s*f\.id/);
    assert.doesNotMatch(sql, /unnest\(\$2::text\[\]\)/);
    assert.equal(mode, "write");
    assert.deepEqual(params, [
      ["a", "c", "b", "d"],
      ["b", "d", "a", "c"]
    ]);
  });

  it("정방향과 역방향 쌍이 같은 위치에서 대응한다", async () => {
    await new LinkStore().createLinks(pairs, "agent-a");

    const [src, dst] = updates[0].params;
    const directed   = src.map((s, i) => `${s}>${dst[i]}`).sort();
    assert.deepEqual(directed, ["a>b", "b>a", "c>d", "d>c"]);
  });

  it("대상 행을 id 순으로 먼저 잠근 뒤 갱신한다", async () => {
    await new LinkStore().createLinks(pairs, "agent-a");

    const { sql } = updates[0];
    assert.match(sql, /WITH locked AS \(\s*SELECT id FROM \S*fragments\s+WHERE id = ANY\(\$1::text\[\]\)\s+ORDER BY id\s+FOR NO KEY UPDATE\s*\)/);
    assert.match(sql, /UPDATE \S*fragments f/);
    assert.match(sql, /FROM locked\s+WHERE f\.id = locked\.id/);
    assert.match(sql, /array_agg\(DISTINCT elem\)/);
  });

  it("갱신 실패는 경고 로그로 남기고 삽입 결과를 그대로 반환한다", async () => {
    failNext = true;

    const ids = await new LinkStore().createLinks(pairs, "agent-a");

    assert.deepEqual(ids, [11, 12]);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0], "[LinkStore] createLinks linked_to update failed: lock timeout");
  });

  it("쌍이 없으면 아무 질의도 발행하지 않는다", async () => {
    const ids = await new LinkStore().createLinks([], "agent-a");

    assert.deepEqual(ids, []);
    assert.equal(updates.length, 0);
  });
});
