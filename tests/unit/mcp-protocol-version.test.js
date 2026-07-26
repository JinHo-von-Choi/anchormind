/**
 * MCP-Protocol-Version 헤더 검증 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-04-17
 * 수정일: 2026-07-26 — 계약 findings/anchormind-protocol-mismatch-contract-20260725.md
 *         반영. negotiatedVersion 불일치를 거부(400)하던 옛 계약을 폐기하고,
 *         헤더 값으로 재앵커링하는 자가치유(C3)로 교체했다 (R1).
 *         구 TC5는 폐기된 계약(mismatch→400)을 고정하고 있어 반드시 교체 대상이었다.
 *
 * 검증 대상 (MCP 2025-06-18 스펙 준수):
 *  1. initialize 응답 후 negotiatedVersion이 세션에 저장됨
 *  2. 헤더 없음 → 2025-03-26 fallback (통과)
 *  3. 헤더=세션 version 일치 → 통과
 *  4. 헤더=미지원 version → 400, "Unsupported protocol version" 부분문자열 포함
 *  5. 헤더=지원 version이지만 세션 version과 다름 → 200 + 재앵커링 (구 400 계약 폐기, R1)
 *  6. initialize 요청은 헤더 검증 생략
 *
 * 인프라 의존성 없이 순수 함수로 분기 로직을 재현하여 검증한다. 실제 핸들러
 * (mcp-handler.js)·세션(sessions.js)을 호출하는 진짜 통합 테스트는
 * tests/unit/mcp-protocol-reanchor-integration.test.js 참고 — 그 파일이
 * red(수정 전 400) → green(수정 후 200) 전환의 실측 증거를 담당한다.
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
 * handleMcpPost의 Protocol-Version 검증 분기 로직 순수 함수 재현
 * (mcp-handler.js `_validateProtocolVersion`, 계약 R1/R4 반영).
 *
 * @param {object} params
 * @param {string}           params.method            - JSON-RPC 메서드
 * @param {string|undefined} params.protoHeader        - req.headers["mcp-protocol-version"] 값
 * @param {string|null|undefined} params.sessionNegotiated
 *   - 세션의 negotiatedVersion 값. `undefined`는 "세션 자체가 없음"(재앵커링 스킵),
 *     `null`은 "세션은 있으나 아직 협상되지 않음"(재앵커링 대상)을 의미한다.
 * @returns {{ status: number, message: string|null, effectiveVersion: string|null,
 *             reanchored: boolean, negotiatedVersionAfter: string|null }}
 */
function checkProtocolVersion({ method, protoHeader, sessionNegotiated }) {
  if (method === "initialize") {
    return { status: 200, message: null, effectiveVersion: null, reanchored: false, negotiatedVersionAfter: sessionNegotiated ?? null };
  }

  const effectiveVersion = protoHeader || FALLBACK_VERSION;

  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(effectiveVersion)) {
    const message = `Bad Request: Unsupported protocol version: ${effectiveVersion} ` +
      `(supported versions: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")})`;
    return { status: 400, message, effectiveVersion, reanchored: false, negotiatedVersionAfter: sessionNegotiated ?? null };
  }

  if (!protoHeader) {
    return { status: 200, message: null, effectiveVersion, reanchored: false, negotiatedVersionAfter: sessionNegotiated ?? null };
  }

  /**
   * R1 자가치유: 세션이 존재하고(sessionNegotiated !== undefined) negotiatedVersion이
   * 헤더와 다르면(null이었던 경우 포함) 거부하지 않고 헤더 값으로 재앵커링한다.
   */
  if (sessionNegotiated !== undefined && sessionNegotiated !== protoHeader) {
    return { status: 200, message: null, effectiveVersion, reanchored: true, negotiatedVersionAfter: protoHeader };
  }

  return { status: 200, message: null, effectiveVersion, reanchored: false, negotiatedVersionAfter: sessionNegotiated ?? protoHeader };
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

describe("MCP-Protocol-Version 헤더 검증 (Phase 2c-3 + 계약 R1/R4)", () => {

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
    assert.strictEqual(result.reanchored, false, "헤더 없는 fallback 경로는 재앵커링하지 않는다");
  });

  it("TC3: 헤더=세션 version 일치 → 통과 (재앵커링 없음)", () => {
    const result = checkProtocolVersion({
      method           : "tools/call",
      protoHeader      : "2025-06-18",
      sessionNegotiated: "2025-06-18"
    });
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.message, null);
    assert.strictEqual(result.reanchored, false);
  });

  it("TC4: 헤더=미지원 version → 400, 'Unsupported protocol version' 부분문자열 포함", () => {
    const result = checkProtocolVersion({
      method           : "tools/call",
      protoHeader      : "2099-01-01",
      sessionNegotiated: "2025-06-18"
    });
    assert.strictEqual(result.status, 400);
    assert.ok(
      result.message.includes("Unsupported protocol version"),
      `A2 회귀 가드: 메시지에 'Unsupported protocol version' 부분문자열이 있어야 한다 (실제: ${result.message})`
    );
    assert.ok(result.message.includes("2099-01-01"), "받은 버전 값이 메시지에 포함되어야 한다");
  });

  it("TC5: 헤더=지원 version이지만 세션 version과 다름 → 200 + 재앵커링 (계약 R1, 구 400 폐기)", () => {
    const result = checkProtocolVersion({
      method           : "tools/call",
      protoHeader      : "2025-03-26",
      sessionNegotiated: "2025-06-18"
    });
    assert.strictEqual(result.status, 200, "구 계약(400 mismatch)은 폐기되었다 — 거부하지 않는다");
    assert.strictEqual(result.message, null);
    assert.strictEqual(result.reanchored, true, "세션 negotiatedVersion을 헤더 값으로 재앵커링해야 한다");
    assert.strictEqual(result.negotiatedVersionAfter, "2025-03-26", "재앵커링 이후 값은 헤더 값이어야 한다");
  });

  it("TC6: initialize 요청은 헤더 검증 생략 (항상 통과)", () => {
    const result = checkProtocolVersion({
      method           : "initialize",
      protoHeader      : "2099-01-01",   // 미지원 버전이어도 생략
      sessionNegotiated: null
    });
    assert.strictEqual(result.status, 200, "initialize는 헤더 검증 대상에서 제외");
  });

  it("TC7: 헤더=지원 version + 세션 negotiatedVersion null → 통과 + 재앵커링 (null 공백 해소, R1/R2)", () => {
    const result = checkProtocolVersion({
      method           : "tools/list",
      protoHeader      : "2025-06-18",
      sessionNegotiated: null   // initialize 직후 아직 저장 안 된 경우
    });
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.reanchored, true, "null negotiatedVersion도 헤더 값으로 채워야 한다");
    assert.strictEqual(result.negotiatedVersionAfter, "2025-06-18");
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

  /* ================================================================ */
  /*  회귀 가드 (계약 §4 A1/A2)                                          */
  /* ================================================================ */

  it("A1: SUPPORTED_PROTOCOL_VERSIONS의 어떤 값도 400을 유발하지 않는다 (세션 미존재 포함)", () => {
    for (const ver of SUPPORTED_PROTOCOL_VERSIONS) {
      const withSession = checkProtocolVersion({ method: "tools/call", protoHeader: ver, sessionNegotiated: "2024-11-05" });
      const noSession    = checkProtocolVersion({ method: "tools/call", protoHeader: ver, sessionNegotiated: undefined });
      assert.notStrictEqual(withSession.status, 400, `${ver} + 세션 있음 → 400 금지`);
      assert.notStrictEqual(noSession.status,    400, `${ver} + 세션 없음 → 400 금지`);
    }
  });

  it("A2: 400 응답의 message는 항상 'Unsupported protocol version' 부분문자열을 포함한다", () => {
    const unsupportedSamples = ["2099-01-01", "1999-01-01", "not-a-version", ""];
    for (const bad of unsupportedSamples) {
      const result = checkProtocolVersion({ method: "tools/call", protoHeader: bad, sessionNegotiated: null });
      if (bad === "") {
        /** 빈 문자열 헤더는 protoHeader가 falsy이므로 fallback(2025-03-26, 지원됨)으로 통과 */
        assert.strictEqual(result.status, 200);
        continue;
      }
      assert.strictEqual(result.status, 400, `${bad}는 미지원이므로 400이어야 한다`);
      assert.ok(result.message.includes("Unsupported protocol version"), `메시지: ${result.message}`);
    }
  });
});
