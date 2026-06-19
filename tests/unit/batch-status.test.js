/**
 * batch-status.test.js
 * 작성자: 최진호 / 작성일: 2026-06-19
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { redisClient } from "../../lib/redis.js";

function makeFakeRedis() {
  const h = new Map();
  return {
    status: "ready",
    async hset(k, obj) { h.set(k, { ...(h.get(k) || {}), ...obj }); return 1; },
    async hgetall(k) { return h.get(k) || {}; },
    async expire() { return 1; },
    _h: h,
  };
}

describe("batch job status", () => {
  let fake;
  beforeEach(() => { fake = makeFakeRedis(); });
  afterEach(async () => { const mod = await import("../../lib/redis.js"); mod.__setRedisClientForTest(redisClient); });

  test("setBatchJobStatus 후 getBatchJobStatus로 조회된다", async () => {
    const mod = await import("../../lib/redis.js");
    mod.__setRedisClientForTest(fake);
    await mod.setBatchJobStatus("brw-1", { state: "queued", accepted: 3 });
    const s = await mod.getBatchJobStatus("brw-1");
    assert.equal(s.state, "queued");
    assert.equal(Number(s.accepted), 3);
  });

  test("미존재 jobId는 null", async () => {
    const mod = await import("../../lib/redis.js");
    mod.__setRedisClientForTest(fake);
    assert.equal(await mod.getBatchJobStatus("nope"), null);
  });

  test("tool_batchStatus는 상태를 그대로 반환", async () => {
    const redis = await import("../../lib/redis.js");
    redis.__setRedisClientForTest(makeFakeRedis());
    await redis.setBatchJobStatus("brw-x", { state: "completed", inserted: 5 });
    const { tool_batchStatus } = await import("../../lib/tools/memory.js");
    const r = await tool_batchStatus({ jobId: "brw-x" });
    assert.equal(r.success, true);
    assert.equal(r.status.state, "completed");
  });
});
