import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  createStreamableSessionWithId,
  rotateSession,
  streamableSessions,
  closeStreamableSession
} from "../../lib/sessions.js";
import { reanchorReusedSession } from "../../lib/handlers/mcp-handler.js";

afterEach(async () => {
  await Promise.all([...streamableSessions.keys()].map(id => closeStreamableSession(id)));
});

describe("session rotate identity boundary", () => {
  it("다른 API key와 master/non-master mismatch를 403으로 거부한다", async () => {
    await createStreamableSessionWithId(
      "session-a", true, "key-a", ["key-a"], ["read"], "workspace-a", null, null, false
    );
    await createStreamableSessionWithId(
      "session-master", true, null, null, null, null, null, null, true
    );
    await createStreamableSessionWithId(
      "session-oauth", true, null, null, null, null, null, null, false
    );
    for (const [sessionId, requesterIdentity] of [
      ["session-a", { keyId: "key-b", isMaster: false }],
      ["session-master", { keyId: null, isMaster: false }],
      ["session-a", { keyId: null, isMaster: true }],
      ["session-oauth", { keyId: null, isMaster: false }]
    ]) {
      await assert.rejects(
        rotateSession(sessionId, { requesterIdentity }),
        error => error.statusCode === 403
      );
      assert.equal(streamableSessions.has(sessionId), true);
    }
  });

  it("exact identity만 회전하고 fresh 권한과 기존 세션 컨텍스트를 함께 보존한다", async () => {
    await createStreamableSessionWithId(
      "session-a", true, "key-a", ["stale-group"], ["admin"],
      "session-workspace", "header-selected-mode", null, false
    );
    const rotated = await rotateSession("session-a", {
      requesterIdentity: {
        keyId: "key-a", isMaster: false, groupKeyIds: ["key-a", "key-group"],
        permissions: ["read"], defaultWorkspace: "key-default-workspace", mode: "key-default-mode"
      }
    });
    const fresh = streamableSessions.get(rotated.newSessionId);
    assert.equal(streamableSessions.has("session-a"), false);
    assert.equal(fresh.keyId, "key-a");
    assert.deepEqual(fresh.groupKeyIds, ["key-a", "key-group"]);
    assert.deepEqual(fresh.permissions, ["read"]);
    assert.equal(fresh.defaultWorkspace, "session-workspace");
    assert.equal(fresh.mode, "header-selected-mode");
    assert.equal(fresh.isMaster, false);
    assert.equal(rotated.workspace, "session-workspace");
    assert.equal(rotated.mode, "header-selected-mode");
  });

  it("master 회전은 기존 workspace와 mode를 보존한다", async () => {
    await createStreamableSessionWithId(
      "session-master-context", true, null, ["stale-master-group"], ["admin"],
      "workspace-master", "audit", null, true
    );
    const rotated = await rotateSession("session-master-context", {
      reason: "synthetic-rotation",
      requesterIdentity: {
        keyId: null, isMaster: true,
        groupKeyIds: ["fresh-master-group"], permissions: ["read"]
      }
    });
    const fresh = streamableSessions.get(rotated.newSessionId);
    assert.deepEqual(fresh.groupKeyIds, ["fresh-master-group"]);
    assert.deepEqual(fresh.permissions, ["read"]);
    assert.equal(fresh.defaultWorkspace, "workspace-master");
    assert.equal(fresh.mode, "audit");
    assert.equal(rotated.reason, "synthetic-rotation");
  });
});

describe("token initialize identity reanchor", () => {
  it("재사용 세션의 전체 auth context를 fresh 값으로 교체한 뒤 persist한다", async () => {
    const stale = {
      keyId: "key-a", groupKeyIds: ["stale-group"], permissions: ["admin"],
      defaultWorkspace: "stale-workspace", mode: "audit", isMaster: true
    };
    let persisted = null;
    await reanchorReusedSession(stale, {
      keyId: "key-a",
      groupKeyIds: ["key-a"],
      permissions: ["read"],
      defaultWorkspace: "workspace-a",
      mode: "recall-only",
      isMaster: false
    }, async session => {
      persisted = { ...session };
      return true;
    });
    assert.deepEqual(stale.groupKeyIds, ["key-a"]);
    assert.deepEqual(stale.permissions, ["read"]);
    assert.equal(stale.defaultWorkspace, "workspace-a");
    assert.equal(stale.mode, "recall-only");
    assert.equal(stale.isMaster, false);
    assert.deepEqual(persisted, stale);
  });

  it("Redis persist callback의 boolean false를 성공으로 취급하지 않는다", async () => {
    await assert.rejects(
      reanchorReusedSession({}, {
        keyId: "key-a", groupKeyIds: ["key-a"], permissions: ["read"], isMaster: false
      }, async () => false),
      /persistence failed/
    );
  });
});
