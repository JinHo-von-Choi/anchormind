/**
 * id 순 묶음 갱신 도우미 단위 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */
import { describe, it, mock, beforeEach } from "node:test";
import assert                              from "node:assert/strict";

const calls   = [];
let   replies = [];
mock.module("../../lib/tools/db.js", {
  exports: {
    queryWithAgentVector: async (agent, sql, params, opts) => {
      calls.push({ agent, sql, params, lock: opts?.lock });
      return replies.shift() ?? { rows: [], rowCount: 0, lockedIds: [] };
    }
  }
});

const { updateInIdOrder, updateOneBatch, readBatchClock, scoreUpdateBatchSize, paramGuard, selectBatchIds, BatchParamError } = await import("../../lib/memory/consolidate/idOrderedUpdate.js");

/** 잠금 문장이 ids 를 잠그고 갱신 문장이 n 행을 갱신한 결과 */
const locked = (n, ids) => ({ rows: [], rowCount: n, lockedIds: ids });

beforeEach(() => { calls.length = 0; replies = []; delete process.env.MEMENTO_SCORE_UPDATE_BATCH; });

describe("updateInIdOrder", () => {
  it("기준 시각을 한 번 읽고, 마지막 id를 이어받아 빈 묶음까지 반복한다", async () => {
    const ts = new Date("2026-10-03T00:00:00Z");
    replies = [
      { rows: [{ ts }] },
      locked(2, ["frag-a", "frag-b"]),
      locked(1, ["frag-c"]),
      locked(0, [])
    ];
    const total = await updateInIdOrder({
      where: "ttl_tier != 'permanent'", set: "importance = 0.5", batchSize: 2
    });
    assert.equal(total, 3);
    assert.equal(calls.length, 4);
    assert.equal(calls[1].lock.operation, "score_batch");
    assert.match(calls[1].lock.sql, /ORDER BY id\s+LIMIT \$2\s+FOR NO KEY UPDATE$/);
    assert.deepEqual(calls[1].lock.params, ["", 2, ts]);
    assert.deepEqual(calls[2].lock.params, ["frag-b", 2, ts]);
    assert.deepEqual(calls[3].lock.params, ["frag-c", 2, ts]);
    assert.deepEqual(calls[1].params, [2, ts]);
    assert.ok(calls.every(c => c.agent === "system"));
  });

  it("추가 인자는 두 문장 모두 $4부터 붙는다", async () => {
    replies = [{ rows: [{ ts: new Date() }] }, locked(0, [])];
    await updateInIdOrder({ where: "importance > $4", set: "importance = 0.5", params: [0.1], batchSize: 10 });
    assert.equal(calls[1].lock.params[3], 0.1);
    assert.equal(calls[1].params[2], 0.1);
  });
});

describe("updateOneBatch", () => {
  it("afterId 를 $1 로 잠그고 갱신 행 수와 잠근 마지막 id 를 돌려준다", async () => {
    const ts = new Date("2026-10-03T00:00:00Z");
    replies  = [locked(2, ["frag-n", "frag-z"])];
    const batch = await updateOneBatch({ where: "importance > $4", set: "importance = 1", params: [0.1], batchSize: 5, afterId: "frag-m", clock: ts });
    assert.deepEqual(batch, { n: 2, lastId: "frag-z" });
    assert.deepEqual(calls[0].lock.params, ["frag-m", 5, ts, 0.1]);
    assert.match(calls[0].lock.sql, /WHERE \(importance > \$4\) AND id > \$1/);
    assert.ok(!/ AND id = \$/.test(calls[0].lock.sql));
  });

  it("갱신 문장은 잠근 행($1)만 갱신하고 쓰지 않는 자리표시자의 형만 정한다", async () => {
    replies = [locked(1, ["frag-a"])];
    await updateOneBatch({ where: "importance > $4", set: "importance = 1", params: [0.1], batchSize: 5, clock: new Date() });
    const { sql, params } = calls[0];
    assert.match(sql, /SET importance = 1\s+WHERE f\.id = ANY\(\$1::text\[\]\)/);
    assert.match(sql, / AND \$2::text IS NOT NULL AND \$3::text IS NOT NULL AND \$4::text IS NOT NULL$/);
    assert.doesNotMatch(sql, /FOR NO KEY UPDATE|locked/);
    assert.equal(params.length, 3);
  });

  it("onlyId 는 마지막 자리표시자로 붙어 한 행으로 한정한다", async () => {
    replies = [locked(0, [])];
    const batch = await updateOneBatch({ where: "importance > $4", set: "importance = 1", params: [0.1], batchSize: 5, clock: new Date(), onlyId: "frag-q" });
    assert.deepEqual(batch, { n: 0, lastId: null });
    assert.match(calls[0].lock.sql, /AND id = \$5\b/);
    assert.equal(calls[0].lock.params[3], 0.1);
    assert.equal(calls[0].lock.params[4], "frag-q");
    assert.equal(calls[0].lock.params[0], "");
    assert.equal(calls[0].params[3], "frag-q");
    assert.match(calls[0].sql, /\$5::text IS NOT NULL/);
  });

  it("where 가 $3 을 쓰지 않으면 잠금 문장에, set 이 쓰지 않으면 갱신 문장에 기준 시각의 형을 정하는 조건을 붙인다", async () => {
    replies = [locked(0, []), locked(0, [])];
    await updateOneBatch({ where: "importance < 1", set: "importance = 1", batchSize: 5, clock: new Date() });
    await updateOneBatch({ where: "importance < 1", set: "last_decay_at = $3", batchSize: 5, clock: new Date() });
    assert.match(calls[0].lock.sql, /AND id > \$1 AND \$3::text IS NOT NULL/);
    assert.match(calls[0].sql, /\$3::text IS NOT NULL/);
    assert.match(calls[1].lock.sql, /\$3::text IS NOT NULL/);
    assert.ok(!/\$3::text IS NOT NULL/.test(calls[1].sql));
  });

  it("readBatchClock 은 NOW() 한 번을 읽는다", async () => {
    const ts = new Date("2026-10-03T01:00:00Z");
    replies  = [{ rows: [{ ts }] }];
    assert.equal(await readBatchClock(), ts);
    assert.equal(calls.length, 1);
  });
});

describe("값 목록의 null", () => {
  it("updateOneBatch 는 null 인자를 BatchParamError 로 거부하고 질의하지 않는다", async () => {
    await assert.rejects(
      updateOneBatch({ where: "importance > $4", set: "importance = 1", params: [null], batchSize: 5, clock: new Date() }),
      (err) => err instanceof BatchParamError && err.position === 4
    );
    assert.equal(calls.length, 0);
  });

  it("updateOneBatch 는 기준 시각과 onlyId 의 null 도 거부한다", async () => {
    await assert.rejects(updateOneBatch({ where: "true", set: "importance = 1", batchSize: 5, clock: null }), BatchParamError);
    await assert.rejects(updateOneBatch({ where: "true", set: "importance = 1", batchSize: 1, clock: new Date(), onlyId: null }), BatchParamError);
    assert.equal(calls.length, 0);
  });

  it("selectBatchIds 는 null 인자를 BatchParamError 로 거부하고 질의하지 않는다", async () => {
    await assert.rejects(selectBatchIds({ where: "true", params: [undefined], batchSize: 5, clock: new Date() }), BatchParamError);
    assert.equal(calls.length, 0);
  });
});

describe("paramGuard", () => {
  it("범위 안에서 sql 이 참조하지 않는 자리표시자만 조건으로 붙인다", () => {
    assert.equal(paramGuard("a = $2 AND b = $12", 2, 4), " AND $3::text IS NOT NULL AND $4::text IS NOT NULL");
    assert.equal(paramGuard("a = $1", 2, 1), "");
  });
});

describe("scoreUpdateBatchSize", () => {
  it("미설정이면 200, 0은 0, 범위 밖은 잘린다", () => {
    assert.equal(scoreUpdateBatchSize(), 200);
    process.env.MEMENTO_SCORE_UPDATE_BATCH = "0";
    assert.equal(scoreUpdateBatchSize(), 0);
    process.env.MEMENTO_SCORE_UPDATE_BATCH = "999999";
    assert.equal(scoreUpdateBatchSize(), 10000);
    process.env.MEMENTO_SCORE_UPDATE_BATCH = "abc";
    assert.equal(scoreUpdateBatchSize(), 200);
    process.env.MEMENTO_SCORE_UPDATE_BATCH = "-5";
    assert.equal(scoreUpdateBatchSize(), 200);
  });
});
