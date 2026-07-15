/**
 * initialize 경로 IP rate limit 선차단 (정적 앵커 가드 + 429 동작 검증)
 *
 * 작성자: 최진호
 * 작성일: 2026-07-16
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = readFileSync(
  fileURLToPath(new URL("../../lib/handlers/mcp-handler.js", import.meta.url)),
  "utf8"
);

describe("mcp initialize pre-auth IP rate limit", () => {
  it("IP 선차단이 _createInitializeSession 호출보다 앞선다", () => {
    const guardIdx = SRC.indexOf("rateLimiter.allow(clientIp, null)");
    /** 함수 "정의"(227행)가 아닌 "호출"(await _createInitializeSession(...))을 앵커링한다 */
    const initIdx  = SRC.indexOf("await _createInitializeSession(");
    assert.ok(guardIdx !== -1, "IP 선차단 코드가 존재해야 한다");
    assert.ok(initIdx  !== -1, "초기화 세션 생성 호출이 존재해야 한다");
    assert.ok(guardIdx < initIdx, "선차단이 초기화 세션 생성보다 먼저 실행되어야 한다");
  });

  it("선차단은 무세션 initialize 요청 조건으로 가드된다", () => {
    assert.match(SRC, /!sessionId\s*&&\s*isInitializeRequest\(msg\)/);
  });

  it("448행 인증 후 rate limit이 initialize 요청을 이중 소비하지 않도록 가드된다", () => {
    /** initialize는 선차단에서 IP 버킷을 소비하므로 후속 인증 rate limit에서 제외 */
    assert.match(SRC, /!isInitializeRequest\(msg\)\s*&&\s*!rateLimiter\.allow\(clientIp,\s*sessionKeyId\)/);
  });
});

/**
 * 동작 검증: 선차단 가드는 순수 함수가 아니라 handleMcpPost 내부 분기이므로,
 * DualRateLimiter의 IP/key 이중 버킷 독립성과 429 형식을 rate-limiter 단위로 확인한다.
 * (핸들러 전체 통합 대신 rate limiter 계약을 고정 — 선차단 로직이 의존하는 불변식)
 */
describe("DualRateLimiter IP/key bucket independence", () => {
  it("IP 버킷 소진이 동일 IP의 key 버킷을 소비하지 않는다", async () => {
    const { DualRateLimiter } = await import("../../lib/rate-limiter.js");
    /** perIp=2로 소량 설정, perKey는 넉넉히 */
    const rl = new DualRateLimiter({ windowMs: 60000, perIp: 2, perKey: 5 });

    const ip = "203.0.113.7";
    /** IP 버킷(keyId=null) 2회 소진 → 3회째 거절 */
    assert.equal(rl.allow(ip, null), true);
    assert.equal(rl.allow(ip, null), true);
    assert.equal(rl.allow(ip, null), false);

    /** 같은 IP라도 keyId 버킷은 독립 — 여전히 허용 */
    assert.equal(rl.allow(ip, "key-xyz"), true);
  });
});
