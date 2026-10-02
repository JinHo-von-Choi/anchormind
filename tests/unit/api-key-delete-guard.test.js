/**
 * API 키 삭제 확인 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 저장 자료가 있는 키는 지우지 않고 409를 돌려준다. 자료가 없으면 지운다.
 */
import { describe, it, mock, beforeEach } from "node:test";
import assert                              from "node:assert/strict";

let sqls    = [];
let replies = [];
let released = 0;
const client = {
  query  : async (sql) => { sqls.push(sql.trim()); return replies.shift() ?? { rows: [], rowCount: 0 }; },
  release: () => { released++; }
};
const pool = {
  query  : async (sql) => { sqls.push(sql.trim()); return replies.shift() ?? { rows: [], rowCount: 0 }; },
  connect: async () => client
};
mock.module("../../lib/tools/db.js", { exports: { getPrimaryPool: () => pool } });
mock.module("../../lib/sessions.js", { exports: { closeSessionsByKeyId: async () => 0 } });

const { handleKeys } = await import("../../lib/admin/admin-keys.js");
const ADMIN_BASE     = "/v1/internal/model/nothing";

function fakeRes() {
  const chunks = [];
  return {
    statusCode: 0,
    setHeader() {},
    end(body) { if (body) chunks.push(body); },
    get body() { return chunks.join(""); }
  };
}
const del = async (id) => {
  const res = fakeRes();
  await handleKeys({ method: "DELETE" }, res, new URL(`http://localhost${ADMIN_BASE}/keys/${id}`));
  return res;
};

beforeEach(() => { sqls = []; replies = []; released = 0; delete process.env.MEMENTO_API_KEY_DELETE_GUARD; });

describe("DELETE /keys/:id", () => {
  it("파편이 있는 키는 409와 건수를 돌려주고 지우지 않는다", async () => {
    replies = [{}, { rows: [{ id: "k1" }] }, { rows: [{ fragments: 2, reconsolidations: 0 }] }, {}];
    const res = await del("k1");
    assert.equal(res.statusCode, 409);
    assert.deepEqual(JSON.parse(res.body), { error: "key_in_use", fragments: 2, reconsolidations: 0 });
    assert.ok(!sqls.some(s => /^DELETE FROM agent_memory\.api_keys/.test(s)), "DELETE가 실행되면 안 된다");
    assert.ok(sqls.includes("ROLLBACK"));
    assert.equal(released, 1);
  });

  it("재공고화 이력만 있어도 409", async () => {
    replies = [{}, { rows: [{ id: "k1" }] }, { rows: [{ fragments: 0, reconsolidations: 1 }] }, {}];
    const res = await del("k1");
    assert.equal(res.statusCode, 409);
  });

  it("자료가 없으면 키 행을 잠근 뒤 지우고 204", async () => {
    replies = [{}, { rows: [{ id: "k1" }] }, { rows: [{ fragments: 0, reconsolidations: 0 }] }, { rowCount: 1 }, {}];
    const res = await del("k1");
    assert.equal(res.statusCode, 204);
    assert.match(sqls[1], /FOR UPDATE/);
    assert.ok(sqls.some(s => /^DELETE FROM agent_memory\.api_keys WHERE id = \$1/.test(s)));
    assert.equal(sqls[sqls.length - 1], "COMMIT");
  });

  it("없는 키는 404", async () => {
    replies = [{}, { rows: [] }, {}];
    const res = await del("nope");
    assert.equal(res.statusCode, 404);
  });

  it("MEMENTO_API_KEY_DELETE_GUARD=false면 확인 없이 지운다", async () => {
    process.env.MEMENTO_API_KEY_DELETE_GUARD = "false";
    replies = [{ rowCount: 1 }];
    const res = await del("k1");
    assert.equal(res.statusCode, 204);
    assert.equal(sqls.length, 1);
    assert.match(sqls[0], /^DELETE FROM agent_memory\.api_keys/);
  });
});
