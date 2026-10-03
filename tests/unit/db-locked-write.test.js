/**
 * 잠금 문장을 앞세운 갱신 트랜잭션 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * queryWithAgentVector 에 lock 을 주면 한 트랜잭션 안에서 잠금 문장을 먼저 실행하고,
 * 잠근 id 배열을 $1 로 붙여 갱신 문장을 실행한다. 잠근 행이 없으면 갱신 문장을 보내지 않고,
 * 교착으로 끝난 트랜잭션은 처음부터 다시 실행한다. pg 를 대역으로 바꿔 발행 순서만 본다.
 */

import { describe, it, mock, beforeEach } from "node:test";
import assert                             from "node:assert/strict";

/** 연결마다 실행한 문장 목록 */
let sessions = [];
/** 문장 텍스트를 받아 결과나 오류를 돌려주는 응답기 */
let respond  = () => ({ rows: [], rowCount: 0 });

class FakeClient {
  constructor() {
    this.log = [];
    sessions.push(this.log);
  }
  async query(sql, params) {
    this.log.push({ sql, params });
    const out = respond(sql, params, this.log);
    if (out instanceof Error) throw out;
    return out;
  }
  release() {}
}

class FakePool {
  constructor() {
    this.totalCount   = 0;
    this.idleCount    = 0;
    this.waitingCount = 0;
  }
  on() {}
  async connect() { return new FakeClient(); }
  async end() {}
}

mock.module("pg", { defaultExport: { Pool: FakePool } });

const { queryWithAgentVector } = await import("../../lib/tools/db.js");

const LOCK_SQL  = "SELECT id FROM agent_memory.fragments WHERE id = ANY($1) ORDER BY id FOR NO KEY UPDATE";
const WRITE_SQL = "UPDATE agent_memory.fragments f SET accessed_at = NOW() WHERE f.id = ANY($1::text[])";

/** 세션의 실행 문장 중 설정 문장을 뺀 본문 */
function body(log) {
  return log.filter(e => !/^(SET |BEGIN|COMMIT|ROLLBACK)/.test(e.sql.trim()));
}

function deadlock() {
  const err = new Error("deadlock detected");
  err.code  = "40P01";
  return err;
}

beforeEach(() => {
  sessions = [];
  respond  = (sql) => sql === LOCK_SQL
    ? { rows: [{ id: "a" }, { id: "b" }], rowCount: 2 }
    : { rows: [], rowCount: 2 };
});

describe("queryWithAgentVector lock 옵션", () => {
  it("한 트랜잭션에서 잠금 문장 뒤에 갱신 문장을 잠근 id와 함께 실행한다", async () => {
    const result = await queryWithAgentVector("system", WRITE_SQL, [0.3],
      { lock: { operation: "access", sql: LOCK_SQL, params: [["b", "a"]] } });

    assert.equal(sessions.length, 1);
    const log = sessions[0];
    assert.equal(log.findIndex(e => e.sql === "BEGIN") < log.findIndex(e => e.sql === LOCK_SQL), true);
    assert.deepEqual(body(log).map(e => e.sql), [LOCK_SQL, WRITE_SQL]);
    assert.deepEqual(body(log)[0].params, [["b", "a"]]);
    assert.deepEqual(body(log)[1].params, [["a", "b"], 0.3]);
    assert.equal(log.at(-1).sql, "COMMIT");
    assert.equal(result.rowCount, 2);
    assert.deepEqual(result.lockedIds, ["a", "b"]);
  });

  it("잠근 행이 없으면 갱신 문장을 보내지 않고 빈 결과를 돌려준다", async () => {
    respond = () => ({ rows: [], rowCount: 0 });
    const result = await queryWithAgentVector("system", WRITE_SQL, [],
      { lock: { operation: "access", sql: LOCK_SQL, params: [["x"]] } });

    assert.deepEqual(body(sessions[0]).map(e => e.sql), [LOCK_SQL]);
    assert.equal(sessions[0].at(-1).sql, "COMMIT");
    assert.deepEqual(result, { rows: [], rowCount: 0, lockedIds: [] });
  });

  it("교착이면 되돌린 뒤 새 트랜잭션에서 잠금부터 다시 실행한다", async () => {
    let writes = 0;
    respond = (sql) => {
      if (sql === LOCK_SQL) return { rows: [{ id: "a" }], rowCount: 1 };
      if (sql === WRITE_SQL) return ++writes === 1 ? deadlock() : { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    };
    const result = await queryWithAgentVector("system", WRITE_SQL, [],
      { lock: { operation: "access", sql: LOCK_SQL, params: [["a"]] } });

    assert.equal(sessions.length, 2);
    assert.equal(sessions[0].at(-1).sql, "ROLLBACK");
    assert.deepEqual(body(sessions[1]).map(e => e.sql), [LOCK_SQL, WRITE_SQL]);
    assert.equal(sessions[1].at(-1).sql, "COMMIT");
    assert.equal(result.rowCount, 1);
  });

  it("lock 이 없으면 문장 하나만 실행하고 교착을 다시 시도하지 않는다", async () => {
    respond = (sql) => sql === WRITE_SQL ? deadlock() : { rows: [], rowCount: 0 };
    await assert.rejects(queryWithAgentVector("system", WRITE_SQL, ["a"], "write"), err => err.code === "40P01");
    assert.equal(sessions.length, 1);
    assert.deepEqual(body(sessions[0]).map(e => e.sql), [WRITE_SQL]);
    assert.deepEqual(body(sessions[0])[0].params, ["a"]);
  });
});
