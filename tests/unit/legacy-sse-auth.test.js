/**
 * Legacy SSE 인증 보안 테스트
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { safeCompare } from "../../lib/auth.js";
import { isLegacySseAuthDisabledMaster } from "../../lib/handlers/sse-handler.js";

describe("safeCompare", () => {
  it("동일 문자열 비교 시 true", () => {
    assert.strictEqual(safeCompare("test-key-123", "test-key-123"), true);
  });

  it("다른 문자열 비교 시 false", () => {
    assert.strictEqual(safeCompare("test-key-123", "wrong-key"), false);
  });

  it("빈 문자열 처리", () => {
    assert.strictEqual(safeCompare("", ""), true);
    assert.strictEqual(safeCompare("", "x"), false);
  });
});

describe("Legacy SSE fail-closed master decision", () => {
  it("ACCESS_KEY 누락만으로 master가 되지 않는다", () => {
    assert.equal(isLegacySseAuthDisabledMaster("", false), false);
  });

  it("명시적 AUTH_DISABLED에서만 master를 허용한다", () => {
    assert.equal(isLegacySseAuthDisabledMaster("", true), true);
    assert.equal(isLegacySseAuthDisabledMaster("synthetic-key", true), false);
  });
});
