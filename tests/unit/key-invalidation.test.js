/**
 * 키 캐시 무효화 알림 시험.
 * 다른 프로세스가 보낸 알림은 이 프로세스의 키 상태 캐시를 지우고, 자기가 보낸 알림은 무시하는지 본다.
 *
 * 작성자: 최진호
 * 작성일: 2026-11-04
 */
import { describe, it, beforeEach, mock } from "node:test";
import assert                             from "node:assert/strict";

process.env.DOTENV_CONFIG_PATH      ??= ".env.test";
process.env.MEMENTO_METRICS_DEFAULT ??= "off";
process.env.REDIS_ENABLED           ??= "false";
process.env.CACHE_ENABLED           ??= "false";
process.env.MEMENTO_SESSION_KEY_RECHECK_MS = "60000";

const KEY_ID = "7a1e0000-0000-4000-8000-0000000000bb";
let lookups  = 0;

const realKeys = await import("../../lib/admin/ApiKeyStore.js");
mock.module("../../lib/admin/ApiKeyStore.js", {
  namedExports: { ...realKeys, getKeyAuthState: async () => { lookups += 1; return { exists: true, status: "active" }; } }
});

const { getCachedKeyState }                                     = await import("../../lib/keys/key-state-cache.js");
const { handleKeyInvalidationMessage, broadcastKeyInvalidation, KEY_INVALIDATION_CHANNEL } = await import("../../lib/keys/invalidation.js");

describe("키 캐시 무효화 알림", () => {
  beforeEach(async () => {
    lookups = 0;
    handleKeyInvalidationMessage(JSON.stringify({ from: "reset", keyIds: [KEY_ID] }));
    await getCachedKeyState(KEY_ID);
  });

  it("다른 프로세스의 알림을 받으면 다음 조회가 DB를 다시 읽는다", async () => {
    await getCachedKeyState(KEY_ID);
    assert.equal(lookups, 1);
    assert.equal(handleKeyInvalidationMessage(JSON.stringify({ from: "other-process", keyIds: [KEY_ID, KEY_ID] })), 1);
    await getCachedKeyState(KEY_ID);
    assert.equal(lookups, 2);
  });

  it("해석할 수 없거나 키 목록이 없는 알림은 캐시를 건드리지 않는다", async () => {
    assert.equal(handleKeyInvalidationMessage("not json"), 0);
    assert.equal(handleKeyInvalidationMessage(JSON.stringify({ from: "other-process" })), 0);
    await getCachedKeyState(KEY_ID);
    assert.equal(lookups, 1);
  });

  it("자기가 보낸 알림은 무시하고, Redis가 꺼져 있으면 보내지 않는다", async () => {
    const sent   = [];
    const client = { status: "ready", publish: async (channel, message) => { sent.push({ channel, message }); } };
    assert.equal(await broadcastKeyInvalidation([KEY_ID], { client, enabled: false }), false);
    assert.equal(await broadcastKeyInvalidation([KEY_ID, "", null], { client, enabled: true }), true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].channel, KEY_INVALIDATION_CHANNEL);
    assert.deepEqual(JSON.parse(sent[0].message).keyIds, [KEY_ID]);
    assert.equal(handleKeyInvalidationMessage(sent[0].message), 0);
    await getCachedKeyState(KEY_ID);
    assert.equal(lookups, 1);
  });
});
