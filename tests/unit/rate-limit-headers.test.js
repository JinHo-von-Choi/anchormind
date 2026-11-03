/**
 * tests/unit/rate-limit-headers.test.js
 *
 * M3: QuotaChecker.getUsage + 인메모리 캐시 동작 검증
 *
 * 작성자: 최진호
 * 작성일: 2026-04-20
 */

import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

describe("QuotaChecker.getUsage", () => {
  beforeEach(async () => {
    const { clearUsageCache } = await import("../../lib/memory/QuotaChecker.js");
    clearUsageCache();
  });

  it("limit/current/remaining을 정확히 반환한다", async () => {
    const { QuotaChecker } = await import("../../lib/memory/QuotaChecker.js");
    const checker = new QuotaChecker();

    const mockClient = {
      query: mock.fn(async (sql) => {
        if (sql === "BEGIN" || sql === "COMMIT" || sql.startsWith("SET LOCAL")) return { rows: [] };
        /** 키가 속한 상한 있는 그룹(그룹 할당량)은 없다 */
        if (sql.includes("api_key_groups")) return { rows: [] };
        if (sql.includes("fragment_limit")) return { rows: [{ fragment_limit: 100 }] };
        if (sql.includes("COUNT")) return { rows: [{ count: 40 }] };
        return { rows: [] };
      }),
      release: mock.fn()
    };
    checker.setPool({ connect: mock.fn(async () => mockClient) });

    const result = await checker.getUsage("key-abc");
    assert.equal(result.limit,     100);
    assert.equal(result.current,   40);
    assert.equal(result.remaining, 60);
    assert.equal(result.resetAt,   null);
  });

  it("fragment_limit null이면 limit=null, remaining=null 반환", async () => {
    const { QuotaChecker } = await import("../../lib/memory/QuotaChecker.js");
    const checker = new QuotaChecker();

    const mockClient = {
      query: mock.fn(async (sql) => {
        if (sql === "BEGIN" || sql === "COMMIT" || sql.startsWith("SET LOCAL")) return { rows: [] };
        /** 키가 속한 상한 있는 그룹(그룹 할당량)은 없다 */
        if (sql.includes("api_key_groups")) return { rows: [] };
        if (sql.includes("fragment_limit")) return { rows: [{ fragment_limit: null }] };
        return { rows: [] };
      }),
      release: mock.fn()
    };
    checker.setPool({ connect: mock.fn(async () => mockClient) });

    const result = await checker.getUsage("key-unlimited");
    assert.equal(result.limit,     null);
    assert.equal(result.remaining, null);
  });

  it("연속 호출 시 캐시 덕분에 DB 1회만 조회한다", async () => {
    const { QuotaChecker, clearUsageCache } = await import("../../lib/memory/QuotaChecker.js");
    clearUsageCache();

    const checker = new QuotaChecker();
    let connectCount = 0;

    const mockClient = {
      query: mock.fn(async (sql) => {
        if (sql === "BEGIN" || sql === "COMMIT" || sql.startsWith("SET LOCAL")) return { rows: [] };
        /** 키가 속한 상한 있는 그룹(그룹 할당량)은 없다 */
        if (sql.includes("api_key_groups")) return { rows: [] };
        if (sql.includes("fragment_limit")) return { rows: [{ fragment_limit: 50 }] };
        if (sql.includes("COUNT")) return { rows: [{ count: 10 }] };
        return { rows: [] };
      }),
      release: mock.fn()
    };
    checker.setPool({ connect: mock.fn(async () => { connectCount++; return mockClient; }) });

    await checker.getUsage("key-cached");
    await checker.getUsage("key-cached");
    await checker.getUsage("key-cached");

    assert.equal(connectCount, 1, "DB connect는 캐시 TTL 내 1회만 호출되어야 한다");
  });

  it("master key(keyId=null)에서 limit=null 즉시 반환 (DB 조회 없음)", async () => {
    const { QuotaChecker } = await import("../../lib/memory/QuotaChecker.js");
    const checker = new QuotaChecker();
    let connectCount = 0;
    checker.setPool({ connect: mock.fn(async () => { connectCount++; return {}; }) });

    const result = await checker.getUsage(null);
    assert.equal(result.limit,     null);
    assert.equal(result.remaining, null);
    assert.equal(connectCount,     0, "master key는 DB를 조회하지 않아야 한다");
  });
});
