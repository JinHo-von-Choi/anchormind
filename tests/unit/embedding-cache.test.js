import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { EmbeddingCache } from "../../lib/memory/embedding/EmbeddingCache.js";

describe("EmbeddingCache", () => {
  const sampleVec = [0.1, 0.2, 0.3, 0.4, 0.5];

  it("redis가 null이면 get은 항상 null 반환", async () => {
    const cache  = new EmbeddingCache({ redis: null });
    const result = await cache.get("hello");
    assert.equal(result, null);
  });

  it("redis가 null이면 set은 예외 없이 무시", () => {
    const cache = new EmbeddingCache({ redis: null });
    assert.doesNotThrow(() => cache.set("hello", sampleVec));
  });

  it("redis가 stub이면 get은 항상 null 반환", async () => {
    const cache  = new EmbeddingCache({ redis: { status: "stub" } });
    const result = await cache.get("hello");
    assert.equal(result, null);
  });

  it("cache miss (getBuffer가 null 반환) 시 null 반환", async () => {
    const redis = {
      status   : "ready",
      getBuffer: mock.fn(async () => null)
    };
    const cache  = new EmbeddingCache({ redis });
    const result = await cache.get("some query");
    assert.equal(result, null);
    assert.equal(redis.getBuffer.mock.calls.length, 1);
  });

  it("set 후 get 시 동일 벡터 복원", async () => {
    const store = new Map();
    const redis = {
      status   : "ready",
      getBuffer: mock.fn(async (key) => store.get(key) ?? null),
      set      : mock.fn(async (key, buf) => { store.set(key, buf); return "OK"; })
    };
    const cache = new EmbeddingCache({ redis, ttlSeconds: 60 });

    cache.set("test query", sampleVec);
    /** fire-and-forget set이 완료될 때까지 한 틱 대기 */
    await new Promise(r => setTimeout(r, 10));

    const result = await cache.get("test query");
    assert.ok(Array.isArray(result));
    assert.equal(result.length, sampleVec.length);
    for (let i = 0; i < sampleVec.length; i++) {
      assert.ok(Math.abs(result[i] - sampleVec[i]) < 1e-6, `index ${i} mismatch`);
    }
  });

  it("동일 텍스트는 동일 키를 생성한다", () => {
    const cache = new EmbeddingCache();
    const k1    = cache._key("hello world");
    const k2    = cache._key("hello world");
    assert.equal(k1, k2);
    assert.ok(k1.startsWith("emb:q:"));
    assert.equal(k1.length, "emb:q:".length + 16);
  });

  it("다른 텍스트는 다른 키를 생성한다", () => {
    const cache = new EmbeddingCache();
    const k1    = cache._key("hello");
    const k2    = cache._key("world");
    assert.notEqual(k1, k2);
  });

  it("set에서 EX TTL 파라미터가 전달된다", async () => {
    const redis = {
      status: "ready",
      set   : mock.fn(async () => "OK")
    };
    const cache = new EmbeddingCache({ redis, ttlSeconds: 1800 });
    cache.set("query", [1.0, 2.0]);
    await new Promise(r => setTimeout(r, 10));

    const call = redis.set.mock.calls[0];
    assert.equal(call.arguments[2], "EX");
    assert.equal(call.arguments[3], 1800);
  });

  it("getBuffer 예외 시 null 반환 (장애 격리)", async () => {
    const redis = {
      status   : "ready",
      getBuffer: mock.fn(async () => { throw new Error("Redis down"); })
    };
    const cache  = new EmbeddingCache({ redis });
    const result = await cache.get("query");
    assert.equal(result, null);
  });

  it("set에서 redis.set 예외 시 예외 전파 없음 (fire-and-forget)", async () => {
    const redis = {
      status: "ready",
      set   : mock.fn(async () => { throw new Error("Redis down"); })
    };
    const cache = new EmbeddingCache({ redis });
    assert.doesNotThrow(() => cache.set("query", [1.0]));
    await new Promise(r => setTimeout(r, 10));
  });
});
