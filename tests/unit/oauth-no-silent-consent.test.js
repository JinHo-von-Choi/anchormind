/**
 * OAuth 동의 화면 HTML 구성 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-04-10
 * 수정일: 2026-10-03
 *
 * GET /authorize의 자동 승인과 동의 화면 분기는 실제 핸들러를 호출하는
 * oauth-bound-client-auth.test.js가 다룬다. 이 파일은 buildConsentHtml 출력만 본다.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

/* ------------------------------------------------------------------ */
/*  buildConsentHtml 출력 구조 검증                                    */
/* ------------------------------------------------------------------ */

import { buildConsentHtml } from "../../lib/oauth.js";

describe("buildConsentHtml — consent 화면 필수 요소 포함 검증", () => {
  const params = {
    response_type        : "code",
    client_id            : "test-client-id",
    redirect_uri         : "https://example.com/callback",
    code_challenge       : "abc123",
    code_challenge_method: "S256",
    state                : "state-xyz",
    scope                : "mcp",
  };

  it("HTTP 200 응답 바디에 'consent' 관련 키워드 포함 (Allow/Deny 버튼)", () => {
    const html = buildConsentHtml(params, "Test App");
    assert.ok(html.includes("Allow"),   "Allow 버튼 없음");
    assert.ok(html.includes("Deny"),    "Deny 버튼 없음");
  });

  it("client_id가 hidden input으로 포함된다", () => {
    const html = buildConsentHtml(params, "Test App");
    assert.ok(html.includes("test-client-id"), "client_id가 HTML에 없음");
  });

  it("scope가 화면에 표시된다", () => {
    const html = buildConsentHtml(params, "Test App");
    assert.ok(html.includes("mcp"), "scope가 HTML에 없음");
  });

  it("clientName이 화면에 표시된다", () => {
    const html = buildConsentHtml(params, "My Special App");
    assert.ok(html.includes("My Special App"), "clientName이 HTML에 없음");
  });

  it("XSS: script 태그가 이스케이프된다", () => {
    const maliciousParams = { ...params, client_id: "<script>alert(1)</script>" };
    const html            = buildConsentHtml(maliciousParams, "App");
    assert.ok(!html.includes("<script>alert(1)</script>"), "XSS 이스케이프 실패");
    assert.ok(html.includes("&lt;script&gt;"),             "이스케이프 미적용");
  });

  it("decision=allow form action이 /authorize를 가리킨다", () => {
    const html = buildConsentHtml(params, "App");
    assert.ok(html.includes('action="/authorize"'), "form action 없음");
  });
});
