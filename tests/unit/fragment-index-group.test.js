/**
 * FragmentIndex — group-aware namespace union 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-10
 *
 * 커밋 ae3a6e6이 도입한 변경사항 회귀 검증:
 * - keyNs() 배열 입력 → explicit throw
 * - keyNsList() 단일·그룹·null 시그니처
 * - _unionFromKeyNamespaces() 멤버별 fetcher 호출 후 union
 * - searchByTopic / searchByKeywords / getRecent / getCachedFragment
 *   5개 read 메서드의 단일·그룹 keyId 동작
 */

import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Redis Map-based stub factory
// ---------------------------------------------------------------------------

function createRedisMock() {
  const _sets    = new Map();
  const _sorted  = new Map();
  const _strings = new Map();

  const stub = {
    status: "ready",

    async sadd(key, ...members) {
      if (!_sets.has(key)) _sets.set(key, new Set());
      for (const m of members) _sets.get(key).add(m);
      return members.length;
    },

    async smembers(key) {
      return [...(_sets.get(key) ?? [])];
    },

    async sinter(...keys) {
      if (keys.length === 0) return [];
      const first = new Set(_sets.get(keys[0]) ?? []);
      for (let i = 1; i < keys.length; i++) {
        const s = _sets.get(keys[i]) ?? new Set();
        for (const v of [...first]) {
          if (!s.has(v)) first.delete(v);
        }
      }
      return [...first];
    },

    async sunion(...keys) {
      const union = new Set();
      for (const key of keys) {
        for (const v of (_sets.get(key) ?? [])) union.add(v);
      }
      return [...union];
    },

    async zadd(key, score, member) {
      if (!_sorted.has(key)) _sorted.set(key, new Map());
      _sorted.get(key).set(member, score);
      return 1;
    },

    async zrevrange(key, start, stop) {
      const map = _sorted.get(key);
      if (!map) return [];
      const entries = [...map.entries()].sort((a, b) => b[1] - a[1]);
      const end     = stop < 0 ? entries.length : stop + 1;
      return entries.slice(start, end).map(([m]) => m);
    },

    async setex(key, _ttl, value) {
      _strings.set(key, value);
      return "OK";
    },

    async get(key) {
      return _strings.get(key) ?? null;
    },

    async expire() { return 1; },

    async del(key) {
      _sets.delete(key);
      _sorted.delete(key);
      _strings.delete(key);
      return 1;
    },

    async srem(key, ...members) {
      const s = _sets.get(key);
      if (s) for (const m of members) s.delete(m);
      return members.length;
    },

    async zrem(key, member) {
      const m = _sorted.get(key);
      if (m) m.delete(member);
      return 1;
    },

    pipeline() {
      const ops = [];
      const self = {
        sadd(key, ...members) { ops.push(() => stub.sadd(key, ...members)); return self; },
        zadd(key, score, mb)  { ops.push(() => stub.zadd(key, score, mb)); return self; },
        setex(key, ttl, val)  { ops.push(() => stub.setex(key, ttl, val)); return self; },
        del(key)              { ops.push(() => stub.del(key));              return self; },
        srem(key, ...m)       { ops.push(() => stub.srem(key, ...m));      return self; },
        zrem(key, member)     { ops.push(() => stub.zrem(key, member));    return self; },
        expire()              { ops.push(() => Promise.resolve(1));         return self; },
        async exec()          { for (const op of ops) await op(); return []; }
      };
      return self;
    },

    _sets, _sorted, _strings
  };

  return stub;
}

// ---------------------------------------------------------------------------
// 현재 stub을 가리키는 mutable ref — mock.module은 단 1회만 호출 가능하므로
// Proxy 대신 ref 객체로 간접 참조한다
// ---------------------------------------------------------------------------

const redisRef = { current: createRedisMock() };

/**
 * FragmentIndex가 import하는 redisClient를 동적으로 교체 가능하게 하는 Proxy.
 * status 속성은 값으로, 메서드는 함수로 올바르게 반환한다.
 */
const redisProxy = new Proxy(redisRef, {
  get(ref, prop) {
    const val = ref.current[prop];
    if (typeof val === "function") return val.bind(ref.current);
    return val;
  }
});

// ---------------------------------------------------------------------------
// Module mock 등록 (import 전에 실행)
// ---------------------------------------------------------------------------

mock.module("../../lib/redis.js", {
  namedExports: { redisClient: redisProxy }
});

mock.module("../../lib/logger.js", {
  namedExports: {
    logInfo : mock.fn(),
    logWarn : mock.fn(),
    logError: mock.fn()
  }
});

mock.module("../../lib/memory/write/FragmentFactory.js", {
  namedExports: {
    FragmentFactory: class {
      extractKeywords() { return []; }
    }
  }
});

const { FragmentIndex } = await import("../../lib/memory/FragmentIndex.js");

// ---------------------------------------------------------------------------
// 헬퍼
// ---------------------------------------------------------------------------

function makeFragment(id, topic, type, keywords = []) {
  return { id, topic, type, keywords, content: "" };
}

function newRedis() {
  const stub = createRedisMock();
  redisRef.current = stub;
  return stub;
}

// ---------------------------------------------------------------------------
// 1. keyNs 시그니처 — index() 키 패턴으로 간접 검증
// ---------------------------------------------------------------------------

describe("keyNs 시그니처", () => {

  it("keyNs(null) → '_g' namespace 사용", async () => {
    const redis = newRedis();
    const idx   = new FragmentIndex();
    const frag  = makeFragment("f1", "test-topic", "fact", ["hello"]);
    await idx.index(frag, null, null);

    const keys = [...redis._sets.keys(), ...redis._sorted.keys()];
    assert.ok(keys.some(k => k.includes("_g")),
      `_g namespace 키 없음. 실제 키: ${keys}`);
  });

  it("keyNs('K1') → '_kK1' namespace 사용", async () => {
    const redis = newRedis();
    const idx   = new FragmentIndex();
    const frag  = makeFragment("f2", "test-topic", "fact", ["hello"]);
    await idx.index(frag, null, "K1");

    const keys = [...redis._sets.keys(), ...redis._sorted.keys()];
    assert.ok(keys.some(k => k.includes("_kK1")),
      `_kK1 namespace 키 없음. 실제 키: ${keys}`);
  });

  it("keyNs(array) → index()가 throws (잘못된 호출 가드)", async () => {
    newRedis();
    const idx  = new FragmentIndex();
    const frag = makeFragment("f3", "test-topic", "fact");

    await assert.rejects(
      () => idx.index(frag, null, ["K1", "K2"]),
      /keyNsList/,
      "배열 keyId를 index()에 전달하면 Error가 발생해야 한다"
    );
  });
});

// ---------------------------------------------------------------------------
// 2. keyNsList 시그니처 — _unionFromKeyNamespaces로 간접 검증
// ---------------------------------------------------------------------------

describe("keyNsList 시그니처", () => {

  beforeEach(() => { newRedis(); });

  it("keyNsList(null) → ['_g'] : fetcher가 '_g'로 호출됨", async () => {
    const idx        = new FragmentIndex();
    const capturedNs = [];
    await idx._unionFromKeyNamespaces(null, async (ns) => { capturedNs.push(ns); return []; });
    assert.deepStrictEqual(capturedNs, ["_g"]);
  });

  it("keyNsList('K1') → ['_kK1'] : fetcher가 '_kK1'로 호출됨", async () => {
    const idx        = new FragmentIndex();
    const capturedNs = [];
    await idx._unionFromKeyNamespaces("K1", async (ns) => { capturedNs.push(ns); return []; });
    assert.deepStrictEqual(capturedNs, ["_kK1"]);
  });

  it("keyNsList(['K1','K2']) → ['_kK1','_kK2'] : fetcher가 두 namespace로 각각 호출됨", async () => {
    const idx        = new FragmentIndex();
    const capturedNs = [];
    await idx._unionFromKeyNamespaces(["K1", "K2"], async (ns) => { capturedNs.push(ns); return []; });
    assert.deepStrictEqual(capturedNs.sort(), ["_kK1", "_kK2"]);
  });
});

// ---------------------------------------------------------------------------
// 3. searchByTopic — 단일·그룹 keyId
// ---------------------------------------------------------------------------

describe("searchByTopic", () => {

  it("단일 keyId: K1 namespace의 topic=foo fragment 1개 반환", async () => {
    newRedis();
    const idx  = new FragmentIndex();
    const frag = makeFragment("frag-A", "foo", "fact");
    await idx.index(frag, null, "K1");

    const result = await idx.searchByTopic("foo", "K1");
    assert.ok(Array.isArray(result));
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0], "frag-A");
  });

  it("그룹 keyId: K1·K2 각각 다른 fragment → union 반환", async () => {
    newRedis();
    const idx = new FragmentIndex();
    await idx.index(makeFragment("frag-K1", "foo", "fact"), null, "K1");
    await idx.index(makeFragment("frag-K2", "foo", "fact"), null, "K2");

    const result = await idx.searchByTopic("foo", ["K1", "K2"]);
    assert.ok(Array.isArray(result));
    assert.ok(result.includes("frag-K1"), "K1 결과 누락");
    assert.ok(result.includes("frag-K2"), "K2 결과 누락");
    assert.strictEqual(result.length, 2, "union에 중복 없어야 함");
  });

  it("그룹 keyId: 동일 fragmentId가 두 namespace에 존재하면 union에서 1회만", async () => {
    newRedis();
    const idx = new FragmentIndex();
    await idx.index(makeFragment("shared-frag", "bar", "fact"), null, "K1");
    await idx.index(makeFragment("shared-frag", "bar", "fact"), null, "K2");

    const result = await idx.searchByTopic("bar", ["K1", "K2"]);
    const count  = result.filter(id => id === "shared-frag").length;
    assert.strictEqual(count, 1, "중복 ID는 1회만 포함되어야 한다");
  });
});

// ---------------------------------------------------------------------------
// 4. getCachedFragment — 단일·그룹·미존재
// ---------------------------------------------------------------------------

describe("getCachedFragment", () => {

  it("단일 keyId: K1 namespace에 cached → keyId=K1로 hit", async () => {
    newRedis();
    const idx  = new FragmentIndex();
    const data = { id: "frag-C", content: "hello", type: "fact" };

    await idx.cacheFragment("frag-C", data, "K1");
    const result = await idx.getCachedFragment("frag-C", "K1");

    assert.ok(result !== null, "cache hit 실패");
    assert.strictEqual(result.id, "frag-C");
    assert.strictEqual(result.content, "hello");
  });

  it("그룹 keyId: K1 namespace에 cached → keyId=[K1,K2]로도 hit (첫 멤버)", async () => {
    newRedis();
    const idx  = new FragmentIndex();
    const data = { id: "frag-D", content: "world", type: "decision" };

    await idx.cacheFragment("frag-D", data, "K1");
    const result = await idx.getCachedFragment("frag-D", ["K1", "K2"]);

    assert.ok(result !== null, "그룹 keyId로 cache hit 실패");
    assert.strictEqual(result.id, "frag-D");
  });

  it("그룹 keyId: K2 namespace에 cached → keyId=[K1,K2]로도 hit (두 번째 멤버)", async () => {
    newRedis();
    const idx  = new FragmentIndex();
    const data = { id: "frag-E", content: "second-member", type: "procedure" };

    await idx.cacheFragment("frag-E", data, "K2");
    const result = await idx.getCachedFragment("frag-E", ["K1", "K2"]);

    assert.ok(result !== null, "두 번째 멤버 namespace에서 hit 실패");
    assert.strictEqual(result.id, "frag-E");
  });

  it("미존재: 어느 namespace에도 없으면 null", async () => {
    newRedis();
    const idx    = new FragmentIndex();
    const result = await idx.getCachedFragment("no-such-frag", ["K1", "K2"]);
    assert.strictEqual(result, null);
  });

  it("단일 keyId 미존재: null 반환", async () => {
    newRedis();
    const idx    = new FragmentIndex();
    const result = await idx.getCachedFragment("ghost", "K3");
    assert.strictEqual(result, null);
  });
});

// ---------------------------------------------------------------------------
// 5. searchByKeywords — sinter 멤버 내 / union 멤버 간
// ---------------------------------------------------------------------------

describe("searchByKeywords", () => {

  it("단일 keyId: 동일 namespace 내 키워드 sinter", async () => {
    newRedis();
    const idx = new FragmentIndex();
    await idx.index(makeFragment("frag-X", "t", "fact", ["alpha", "beta"]), null, "K1");
    await idx.index(makeFragment("frag-Y", "t", "fact", ["alpha"]),         null, "K1");

    const result = await idx.searchByKeywords(["alpha", "beta"], 0, "K1");
    assert.ok(result.includes("frag-X"), "sinter 결과에 frag-X 없음");
    assert.ok(!result.includes("frag-Y"), "frag-Y는 sinter에서 제외되어야 한다");
  });

  it("단일 keyId: sinter 결과 부족(< minResults) 시 sunion으로 확장", async () => {
    newRedis();
    const idx = new FragmentIndex();
    await idx.index(makeFragment("frag-P", "t", "fact", ["x"]), null, "K1");
    await idx.index(makeFragment("frag-Q", "t", "fact", ["y"]), null, "K1");

    const result = await idx.searchByKeywords(["x", "y"], 3, "K1");
    assert.ok(result.includes("frag-P"), "sunion에 frag-P 없음");
    assert.ok(result.includes("frag-Q"), "sunion에 frag-Q 없음");
  });

  it("그룹 keyId: 멤버 간 union (K1 결과 + K2 결과)", async () => {
    newRedis();
    const idx = new FragmentIndex();
    await idx.index(makeFragment("frag-G1", "t", "fact", ["kw"]), null, "K1");
    await idx.index(makeFragment("frag-G2", "t", "fact", ["kw"]), null, "K2");

    const result = await idx.searchByKeywords(["kw"], 0, ["K1", "K2"]);
    assert.ok(result.includes("frag-G1"), "K1 결과 누락");
    assert.ok(result.includes("frag-G2"), "K2 결과 누락");
  });

  it("그룹 keyId: 멤버 내 sinter는 각 namespace 기준 — frag-Both(K1)만 통과", async () => {
    newRedis();
    const idx = new FragmentIndex();
    await idx.index(makeFragment("frag-Only1", "t", "fact", ["kw1"]),         null, "K1");
    await idx.index(makeFragment("frag-Both",  "t", "fact", ["kw1", "kw2"]), null, "K1");
    await idx.index(makeFragment("frag-Only2", "t", "fact", ["kw2"]),         null, "K2");

    /**
     * 그룹 keyId=[K1,K2], keywords=[kw1,kw2], minResults=0
     * K1: sinter([kw1,kw2]) → frag-Both (frag-Only1은 kw2 없으므로 제외)
     * K2: sinter([kw1,kw2]) → [] (frag-Only2는 kw1 없으므로 제외)
     * union = [frag-Both]
     */
    const result = await idx.searchByKeywords(["kw1", "kw2"], 0, ["K1", "K2"]);
    assert.ok(result.includes("frag-Both"), "frag-Both는 K1 sinter에서 포함되어야 한다");
    assert.ok(!result.includes("frag-Only1"),
      "frag-Only1은 K1 namespace에서 kw2 없으므로 sinter 제외되어야 한다");
  });
});

// ---------------------------------------------------------------------------
// 6. getRecent — 그룹 keyId union
// ---------------------------------------------------------------------------

describe("getRecent", () => {

  it("단일 keyId: 최근 파편 목록 반환", async () => {
    newRedis();
    const idx = new FragmentIndex();
    await idx.index(makeFragment("r-1", "t", "fact"), null, "K1");
    await idx.index(makeFragment("r-2", "t", "fact"), null, "K1");

    const result = await idx.getRecent(10, "K1");
    assert.ok(result.includes("r-1"), "r-1 없음");
    assert.ok(result.includes("r-2"), "r-2 없음");
  });

  it("그룹 keyId: K1·K2 멤버별 zrevrange 후 union", async () => {
    newRedis();
    const idx = new FragmentIndex();
    await idx.index(makeFragment("r-K1", "t", "fact"), null, "K1");
    await idx.index(makeFragment("r-K2", "t", "fact"), null, "K2");

    const result = await idx.getRecent(10, ["K1", "K2"]);
    assert.ok(Array.isArray(result));
    assert.ok(result.includes("r-K1"), "K1 파편 누락");
    assert.ok(result.includes("r-K2"), "K2 파편 누락");
  });

  it("그룹 keyId: count 초과분은 슬라이스됨", async () => {
    newRedis();
    const idx = new FragmentIndex();
    for (let i = 0; i < 5; i++) {
      await idx.index(makeFragment(`r-K1-${i}`, "t", "fact"), null, "K1");
      await idx.index(makeFragment(`r-K2-${i}`, "t", "fact"), null, "K2");
    }

    const result = await idx.getRecent(3, ["K1", "K2"]);
    assert.ok(result.length <= 3, `count=3인데 ${result.length}개 반환됨`);
  });
});
