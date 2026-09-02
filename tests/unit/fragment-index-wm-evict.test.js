/**
 * FragmentIndex.evictWorkingMemoryItems 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-08-15
 *
 * WM 리스트 전체 삭제(clearWorkingMemory) 대신 지정 id 집합만 evict하는
 * 신규 API를 검증한다. 실 Redis EVAL 대신, 동일 계약(필터링 후 재기록,
 * evict 대상 없으면 무변경)을 구현한 stub eval로 리스트 조작을 검증한다.
 */

import { describe, it, beforeEach, mock } from "node:test";
import assert                             from "node:assert/strict";

function createRedisMock() {
  const _lists = new Map();

  const stub = {
    status: "ready",
    _lists,

    async rpush(key, value) {
      if (!_lists.has(key)) _lists.set(key, []);
      _lists.get(key).push(value);
      return _lists.get(key).length;
    },

    async lrange(key, start, stop) {
      const list = _lists.get(key) ?? [];
      const end  = stop < 0 ? list.length : stop + 1;
      return list.slice(start, end);
    },

    async expire() { return 1; },

    async del(key) {
      _lists.delete(key);
      return 1;
    },

    /** ioredis EVAL 커맨드 stub — Redis Lua 스크립트 호출을 흉내낼 뿐 JS eval()이 아니다.
     *  evictWorkingMemoryItems가 실행하는 Lua 스크립트와 동일한 필터링 계약만 재현한다. */
    async eval(_script, numKeys, key, ttl, ...ids) {
      const toEvict = new Set(ids);
      const items   = _lists.get(key) ?? [];
      const kept    = [];
      let evicted   = 0;

      for (const raw of items) {
        const parsed = JSON.parse(raw);
        if (toEvict.has(parsed.id)) evicted++;
        else kept.push(raw);
      }

      if (evicted > 0) {
        if (kept.length > 0) _lists.set(key, kept);
        else _lists.delete(key);
      }
      return evicted;
    },
  };

  return stub;
}

const redisRef = { current: createRedisMock() };
const redisProxy = new Proxy(redisRef, {
  get(ref, prop) {
    const val = ref.current[prop];
    return typeof val === "function" ? val.bind(ref.current) : val;
  }
});

mock.module("../../lib/redis.js", { namedExports: { redisClient: redisProxy } });
mock.module("../../lib/logger.js", {
  namedExports: { logInfo: mock.fn(), logWarn: mock.fn(), logError: mock.fn() }
});
mock.module("../../lib/memory/write/FragmentFactory.js", {
  namedExports: { FragmentFactory: class { extractKeywords() { return []; } } }
});

const { FragmentIndex } = await import("../../lib/memory/FragmentIndex.js");

function newRedis() {
  const stub = createRedisMock();
  redisRef.current = stub;
  return stub;
}

async function seedWm(idx, sessionId, items) {
  for (const item of items) {
    await idx.addToWorkingMemory(sessionId, {
      agent_id: "default", key_id: null, workspace: null, ...item
    });
  }
}

describe("FragmentIndex.evictWorkingMemoryItems", () => {

  beforeEach(() => { newRedis(); });

  it("scope metadata 누락은 캐시를 건너뛰고 호출자에게 예외를 전파하지 않는다", async () => {
    const idx = new FragmentIndex();
    await assert.doesNotReject(
      idx.addToWorkingMemory("session-missing-scope", {
        id: "wm-missing", content: "synthetic", type: "fact"
      })
    );
    assert.deepEqual(await idx.getWorkingMemory("session-missing-scope"), []);
  });

  it("agent/key/workspace metadata를 Working Memory에서 그대로 round-trip한다", async () => {
    const idx = new FragmentIndex();
    await idx.addToWorkingMemory("session-scope", {
      id: "wm-scope", content: "synthetic", type: "fact",
      agent_id: "default", key_id: "key-a", workspace: "workspace-a"
    });
    const [item] = await idx.getWorkingMemory("session-scope");
    assert.equal(item.agent_id, "default");
    assert.equal(item.key_id, "key-a");
    assert.equal(item.workspace, "workspace-a");
  });

  it("지정된 id만 evict하고 나머지는 보존한다", async () => {
    const idx = new FragmentIndex();
    await seedWm(idx, "sess-1", [
      { id: "wm-1", content: "항목1", type: "fact" },
      { id: "wm-2", content: "항목2", type: "fact" },
      { id: "wm-3", content: "항목3", type: "fact" },
    ]);

    const evicted = await idx.evictWorkingMemoryItems("sess-1", ["wm-1", "wm-2"]);
    assert.equal(evicted, 2);

    const remaining = await idx.getWorkingMemory("sess-1");
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, "wm-3");
  });

  it("evict 중 새로 유입된 항목과 무관한 id는 그대로 남는다", async () => {
    const idx = new FragmentIndex();
    await seedWm(idx, "sess-2", [
      { id: "wm-old-1", content: "구항목", type: "fact" },
    ]);

    /** reflect 실행 중 신규 유입 시뮬레이션 */
    await seedWm(idx, "sess-2", [
      { id: "wm-new-1", content: "신규 유입 항목", type: "fact" },
    ]);

    await idx.evictWorkingMemoryItems("sess-2", ["wm-old-1"]);

    const remaining = await idx.getWorkingMemory("sess-2");
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, "wm-new-1");
  });

  it("evict 대상 id가 하나도 없으면 리스트가 그대로 유지된다", async () => {
    const idx = new FragmentIndex();
    await seedWm(idx, "sess-3", [
      { id: "wm-a", content: "항목A", type: "fact" },
    ]);

    const evicted = await idx.evictWorkingMemoryItems("sess-3", ["no-such-id"]);
    assert.equal(evicted, 0);

    const remaining = await idx.getWorkingMemory("sess-3");
    assert.equal(remaining.length, 1);
  });

  it("ids 배열이 비어있으면 evict 스크립트를 호출하지 않는다", async () => {
    const idx = new FragmentIndex();
    await seedWm(idx, "sess-4", [
      { id: "wm-x", content: "항목X", type: "fact" },
    ]);

    const evicted = await idx.evictWorkingMemoryItems("sess-4", []);
    assert.equal(evicted, 0);

    const remaining = await idx.getWorkingMemory("sess-4");
    assert.equal(remaining.length, 1, "빈 ids 호출은 기존 리스트를 건드리지 않아야 한다");
  });

  it("sessionId가 없으면 0을 반환하고 아무 것도 하지 않는다", async () => {
    const idx = new FragmentIndex();
    const evicted = await idx.evictWorkingMemoryItems(null, ["wm-1"]);
    assert.equal(evicted, 0);
  });
});
