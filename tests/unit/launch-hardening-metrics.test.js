/**
 * 공개 하드닝 관측성 카운터 3종
 *
 * 작성자: 최진호
 * 작성일: 2026-07-16
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

/** 라벨 없는 카운터의 현재 합계를 반환 */
async function counterValue(metric) {
  const snap = await metric.get();
  return snap.values.reduce((sum, v) => sum + v.value, 0);
}

describe("launch hardening observability counters", () => {
  it("세 카운터와 기록 함수를 export하고 inc가 반영된다", async () => {
    const m = await import("../../lib/metrics.js");

    assert.equal(typeof m.recordEmbeddingSemaphoreWaitExceeded, "function");
    assert.equal(typeof m.recordInitializeIpRateLimited, "function");
    assert.equal(typeof m.recordQuotaCachePass, "function");

    const beforeSem   = await counterValue(m.embeddingSemaphoreWaitExceededTotal);
    const beforeInit  = await counterValue(m.initializeIpRateLimitedTotal);
    const beforeQuota = await counterValue(m.quotaCachePassTotal);

    m.recordEmbeddingSemaphoreWaitExceeded();
    m.recordInitializeIpRateLimited();
    m.recordQuotaCachePass();

    assert.equal(await counterValue(m.embeddingSemaphoreWaitExceededTotal), beforeSem + 1);
    assert.equal(await counterValue(m.initializeIpRateLimitedTotal), beforeInit + 1);
    assert.equal(await counterValue(m.quotaCachePassTotal), beforeQuota + 1);
  });

  it("레지스트리에 세 메트릭이 등록된다", async () => {
    const m = await import("../../lib/metrics.js");
    assert.ok(m.register.getSingleMetric("mcp_embedding_semaphore_wait_exceeded_total"));
    assert.ok(m.register.getSingleMetric("mcp_initialize_ip_rate_limited_total"));
    assert.ok(m.register.getSingleMetric("mcp_quota_cache_pass_total"));
  });
});
