import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter, DualRateLimiter } from "../../lib/rate-limiter.js";

describe("RateLimiter", () => {
  let limiter;

  beforeEach(() => {
    limiter = new RateLimiter({ windowMs: 1000, maxRequests: 3 });
  });

  it("allows requests within limit", () => {
    assert.ok(limiter.allow("1.2.3.4"));
    assert.ok(limiter.allow("1.2.3.4"));
    assert.ok(limiter.allow("1.2.3.4"));
  });

  it("blocks requests exceeding limit", () => {
    limiter.allow("1.2.3.4");
    limiter.allow("1.2.3.4");
    limiter.allow("1.2.3.4");
    assert.strictEqual(limiter.allow("1.2.3.4"), false);
  });

  it("peek은 요청을 기록하지 않고 한 번 더 받을 수 있는지만 알려 준다", () => {
    assert.ok(limiter.peek("9.9.9.9"));
    limiter.allow("9.9.9.9");
    limiter.allow("9.9.9.9");
    assert.ok(limiter.peek("9.9.9.9"));
    assert.ok(limiter.peek("9.9.9.9"));
    limiter.allow("9.9.9.9");
    assert.strictEqual(limiter.peek("9.9.9.9"), false);
  });

  it("isolates different IPs", () => {
    limiter.allow("1.2.3.4");
    limiter.allow("1.2.3.4");
    limiter.allow("1.2.3.4");
    assert.ok(limiter.allow("5.6.7.8"));
  });

  it("resets after window expires", async () => {
    limiter = new RateLimiter({ windowMs: 50, maxRequests: 1 });
    limiter.allow("1.2.3.4");
    assert.strictEqual(limiter.allow("1.2.3.4"), false);
    await new Promise(r => setTimeout(r, 60));
    assert.ok(limiter.allow("1.2.3.4"));
  });

  it("cleanup removes expired entries", async () => {
    limiter = new RateLimiter({ windowMs: 50, maxRequests: 10 });
    limiter.allow("1.2.3.4");
    await new Promise(r => setTimeout(r, 60));
    limiter.cleanup();
    assert.strictEqual(limiter.size, 0);
  });
});

describe("DualRateLimiter", () => {
  let dual;

  beforeEach(() => {
    dual = new DualRateLimiter({ windowMs: 1000, perIp: 2, perKey: 5 });
  });

  it("uses IP limit when no keyId", () => {
    assert.ok(dual.allow("1.2.3.4"));
    assert.ok(dual.allow("1.2.3.4"));
    assert.strictEqual(dual.allow("1.2.3.4"), false);
  });

  it("uses key limit when keyId provided", () => {
    for (let i = 0; i < 5; i++) {
      assert.ok(dual.allow("1.2.3.4", "key-abc"));
    }
    assert.strictEqual(dual.allow("1.2.3.4", "key-abc"), false);
  });

  it("keyId and IP limits are independent", () => {
    dual.allow("1.2.3.4");
    dual.allow("1.2.3.4");
    assert.strictEqual(dual.allow("1.2.3.4"), false);

    assert.ok(dual.allow("1.2.3.4", "key-abc"));
  });

  it("different keyIds have separate limits", () => {
    for (let i = 0; i < 5; i++) {
      dual.allow("1.2.3.4", "key-1");
    }
    assert.strictEqual(dual.allow("1.2.3.4", "key-1"), false);
    assert.ok(dual.allow("1.2.3.4", "key-2"));
  });

  it("cleanup delegates to both sub-limiters", async () => {
    dual = new DualRateLimiter({ windowMs: 50, perIp: 10, perKey: 10 });
    dual.allow("1.2.3.4");
    dual.allow("1.2.3.4", "key-abc");
    assert.strictEqual(dual.size, 2);

    await new Promise(r => setTimeout(r, 60));
    dual.cleanup();
    assert.strictEqual(dual.size, 0);
  });

  it("destroy clears all buckets", () => {
    dual.allow("1.2.3.4");
    dual.allow("1.2.3.4", "key-abc");
    dual.destroy();
    assert.strictEqual(dual.size, 0);
  });
});
