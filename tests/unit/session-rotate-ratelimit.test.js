/**
 * Rate-limit 헬퍼(_rotate-ratelimit.js) 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-20
 *
 * 검증 대상:
 *  1. 분당 5회(기본) 허용 — 5번째까지 allowed=true
 *  2. 6번째 요청 → allowed=false, retryAfter > 0
 *  3. 윈도우 만료 후 카운터 리셋 → 다시 allowed=true
 *  4. Retry-After 헤더값이 양의 정수
 *  5. MEMENTO_ROTATE_RATE_LIMIT_PER_MIN 환경변수 오버라이드
 */

import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

/** 테스트용 fake req — remoteAddress와 x-forwarded-for 설정 가능 */
function fakeReq({ ip = "192.168.1.1", forwarded = null } = {}) {
  const headers = {};
  if (forwarded) headers["x-forwarded-for"] = forwarded;
  return {
    headers,
    socket: { remoteAddress: ip },
  };
}

/** 모듈 경로 (import cache 회피 불필요 — _resetForTest로 상태 초기화) */
const MOD_PATH = "../../lib/handlers/_rotate-ratelimit.js";

describe("checkRotateRateLimit", () => {
  let checkRotateRateLimit, _resetForTest, _setForTest;

  before(async () => {
    ({ checkRotateRateLimit, _resetForTest, _setForTest } = await import(MOD_PATH));
  });

  beforeEach(() => {
    _resetForTest();
  });

  it("분당 5회(기본) 이하 요청은 allowed=true", () => {
    const req = fakeReq({ ip: "10.0.0.1" });
    for (let i = 0; i < 5; i++) {
      const result = checkRotateRateLimit(req);
      assert.strictEqual(result.allowed, true, `${i + 1}번째 요청이 blocked됨`);
    }
  });

  it("6번째 요청 → allowed=false, retryAfter > 0", () => {
    const req = fakeReq({ ip: "10.0.0.2" });
    for (let i = 0; i < 5; i++) checkRotateRateLimit(req);

    const result = checkRotateRateLimit(req);
    assert.strictEqual(result.allowed, false);
    assert.ok(result.retryAfter > 0, `retryAfter는 양수여야 함, 실제: ${result.retryAfter}`);
  });

  it("retryAfter는 양의 정수(초 단위)", () => {
    const req = fakeReq({ ip: "10.0.0.3" });
    _setForTest("10.0.0.3", 5);

    const result = checkRotateRateLimit(req);
    assert.strictEqual(result.allowed, false);
    assert.ok(Number.isInteger(result.retryAfter), "retryAfter가 정수여야 함");
    assert.ok(result.retryAfter > 0 && result.retryAfter <= 60, `retryAfter 범위 초과: ${result.retryAfter}`);
  });

  it("윈도우 만료 후 카운터 리셋 → 다시 allowed=true", () => {
    const req = fakeReq({ ip: "10.0.0.4" });
    /** 윈도우를 61초 전으로 설정 → 만료 상태 */
    _setForTest("10.0.0.4", 5, Date.now() - 61_000);

    const result = checkRotateRateLimit(req);
    assert.strictEqual(result.allowed, true, "윈도우 만료 후 첫 요청이 blocked됨");
  });

  it("MEMENTO_ROTATE_RATE_LIMIT_PER_MIN=2 오버라이드 시 3번째 요청이 거부됨", () => {
    const original = process.env.MEMENTO_ROTATE_RATE_LIMIT_PER_MIN;
    process.env.MEMENTO_ROTATE_RATE_LIMIT_PER_MIN = "2";

    try {
      const req = fakeReq({ ip: "10.0.0.5" });
      assert.strictEqual(checkRotateRateLimit(req).allowed, true,  "1번째");
      assert.strictEqual(checkRotateRateLimit(req).allowed, true,  "2번째");
      const r3 = checkRotateRateLimit(req);
      assert.strictEqual(r3.allowed, false, "3번째는 blocked되어야 함");
      assert.ok(r3.retryAfter > 0);
    } finally {
      if (original === undefined) {
        delete process.env.MEMENTO_ROTATE_RATE_LIMIT_PER_MIN;
      } else {
        process.env.MEMENTO_ROTATE_RATE_LIMIT_PER_MIN = original;
      }
    }
  });

  it("X-Forwarded-For 헤더의 첫 번째 IP로 카운트됨", () => {
    const req = fakeReq({ ip: "172.16.0.1", forwarded: "203.0.113.1, 10.0.0.1" });
    for (let i = 0; i < 5; i++) checkRotateRateLimit(req);

    const r6 = checkRotateRateLimit(req);
    assert.strictEqual(r6.allowed, false, "X-Forwarded-For IP로 카운트되어야 함");

    /** 같은 소켓 IP지만 forwarded 없는 다른 req는 별도 카운터 */
    const reqDirect = fakeReq({ ip: "172.16.0.1" });
    const rDirect = checkRotateRateLimit(reqDirect);
    assert.strictEqual(rDirect.allowed, true, "forwarded 없는 직접 접속은 별도 카운터");
  });
});
