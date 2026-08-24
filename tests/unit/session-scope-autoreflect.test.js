import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  createStreamableSessionWithId,
  streamableSessions,
  closeStreamableSession,
  cleanupExpiredSessions,
  createLegacySseSession,
  closeLegacySseSession,
  currentSegmentId,
  legacySseSessions
} from "../../lib/sessions.js";

afterEach(() => {
  streamableSessions.clear();
  legacySseSessions.clear();
});

describe("session AutoReflect scope forwarding", () => {
  test("closeStreamableSession forwards the immutable workspace scope and skips partial scope", async () => {
    const calls = [];
    const autoReflectFn = async (...args) => { calls.push(args); };

    await createStreamableSessionWithId(
      "scope-close-a", true, "key-a", ["key-a"], [], "ws-a"
    );
    await createStreamableSessionWithId(
      "scope-close-missing", true, "key-a", ["key-a"], [], null
    );

    await closeStreamableSession("scope-close-a", { autoReflectFn });
    await closeStreamableSession("scope-close-missing", { autoReflectFn });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], [
      "scope-close-a#1",
      "default",
      { keyId: "key-a", groupKeyIds: ["key-a"], workspace: "ws-a" }
    ]);
  });

  test("idle cleanup forwards scope and performs no reflect/write for missing workspace", async () => {
    const calls = [];
    const autoReflectFn = async (...args) => { calls.push(args); };
    const stale = Date.now() - (26 * 60 * 60 * 1000);

    await createStreamableSessionWithId(
      "scope-idle-a", true, "key-a", ["key-a"], [], "ws-a"
    );
    await createStreamableSessionWithId(
      "scope-idle-missing", true, "key-a", ["key-a"], [], null
    );
    streamableSessions.get("scope-idle-a").lastAccessedAt = stale;
    streamableSessions.get("scope-idle-missing").lastAccessedAt = stale;

    await cleanupExpiredSessions({ autoReflectFn });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], [
      "scope-idle-a#1",
      "default",
      { keyId: "key-a", groupKeyIds: ["key-a"], workspace: "ws-a" }
    ]);
  });

  test("expired cleanup uses the same scope and does not invoke reflect for partial sessions", async () => {
    const calls = [];
    const autoReflectFn = async (...args) => { calls.push(args); };

    await createStreamableSessionWithId(
      "scope-expired-a", true, "key-a", ["key-a"], [], "ws-a"
    );
    await createStreamableSessionWithId(
      "scope-expired-missing", true, "key-a", ["key-a"], [], null
    );
    streamableSessions.get("scope-expired-a").expiresAt = Date.now() - 1;
    streamableSessions.get("scope-expired-missing").expiresAt = Date.now() - 1;

    await cleanupExpiredSessions({ autoReflectFn });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], [
      "scope-expired-a#1",
      "default",
      { keyId: "key-a", groupKeyIds: ["key-a"], workspace: "ws-a" }
    ]);
  });

  test("master streamable close, idle, and expiry preserve unrestricted AutoReflect", async () => {
    const calls = [];
    const autoReflectFn = async (...args) => { calls.push(args); };

    await createStreamableSessionWithId("master-close", true, null, null, null, null);
    await closeStreamableSession("master-close", { autoReflectFn });

    await createStreamableSessionWithId("master-idle", true, null, null, null, null);
    streamableSessions.get("master-idle").lastAccessedAt = Date.now() - (26 * 60 * 60 * 1000);
    await cleanupExpiredSessions({ autoReflectFn });

    await createStreamableSessionWithId("master-expired", true, null, null, null, null);
    streamableSessions.get("master-expired").expiresAt = Date.now() - 1;
    await cleanupExpiredSessions({ autoReflectFn });

    assert.deepEqual(calls, [["master-close#1"], ["master-idle#1"], ["master-expired#1"]]);
  });

  test("master segment rotation and legacy SSE close preserve unrestricted AutoReflect", async () => {
    const calls = [];
    const autoReflectFn = async (...args) => { calls.push(args); };

    await createStreamableSessionWithId("master-segment", true, null, null, null, null);
    const master = streamableSessions.get("master-segment");
    master.lastToolActivityAt = Date.now() - (60 * 60 * 1000);
    await currentSegmentId("master-segment", { autoReflectFn });

    const response = { endCalls: 0, end() { this.endCalls++; } };
    const legacyId = createLegacySseSession(response);
    await closeLegacySseSession(legacyId, { autoReflectFn });

    assert.deepEqual(calls, [["master-segment#1"], [legacyId]]);
    assert.equal(response.endCalls, 1);
  });
});
