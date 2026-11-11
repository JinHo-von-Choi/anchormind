/**
 * MCP Origin 헤더 차단 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-17
 *
 * 검증 대상 (MCP 2025-06-18 스펙 준수 — DNS rebinding 방어):
 *  1. Origin 없음(CLI/curl) + STRICT=true → 통과
 *  2. Origin=claude.ai + STRICT=true → 통과
 *  3. Origin=evil.com + STRICT=true → 차단 (403)
 *  4. Origin=evil.com + STRICT=false → 통과 (opt-in 기본값)
 *  5. OAUTH_TRUSTED_ORIGINS 커스텀 추가 동작 검증
 *
 * STRICT_ORIGIN은 config import 시점에 고정되므로 이 파일은 정책을 순수 함수로
 * 재현하는 spec-level 테스트다. 실제 handler helper의 기본값 검증은 origin-policy.test.js에서 수행한다.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * isOriginAllowed 로직 순수 함수 재현
 *
 * @param {object} params
 * @param {string|undefined} params.origin       - req.headers.origin 값
 * @param {boolean}          params.strictOrigin - STRICT_ORIGIN env 값
 * @param {string[]}         params.oauthTrusted - OAUTH_TRUSTED_ORIGINS 값
 * @param {Set<string>}      params.allowedSet   - ALLOWED_ORIGINS Set
 */
function checkOriginAllowed({ origin, strictOrigin, oauthTrusted = [], allowedSet = new Set() }) {
  if (!origin)        return true;
  if (!strictOrigin)  return true;

  const allowlist = new Set([
    "https://claude.ai",
    "https://chatgpt.com",
    "https://platform.openai.com",
    ...oauthTrusted,
    ...allowedSet
  ]);

  return allowlist.has(origin);
}

/* ================================================================== */
/*  테스트 케이스                                                       */
/* ================================================================== */

describe("isOriginAllowed — DNS rebinding 방어", () => {

  it("TC1: Origin 없음(CLI/curl) + STRICT=true → 통과", () => {
    const allowed = checkOriginAllowed({
      origin      : undefined,
      strictOrigin: true
    });
    assert.strictEqual(allowed, true, "Origin 헤더 없는 요청은 항상 통과해야 함");
  });

  it("TC2: Origin=claude.ai + STRICT=true → 통과", () => {
    const allowed = checkOriginAllowed({
      origin      : "https://claude.ai",
      strictOrigin: true
    });
    assert.strictEqual(allowed, true, "신뢰 도메인 claude.ai는 허용");
  });

  it("TC3: Origin=evil.com + STRICT=true → 차단", () => {
    const allowed = checkOriginAllowed({
      origin      : "https://evil.com",
      strictOrigin: true
    });
    assert.strictEqual(allowed, false, "등록되지 않은 Origin은 STRICT 모드에서 차단");
  });

  it("TC4: Origin=evil.com + STRICT=false(기본값) → 통과", () => {
    const allowed = checkOriginAllowed({
      origin      : "https://evil.com",
      strictOrigin: false
    });
    assert.strictEqual(allowed, true, "STRICT=false(기본)에서는 모든 Origin 통과");
  });

  it("TC5: OAUTH_TRUSTED_ORIGINS 커스텀 추가 → 해당 Origin 허용", () => {
    const customTrusted = ["https://custom-app.example.com"];
    const allowedCustom = checkOriginAllowed({
      origin      : "https://custom-app.example.com",
      strictOrigin: true,
      oauthTrusted: customTrusted
    });
    assert.strictEqual(allowedCustom, true, "OAUTH_TRUSTED_ORIGINS에 등록된 Origin은 허용");

    const blockedOther = checkOriginAllowed({
      origin      : "https://other-app.example.com",
      strictOrigin: true,
      oauthTrusted: customTrusted
    });
    assert.strictEqual(blockedOther, false, "등록되지 않은 Origin은 여전히 차단");
  });

  it("TC6: ALLOWED_ORIGINS Set에 추가된 Origin → 허용", () => {
    const allowed = checkOriginAllowed({
      origin      : "https://my-intranet.example.com",
      strictOrigin: true,
      allowedSet  : new Set(["https://my-intranet.example.com"])
    });
    assert.strictEqual(allowed, true, "ALLOWED_ORIGINS에 등록된 Origin은 허용");
  });

  it("TC7: chatgpt.com + STRICT=true → 통과 (기본 신뢰 도메인)", () => {
    const allowed = checkOriginAllowed({
      origin      : "https://chatgpt.com",
      strictOrigin: true
    });
    assert.strictEqual(allowed, true);
  });
});
