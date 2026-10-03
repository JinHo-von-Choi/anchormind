/**
 * FragmentIndex 작업 기억 저장소 선택 단위 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * Redis 상태(준비, 미준비)와 MEMENTO_WM_PG_FALLBACK 조합마다 저장소 선택, addToWorkingMemory
 * 반환값, 조회, 항목 제거, 세션 삭제가 어느 저장소에 닿는지 확인한다. 컨텍스트 조합이 두
 * 저장소에서 같은 항목 모양을 받는지도 본다.
 */

import { describe, it, mock, beforeEach, afterEach } from "node:test";
import assert                                         from "node:assert/strict";

import { createFakeWmDb } from "./_wm-fake-db.js";

const dbRef    = { fake: createFakeWmDb() };
const infoLogs = [];

function createRedisMock() {
  const lists = new Map();
  return {
    status: "ready",
    lists,
    async rpush(key, value) {
      if (!lists.has(key)) lists.set(key, []);
      lists.get(key).push(value);
      return lists.get(key).length;
    },
    async lrange(key, start, stop) {
      const list = lists.get(key) ?? [];
      return list.slice(start, stop < 0 ? list.length : stop + 1);
    },
    async expire() { return 1; },
    async del(key) { lists.delete(key); return 1; },
    pipeline() {
      const ops = [];
      const p = {
        del   : (k)    => { ops.push(() => lists.delete(k)); return p; },
        rpush : (k, v) => { ops.push(() => { if (!lists.has(k)) lists.set(k, []); lists.get(k).push(v); }); return p; },
        expire: ()     => p,
        exec  : async () => { ops.forEach(op => op()); return []; }
      };
      return p;
    },
    /** ioredis EVAL 커맨드 stub이다. Lua 스크립트 호출의 필터링 계약만 재현하며 JS eval()이 아니다. */
    async eval(_script, _numKeys, key, _ttl, ...ids) {
      const toEvict = new Set(ids);
      const items   = lists.get(key) ?? [];
      const kept    = items.filter(raw => !toEvict.has(JSON.parse(raw).id));
      lists.set(key, kept);
      return items.length - kept.length;
    }
  };
}

const redisRef   = { current: createRedisMock() };
const redisProxy = new Proxy(redisRef, {
  get(ref, prop) {
    const val = ref.current[prop];
    return typeof val === "function" ? val.bind(ref.current) : val;
  }
});

mock.module("../../lib/redis.js", { namedExports: { redisClient: redisProxy } });
const realLogger = await import("../../lib/logger.js");
mock.module("../../lib/logger.js", {
  namedExports: { ...realLogger, logInfo: (m) => infoLogs.push(String(m)), logWarn: mock.fn(), logError: mock.fn() }
});
const realDb = await import("../../lib/tools/db.js");
mock.module("../../lib/tools/db.js", {
  namedExports: {
    ...realDb,
    queryWithAgentVector: (...args) => dbRef.fake.queryWithAgentVector(...args),
    withTransaction     : (...args) => dbRef.fake.withTransaction(...args),
    getPrimaryPool      : (...args) => dbRef.fake.getPrimaryPool(...args)
  }
});

const { FragmentIndex }        = await import("../../lib/memory/FragmentIndex.js");
const { markWorkingMemoryRow } = await import("../../lib/memory/WorkingMemoryRows.js");
const { ContextBuilder }       = await import("../../lib/memory/read/ContextBuilder.js");

function wmFragment(id, extra = {}) {
  return {
    id, content: `작업 기억 본문 ${id}`, type: "fact", topic: "t", importance: 0.5, estimated_tokens: 10,
    agent_id: "default", key_id: null, workspace: null, session_id: "sess-1", ...extra
  };
}

/** 대체 경로 행을 FragmentWriter.insert 대신 대역 DB에 넣는다. */
function insertFallbackRow(fragment) {
  return dbRef.fake.insertFragment(markWorkingMemoryRow(fragment));
}

beforeEach(() => {
  redisRef.current = createRedisMock();
  dbRef.fake       = createFakeWmDb();
  infoLogs.length  = 0;
  delete process.env.MEMENTO_WM_PG_FALLBACK;
});
afterEach(() => { delete process.env.MEMENTO_WM_PG_FALLBACK; });

describe("저장소 선택", () => {
  it("Redis가 준비되어 있으면 redis다", () => {
    assert.equal(new FragmentIndex().workingMemoryBackend(), "redis");
  });

  it("Redis가 준비되지 않았고 대체 경로가 켜져 있으면 postgres다", () => {
    redisRef.current.status = "connecting";
    assert.equal(new FragmentIndex().workingMemoryBackend(), "postgres");
  });

  it("Redis 미사용 stub도 대체 경로가 켜져 있으면 postgres다", () => {
    redisRef.current.status = "stub";
    assert.equal(new FragmentIndex().workingMemoryBackend(), "postgres");
  });

  it("대체 경로를 끄면 Redis가 준비되지 않은 동안 none이다", () => {
    process.env.MEMENTO_WM_PG_FALLBACK = "off";
    redisRef.current.status = "end";
    assert.equal(new FragmentIndex().workingMemoryBackend(), "none");
  });

  it("저장소가 바뀔 때만 한 번씩 기록한다", () => {
    const index = new FragmentIndex();
    index.workingMemoryBackend();
    index.workingMemoryBackend();
    redisRef.current.status = "end";
    index.workingMemoryBackend();
    index.workingMemoryBackend();
    assert.deepEqual(infoLogs.filter(l => l.startsWith("[WorkingMemory]")),
      ["[WorkingMemory] backend=redis", "[WorkingMemory] backend=postgres"]);
  });
});

describe("addToWorkingMemory 반환값", () => {
  it("Redis에 넣으면 true이고 DB를 부르지 않는다", async () => {
    const stored = await new FragmentIndex().addToWorkingMemory("sess-1", wmFragment("a"));
    assert.equal(stored, true);
    assert.equal(redisRef.current.lists.get("frag:wm:sess-1").length, 1);
    assert.equal(dbRef.fake.calls.length, 0);
  });

  it("Redis가 준비되지 않으면 false이고 아무것도 기록하지 않는다", async () => {
    redisRef.current.status = "connecting";
    const stored = await new FragmentIndex().addToWorkingMemory("sess-1", wmFragment("a"));
    assert.equal(stored, false);
    assert.equal(redisRef.current.lists.size, 0);
  });

  it("Redis 쓰기가 실패하면 false다", async () => {
    redisRef.current.rpush = async () => { throw new Error("connection lost"); };
    assert.equal(await new FragmentIndex().addToWorkingMemory("sess-1", wmFragment("a")), false);
  });

  it("세션 ID가 없으면 false다", async () => {
    assert.equal(await new FragmentIndex().addToWorkingMemory("", wmFragment("a")), false);
  });

  it("Redis 경로의 토큰 상한 제거는 그대로 동작한다", async () => {
    const index = new FragmentIndex();
    for (let i = 0; i < 6; i++) await index.addToWorkingMemory("sess-1", wmFragment(`r${i}`, { estimated_tokens: 100 }));
    const ids = (await index.getWorkingMemory("sess-1")).map(i => i.id);
    assert.deepEqual(ids, ["r1", "r2", "r3", "r4", "r5"]);
  });
});

describe("조회, 제거, 삭제", () => {
  it("대체 경로를 끄면 redis 저장소 조회는 Redis만 읽고 DB를 부르지 않는다", async () => {
    process.env.MEMENTO_WM_PG_FALLBACK = "off";
    const index = new FragmentIndex();
    await index.addToWorkingMemory("sess-1", wmFragment("a"));
    assert.deepEqual((await index.getWorkingMemory("sess-1")).map(i => i.id), ["a"]);
    assert.equal(dbRef.fake.calls.length, 0);
  });

  it("대체 경로 행이 없으면 redis 저장소 조회의 추가 비용은 인덱스 조회 한 번이고 결과는 Redis 항목 그대로다", async () => {
    const index = new FragmentIndex();
    await index.addToWorkingMemory("sess-1", wmFragment("a"));
    const items = await index.getWorkingMemory("sess-1");
    assert.deepEqual(items.map(i => i.id), ["a"]);
    assert.equal(dbRef.fake.calls.length, 1);
    assert.match(dbRef.fake.calls[0].sql, /session_id = \$1/);
  });

  it("Redis가 준비되어 있어도 대체 경로로 쓴 같은 세션의 행을 함께 읽는다", async () => {
    const index = new FragmentIndex();
    await index.addToWorkingMemory("sess-1", wmFragment("in-redis"));
    insertFallbackRow(wmFragment("in-rows", { content: "대체 경로로 쓴 본문입니다" }));
    const ids = (await index.getWorkingMemory("sess-1")).map(i => i.id).sort();
    assert.deepEqual(ids, ["in-redis", "in-rows"]);
  });

  it("Redis가 끊겼다 돌아온 뒤에도 끊긴 동안 쓴 행이 보인다", async () => {
    redisRef.current.status = "end";
    insertFallbackRow(wmFragment("during-outage"));
    redisRef.current.status = "ready";
    const index = new FragmentIndex();
    await index.addToWorkingMemory("sess-1", wmFragment("after"));
    assert.deepEqual((await index.getWorkingMemory("sess-1")).map(i => i.id).sort(), ["after", "during-outage"]);
  });

  it("같은 본문이 두 출처에 있으면 한 번만 돌려준다", async () => {
    const index = new FragmentIndex();
    await index.addToWorkingMemory("sess-1", wmFragment("a", { content: "같은 본문입니다 충분히 깁니다" }));
    insertFallbackRow(wmFragment("b", { content: "같은 본문입니다 충분히 깁니다" }));
    assert.equal((await index.getWorkingMemory("sess-1")).length, 1);
  });

  it("Redis에 쓰기가 실패해 행으로 간 항목도 컨텍스트 조합에 나온다", async () => {
    redisRef.current.rpush = async () => { throw new Error("connection lost"); };
    const index  = new FragmentIndex();
    const fragment = wmFragment("fell-back");
    assert.equal(await index.addToWorkingMemory("sess-1", fragment), false);
    insertFallbackRow(fragment);
    const builder = new ContextBuilder({
      recall : async () => ({ fragments: [] }),
      store  : { searchBySource: async () => [] },
      index  : Object.assign(index, { setSeenIds: async () => {} }),
      getPool: () => null
    });
    const result = await builder.build({ sessionId: "sess-1", structured: true });
    assert.deepEqual(result.working.current_session.map(i => i.id), ["fell-back"]);
  });

  it("postgres 저장소는 현재 세션의 행을 같은 항목 모양으로 읽는다", async () => {
    redisRef.current.status = "end";
    insertFallbackRow(wmFragment("a"));
    insertFallbackRow(wmFragment("b", { session_id: "sess-2" }));
    const items = await new FragmentIndex().getWorkingMemory("sess-1");
    assert.deepEqual(items.map(i => i.id), ["a"]);
    assert.equal(items[0].agent_id, "default");
    assert.equal(items[0].key_id, null);
    assert.equal(typeof items[0].added_at, "number");
  });

  it("none 저장소는 빈 목록이다", async () => {
    process.env.MEMENTO_WM_PG_FALLBACK = "off";
    redisRef.current.status = "end";
    insertFallbackRow(wmFragment("a"));
    assert.deepEqual(await new FragmentIndex().getWorkingMemory("sess-1"), []);
  });

  it("postgres 저장소의 항목 제거는 지정한 id의 행만 지운다", async () => {
    redisRef.current.status = "end";
    insertFallbackRow(wmFragment("a"));
    insertFallbackRow(wmFragment("b"));
    const index = new FragmentIndex();
    assert.equal(await index.evictWorkingMemoryItems("sess-1", ["a", "a", null]), 1);
    assert.deepEqual((await index.getWorkingMemory("sess-1")).map(i => i.id), ["b"]);
  });

  it("redis 저장소의 항목 제거는 Redis 항목과 행 모두에서 지정한 id를 지운다", async () => {
    const index = new FragmentIndex();
    await index.addToWorkingMemory("sess-1", wmFragment("a"));
    await index.addToWorkingMemory("sess-1", wmFragment("b"));
    insertFallbackRow(wmFragment("c"));
    assert.equal(await index.evictWorkingMemoryItems("sess-1", ["a", "c"]), 2);
    assert.deepEqual((await index.getWorkingMemory("sess-1")).map(i => i.id), ["b"]);
  });

  it("대체 경로를 끄면 항목 제거가 DB를 부르지 않는다", async () => {
    process.env.MEMENTO_WM_PG_FALLBACK = "off";
    const index = new FragmentIndex();
    await index.addToWorkingMemory("sess-1", wmFragment("a"));
    assert.equal(await index.evictWorkingMemoryItems("sess-1", ["a"]), 1);
    assert.equal(dbRef.fake.calls.length, 0);
  });

  it("세션 삭제는 두 저장소를 모두 비운다", async () => {
    const index = new FragmentIndex();
    await index.addToWorkingMemory("sess-1", wmFragment("a"));
    insertFallbackRow(wmFragment("b"));
    await index.clearWorkingMemory("sess-1");
    assert.equal(redisRef.current.lists.has("frag:wm:sess-1"), false);
    assert.equal(dbRef.fake.rows.length, 0);
  });

  it("대체 경로를 끄면 세션 삭제가 DB를 부르지 않는다", async () => {
    process.env.MEMENTO_WM_PG_FALLBACK = "off";
    await new FragmentIndex().clearWorkingMemory("sess-1");
    assert.equal(dbRef.fake.calls.length, 0);
  });

  it("키별 상한은 설정한 행 수보다 하나 적게 남겨 새 행이 들어가도 상한 안이다", async () => {
    process.env.MEMENTO_WM_FALLBACK_MAX_ROWS = "3";
    try {
      for (let i = 0; i < 5; i++) {
        const f = wmFragment(`k${i}`, { key_id: "key-1", session_id: `s${i}`, content: `키 상한 본문 ${i} 충분히 깁니다` });
        markWorkingMemoryRow(f);
        f.created_at = Date.now() - (5 - i) * 1000;
        dbRef.fake.insertFragment(f);
      }
      assert.equal(await new FragmentIndex().enforceFallbackKeyCap("key-1"), 3);
      assert.equal(dbRef.fake.rows.length, 2);
    } finally {
      delete process.env.MEMENTO_WM_FALLBACK_MAX_ROWS;
    }
  });

  it("대체 경로 보관량 줄이기는 토큰 상한을 넘는 오래된 행을 지운다", async () => {
    redisRef.current.status = "end";
    const index = new FragmentIndex();
    for (let i = 0; i < 6; i++) {
      const f = wmFragment(`p${i}`, { estimated_tokens: 100 });
      markWorkingMemoryRow(f);
      f.created_at = Date.now() - (6 - i) * 1000;
      dbRef.fake.insertFragment(f);
    }
    assert.equal(await index.enforceFallbackWorkingMemoryBudget("sess-1"), 1);
    assert.deepEqual((await index.getWorkingMemory("sess-1")).map(i => i.id), ["p1", "p2", "p3", "p4", "p5"]);
  });
});

describe("컨텍스트 조합", () => {
  function builderFor(index) {
    return new ContextBuilder({
      recall : async () => ({ fragments: [] }),
      store  : { searchBySource: async () => [] },
      index  : Object.assign(index, { setSeenIds: async () => {} }),
      getPool: () => null
    });
  }

  it("redis 저장소와 postgres 저장소가 같은 WORKING 구획을 만든다", async () => {
    const viaRedis = new FragmentIndex();
    await viaRedis.addToWorkingMemory("sess-1", wmFragment("a"));
    const redisResult = await builderFor(viaRedis).build({ sessionId: "sess-1", structured: true });

    redisRef.current.status = "end";
    insertFallbackRow(wmFragment("a"));
    const pgResult = await builderFor(new FragmentIndex()).build({ sessionId: "sess-1", structured: true });

    assert.deepEqual(pgResult.working.current_session.map(i => i.id), ["a"]);
    assert.deepEqual(pgResult.working.current_session.map(i => i.id), redisResult.working.current_session.map(i => i.id));
    assert.equal(pgResult.wmCount, redisResult.wmCount);
  });

  it("postgres 저장소도 다른 키의 항목을 현재 키의 컨텍스트에 싣지 않는다", async () => {
    redisRef.current.status = "end";
    insertFallbackRow(wmFragment("mine",  { key_id: "key-1" }));
    insertFallbackRow(wmFragment("other", { key_id: "key-2" }));
    const result = await builderFor(new FragmentIndex()).build({ sessionId: "sess-1", structured: true, _keyId: "key-1" });
    assert.deepEqual(result.working.current_session.map(i => i.id), ["mine"]);
  });

  it("postgres 저장소도 다른 세션의 항목을 싣지 않는다", async () => {
    redisRef.current.status = "end";
    insertFallbackRow(wmFragment("here"));
    insertFallbackRow(wmFragment("away", { session_id: "sess-2" }));
    const result = await builderFor(new FragmentIndex()).build({ sessionId: "sess-1", structured: true });
    assert.deepEqual(result.working.current_session.map(i => i.id), ["here"]);
  });
});
