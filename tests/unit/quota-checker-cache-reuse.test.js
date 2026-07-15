/**
 * QuotaChecker.check() 캐시 재사용 + 임박 시에만 FOR UPDATE
 *
 * 작성자: 최진호
 * 작성일: 2026-07-16
 */

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

/**
 * getUsage(평문 SELECT fragment_limit, FOR UPDATE 없음)·정밀(FOR UPDATE)·COUNT를
 * 모두 응답하는 mock. FOR UPDATE 분기를 fragment_limit 일반 분기보다 먼저 검사한다.
 */
function makeConnect(fragmentLimit, count) {
  return mock.fn(async () => ({
    query: mock.fn(async (sql) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.startsWith("SET LOCAL")) return { rows: [] };
      if (sql.includes("COUNT"))          return { rows: [{ count }] };
      if (sql.includes("FOR UPDATE"))     return { rows: [{ fragment_limit: fragmentLimit }] };
      if (sql.includes("fragment_limit")) return { rows: [{ fragment_limit: fragmentLimit }] };
      return { rows: [] };
    }),
    release: mock.fn()
  }));
}

describe("QuotaChecker.check cache reuse", () => {
  it("캐시 워밍 후 여유가 충분하면 check()가 추가 DB connect를 열지 않는다", async () => {
    const { QuotaChecker, clearUsageCache } = await import("../../lib/memory/QuotaChecker.js");
    clearUsageCache();
    const checker = new QuotaChecker();

    /** limit 1000, current 10 → remaining 990 > margin(10) */
    const connect = makeConnect(1000, 10);
    checker.setPool({ connect });

    /** 사전 getUsage로 캐시 워밍 (connect 1회) */
    await checker.getUsage("key-abundant");
    const afterWarm = connect.mock.callCount();
    assert.equal(afterWarm, 1, "getUsage는 connect 1회");

    /** check()는 캐시 재사용 → 여유 충분 → 정밀 트랜잭션 미개시 (추가 connect 0회) */
    await checker.check("key-abundant");
    assert.equal(connect.mock.callCount(), afterWarm, "여유 충분 시 check는 추가 connect 0회");
  });

  it("한도 임박(remaining ≤ margin)이면 정밀 검사로 초과를 차단한다", async () => {
    const { QuotaChecker, clearUsageCache } = await import("../../lib/memory/QuotaChecker.js");
    clearUsageCache();
    const checker = new QuotaChecker();

    /** limit 100, current 100 → remaining 0 ≤ margin → 정밀 경로 진입 후 초과 throw */
    checker.setPool({ connect: makeConnect(100, 100) });

    await assert.rejects(
      () => checker.check("key-full"),
      (err) => err.code === "fragment_limit_exceeded"
    );
  });
});
