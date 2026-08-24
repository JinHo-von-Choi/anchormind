import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  createStreamableSessionWithId,
  streamableSessions,
  closeStreamableSession,
  cleanupExpiredSessions
} from "../../lib/sessions.js";

afterEach(() => {
  streamableSessions.clear();
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
});
