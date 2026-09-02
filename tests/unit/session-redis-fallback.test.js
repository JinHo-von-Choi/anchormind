import { describe, it, mock, afterEach } from "node:test";
import assert from "node:assert/strict";

mock.module("../../lib/config.js", {
  exports: {
    SESSION_TTL_MS: 60_000,
    REDIS_ENABLED: true,
    REDIS_SESSION_FAIL_CLOSED: false,
    CACHE_SESSION_TTL: 60,
    SSE_HEARTBEAT_INTERVAL_MS: 60_000,
    SSE_MAX_HEARTBEAT_FAILURES: 3,
    IDLE_REFLECT_HOURS: 24,
    SUPPORTED_PROTOCOL_VERSIONS: ["2025-11-25"]
  }
});
mock.module("../../lib/redis.js", {
  exports: {
    saveSession: async () => false,
    getSession: async () => null,
    deleteSession: async () => true
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

const { createStreamableSessionWithId, streamableSessions } = await import("../../lib/sessions.js");

afterEach(() => streamableSessions.clear());

describe("Redis session availability fallback", () => {
  it("기본 정책에서는 Redis 저장 실패에도 in-memory 세션을 유지한다", async () => {
    await assert.doesNotReject(
      createStreamableSessionWithId(
        "session-fallback", true, "key-a", ["key-a"], ["read"], null, null, null, false
      )
    );
    assert.equal(streamableSessions.has("session-fallback"), true);
  });
});
