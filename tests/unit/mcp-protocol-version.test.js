/**
 * MCP-Protocol-Version 헤더 검증 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-17
 *
 * 검증 대상 (MCP 2025-06-18 스펙 준수):
 *  1. initialize 응답 후 negotiatedVersion이 세션에 저장됨
 *  2. 헤더 없음 → 2025-03-26 fallback (통과)
 *  3. 헤더=세션 version 일치 → 통과
 *  4. 헤더=미지원 version → 400
 *  5. 헤더=지원 version이지만 세션 version과 다름 → 400
 *  6. initialize 요청은 헤더 검증 생략
 *
 * 인프라 의존성 없이 순수 함수로 분기 로직을 재현하여 검증한다.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05"
];

const FALLBACK_VERSION = "2025-03-26";

/**
 * handleMcpPost의 Protocol-Version 검증 분기 로직 순수 함수 재현.
 *
 * @param {object} params
 * @param {string}          params.method              - JSON-RPC 메서드
 * @param {string|undefined} params.protoHeader        - req.headers["mcp-protocol-version"] 값
 * @param {string|null}     params.sessionNegotiated   - session.negotiatedVersion 값
 * @returns {{ status: number, message: string|null, effectiveVersion: string|null }}
 */
function checkProtocolVersion({ method, protoHeader, sessionNegotiated }) {
  if (method === "initialize") {
    return { status: 200, message: null, effectiveVersion: null };
  }

  const effectiveVersion = protoHeader || FALLBACK_VERSION;

  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(effectiveVersion)) {
    return { status: 400, message: "Unsupported protocol version", effectiveVersion };
  }

  if (protoHeader && sessionNegotiated && sessionNegotiated !== protoHeader) {
    return {
      status : 400,
      message: `Protocol version mismatch: session negotiated ${sessionNegotiated} but request sent ${protoHeader}. Re-initialize the session.`,
      data   : { negotiatedVersion: sessionNegotiated, receivedVersion: protoHeader, action: "reinitialize" },
      effectiveVersion
    };
  }

  return { status: 200, message: null, effectiveVersion };
}

/**
 * initialize 완료 후 negotiatedVersion 세션 저장 로직 재현
 */
function simulateInitializeVersionStore(responseProtocolVersion) {
  const session = { negotiatedVersion: null };
  if (responseProtocolVersion) {
    session.negotiatedVersion = responseProtocolVersion;
  }
  return session;
}

/* ================================================================== */
/*  테스트 케이스                                                       */
/* ================================================================== */

describe("MCP-Protocol-Version 헤더 검증 (Phase 2c-3)", () => {

  it("TC1: initialize 응답 후 negotiatedVersion이 세션에 저장됨", () => {
    const session = simulateInitializeVersionStore("2025-06-18");
    assert.strictEqual(session.negotiatedVersion, "2025-06-18");
  });

  it("TC1b: negotiatedVersion null 초기값 확인", () => {
    const session = simulateInitializeVersionStore(null);
    assert.strictEqual(session.negotiatedVersion, null);
  });

  it("TC2: 헤더 없음 → 2025-03-26 fallback (통과)", () => {
    const result = checkProtocolVersion({
      method           : "tools/call",
      protoHeader      : undefined,
      sessionNegotiated: "2025-06-18"
    });
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.effectiveVersion, FALLBACK_VERSION);
  });

  it("TC3: 헤더=세션 version 일치 → 통과", () => {
    const result = checkProtocolVersion({
      method           : "tools/call",
      protoHeader      : "2025-06-18",
      sessionNegotiated: "2025-06-18"
    });
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.message, null);
  });

  it("TC4: 헤더=미지원 version → 400", () => {
    const result = checkProtocolVersion({
      method           : "tools/call",
      protoHeader      : "2099-01-01",
      sessionNegotiated: "2025-06-18"
    });
    assert.strictEqual(result.status, 400);
    assert.strictEqual(result.message, "Unsupported protocol version");
  });

  it("TC5: 헤더=지원 version이지만 세션 version과 다름 → 400", () => {
    const result = checkProtocolVersion({
      method           : "tools/call",
      protoHeader      : "2025-03-26",
      sessionNegotiated: "2025-06-18"
    });
    assert.equal(result.status, 400);
    assert.match(result.message, /Re-initialize the session/);
    assert.equal(result.data.action, "reinitialize");
    assert.equal(result.data.negotiatedVersion, "2025-06-18");
    assert.equal(result.data.receivedVersion, "2025-03-26");
  });

  it("TC6: initialize 요청은 헤더 검증 생략 (항상 통과)", () => {
    const result = checkProtocolVersion({
      method           : "initialize",
      protoHeader      : "2099-01-01",   // 미지원 버전이어도 생략
      sessionNegotiated: null
    });
    assert.strictEqual(result.status, 200, "initialize는 헤더 검증 대상에서 제외");
  });

  it("TC7: 헤더=지원 version + 세션 negotiatedVersion null → 통과", () => {
    const result = checkProtocolVersion({
      method           : "tools/list",
      protoHeader      : "2025-06-18",
      sessionNegotiated: null   // initialize 직후 아직 저장 안 된 경우
    });
    assert.strictEqual(result.status, 200);
  });

  it("TC8: 모든 SUPPORTED_PROTOCOL_VERSIONS가 개별적으로 통과", () => {
    for (const ver of SUPPORTED_PROTOCOL_VERSIONS) {
      const result = checkProtocolVersion({
        method           : "tools/call",
        protoHeader      : ver,
        sessionNegotiated: ver
      });
      assert.strictEqual(result.status, 200, `${ver} should pass`);
    }
  });
});
