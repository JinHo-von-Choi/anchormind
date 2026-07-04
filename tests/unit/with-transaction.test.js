/**
 * withTransaction 헬퍼 계약 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-07-04
 */
import { test } from "node:test";
import assert   from "node:assert";
import { withTransaction } from "../../lib/tools/db.js";

function fakePool(queryLog) {
  const client = {
    query  : async (sql) => { queryLog.push(sql); },
    release: () => { queryLog.push("RELEASE"); }
  };
  return { connect: async () => client };
}

test("성공 경로: BEGIN → fn → COMMIT → release, 반환값 전달", async () => {
  const log = [];
  const out = await withTransaction(fakePool(log), async (c) => { await c.query("WORK"); return 42; });
  assert.strictEqual(out, 42);
  assert.deepStrictEqual(log, ["BEGIN", "WORK", "COMMIT", "RELEASE"]);
});

test("실패 경로: ROLLBACK 후 원 에러 재throw, release 보장", async () => {
  const log = [];
  await assert.rejects(
    () => withTransaction(fakePool(log), async () => { throw new Error("boom"); }),
    /boom/
  );
  assert.deepStrictEqual(log, ["BEGIN", "ROLLBACK", "RELEASE"]);
});

test("ROLLBACK 자체가 실패해도 원 에러가 유지된다", async () => {
  const client = {
    query: async (sql) => {
      if (sql === "ROLLBACK") throw new Error("rb-fail");
      if (sql === "WORK")     throw new Error("boom");
    },
    release: () => {}
  };
  await assert.rejects(
    () => withTransaction({ connect: async () => client }, async (c) => c.query("WORK")),
    /boom/
  );
});
