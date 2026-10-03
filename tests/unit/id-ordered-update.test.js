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
    queryWithAgentVector: async (agent, sql, params) => {
      calls.push({ agent, sql, params });
      return replies.shift() ?? { rows: [{ n: 0, last_id: null }] };
    }
  }
});

const { updateInIdOrder, updateOneBatch, readBatchClock, scoreUpdateBatchSize } = await import("../../lib/memory/consolidate/idOrderedUpdate.js");

beforeEach(() => { calls.length = 0; replies = []; delete process.env.MEMENTO_SCORE_UPDATE_BATCH; });

describe("updateInIdOrder", () => {
  it("기준 시각을 한 번 읽고, 마지막 id를 이어받아 빈 묶음까지 반복한다", async () => {
    const ts = new Date("2026-10-03T00:00:00Z");
    replies = [
      { rows: [{ ts }] },
      { rows: [{ n: 2, last_id: "frag-b" }] },
      { rows: [{ n: 1, last_id: "frag-c" }] },
      { rows: [{ n: 0, last_id: null }] }
    ];
    const total = await updateInIdOrder({
      where: "ttl_tier != 'permanent'", set: "importance = 0.5", batchSize: 2
    });
    assert.equal(total, 3);
    assert.equal(calls.length, 4);
    assert.match(calls[1].sql, /ORDER BY id\s+LIMIT \$2\s+FOR NO KEY UPDATE/);
    assert.deepEqual(calls[1].params, ["", 2, ts]);
    assert.deepEqual(calls[2].params, ["frag-b", 2, ts]);
    assert.deepEqual(calls[3].params, ["frag-c", 2, ts]);
    assert.ok(calls.every(c => c.agent === "system"));
  });

  it("추가 인자는 $4부터 붙는다", async () => {
    replies = [{ rows: [{ ts: new Date() }] }, { rows: [{ n: 0, last_id: null }] }];
    await updateInIdOrder({ where: "importance > $4", set: "importance = 0.5", params: [0.1], batchSize: 10 });
    assert.equal(calls[1].params[3], 0.1);
  });
});

describe("updateOneBatch", () => {
  it("afterId 를 $1 로 쓰고 갱신 행 수와 잠근 마지막 id 를 돌려준다", async () => {
    const ts = new Date("2026-10-03T00:00:00Z");
    replies  = [{ rows: [{ n: 2, last_id: "frag-z" }] }];
    const batch = await updateOneBatch({ where: "importance > $4", set: "importance = 1", params: [0.1], batchSize: 5, afterId: "frag-m", clock: ts });
    assert.deepEqual(batch, { n: 2, lastId: "frag-z" });
    assert.deepEqual(calls[0].params, ["frag-m", 5, ts, 0.1]);
    assert.ok(!/ AND id = \$/.test(calls[0].sql));
  });

  it("onlyId 는 마지막 자리표시자로 붙어 한 행으로 한정한다", async () => {
    replies = [{ rows: [{ n: 0, last_id: null }] }];
    const batch = await updateOneBatch({ where: "importance > $4", set: "importance = 1", params: [0.1], batchSize: 5, clock: new Date(), onlyId: "frag-q" });
    assert.deepEqual(batch, { n: 0, lastId: null });
    assert.match(calls[0].sql, /AND id = \$5\b/);
    assert.equal(calls[0].params[3], 0.1);
    assert.equal(calls[0].params[4], "frag-q");
    assert.equal(calls[0].params[0], "");
  });

  it("where 와 set 이 $3 을 쓰지 않으면 기준 시각의 형을 정하는 조건을 덧붙인다", async () => {
    replies = [{ rows: [{ n: 0, last_id: null }] }, { rows: [{ n: 0, last_id: null }] }];
    await updateOneBatch({ where: "importance < 1", set: "importance = 1", batchSize: 5, clock: new Date() });
    await updateOneBatch({ where: "importance < 1", set: "last_decay_at = $3", batchSize: 5, clock: new Date() });
    assert.match(calls[0].sql, /AND id > \$1 AND \$3::timestamptz IS NOT NULL/);
    assert.ok(!/\$3::timestamptz IS NOT NULL/.test(calls[1].sql));
  });

  it("readBatchClock 은 NOW() 한 번을 읽는다", async () => {
    const ts = new Date("2026-10-03T01:00:00Z");
    replies  = [{ rows: [{ ts }] }];
    assert.equal(await readBatchClock(), ts);
    assert.equal(calls.length, 1);
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
