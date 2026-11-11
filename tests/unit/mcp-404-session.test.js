/**
 * MCP 세션 404 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-17
 *
 * 검증 대상 (MCP 2025-06-18 스펙 준수):
 *  1. sessionId 없음 + initialize → 세션 생성 (200)
 *  2. sessionId 없음 + 비-initialize → 400 (Session required)
 *  3. 유효 sessionId + 맞는 keyId → 기존 경로 (200)
 *  4. sessionId 있으나 Redis 없음 + 인증 실패 → 404 Not Found
 *  5. sessionId expired → 404 Not Found
 *  6. sessionId + keyId 불일치 → 403 Forbidden
 *
 * 인프라 의존성 없이 순수 함수로 분기 로직을 재현하여 검증한다.
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
  return { valid, keyId, groupKeyIds: null, permissions: null, defaultWorkspace: null };
}

/**
 * handleMcpPost의 세션 처리 분기 로직만 추출하여 순수 함수로 재현.
 *
 * 반환값: { status, body }
 *   status: HTTP 상태 코드
 *   body.error.message: 에러 메시지 (에러인 경우)
 */
function simulateSessionBranch({ sessionId, validationScenario, authValid, authKeyId, redisKeyId = null, isInitialize = false }) {
  if (sessionId) {
    const validation = fakeValidation(validationScenario);

    if (!validation.valid) {
      const isRecoverable = validation.reason === "Session not found"
                         || validation.reason === "Session expired";

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
          // 인증 실패 → 404
          return { status: 404, body: { jsonrpc: "2.0", id: null, error: { code: -32000, message: "Session not found" } } };
        }
      } else {
        // 복구 불가 → 404
        return { status: 404, body: { jsonrpc: "2.0", id: null, error: { code: -32000, message: "Session not found" } } };
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

describe("MCP 세션 404 분기", () => {

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

  it("TC4: sessionId 있으나 Redis 없음 + 인증 실패 → 404 Not Found", () => {
    const result = simulateSessionBranch({
      sessionId          : "ghost-session-id",
      validationScenario : "not_found",
      authValid          : false,
      authKeyId          : null
    });
    assert.strictEqual(result.status, 404);
    assert.strictEqual(result.body.error.message, "Session not found");
  });

  it("TC5: sessionId expired → 404 Not Found", () => {
    const result = simulateSessionBranch({
      sessionId          : "expired-session-id",
      validationScenario : "expired",
      authValid          : false,
      authKeyId          : null
    });
    assert.strictEqual(result.status, 404);
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
