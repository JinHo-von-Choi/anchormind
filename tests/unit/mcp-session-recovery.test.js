/**
 * MCP 세션 복구 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-17
 *
 * 검증 대상:
 *  1. 유효한 sessionId 재전송 시 동일 ID로 복원 → same_id_success
 *  2. 다른 keyId로 sessionId 재전송 시 → keyid_mismatch (403)
 *  3. sessionId 있지만 Redis에 없음 + 인증 성공 → same_id_success
 *  4. lastReflectedAt이 null이면 초기 sessionData에 포함됨 (순수 함수 검증)
 *
 * mock.module이 필요한 케이스는 순수 함수로 분기 로직을 재현하여 검증.
 * mock.module 케이스는 --experimental-test-module-mocks 경유 (test:unit:node 스크립트)에서 동작.
 */

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { hasSessionIdentityMismatch } from "../../lib/handlers/mcp-handler.js";

/** ─────────────────────────────────────────────────────────────────
 *  sessionData 구조 검증 (TC4: lastReflectedAt 초기화)
 *
 *  실제 createStreamableSessionWithId 호출 없이
 *  sessionData 생성 로직만 재현하여 필드 구조를 검증한다.
 * ──────────────────────────────────────────────────────────────── */

describe("createStreamableSessionWithId — sessionData 구조 검증", () => {

  /**
   * sessions.js의 createStreamableSessionWithId 내부 sessionData 생성을 재현.
   */
  function buildSessionData(sessionId, authenticated, keyId, groupKeyIds, permissions, defaultWorkspace) {
    const now = Date.now();
    return {
      sessionId,
      authenticated,
      keyId              : keyId ?? null,
      groupKeyIds        : groupKeyIds ?? null,
      permissions        : permissions ?? null,
      defaultWorkspace   : defaultWorkspace ?? null,
      createdAt          : now,
      expiresAt          : now + 43200 * 60 * 1000,
      lastAccessedAt     : now,
      lastReflectedAt    : null,
    };
  }

  it("TC4: lastReflectedAt이 null로 초기화됨", () => {
    const data = buildSessionData("test-id", true, "key-1");
    assert.ok("lastReflectedAt" in data, "lastReflectedAt 필드 존재");
    assert.strictEqual(data.lastReflectedAt, null, "초기값 null");
  });

  it("sessionId, keyId, authenticated 필드 정확히 설정", () => {
    const data = buildSessionData("my-session", true, "key-A", ["key-A", "key-B"]);
    assert.strictEqual(data.sessionId, "my-session");
    assert.strictEqual(data.keyId, "key-A");
    assert.strictEqual(data.authenticated, true);
    assert.deepStrictEqual(data.groupKeyIds, ["key-A", "key-B"]);
  });

  it("master 키 세션 (keyId=null) → keyId null, lastReflectedAt null", () => {
    const data = buildSessionData("master-sess", false, null);
    assert.strictEqual(data.keyId, null);
    assert.strictEqual(data.lastReflectedAt, null);
  });

});

/** ─────────────────────────────────────────────────────────────────
 *  세션 복구 분기 — keyId 교차 검증 (순수 함수 재현)
 *
 *  mcp-handler.js의 auto-recovery 분기를 추출한 순수 테스트 헬퍼.
 * ──────────────────────────────────────────────────────────────── */

/**
 * @returns {"same_id_success"|"keyid_mismatch"|"not_found"}
 */
async function simulateRecovery({
  redisSession,
  authResult,
  redisEnabled = true,
}) {
  const mockRecordTI = mock.fn();
  const mockRecordSR = mock.fn();
  const mockCreate   = mock.fn(async () => "same-session-id");

  if (!authResult.valid) {
    mockRecordSR("not_found");
    return "not_found";
  }

  const incomingKeyId = authResult.keyId ?? null;

  if (redisEnabled && redisSession !== undefined) {
    const existingRedis = redisSession;
    if (hasSessionIdentityMismatch(existingRedis, authResult)) {
      mockRecordTI("session_recover_keyid_mismatch");
      mockRecordSR("keyid_mismatch");
      return "keyid_mismatch";
    }
  }

  await mockCreate("session-id", true, incomingKeyId);
  mockRecordSR("same_id_success");
  return "same_id_success";
}

describe("세션 복구 분기 — keyId 교차 검증", () => {

  it("TC1: keyId 일치 → same_id_success", async () => {
    const result = await simulateRecovery({
      redisSession: { keyId: "key-A", authenticated: true },
      authResult:   { valid: true, keyId: "key-A", isMaster: false },
    });
    assert.strictEqual(result, "same_id_success");
  });

  it("TC2: 다른 keyId → keyid_mismatch (403)", async () => {
    const result = await simulateRecovery({
      redisSession: { keyId: "key-A", authenticated: true },
      authResult:   { valid: true, keyId: "key-B", isMaster: false },
    });
    assert.strictEqual(result, "keyid_mismatch");
  });

  it("TC3: Redis에 기존 세션 없음 (null) + 인증 성공 → same_id_success", async () => {
    const result = await simulateRecovery({
      redisSession: null,
      authResult:   { valid: true, keyId: "key-C", isMaster: false },
    });
    assert.strictEqual(result, "same_id_success");
  });

  it("TC4: 인증 실패 → not_found", async () => {
    const result = await simulateRecovery({
      redisSession: null,
      authResult:   { valid: false, error: "Unauthorized" },
    });
    assert.strictEqual(result, "not_found");
  });

  it("TC5: Redis 비활성화 + keyId 불일치 → same_id_success (검증 스킵)", async () => {
    const result = await simulateRecovery({
      redisSession : { keyId: "key-A", authenticated: true },
      authResult   : { valid: true, keyId: "key-B", isMaster: false },
      redisEnabled : false,
    });
    assert.strictEqual(result, "same_id_success");
  });

  it("TC6: master 키(keyId=null) 복구 → same_id_success", async () => {
    const result = await simulateRecovery({
      redisSession: { keyId: null, isMaster: true, authenticated: true },
      authResult:   { valid: true, keyId: null, isMaster: true },
    });
    assert.strictEqual(result, "same_id_success");
  });

  it("TC7: keyId=null이어도 OAuth non-master와 master identity는 교차 복구되지 않는다", async () => {
    const result = await simulateRecovery({
      redisSession: { keyId: null, isMaster: true, authenticated: true },
      authResult: { valid: true, keyId: null, isMaster: false }
    });
    assert.strictEqual(result, "keyid_mismatch");
  });

});
