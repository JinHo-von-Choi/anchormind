import { describe, it, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

const redisState = { saveResult: true, deletes: [] };

mock.module("../../lib/config.js", {
  exports: {
    SESSION_TTL_MS: 60_000,
    REDIS_ENABLED: true,
    REDIS_SESSION_FAIL_CLOSED: true,
    CACHE_SESSION_TTL: 60,
    SSE_HEARTBEAT_INTERVAL_MS: 60_000,
    SSE_MAX_HEARTBEAT_FAILURES: 3,
    IDLE_REFLECT_HOURS: 24,
    SUPPORTED_PROTOCOL_VERSIONS: ["2025-11-25"]
  }
});
mock.module("../../lib/redis.js", {
  exports: {
    saveSession: async () => redisState.saveResult,
    getSession: async () => null,
    deleteSession: async id => {
      redisState.deletes.push(id);
      return id !== "session-old";
    }
  }
});
mock.module("../../lib/memory/processors/AutoReflect.js", {
  exports: { autoReflect: async () => null }
});
mock.module("../../lib/logger.js", {
  exports: { logInfo: () => {}, logWarn: () => {} }
});
mock.module("../../lib/metrics.js", {
  exports: {
    recordSessionIdleReflect: () => {},
    recordProtocolVersionReanchored: () => {}
  }
});

const {
  createStreamableSessionWithId,
  rotateSession,
  streamableSessions
} = await import("../../lib/sessions.js");

beforeEach(() => {
  redisState.saveResult = true;
  redisState.deletes = [];
  streamableSessions.clear();
});
afterEach(() => { streamableSessions.clear(); });

describe("Redis session boolean fail-closed", () => {
  it("create save=false면 local session을 제거하고 실패한다", async () => {
    redisState.saveResult = false;
    await assert.rejects(
      createStreamableSessionWithId(
        "session-failed", true, "key-a", ["key-a"], ["read"], null, null, null, false
      ),
      error => error.statusCode === 503 && /persistence failed/.test(error.message)
    );
    assert.equal(streamableSessions.has("session-failed"), false);
  });

  it("rotate old delete=false면 new session을 정리하고 old session을 유지한다", async () => {
    await createStreamableSessionWithId(
      "session-old", true, "key-a", ["key-a"], ["read"], null, null, null, false
    );
    await assert.rejects(
      rotateSession("session-old", {
        requesterIdentity: {
          keyId: "key-a", isMaster: false, groupKeyIds: ["key-a"], permissions: ["read"]
        }
      }),
      error => error.statusCode === 503
    );
    assert.equal(streamableSessions.has("session-old"), true);
    assert.deepEqual([...streamableSessions.keys()], ["session-old"]);
    assert.equal(redisState.deletes[0], "session-old");
    assert.equal(redisState.deletes.length, 2);
    assert.notEqual(redisState.deletes[1], "session-old");
  });

  it("rotate의 new session 저장 실패도 503으로 반환하고 old session을 유지한다", async () => {
    await createStreamableSessionWithId(
      "session-old", true, "key-a", ["key-a"], ["read"], null, null, null, false
    );
    redisState.saveResult = false;
    await assert.rejects(
      rotateSession("session-old", {
        requesterIdentity: {
          keyId: "key-a", isMaster: false, groupKeyIds: ["key-a"], permissions: ["read"]
        }
      }),
      error => error.statusCode === 503
    );
    assert.equal(streamableSessions.has("session-old"), true);
    assert.deepEqual([...streamableSessions.keys()], ["session-old"]);
  });
});
