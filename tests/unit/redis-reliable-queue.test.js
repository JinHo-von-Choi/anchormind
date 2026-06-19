/**
 * redis-reliable-queue.test.js
 * 작성자: 최진호 / 작성일: 2026-06-19
 * RPOPLPUSH 기반 신뢰성 큐 헬퍼 검증 (in-memory fake redis).
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { redisClient } from "../../lib/redis.js";

/** 최소 in-memory redis (list 명령만). index 0 = head */
function makeFakeRedis() {
  const store = new Map();
  return {
    status: "ready",
    async lpush(k, v) { const a = store.get(k) || []; a.unshift(v); store.set(k, a); return a.length; },
    async rpush(k, v) { const a = store.get(k) || []; a.push(v); store.set(k, a); return a.length; },
    async rpop(k)     { const a = store.get(k) || []; const v = a.pop(); store.set(k, a); return v ?? null; },
    async rpoplpush(src, dst) {
      const s = store.get(src) || []; const v = s.pop(); store.set(src, s);
      if (v === undefined) return null;
      const d = store.get(dst) || []; d.unshift(v); store.set(dst, d); return v;
    },
    async lrem(k, count, v) { const a = store.get(k) || []; const i = a.indexOf(v); if (i >= 0) a.splice(i, 1); store.set(k, a); return i >= 0 ? 1 : 0; },
    async llen(k) { return (store.get(k) || []).length; },
    _store: store,
  };
}

describe("reliable queue", () => {
  let fake;
  beforeEach(() => { fake = makeFakeRedis(); });
  afterEach(async () => { const mod = await import("../../lib/redis.js"); mod.__setRedisClientForTest(redisClient); });

  test("popFromQueueReliable는 메인→processing 원자 이동 후 data/raw 반환, ack로 정리", async () => {
    const mod = await import("../../lib/redis.js");
    mod.__setRedisClientForTest(fake);
    // pushToQueue 대신 fake에 직접 시딩 (생산 코드 변경 최소화)
    await fake.lpush("queue:q1", JSON.stringify({ jobId: "j1", retryCount: 0, queuedAt: 0 }));
    const popped = await mod.popFromQueueReliable("q1");
    assert.equal(popped.data.jobId, "j1");
    assert.equal(await fake.llen("queue:q1"), 0);
    assert.equal(await fake.llen("queue:q1:processing"), 1);
    await mod.ackQueueItem("q1", popped.raw);
    assert.equal(await fake.llen("queue:q1:processing"), 0);
  });

  test("빈 큐는 null 반환", async () => {
    const mod = await import("../../lib/redis.js");
    mod.__setRedisClientForTest(fake);
    assert.equal(await mod.popFromQueueReliable("empty"), null);
  });

  test("requeueProcessing은 잔존 processing 항목을 메인 큐로 되돌린다", async () => {
    const mod = await import("../../lib/redis.js");
    mod.__setRedisClientForTest(fake);
    await fake.lpush("queue:q1:processing", JSON.stringify({ jobId: "stale" }));
    const moved = await mod.requeueProcessing("q1");
    assert.equal(moved, 1);
    assert.equal(await fake.llen("queue:q1"), 1);
    assert.equal(await fake.llen("queue:q1:processing"), 0);
  });
});
