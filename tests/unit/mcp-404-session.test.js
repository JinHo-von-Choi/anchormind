/**
 * MCP 세션 404 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-17
 * 수정일: 2026-07-26 — 계약 findings/anchormind-protocol-mismatch-contract-20260725.md
 *         반영 (R5). "세션 부재 + 인증 무효"는 404 → 401(+WWW-Authenticate)로 정정,
 *         "세션 실제 종료(TTL 만료)"는 -32000 → -32001로 코드 정렬(SDK 관행).
 *         두 케이스는 이전엔 동일하게 "Session not found" 404로 뭉뚱그려졌으나,
 *         validateStreamableSession의 반환 reason으로 실제 구분 가능한 신호였다.
 *
 * 검증 대상 (MCP 2025-06-18 스펙 준수):
 *  1. sessionId 없음 + initialize → 세션 생성 (200)
 *  2. sessionId 없음 + 비-initialize → 400 (Session required)
 *  3. 유효 sessionId + 맞는 keyId → 기존 경로 (200)
 *  4. sessionId 있으나 어디에도 기록 없음("Session not found") + 인증 실패 → 401 (구 404 정정)
 *  5. sessionId 있고 레코드는 찾았으나 TTL 만료("Session expired") → 404 + -32001 (구 -32000 정정)
 *  6. sessionId + keyId 불일치 → 403 Forbidden
 *
 * 인프라 의존성 없이 순수 함수로 분기 로직을 재현하여 검증한다. 실제 핸들러를
 * 호출하는 통합 테스트는 tests/unit/mcp-protocol-reanchor-integration.test.js 참고.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * validateStreamableSession 반환 구조를 재현한 스텁
 */
function fakeValidation(scenario) {
  if (scenario === "valid") {
    return {
      valid  : true,
      session: { keyId: "key-1", groupKeyIds: null, permissions: null, defaultWorkspace: null, authenticated: true }
    };
  }
  if (scenario === "not_found") {
    return { valid: false, reason: "Session not found" };
  }
  if (scenario === "expired") {
    return { valid: false, reason: "Session expired" };
  }
  return { valid: false, reason: "Unknown" };
}

/**
 * validateAuthentication 스텁
 */
function fakeAuth(valid, keyId = null) {
  return { valid, keyId, groupKeyIds: null, permissions: null, defaultWorkspace: null, error: valid ? undefined : "Invalid or missing access key" };
}

/**
 * handleMcpPost의 세션 처리 분기 로직만 추출하여 순수 함수로 재현
 * (mcp-handler.js `_resolveExistingSession`, 계약 R5 반영).
 *
 * 반환값: { status, body }
 *   status: HTTP 상태 코드
 *   body.error.message: 에러 메시지 (에러인 경우)
 */
function simulateSessionBranch({ sessionId, validationScenario, authValid, authKeyId, redisKeyId = null, isInitialize = false }) {
  if (sessionId) {
    const validation = fakeValidation(validationScenario);

    if (!validation.valid) {
      /**
       * R5: "Session not found"만 인증 기반 자동복구 대상이다. "Session expired"는
       * 레코드를 실제로 찾았고 TTL이 지났다는 검증 가능한 종료 신호이므로,
       * 인증 유효 여부와 무관하게 404 + -32001(재initialize 필요)로 응답한다.
       */
      const isRecoverable = validation.reason === "Session not found";

      if (isRecoverable) {
        const authResult = fakeAuth(authValid, authKeyId);

        if (authResult.valid) {
          // keyId 교차 검증
          if (redisKeyId !== null && redisKeyId !== authResult.keyId) {
            return { status: 403, body: { jsonrpc: "2.0", id: null, error: { code: -32000, message: "Forbidden" } } };
          }
          // 동일 ID 복구 성공 → 200 (세션 생성됨)
          return { status: 200, body: null, recovered: true };
        } else {
          // 인증 실패 → 401 (구 404 정정, C5a)
          return { status: 401, body: { jsonrpc: "2.0", id: null, error: { code: -32000, message: authResult.error } } };
        }
      } else {
        // 세션 실제 종료(TTL 만료) → 404 + -32001 (C5c)
        return { status: 404, body: { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Session not found" } } };
      }
    }

    // 유효한 세션 → 기존 경로
    return { status: 200, body: null };
  }

  if (!sessionId && isInitialize) {
    const authCheck = fakeAuth(authValid, authKeyId);
    if (!authCheck.valid) {
      return { status: 401, body: { jsonrpc: "2.0", id: null, error: { code: -32000, message: "Unauthorized" } } };
    }
    return { status: 200, body: null, newSession: true };
  }

  // sessionId 없음 + 비-initialize
  return {
    status: 400,
    body  : {
      jsonrpc: "2.0",
      id     : null,
      error  : { code: -32000, message: "Session required. Send an 'initialize' request first to create a session, then include the returned MCP-Session-Id header in subsequent requests." }
    }
  };
}

/* ================================================================== */
/*  테스트 케이스                                                       */
/* ================================================================== */

describe("MCP 세션 404 분기 (Phase 2c-1 + 계약 R5)", () => {

  it("TC1: sessionId 없음 + initialize + 인증 성공 → 세션 생성 (200)", () => {
    const result = simulateSessionBranch({
      sessionId          : null,
      validationScenario : "valid",
      authValid          : true,
      authKeyId          : "key-1",
      isInitialize       : true
    });
    assert.strictEqual(result.status, 200);
    assert.ok(result.newSession, "새 세션이 생성되어야 함");
  });

  it("TC2: sessionId 없음 + 비-initialize → 400 (Session required)", () => {
    const result = simulateSessionBranch({
      sessionId          : null,
      validationScenario : "valid",
      authValid          : true,
      authKeyId          : "key-1",
      isInitialize       : false
    });
    assert.strictEqual(result.status, 400);
    assert.ok(
      result.body.error.message.includes("Session required"),
      "Session required 메시지 포함"
    );
  });

  it("TC3: 유효 sessionId + 맞는 keyId → 200 (기존 경로)", () => {
    const result = simulateSessionBranch({
      sessionId          : "valid-session-id",
      validationScenario : "valid",
      authValid          : true,
      authKeyId          : "key-1"
    });
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.recovered, undefined);
  });

  it("TC4: sessionId 있으나 기록 없음(Session not found) + 인증 실패 → 401 (구 404 정정, C5a)", () => {
    const result = simulateSessionBranch({
      sessionId          : "ghost-session-id",
      validationScenario : "not_found",
      authValid          : false,
      authKeyId          : null
    });
    assert.strictEqual(result.status, 401, "인증 무효는 404가 아니라 401이어야 한다");
    assert.strictEqual(result.body.error.code, -32000);
  });

  it("TC5: sessionId 레코드는 찾았으나 TTL 만료(Session expired) → 404 + -32001 (C5c)", () => {
    const result = simulateSessionBranch({
      sessionId          : "expired-session-id",
      validationScenario : "expired",
      authValid          : true,   // 인증 유효 여부와 무관하게 종료 취급되어야 함을 함께 증명
      authKeyId          : "key-1"
    });
    assert.strictEqual(result.status, 404);
    assert.strictEqual(result.body.error.code, -32001, "SDK 관행에 맞춘 -32001 코드");
    assert.strictEqual(result.body.error.message, "Session not found");
  });

  it("TC6: sessionId + keyId 불일치 → 403 Forbidden", () => {
    const result = simulateSessionBranch({
      sessionId          : "session-owned-by-key-1",
      validationScenario : "not_found",
      authValid          : true,
      authKeyId          : "key-2",   // 재인증 keyId
      redisKeyId         : "key-1"    // Redis 기존 keyId
    });
    assert.strictEqual(result.status, 403);
    assert.strictEqual(result.body.error.message, "Forbidden");
  });
});
