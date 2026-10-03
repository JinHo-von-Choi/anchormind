/**
 * 세션 활동 기록의 소유 키 시험(Redis 대역)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */
import { describe, it, mock } from "node:test";
import assert                 from "node:assert/strict";

const store = new Map();
mock.module("../../lib/redis.js", {
  namedExports: {
    redisClient: {
      status: "ready",
      get   : async (k) => store.get(k) ?? null,
      setex : async (k, _ttl, v) => { store.set(k, v); }
    }
  }
});

const { SessionActivityTracker } = await import("../../lib/memory/processors/SessionActivityTracker.js");

describe("SessionActivityTracker 소유 키", () => {
  it("keyId와 workspace를 주면 기록에 남기고, 주지 않은 기록은 값을 지우지 않는다", async () => {
    await SessionActivityTracker.record("s1", { tool: "remember", keyId: "k1", workspace: "team" });
    await SessionActivityTracker.record("s1", { action: "reflected" });
    const log = await SessionActivityTracker.getActivity("s1");
    assert.equal(log.keyId, "k1");
    assert.equal(log.workspace, "team");
  });

  it("master 세션은 keyId null로 남긴다", async () => {
    await SessionActivityTracker.record("s2", { tool: "recall", keyId: null, workspace: null });
    const log = await SessionActivityTracker.getActivity("s2");
    assert.equal(Object.hasOwn(log, "keyId"), true);
    assert.equal(log.keyId, null);
  });
});
