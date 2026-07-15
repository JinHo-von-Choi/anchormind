import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

/** getUsage 평문 SELECT·정밀 FOR UPDATE·COUNT를 모두 응답하는 mock client */
function mockClient(fragmentLimit, count) {
  return {
    query: mock.fn(async (sql) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.startsWith("SET LOCAL")) return { rows: [] };
      if (sql.includes("COUNT"))          return { rows: [{ count }] };
      if (sql.includes("FOR UPDATE"))     return { rows: [{ fragment_limit: fragmentLimit }] };
      if (sql.includes("fragment_limit")) return { rows: [{ fragment_limit: fragmentLimit }] };
      return { rows: [] };
    }),
    release: mock.fn()
  };
}

describe("QuotaChecker", () => {
  it("keyId가 null이면 검사를 건너뛴다", async () => {
    const { QuotaChecker, clearUsageCache } = await import("../../lib/memory/QuotaChecker.js");
    clearUsageCache();
    const checker = new QuotaChecker();
    await assert.doesNotReject(() => checker.check(null));
  });

  it("할당량 미초과 시 정상 통과", async () => {
    const { QuotaChecker, clearUsageCache } = await import("../../lib/memory/QuotaChecker.js");
    clearUsageCache();
    const checker = new QuotaChecker();
    /** limit 100, current 50 → remaining 50 > margin → 여유 통과 */
    checker.setPool({ connect: mock.fn(async () => mockClient(100, 50)) });
    await assert.doesNotReject(() => checker.check("key-pass"));
  });

  it("할당량 초과 시 fragment_limit_exceeded 에러", async () => {
    const { QuotaChecker, clearUsageCache } = await import("../../lib/memory/QuotaChecker.js");
    clearUsageCache();
    const checker = new QuotaChecker();
    /** limit 10, current 10 → remaining 0 ≤ margin → 정밀 경로 진입 후 초과 throw */
    checker.setPool({ connect: mock.fn(async () => mockClient(10, 10)) });
    await assert.rejects(
      () => checker.check("key-exceed"),
      (err) => err.code === "fragment_limit_exceeded"
    );
  });

  it("fragment_limit가 null이면 무제한 — 통과", async () => {
    const { QuotaChecker, clearUsageCache } = await import("../../lib/memory/QuotaChecker.js");
    clearUsageCache();
    const checker = new QuotaChecker();
    checker.setPool({ connect: mock.fn(async () => mockClient(null, 0)) });
    await assert.doesNotReject(() => checker.check("key-unlimited"));
  });
});
