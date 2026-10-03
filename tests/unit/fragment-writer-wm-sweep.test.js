/**
 * FragmentWriter.deleteExpired의 작업 기억 행 정리 격리 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 작업 기억 행 정리가 실패해도 일반 파편 정리가 그대로 실행되는지, 정리가 일반 파편 삭제 수만
 * 돌려주는지 확인한다.
 */

import { describe, it, mock, beforeEach, after } from "node:test";
import assert                                     from "node:assert/strict";

import { createFakeWmDb } from "./_wm-fake-db.js";

const dbRef = { fake: createFakeWmDb() };
const gcSql = [];

const realDb = await import("../../lib/tools/db.js");
mock.module("../../lib/tools/db.js", {
  namedExports: {
    ...realDb,
    queryWithAgentVector: async (agent, sql, params, opts) => {
      if (/gc_candidates/.test(sql)) {
        gcSql.push(sql);
        return { rows: [], rowCount: 7 };
      }
      return dbRef.fake.queryWithAgentVector(agent, sql, params, opts);
    },
    withTransaction: (...args) => dbRef.fake.withTransaction(...args),
    getPrimaryPool : (...args) => dbRef.fake.getPrimaryPool(...args)
  }
});

const { FragmentWriter }        = await import("../../lib/memory/write/FragmentWriter.js");
const { teardownTestResources } = await import("../_lifecycle.js");

after(async () => { await teardownTestResources(); });

beforeEach(() => { dbRef.fake = createFakeWmDb(); gcSql.length = 0; });

describe("deleteExpired와 작업 기억 행 정리", () => {
  it("작업 기억 행 정리가 실패해도 일반 파편 정리를 실행하고 그 삭제 수를 돌려준다", async () => {
    dbRef.fake.state.failTransactions = new Error("lock timeout");
    const deleted = await new FragmentWriter().deleteExpired();
    assert.equal(gcSql.length, 1, "일반 파편 정리가 건너뛰어졌다");
    assert.equal(deleted, 7);
  });

  it("정상이면 만료한 작업 기억 행을 지우되 반환값은 일반 파편 삭제 수다", async () => {
    dbRef.fake.rows.push({
      id: "wm-old", session_id: "s", source: "wm-fallback", valid_to: new Date(0),
      created_at: new Date(Date.now() - 48 * 3600 * 1000), key_id: null
    });
    const deleted = await new FragmentWriter().deleteExpired();
    assert.equal(dbRef.fake.rows.length, 0);
    assert.equal(deleted, 7);
  });
});
